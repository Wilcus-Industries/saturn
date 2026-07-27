//! Port of sendHttpRequest (lib/integrations.server.ts). The URL policy is
//! scheme-only — `parse_request_url`, shared with the MCP client — because on a
//! single-user desktop app every URL in play is the user's own and reaching
//! Ollama, a NAS or an MCP server on 127.0.0.1 is the point. The egress
//! blocklist the hosted product carried is gone with the tenancy.
//!
//! reqwest's automatic redirect following is still switched OFF: a 30x must not
//! be able to walk a request off http(s) entirely, so every hop is re-parsed.
//!
//! Blocking reqwest on purpose: the interpreter is synchronous and owns a plain
//! std thread (never a runtime worker), which is where a blocking client is safe.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::time::{Duration, Instant};

use reqwest::blocking::Client;
use reqwest::{redirect, Method, Url};
use serde_json::Value;

use crate::interpreter::{js, utf16_prefix};

const HTTP_METHODS: [&str; 5] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX_URL: usize = 2048;
const MAX_HEADERS: usize = 20;
const MAX_HEADER_VALUE: usize = 2048;
const MAX_REQUEST_BODY: usize = 65_536;
const MAX_REDIRECTS: usize = 5;
const MAX_RESPONSE_BYTES: u64 = 1_048_576; // 1 MiB read cap
const MAX_RESULT_BODY: usize = 16_384; // chars of raw body kept in the result
const TOTAL_DEADLINE: Duration = Duration::from_secs(20);
const SEND_TIMEOUT: Duration = Duration::from_secs(15);
// hop-by-hop / length headers the client owns — a caller must not set them
const FORBIDDEN_HEADERS: [&str; 7] = [
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "upgrade",
    "expect",
    "accept-encoding",
];
const REDIRECT_STATUS: [u16; 5] = [301, 302, 303, 307, 308];

/// The URL policy for the http-request node **and** the MCP client: scheme
/// only. Private addresses, plain http and localhost are all permitted, because
/// on a single-user desktop app every URL in play is the user's own — the node
/// exists to reach Ollama on 11434, a NAS or Home Assistant, and an MCP server
/// is just as often a CLI serving `http://127.0.0.1:8765/mcp`. The hosted
/// product blocked them because the URL arrived from an untrusted tenant; that
/// threat model is gone with the tenancy (`docs/open-decisions.md` §1.3).
///
/// Called on every redirect hop: a 302 must not be able to walk the request off
/// http(s) entirely (file:, data:, ftp:).
pub(crate) fn parse_request_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Invalid server URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Server URL must be http or https".into());
    }
    Ok(url)
}

// --- headers ---------------------------------------------------------------

// mirrors /^[a-z0-9!#$%&'*+.^_`|~-]{1,64}$/i — a non-ASCII name fails the
// charset test anyway, so counting bytes for the length is safe
fn valid_header_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b))
}

/// Parses the headers textarea into lowercased keys. Lowercasing collapses
/// case-insensitive header names, making the forbidden-strip and the
/// "user's value wins over defaults" checks trivial.
fn parse_headers(raw: &str) -> Result<BTreeMap<String, String>, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(BTreeMap::new());
    }
    let parsed: Value =
        serde_json::from_str(trimmed).map_err(|_| "headers must be a JSON object".to_string())?;
    let obj = parsed
        .as_object()
        .ok_or_else(|| "headers must be a JSON object".to_string())?;
    if obj.len() > MAX_HEADERS {
        return Err(format!("too many headers (max {MAX_HEADERS})"));
    }
    let mut out = BTreeMap::new();
    for (name, value) in obj {
        let value = value
            .as_str()
            .ok_or_else(|| format!("header \"{name}\" must be a string"))?;
        if !valid_header_name(name) {
            return Err(format!("invalid header name \"{name}\""));
        }
        if value.encode_utf16().count() > MAX_HEADER_VALUE {
            return Err(format!("header \"{name}\" value is too long"));
        }
        if value.contains(['\r', '\n']) {
            return Err(format!("header \"{name}\" value has a line break"));
        }
        let lower = name.to_lowercase();
        if FORBIDDEN_HEADERS.contains(&lower.as_str()) {
            continue; // the client controls these
        }
        out.insert(lower, value.to_string());
    }
    Ok(out)
}

// --- the sender ------------------------------------------------------------

/// A transport failure, rendered WITHOUT the request URL.
///
/// `reqwest::Error`'s Display appends ` for url (<full url>)`; `fetch` in the
/// TypeScript threw a bare "fetch failed". That difference is a secret leak, not
/// cosmetics: every one of these strings ends up in `workflow_run.error` and the
/// persisted `workflow_run.log`, and the URL routinely carries a secret — a
/// Telegram bot token rides in the path, and `{{var:…}}` substitutes plaintext
/// into an http node's query string before the request is built. Every
/// `req.send()` in this crate goes through here.
pub fn net_error(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

/// One outbound HTTP request. Non-2xx responses are data (the user branches on
/// `status` with an if node), not errors. Never panics; errors come back as
/// values so the console and the run log can render them.
pub fn send(config: &HashMap<String, String>) -> Result<String, String> {
    send_inner(config).map_err(|e| format!("http request: {e}"))
}

fn send_inner(config: &HashMap<String, String>) -> Result<String, String> {
    let get = |k: &str| config.get(k).map(String::as_str).unwrap_or("");

    let method = match get("method").trim() {
        "" => "GET".to_string(),
        m => m.to_uppercase(),
    };
    if !HTTP_METHODS.contains(&method.as_str()) {
        return Err(format!("unsupported method \"{method}\""));
    }
    let start_url = get("url").trim();
    if start_url.is_empty() {
        return Err("url is empty".into());
    }
    if start_url.encode_utf16().count() > MAX_URL {
        return Err("url is too long".into());
    }
    let mut headers = parse_headers(get("headers"))?;

    // body rides non-GET requests only; a GET body is silently dropped
    let mut body: Option<String> = None;
    if method != "GET" {
        let raw = get("body");
        if raw.encode_utf16().count() > MAX_REQUEST_BODY {
            return Err("body is too large".into());
        }
        if !raw.is_empty() {
            headers
                .entry("content-type".into())
                .or_insert_with(|| "application/json".into());
            body = Some(raw.to_string());
        }
    }
    // defaults sit UNDER the user's headers (theirs already occupy the key)
    headers.entry("accept".into()).or_insert_with(|| "*/*".into());
    headers
        .entry("user-agent".into())
        .or_insert_with(|| "saturn-workflow/1.0".into());

    let client = Client::builder()
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;

    let deadline = Instant::now() + TOTAL_DEADLINE;
    let mut current = start_url.to_string();
    let mut cur_method = method;
    let mut cur_body = body;
    let mut response = None;
    for hop in 0..=MAX_REDIRECTS {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("timed out".into());
        }
        let url = parse_request_url(&current)?;
        let verb = Method::from_bytes(cur_method.as_bytes()).map_err(|_| "unsupported method")?;
        let mut req = client
            .request(verb, url.clone())
            .timeout(remaining.min(SEND_TIMEOUT));
        for (name, value) in &headers {
            req = req.header(name.as_str(), value.as_str());
        }
        if let Some(b) = cur_body.as_ref().filter(|_| cur_method != "GET") {
            req = req.body(b.clone());
        }
        let res = req.send().map_err(|e| {
            if e.is_timeout() {
                "timed out".to_string()
            } else {
                net_error(e)
            }
        })?;

        let status = res.status().as_u16();
        if !REDIRECT_STATUS.contains(&status) {
            response = Some(res);
            break;
        }
        let location = res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let Some(location) = location else {
            response = Some(res); // a 30x without Location is just the response
            break;
        };
        if hop == MAX_REDIRECTS {
            return Err("too many redirects".into());
        }
        let next = url
            .join(&location)
            .map_err(|_| "invalid redirect location".to_string())?;
        // credentials never follow a cross-origin redirect (mirrors the fetch
        // spec's Authorization strip — a service must not be able to 30x a
        // wired bearer token onto a foreign host)
        if next.origin() != url.origin() {
            headers.remove("authorization");
            headers.remove("cookie");
        }
        current = next.to_string();
        // 301/302/303 downgrade the method to GET and drop the request body
        if matches!(status, 301 | 302 | 303) {
            cur_method = "GET".into();
            cur_body = None;
            headers.remove("content-type");
        }
    }
    let Some(mut res) = response else {
        return Err("no response".into()); // unreachable — the loop always sets it
    };

    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // read capped at 1 MiB so a huge body cannot exhaust memory
    let mut buf = Vec::new();
    let mut truncated = false;
    (&mut res)
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() as u64 > MAX_RESPONSE_BYTES {
        buf.truncate(MAX_RESPONSE_BYTES as usize);
        truncated = true;
    }
    let text = String::from_utf8_lossy(&buf).into_owned();

    // embed a parsed JSON body when whole (single-extract UX), else raw text.
    // js::J, not serde_json::Value: without the `preserve_order` feature the
    // latter's Map is a BTreeMap, so a response body's keys would come back out
    // alphabetized — and this string is the node's `response` value output.
    let mut out_body = None;
    if content_type.to_lowercase().contains("json") && !truncated {
        match js::parse(&text) {
            Ok(parsed @ (js::J::O(_) | js::J::A(_))) => out_body = Some(parsed),
            _ => {}
        }
    }
    let out_body = out_body.unwrap_or_else(|| match utf16_prefix(&text, MAX_RESULT_BODY) {
        Some(cut) => {
            truncated = true;
            js::J::S(cut)
        }
        None => js::J::S(text),
    });

    // key order is JSON.stringify's, i.e. the order they are written here
    let mut obj = vec![
        ("status".to_string(), js::J::S(status.to_string())),
        ("contentType".to_string(), js::J::S(content_type)),
        ("body".to_string(), out_body),
    ];
    if truncated {
        obj.push(("truncated".to_string(), js::J::S("true".into())));
    }
    Ok(js::stringify(&js::J::O(obj)))
}

/// Serves `responses` verbatim to that many successive connections on loopback,
/// then exits. Tests only — the sender must never touch the real network.
#[cfg(test)]
pub fn spawn_test_server(responses: Vec<&'static str>) -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        use std::io::Write;
        for body in responses {
            let Ok((mut sock, _)) = listener.accept() else { return };
            // drain the request head so the client never sees a reset
            let mut seen = Vec::new();
            let mut byte = [0u8; 1];
            while sock.read(&mut byte).unwrap_or(0) == 1 {
                seen.push(byte[0]);
                if seen.ends_with(b"\r\n\r\n") {
                    break;
                }
            }
            let _ = sock.write_all(body.as_bytes());
            let _ = sock.flush();
        }
    });
    port
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    /// The http-request node reaches the local network on purpose, so the only
    /// thing its URL policy still refuses is a non-http scheme — including on a
    /// redirect hop, which is the case that matters.
    #[test]
    fn request_urls_are_scheme_checked_and_otherwise_local_friendly() {
        for ok in [
            "http://localhost:11434/api/generate", // ollama
            "http://192.168.1.50/",                // NAS
            "https://homeassistant.local:8123/",
            "http://127.0.0.1:3000/x",
            "https://example.com/x",
        ] {
            assert!(parse_request_url(ok).is_ok(), "{ok} must be allowed");
        }
        for bad in ["file:///etc/passwd", "ftp://example.com/x", "data:text/plain,hi", "not a url"] {
            assert!(parse_request_url(bad).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn rejects_bad_config_before_any_socket() {
        assert!(send(&cfg(&[("url", "https://example.com"), ("method", "TRACE")]))
            .unwrap_err()
            .contains("unsupported method \"TRACE\""));
        assert!(send(&cfg(&[("url", "")])).unwrap_err().contains("url is empty"));
        assert!(send(&cfg(&[("url", "https://x.test"), ("headers", "[]")]))
            .unwrap_err()
            .contains("headers must be a JSON object"));
        assert!(parse_headers(r#"{"x-a":"a\r\nb"}"#).unwrap_err().contains("line break"));
        assert!(parse_headers(r#"{"bad name":"v"}"#).unwrap_err().contains("invalid header name"));
        // fetch owns these; they are dropped, not rejected
        assert!(parse_headers(r#"{"Host":"evil","X-Ok":"1"}"#).unwrap().get("host").is_none());
        assert_eq!(parse_headers(r#"{"X-Ok":"1"}"#).unwrap()["x-ok"], "1");
    }

    #[test]
    fn reads_a_json_response() {
        let port = spawn_test_server(vec![concat!(
            "HTTP/1.1 201 Created\r\n",
            "content-type: application/json\r\n",
            "content-length: 18\r\n",
            "connection: close\r\n\r\n",
            "{\"z\":1e3,\"a\":\"hi\"}"
        )]);
        let out = send(&cfg(&[("url", &format!("http://127.0.0.1:{port}/"))])).unwrap();
        // This whole string is the node's `response` value output, so its key
        // order and its number rendering are observable: JSON.stringify emitted
        // declaration order and `1000`, a serde_json::Map would alphabetize both
        // levels and ryu would write `1000.0`.
        assert_eq!(
            out,
            r#"{"status":"201","contentType":"application/json","body":{"z":1000,"a":"hi"}}"#
        );
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["body"]["a"], "hi"); // parsed, not a raw string
        assert!(v.get("truncated").is_none());
    }

    /// The reason the redirect loop is hand-driven: hop 2 must be re-validated.
    /// reqwest's own follower would have fetched 10.0.0.1 here.
    #[test]
    fn redirect_hops_are_revalidated() {
        let port = spawn_test_server(vec![concat!(
            "HTTP/1.1 302 Found\r\n",
            "location: file:///etc/passwd\r\n",
            "content-length: 0\r\n",
            "connection: close\r\n\r\n"
        )]);
        let err = send(&cfg(&[("url", &format!("http://127.0.0.1:{port}/"))])).unwrap_err();
        assert_eq!(err, "http request: Server URL must be http or https");
    }

    /// A transport failure must not echo the request URL back into the run log:
    /// `{{var:…}}` substitutes plaintext into the url field before the request
    /// is built, so reqwest's default Display would persist the user's API key
    /// in `workflow_run.error`. Guards `net_error` at every send site.
    #[test]
    fn a_failed_request_never_echoes_the_url() {
        // bind then drop -> a port with nothing listening (connection refused)
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/v1?api_key=sk-SUPER-SECRET");
        let err = send(&cfg(&[("url", &url)])).unwrap_err();
        assert!(!err.contains("sk-SUPER-SECRET"), "the run log leaked the url: {err}");
        assert!(!err.contains(&url), "{err}");
    }

    /// A relative Location still resolves against the current hop, and the
    /// second hop is a normal request.
    #[test]
    fn follows_a_same_origin_redirect() {
        let port = spawn_test_server(vec![
            "HTTP/1.1 301 Moved\r\nlocation: /next\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 5\r\nconnection: close\r\n\r\nfinal",
        ]);
        let out = send(&cfg(&[("url", &format!("http://127.0.0.1:{port}/start"))])).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["status"], "200");
        assert_eq!(v["body"], "final");
    }
}

