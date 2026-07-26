//! Port of the per-provider integration senders (lib/integrations.server.ts).
//! SECURITY-CRITICAL and translated as-is, not improved: config arrives from
//! the graph and is untrusted, so every value that reaches a URL *path* is
//! shape-checked first.
//!
//! Two SSRF guards carry the weight and must survive any edit:
//!   - exact-host allowlists (`==`, never `contains`) for the Discord webhook
//!     URL, the only sender whose URL is user-supplied;
//!   - the id/token charset checks, because a Discord channel id and a Telegram
//!     bot token are interpolated straight into the request path. Anything
//!     admitting "/", "?", "#" or "%" would let config re-aim the request at
//!     another endpoint of the same host.
//!
//! Blocking reqwest for the same reason as `http.rs`: the interpreter is
//! synchronous and each run owns a plain std thread.

use std::collections::{BTreeSet, HashMap};
use std::io::Read;
use std::time::Duration;

use reqwest::blocking::{Client, RequestBuilder, Response};
use reqwest::Url;
use serde_json::{json, Value};

use crate::interpreter::utf16_prefix;

const MAX_INTEGRATION_MESSAGE: usize = 4096; // text cap (matches Telegram's message limit)
const MAX_INTEGRATION_IMAGE: usize = 4_194_304; // image data-URL cap (mirrors the runner)
const DISCORD_CONTENT_LIMIT: usize = 2000; // Discord's hard cap on `content`
const DISCORD_UPLOAD_LIMIT: usize = 8_388_608; // 8 MiB — Discord free webhook attachment cap
const TELEGRAM_TEXT_LIMIT: usize = 4096; // Telegram's sendMessage cap
const TELEGRAM_UPLOAD_LIMIT: usize = 10_485_760; // 10 MiB — Telegram photo upload cap
const SEND_TIMEOUT: Duration = Duration::from_secs(15);
// The TypeScript read error bodies unbounded and then kept 200 chars; the read
// is capped here because nothing downstream can use more than the 200.
const ERROR_BODY_READ: u64 = 4096;
const ERROR_BODY_CHARS: usize = 200;
// Discord caps a message at 4000 chars and we ask for at most 100 of them.
const READ_RESPONSE_MAX: u64 = 4_194_304;

// --- shape checks (the SSRF guards) ----------------------------------------

/// `/^\d{17,20}$/` — a Discord snowflake. Doubles as the SSRF guard: bot-API
/// URLs are a fixed base plus this digits-only id.
fn is_snowflake(s: &str) -> bool {
    (17..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_digit())
}

/// `/^\d{1,20}:[A-Za-z0-9_-]{25,64}$/` — the Telegram bot token rides in the
/// URL *path* (api.telegram.org/bot<token>/<method>), so the charset (no "/",
/// "?", "#", "%") is what keeps untrusted config from shaping the target.
pub(crate) fn is_telegram_token(s: &str) -> bool {
    let Some((digits, rest)) = s.split_once(':') else {
        return false;
    };
    (1..=20).contains(&digits.len())
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (25..=64).contains(&rest.len())
        && rest
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `/^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/` — a numeric id (negative for groups,
/// -100… for supergroups/channels) or a public @channelusername. chat_id only
/// ever travels in the JSON body / form field, but gets the same strictness.
fn is_telegram_chat_id(s: &str) -> bool {
    if let Some(name) = s.strip_prefix('@') {
        return (5..=32).contains(&name.len())
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    }
    let digits = s.strip_prefix('-').unwrap_or(s);
    (1..=20).contains(&digits.len()) && digits.bytes().all(|b| b.is_ascii_digit())
}

// --- shared request plumbing -----------------------------------------------

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(SEND_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())
}

/// Maps a finished response onto the TypeScript's value shape: `ok` on 2xx,
/// otherwise `<label> failed (<status>)[: <first 200 chars of body>]`.
fn finish(res: Response, label: &str, ok: &str) -> Result<String, String> {
    let status = res.status();
    if status.is_success() {
        return Ok(ok.to_string());
    }
    let mut buf = Vec::new();
    let _ = res.take(ERROR_BODY_READ).read_to_end(&mut buf);
    let text = String::from_utf8_lossy(&buf).into_owned();
    let body = utf16_prefix(&text, ERROR_BODY_CHARS).unwrap_or(text);
    Err(match body.is_empty() {
        true => format!("{label} failed ({})", status.as_u16()),
        false => format!("{label} failed ({}): {body}", status.as_u16()),
    })
}

fn send(req: RequestBuilder, label: &str, ok: &str) -> Result<String, String> {
    // an untrusted bot token lands in an `authorization` header value; a CRLF in
    // it fails HeaderValue construction, which reqwest surfaces here (fetch threw
    // the same way), so injection is impossible rather than merely unlikely
    let res = req.send().map_err(|e| {
        if e.is_timeout() {
            format!("{label} failed: timed out")
        } else {
            // NOT `{e}`: reqwest's Display appends the request URL, and the
            // Telegram bot token rides in that URL's path. This string is
            // persisted in workflow_run.log. See `http::net_error`.
            format!("{label} failed: {}", crate::http::net_error(e))
        }
    })?;
    finish(res, label, ok)
}

// --- data:image payloads ---------------------------------------------------

/// Node's `Buffer.from(b64, "base64")`, which never throws: non-alphabet bytes
/// (padding, whitespace, junk) are skipped and a trailing partial group is
/// dropped. base64url's `-_` decode too, exactly as Node accepts them.
fn base64_decode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let (mut acc, mut bits) = (0u32, 0u32);
    for b in s.bytes() {
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    out
}

#[cfg_attr(test, derive(Debug))]
struct Image {
    bytes: Vec<u8>,
    mime: String,
    ext: String,
}

/// Splits `data:image/png;base64,…` into upload parts. Returns the sender's
/// error value verbatim on the paths the TypeScript rejects.
fn parse_data_image(message: &str, limit: usize) -> Result<Image, String> {
    const MARKER: &str = ";base64,";
    let Some(idx) = message.find(MARKER) else {
        return Err("unsupported image encoding (expected base64)".into());
    };
    let mime = &message[5..idx]; // past "data:", up to the marker
    let bytes = base64_decode(&message[idx + MARKER.len()..]);
    if bytes.is_empty() {
        return Err("image data is empty".into());
    }
    if bytes.len() > limit {
        return Err(format!("image too large (max {limit} bytes)"));
    }
    // "image/svg+xml" -> "svg". Both fields are echoed into multipart headers,
    // so both are constrained to a charset that cannot break out of them —
    // the Blob/FormData serializer did this implicitly in the browser API.
    let subtype = mime.split('/').nth(1).unwrap_or("png");
    let ext: String = subtype
        .split('+')
        .next()
        .unwrap_or("png")
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .take(8)
        .collect();
    let ext = ext.to_ascii_lowercase();
    Ok(Image {
        bytes,
        mime: safe_mime(mime),
        ext: if ext.is_empty() { "png".into() } else { ext },
    })
}

/// A `type/subtype` of HTTP token chars, or the octet-stream fallback a Blob
/// with an unparseable type would have produced.
fn safe_mime(mime: &str) -> String {
    let token = |s: &str| {
        (1..=64).contains(&s.len())
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
    };
    match mime.split_once('/') {
        Some((t, sub)) if token(t) && token(sub) => mime.to_ascii_lowercase(),
        _ => "application/octet-stream".into(),
    }
}

/// One multipart/form-data body: plain text fields then a single file part.
/// Returns the content-type header value alongside it.
fn multipart(
    fields: &[(&str, &str)],
    file_field: &str,
    img: &Image,
) -> (String, Vec<u8>) {
    let boundary = format!("----saturn{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(value.as_bytes());
        body.extend_from_slice(b"\r\n");
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; \
             filename=\"image.{}\"\r\nContent-Type: {}\r\n\r\n",
            img.ext, img.mime
        )
        .as_bytes(),
    );
    body.extend_from_slice(&img.bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    (format!("multipart/form-data; boundary={boundary}"), body)
}

/// `text.slice(0, limit - 1) + "…"` past `limit` UTF-16 units.
fn clamp(text: &str, limit: usize) -> String {
    match utf16_prefix(text, limit) {
        None => text.to_string(),
        Some(_) => format!("{}…", utf16_prefix(text, limit - 1).unwrap_or_default()),
    }
}

// --- discord ---------------------------------------------------------------

/// Shared Discord message POST — webhook execute URLs and the bot
/// channel-messages API accept the identical content / files[0] shape.
fn post_discord_message(
    url: Url,
    auth: Option<&str>,
    message: &str,
    label: &str,
) -> Result<String, String> {
    if crate::interpreter::js::trim(message).is_empty() {
        return Err("message is empty".into());
    }
    let client = client()?;
    let mut req = client.post(url);
    if let Some(token) = auth {
        req = req.header("authorization", format!("Bot {token}"));
    }
    // an image data URL uploads as a file attachment (multipart), not as text
    if message.starts_with("data:image/") {
        let img = parse_data_image(message, DISCORD_UPLOAD_LIMIT)?;
        let (content_type, body) = multipart(&[], "files[0]", &img);
        return send(req.header("content-type", content_type).body(body), label, "sent");
    }
    let content = clamp(message, DISCORD_CONTENT_LIMIT);
    send(req.json(&json!({ "content": content })), label, "sent")
}

fn send_discord_webhook(config: &HashMap<String, String>, message: &str) -> Result<String, String> {
    // SSRF guard: the URL is untrusted, so only exact Discord webhook hosts and
    // the fixed webhook path may be fetched — host EQUALITY, never a substring
    // test, which "discord.com.evil.tld" would pass.
    let Ok(url) = Url::parse(cfg(config, "webhookUrl")) else {
        return Err("invalid webhook url".into());
    };
    let host = url.host_str().unwrap_or("");
    if url.scheme() != "https"
        || !(host == "discord.com" || host == "discordapp.com")
        || !url.path().starts_with("/api/webhooks/")
    {
        return Err("webhook url must look like https://discord.com/api/webhooks/…".into());
    }
    post_discord_message(url, None, message, "discord webhook")
}

/// Shared bot-API config parse. The snowflake check doubles as the SSRF guard.
fn bot_channel(config: &HashMap<String, String>) -> Result<(String, String), String> {
    let token = cfg(config, "botToken");
    let channel = cfg(config, "channelId");
    if token.is_empty() {
        return Err("bot token is empty".into());
    }
    if !is_snowflake(channel) {
        return Err("channel id must be a numeric id".into());
    }
    Ok((token.to_string(), channel.to_string()))
}

fn send_discord_message(config: &HashMap<String, String>, message: &str) -> Result<String, String> {
    let (token, channel) = bot_channel(config)?;
    let url = discord_channel_url(&channel, "messages");
    post_discord_message(url, Some(&token), message, "discord send")
}

fn discord_channel_url(channel: &str, path: &str) -> Url {
    // safe to unwrap: the base is a literal and `channel` passed is_snowflake
    Url::parse(&format!(
        "https://discord.com/api/v10/channels/{channel}/{path}"
    ))
    .expect("fixed base + digits-only id")
}

/// GET the channel's recent history. Returns a compact chronological JSON array
/// for the node's "messages" value output — Discord's raw newest-first objects
/// are huge and extract/agent-hostile.
fn read_discord_messages(config: &HashMap<String, String>, _msg: &str) -> Result<String, String> {
    let (token, channel) = bot_channel(config)?;
    // Number(" ") is 0 and Number("x") is NaN — both fall through to the default.
    // js::to_number, not f64::from_str: they disagree on "0x10", "Infinity", "1_0".
    let n = crate::interpreter::js::to_number(cfg(config, "count"));
    let count = if n.is_finite() && n.trunc() > 0.0 { (n.trunc() as u64).min(100) } else { 20 };
    let mut url = discord_channel_url(&channel, "messages");
    url.query_pairs_mut().append_pair("limit", &count.to_string());

    let res = client()?
        .get(url)
        .header("authorization", format!("Bot {token}"))
        .send()
        .map_err(|e| {
            if e.is_timeout() {
                "discord read failed: timed out".to_string()
            } else {
                format!("discord read failed: {}", crate::http::net_error(e))
            }
        })?;
    if !res.status().is_success() {
        return finish(res, "discord read", ""); // always the Err arm here
    }
    let mut buf = Vec::new();
    let _ = res.take(READ_RESPONSE_MAX).read_to_end(&mut buf);
    shape_discord_messages(serde_json::from_slice(&buf).unwrap_or(Value::Null))
}

// A derived struct, not `json!`: serde_json's Map is a BTreeMap here (no
// `preserve_order` feature), so an object built as a map would serialize
// alphabetically while JSON.stringify emitted declaration order. Derive keeps
// the field order the TypeScript produced.
#[derive(serde::Serialize)]
struct DiscordMessage {
    id: String,
    author: String,
    bot: bool,
    content: String,
    timestamp: String,
    attachments: Vec<String>,
}

fn shape_discord_messages(raw: Value) -> Result<String, String> {
    let Value::Array(mut items) = raw else {
        return Err("discord read failed: unexpected response".into());
    };
    items.reverse(); // Discord returns newest-first; the node wants chronological
    // indexing a non-object Value yields Null, so a null/garbage entry defaults
    // through every field exactly as the `(m ?? {})` casts did
    let str_at = |v: &Value, k: &str| v[k].as_str().unwrap_or("").to_string();
    let out: Vec<DiscordMessage> = items
        .iter()
        .map(|m| DiscordMessage {
            id: str_at(m, "id"),
            author: str_at(&m["author"], "username"),
            bot: m["author"]["bot"] == Value::Bool(true),
            content: str_at(m, "content"),
            timestamp: str_at(m, "timestamp"),
            attachments: m["attachments"].as_array().map_or_else(Vec::new, |a| {
                a.iter()
                    .map(|att| str_at(att, "url"))
                    .filter(|u| !u.is_empty())
                    .collect()
            }),
        })
        .collect();
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

fn send_discord_typing(config: &HashMap<String, String>, _msg: &str) -> Result<String, String> {
    let (token, channel) = bot_channel(config)?;
    // Discord has no cancel-typing call — the indicator expires ~10s after the
    // last trigger (or when the bot sends a message), so "off" is a no-op
    if config.get("status").map_or("on", |s| crate::interpreter::js::trim(s)) == "off" {
        return Ok("typing off (indicator expires on its own)".into());
    }
    let req = client()?
        .post(discord_channel_url(&channel, "typing"))
        .header("authorization", format!("Bot {token}"));
    send(req, "discord typing", "typing")
}

// --- telegram --------------------------------------------------------------

fn telegram_config(config: &HashMap<String, String>) -> Result<(String, String), String> {
    let token = cfg(config, "botToken");
    let chat = cfg(config, "chatId");
    if !is_telegram_token(token) {
        return Err("bot token must look like 123456:ABC…".into());
    }
    if !is_telegram_chat_id(chat) {
        return Err("chat id must be a numeric id or @channelusername".into());
    }
    Ok((token.to_string(), chat.to_string()))
}

pub(crate) fn telegram_url(token: &str, method: &str) -> Url {
    // safe to unwrap: the base is a literal, `token` passed is_telegram_token
    // (no "/", "?", "#" or "%") and `method` is a caller literal
    Url::parse(&format!("https://api.telegram.org/bot{token}/{method}"))
        .expect("fixed base + charset-checked token")
}

fn send_telegram_message(config: &HashMap<String, String>, message: &str) -> Result<String, String> {
    let (token, chat) = telegram_config(config)?;
    if crate::interpreter::js::trim(message).is_empty() {
        return Err("message is empty".into());
    }
    let client = client()?;
    if message.starts_with("data:image/") {
        let img = parse_data_image(message, TELEGRAM_UPLOAD_LIMIT)?;
        let (content_type, body) = multipart(&[("chat_id", &chat)], "photo", &img);
        let req = client
            .post(telegram_url(&token, "sendPhoto"))
            .header("content-type", content_type)
            .body(body);
        return send(req, "telegram send", "sent");
    }
    let text = clamp(message, TELEGRAM_TEXT_LIMIT);
    let req = client
        .post(telegram_url(&token, "sendMessage"))
        .json(&json!({ "chat_id": chat, "text": text }));
    send(req, "telegram send", "sent")
}

fn send_telegram_typing(config: &HashMap<String, String>, _msg: &str) -> Result<String, String> {
    let (token, chat) = telegram_config(config)?;
    // Telegram has no cancel call — the indicator expires ~5s after
    // sendChatAction (or when the bot sends a message), so "off" is a no-op
    if config.get("status").map_or("on", |s| crate::interpreter::js::trim(s)) == "off" {
        return Ok("typing off (indicator expires on its own)".into());
    }
    let req = client()?
        .post(telegram_url(&token, "sendChatAction"))
        .json(&json!({ "chat_id": chat, "action": "typing" }));
    send(req, "telegram typing", "typing")
}

// --- secret-variable sentinels ---------------------------------------------

const SENTINEL_LEN: usize = 44; // "{{var:" + 36-char uuid + "}}"

/// The uuid inside a `{{var:…}}` starting at `i`, lowercased, if the whole
/// sentinel is well-formed.
fn sentinel_at(b: &[u8], i: usize) -> Option<String> {
    let whole = b.get(i..i + SENTINEL_LEN)?;
    if !whole.starts_with(b"{{var:") || !whole.ends_with(b"}}") {
        return None;
    }
    let id = &whole[6..42];
    let mut p = 0;
    for (n, group) in [8usize, 4, 4, 4, 12].iter().enumerate() {
        if n > 0 {
            if id[p] != b'-' {
                return None;
            }
            p += 1;
        }
        if !id[p..p + group].iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        p += group;
    }
    Some(String::from_utf8_lossy(id).to_ascii_lowercase())
}

/// Rewrites every well-formed sentinel through `f`; a `None` leaves it literal.
fn replace_sentinels(text: &str, f: &mut dyn FnMut(&str) -> Option<String>) -> String {
    if !text.contains("{{var:") {
        return text.to_string();
    }
    let b = text.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if let Some(id) = sentinel_at(b, i) {
            match f(&id) {
                Some(v) => out.extend_from_slice(v.as_bytes()),
                None => out.extend_from_slice(&b[i..i + SENTINEL_LEN]),
            }
            i += SENTINEL_LEN;
        } else {
            out.push(b[i]); // ASCII pattern, so multi-byte chars copy through intact
            i += 1;
        }
    }
    String::from_utf8(out).expect("copied whole chars and whole strings")
}

/// Secret-variable sentinel substitution: variable nodes evaluate to
/// `{{var:<uuid>}}` in the graph, and the plaintext exists only past this point.
/// Unresolved sentinels (deleted variable, unknown uuid) stay literal — the
/// per-provider validators then reject them with their normal error, no oracle.
/// Runs before the senders so their SSRF checks see the substituted value.
///
/// `lookup` takes a lowercased uuid. Phase D supplies the Keychain-backed one;
/// until then every sentinel is unresolved, which is the safe direction.
pub fn substitute_variables(
    config: &HashMap<String, String>,
    message: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> (HashMap<String, String>, String) {
    let mut ids = BTreeSet::new();
    let mut collect = |id: &str| {
        ids.insert(id.to_string());
        None
    };
    for text in config.values() {
        let _ = replace_sentinels(text, &mut collect);
    }
    let _ = replace_sentinels(message, &mut collect);
    if ids.is_empty() {
        return (config.clone(), message.to_string());
    }
    // one lookup per distinct id, not per occurrence
    let values: HashMap<String, String> = ids
        .iter()
        .filter_map(|id| lookup(id).map(|v| (id.clone(), v)))
        .collect();
    let mut sub = |id: &str| values.get(id).cloned();
    (
        config
            .iter()
            .map(|(k, v)| (k.clone(), replace_sentinels(v, &mut sub)))
            .collect(),
        replace_sentinels(message, &mut sub),
    )
}

// --- entry point -----------------------------------------------------------

fn cfg<'a>(config: &'a HashMap<String, String>, key: &str) -> &'a str {
    config.get(key).map_or("", |v| crate::interpreter::js::trim(v))
}

/// Executes one integration send. `Ok` is the sender's text result (the value a
/// read-style node publishes on its output port); `Err` is a user-facing message
/// — this never panics and never throws the way the TypeScript never threw.
pub fn execute(
    provider_id: &str,
    config: &HashMap<String, String>,
    message: &str,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<String, String> {
    type Send = fn(&HashMap<String, String>, &str) -> Result<String, String>;
    let send: Send = match provider_id {
        "discord-webhook" => send_discord_webhook,
        "discord-send-message" => send_discord_message,
        "discord-read-messages" => read_discord_messages,
        "discord-typing" => send_discord_typing,
        "telegram-send-message" => send_telegram_message,
        "telegram-typing" => send_telegram_typing,
        "http-request" => |config, _| crate::http::send(config),
        _ => return Err("unknown integration".into()),
    };
    // caps run pre-substitution (a sentinel is ~44 chars); a substituted secret
    // can grow the message past the cap, but every sender truncates at its own
    // platform limit anyway
    let is_image = message.starts_with("data:image/");
    let cap = if is_image { MAX_INTEGRATION_IMAGE } else { MAX_INTEGRATION_MESSAGE };
    if utf16_prefix(message, cap).is_some() {
        return Err(if is_image {
            format!("image too large (max {MAX_INTEGRATION_IMAGE} chars)")
        } else {
            format!("message too long (max {MAX_INTEGRATION_MESSAGE} chars)")
        });
    }
    let (config, message) = substitute_variables(config, message, lookup);
    send(&config, &message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    const NO_VARS: &dyn Fn(&str) -> Option<String> = &|_| None;

    /// The whole security value of the Discord webhook sender. Host EQUALITY:
    /// a `contains("discord.com")` translation passes every case in the second
    /// list, which is a real SSRF. No socket is opened — every one of these
    /// fails validation before the client is built.
    #[test]
    fn webhook_url_allowlist_is_exact_host_and_path() {
        for ok in [
            "https://discord.com/api/webhooks/123/abc",
            "https://discordapp.com/api/webhooks/123/abc?wait=true",
        ] {
            let err = send_discord_webhook(&cfg_of(&[("webhookUrl", ok)]), "").unwrap_err();
            assert_eq!(err, "message is empty", "{ok} must pass the URL check");
        }
        for bad in [
            "https://discord.com.evil.tld/api/webhooks/1/a", // substring bypass
            "https://evil.tld/discord.com/api/webhooks/1/a",
            "https://notdiscord.com/api/webhooks/1/a",
            "https://evil.tld/api/webhooks/1/a",
            "http://discord.com/api/webhooks/1/a",  // http downgrade
            "https://discord.com/api/v10/channels", // wrong path
            "https://discord.com/api/webhooks",     // missing trailing slash
            "https://discord.com/@api/webhooks/1",
        ] {
            let err = send_discord_webhook(&cfg_of(&[("webhookUrl", bad)]), "hi").unwrap_err();
            assert!(err.starts_with("webhook url must look like"), "{bad} must be refused");
        }
        // an unparseable URL is its own error, and a path-traversal attempt in a
        // valid webhook URL is normalized by the parser, never re-aimed off-host
        assert_eq!(
            send_discord_webhook(&cfg_of(&[("webhookUrl", "not a url")]), "hi").unwrap_err(),
            "invalid webhook url"
        );
        let escaped = Url::parse("https://discord.com/api/webhooks/../../x").unwrap();
        assert_eq!(escaped.path(), "/x"); // and so fails the startsWith check
    }

    /// Both id/token checks are SSRF guards, not format validation: each value
    /// is interpolated into a URL path, so anything admitting a separator lets
    /// config re-aim the request.
    #[test]
    fn id_and_token_shapes_reject_path_injection() {
        assert!(is_snowflake("12345678901234567"));   // 17
        assert!(is_snowflake("12345678901234567890")); // 20
        for bad in [
            "1234567890123456",      // 16
            "123456789012345678901", // 21
            "123/456/../../guilds",
            "1234567890123456789?x",
            "1234567890123456789#",
            "1234567890123456789%2f",
            "1234567890123456 ",
            "abcdefghijklmnopq",
            "",
        ] {
            assert!(!is_snowflake(bad), "{bad:?} must be refused");
        }

        assert!(is_telegram_token("123456:ABCDEFGHIJKLMNOPQRSTUVWXY")); // 25 after colon
        assert!(is_telegram_token("1:aA0_-aA0_-aA0_-aA0_-aA0_-")); // "-" is in the class
        for bad in [
            "123456:short",
            "123456:ABCDEFGHIJKLMNOPQRSTUVWX",  // 24
            "123456:AAAA/../bot999999:BBBBBBBBBBBBBBBBBBBBBBBBB", // path escape
            "123456:AAAAAAAAAAAAAAAAAAAAAAAA?", // query
            "123456:AAAAAAAAAAAAAAAAAAAAAAAA%2f",
            "123456:AAAAAAAAAAAAAAAAAAAAAAAA#",
            "123456:AAAAAAAAAAAAAAAAAAAAAAAA.",
            "abc:ABCDEFGHIJKLMNOPQRSTUVWXY",
            "123456789012345678901:ABCDEFGHIJKLMNOPQRSTUVWXY", // 21 digits
            "ABCDEFGHIJKLMNOPQRSTUVWXY",
            "",
        ] {
            assert!(!is_telegram_token(bad), "{bad:?} must be refused");
        }

        for ok in ["1", "-1001234567890", "@channelname", "@a_bcde", "99999999999999999999"] {
            assert!(is_telegram_chat_id(ok), "{ok:?} must pass");
        }
        for bad in ["", "-", "@abcd", "@abcdefghijklmnopqrstuvwxyz1234567", "@bad-name", "12 34", "1/2", "abc"] {
            assert!(!is_telegram_chat_id(bad), "{bad:?} must be refused");
        }

        // and the guards are actually wired into the senders, before any socket
        assert_eq!(
            send_discord_message(&cfg_of(&[("botToken", "t"), ("channelId", "1/2")]), "hi").unwrap_err(),
            "channel id must be a numeric id"
        );
        assert_eq!(
            send_discord_message(&cfg_of(&[("channelId", "12345678901234567")]), "hi").unwrap_err(),
            "bot token is empty"
        );
        assert_eq!(
            send_telegram_message(&cfg_of(&[("botToken", "x"), ("chatId", "1")]), "hi").unwrap_err(),
            "bot token must look like 123456:ABC…"
        );
        assert_eq!(
            send_telegram_typing(&cfg_of(&[
                ("botToken", "1:aA0_-aA0_-aA0_-aA0_-aA0_-"),
                ("chatId", "@bad-name"),
            ]), "").unwrap_err(),
            "chat id must be a numeric id or @channelusername"
        );
    }

    /// The fixed bases stay fixed once the shape checks have passed.
    #[test]
    fn urls_are_built_on_fixed_bases() {
        let u = discord_channel_url("12345678901234567", "typing");
        assert_eq!(u.as_str(), "https://discord.com/api/v10/channels/12345678901234567/typing");
        let t = telegram_url("123456:ABCDEFGHIJKLMNOPQRSTUVWXY", "sendMessage");
        assert_eq!(t.as_str(), "https://api.telegram.org/bot123456:ABCDEFGHIJKLMNOPQRSTUVWXY/sendMessage");
        assert_eq!(t.host_str(), Some("api.telegram.org"));
    }

    #[test]
    fn typing_off_is_a_local_no_op() {
        let discord = cfg_of(&[("botToken", "t"), ("channelId", "12345678901234567"), ("status", " off ")]);
        assert_eq!(send_discord_typing(&discord, "").unwrap(), "typing off (indicator expires on its own)");
        let telegram = cfg_of(&[
            ("botToken", "123456:ABCDEFGHIJKLMNOPQRSTUVWXY"),
            ("chatId", "-1001234567890"),
            ("status", "off"),
        ]);
        assert_eq!(send_telegram_typing(&telegram, "").unwrap(), "typing off (indicator expires on its own)");
    }

    #[test]
    fn message_caps_and_truncation() {
        // executeIntegration's pre-send caps
        let long = "x".repeat(MAX_INTEGRATION_MESSAGE + 1);
        assert_eq!(
            execute("telegram-typing", &HashMap::new(), &long, NO_VARS).unwrap_err(),
            "message too long (max 4096 chars)"
        );
        let img = format!("data:image/png;base64,{}", "A".repeat(MAX_INTEGRATION_IMAGE));
        assert_eq!(
            execute("discord-webhook", &HashMap::new(), &img, NO_VARS).unwrap_err(),
            "image too large (max 4194304 chars)"
        );
        assert_eq!(execute("nope", &HashMap::new(), "hi", NO_VARS).unwrap_err(), "unknown integration");

        // per-platform truncation: slice(0, limit-1) + "…", counted in UTF-16
        assert_eq!(clamp("hello", 2000), "hello");
        assert_eq!(clamp(&"x".repeat(2000), 2000), "x".repeat(2000));
        let over = clamp(&"x".repeat(2001), 2000);
        assert_eq!(over.encode_utf16().count(), 2000);
        assert!(over.ends_with('…'));
        // an astral char is 2 UTF-16 units, so a byte- or char-indexed cut differs
        assert_eq!(clamp(&"🙂".repeat(3), 4), "🙂\u{fffd}…");
    }

    #[test]
    fn data_image_parsing() {
        let img = parse_data_image("data:image/png;base64,aGk=", DISCORD_UPLOAD_LIMIT).unwrap();
        assert_eq!(img.bytes, b"hi");
        assert_eq!((img.mime.as_str(), img.ext.as_str()), ("image/png", "png"));
        assert_eq!(parse_data_image("data:image/svg+xml;base64,aGk=", 99).unwrap().ext, "svg");
        assert_eq!(
            parse_data_image("data:image/png,notbase64", 99).unwrap_err(),
            "unsupported image encoding (expected base64)"
        );
        assert_eq!(parse_data_image("data:image/png;base64,", 99).unwrap_err(), "image data is empty");
        assert_eq!(
            parse_data_image("data:image/png;base64,aGVsbG8=", 3).unwrap_err(),
            "image too large (max 3 bytes)"
        );
        // Node's decoder is lenient: junk and missing padding never throw
        assert_eq!(base64_decode("aGVsbG8"), b"hello");
        assert_eq!(base64_decode("a G\nV s bG8="), b"hello");
        assert_eq!(base64_decode("+/A="), base64_decode("-_A="));

        // mime and filename are echoed into multipart headers — a header break
        // or a quote in either would forge a part
        let evil = parse_data_image("data:image/p\r\nX: y;base64,aGk=", 99).unwrap();
        assert_eq!(evil.mime, "application/octet-stream"); // unparseable type -> Blob's fallback
        assert_eq!(evil.ext, "pxy"); // separators stripped, not carried into the header
        let (ct, body) = multipart(&[("chat_id", "-100")], "photo", &evil);
        let text = String::from_utf8_lossy(&body);
        assert!(ct.starts_with("multipart/form-data; boundary=----saturn"));
        assert!(!text.contains("X: y")); // no forged header, no forged part
        assert!(text.contains("filename=\"image.pxy\"\r\nContent-Type: application/octet-stream"));
        assert!(text.contains("name=\"chat_id\"\r\n\r\n-100\r\n"));
        assert!(!parse_data_image("data:image/\"a;base64,aGk=", 99).unwrap().ext.contains('"'));
    }

    #[test]
    fn discord_read_shaping() {
        // newest-first in, chronological out, with only the fields the node needs
        let raw = json!([
            { "id": "2", "content": "second", "timestamp": "t2",
              "author": { "username": "bob", "bot": true },
              "attachments": [{ "url": "https://cdn/x.png" }, { "nope": 1 }] },
            { "id": "1", "content": "first", "timestamp": "t1", "author": { "username": "amy" } },
            null,
        ]);
        let text = shape_discord_messages(raw).unwrap();
        // key order is part of the value the node publishes — JSON.stringify
        // emitted declaration order, and an alphabetizing map would not
        assert!(text.starts_with(r#"[{"id":"","author":"","bot":false,"content":"","#));
        let out: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(out[0]["id"], ""); // the null entry, defaulted throughout
        assert_eq!(out[1]["content"], "first");
        assert_eq!(out[1]["author"], "amy");
        assert_eq!(out[1]["bot"], false);
        assert_eq!(out[2]["bot"], true);
        assert_eq!(out[2]["attachments"], json!(["https://cdn/x.png"]));
        assert_eq!(
            shape_discord_messages(json!({ "message": "401: Unauthorized" })).unwrap_err(),
            "discord read failed: unexpected response"
        );
    }

    /// The wire half, driven against loopback — the senders themselves are
    /// pinned to discord.com / api.telegram.org and must never be reached, so
    /// this exercises the shared POST through the one function that takes a URL.
    #[test]
    fn posts_a_message_and_reports_failures() {
        // the error body is kept to 200 chars, so make it longer than that
        let long: &'static str = Box::leak(
            format!(
                "HTTP/1.1 401 Unauthorized\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}{}",
                12 + 300,
                "{\"message\":\"",
                "y".repeat(300)
            )
            .into_boxed_str(),
        );
        let port = crate::http::spawn_test_server(vec![
            "HTTP/1.1 204 No Content\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            long,
            "HTTP/1.1 500 Oops\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        ]);
        let url = |p: &str| Url::parse(&format!("http://127.0.0.1:{port}{p}")).unwrap();

        assert_eq!(post_discord_message(url("/a"), None, "hi", "discord webhook").unwrap(), "sent");
        assert_eq!(
            post_discord_message(url("/b"), Some("tok"), "hi", "discord send").unwrap_err(),
            format!("discord send failed (401): {{\"message\":\"{}", "y".repeat(188))
        );
        // no body -> no ": " suffix
        assert_eq!(
            post_discord_message(url("/c"), None, "hi", "discord webhook").unwrap_err(),
            "discord webhook failed (500)"
        );
        // empty message never opens a socket at all
        assert_eq!(post_discord_message(url("/d"), None, "  ", "x").unwrap_err(), "message is empty");
        // a dead port is a value error, not a panic
        assert!(post_discord_message(Url::parse("http://127.0.0.1:1/x").unwrap(), None, "hi", "discord send")
            .unwrap_err()
            .starts_with("discord send failed:"));
    }

    #[test]
    fn variable_sentinels_substitute_only_when_resolved() {
        let id = "0f2a1c3d-4e5b-6a7b-8c9d-0e1f2a3b4c5d";
        let config = cfg_of(&[
            ("botToken", &format!("{{{{var:{}}}}}", id.to_uppercase())), // case-insensitive
            ("chatId", "{{var:ffffffff-ffff-ffff-ffff-ffffffffffff}}"),  // unknown -> literal
            ("note", "no sentinel héré"),
            ("broken", "{{var:not-a-uuid}} {{var:0f2a1c3d-4e5b-6a7b-8c9d-0e1f2a3b4c5}}"),
        ]);
        let seen = std::cell::RefCell::new(Vec::new());
        let (out, msg) = substitute_variables(&config, &format!("say {{{{var:{id}}}}}"), &|q| {
            seen.borrow_mut().push(q.to_string());
            (q == id).then(|| "SECRET".to_string())
        });
        assert_eq!(out["botToken"], "SECRET");
        assert_eq!(msg, "say SECRET");
        assert_eq!(out["chatId"], "{{var:ffffffff-ffff-ffff-ffff-ffffffffffff}}");
        assert_eq!(out["note"], "no sentinel héré");
        assert_eq!(out["broken"], config["broken"]); // malformed stays untouched
        let mut seen = seen.into_inner();
        seen.sort();
        seen.dedup();
        assert_eq!(seen, vec![id.to_string(), "ffffffff-ffff-ffff-ffff-ffffffffffff".to_string()]);

        // no sentinel anywhere -> the lookup is never called
        let (same, m) = substitute_variables(&cfg_of(&[("a", "b")]), "plain", &|_| {
            panic!("must not look anything up")
        });
        assert_eq!((same["a"].as_str(), m.as_str()), ("b", "plain"));

        // the point of all this: substitution runs BEFORE the SSRF checks, so a
        // variable-fed token is validated as its plaintext, and an unresolved
        // one is rejected by the normal validator rather than sent literally
        let vars = cfg_of(&[("botToken", &format!("{{{{var:{id}}}}}")), ("chatId", "1")]);
        assert_eq!(
            execute("telegram-typing", &vars, "", &|_| Some("nope".into())).unwrap_err(),
            "bot token must look like 123456:ABC…"
        );
        assert_eq!(
            execute("telegram-typing", &vars, "", NO_VARS).unwrap_err(),
            "bot token must look like 123456:ABC…"
        );
        let good = execute("telegram-typing", &cfg_of(&[
            ("botToken", &format!("{{{{var:{id}}}}}")),
            ("chatId", "1"),
            ("status", "off"),
        ]), "", &|_| Some("123456:ABCDEFGHIJKLMNOPQRSTUVWXY".into()));
        assert_eq!(good.unwrap(), "typing off (indicator expires on its own)");
    }
}
