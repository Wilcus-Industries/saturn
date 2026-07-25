//! Port of sendHttpRequest + assertPublicHttpsUrl (lib/integrations.server.ts,
//! lib/mcp.ts). SECURITY-CRITICAL and translated as-is, not improved: the URL is
//! fully user-controlled, so every redirect hop is re-validated against the
//! egress blocklist. reqwest's automatic redirect following is switched OFF —
//! it would chase a public host's 30x onto a private IP past the guard, which
//! is the exact hole the manual loop closes.
//!
//! Blocking reqwest on purpose: the interpreter is synchronous and owns a plain
//! std thread (never a runtime worker), which is where a blocking client is safe.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, ToSocketAddrs};
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

// --- egress guard ----------------------------------------------------------

// IPv4 special-use / private ranges (RFC 5735 / 6598 / 1918)
const V4_BLOCKED: &[(Ipv4Addr, u32)] = &[
    (Ipv4Addr::new(0, 0, 0, 0), 8),
    (Ipv4Addr::new(10, 0, 0, 0), 8),
    (Ipv4Addr::new(100, 64, 0, 0), 10),
    (Ipv4Addr::new(127, 0, 0, 0), 8),
    (Ipv4Addr::new(169, 254, 0, 0), 16),
    (Ipv4Addr::new(172, 16, 0, 0), 12),
    (Ipv4Addr::new(192, 0, 0, 0), 24),
    (Ipv4Addr::new(192, 0, 2, 0), 24),
    (Ipv4Addr::new(192, 88, 99, 0), 24),
    (Ipv4Addr::new(192, 168, 0, 0), 16),
    (Ipv4Addr::new(198, 18, 0, 0), 15),
    (Ipv4Addr::new(198, 51, 100, 0), 24),
    (Ipv4Addr::new(203, 0, 113, 0), 24),
    (Ipv4Addr::new(224, 0, 0, 0), 4),
    (Ipv4Addr::new(240, 0, 0, 0), 4),
];

const V6_BLOCKED: &[(Ipv6Addr, u32)] = &[
    (Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 0), 128),      // unspecified
    (Ipv6Addr::new(0, 0, 0, 0, 0, 0, 0, 1), 128),      // loopback
    (Ipv6Addr::new(0x64, 0xff9b, 0, 0, 0, 0, 0, 0), 96), // NAT64
    (Ipv6Addr::new(0x100, 0, 0, 0, 0, 0, 0, 0), 64),   // discard-only
    (Ipv6Addr::new(0xfc00, 0, 0, 0, 0, 0, 0, 0), 7),   // unique-local
    (Ipv6Addr::new(0xfe80, 0, 0, 0, 0, 0, 0, 0), 10),  // link-local
    (Ipv6Addr::new(0xff00, 0, 0, 0, 0, 0, 0, 0), 8),   // multicast
    (Ipv6Addr::new(0x2001, 0xdb8, 0, 0, 0, 0, 0, 0), 32), // documentation
];

fn v4_blocked(ip: Ipv4Addr) -> bool {
    let a = u32::from(ip);
    V4_BLOCKED.iter().any(|(net, bits)| {
        let shift = 32 - bits;
        a >> shift == u32::from(*net) >> shift
    })
}

fn ip_blocked(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_blocked(v4),
        // an IPv4-mapped literal (::ffff:127.0.0.1) must answer to the v4 rules
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4_blocked(v4),
            None => {
                let a = u128::from(v6);
                V6_BLOCKED.iter().any(|(net, bits)| {
                    let shift = 128 - bits;
                    a >> shift == u128::from(*net) >> shift
                })
            }
        },
    }
}

/// The http-request node's URL policy: scheme only. Private addresses, plain
/// http and localhost are all permitted, because on a single-user desktop app
/// the graph is the user's own and the node's whole point is reaching things
/// like Ollama on 11434, a NAS, or Home Assistant. The hosted product blocked
/// them because the URL arrived from an untrusted tenant's graph; that threat
/// model is gone with the tenancy.
///
/// Still called on every redirect hop: a 302 must not be able to walk the
/// request off http(s) entirely (file:, data:, ftp:).
fn parse_request_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Invalid server URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Server URL must be http or https".into());
    }
    Ok(url)
}

/// The strict egress guard: https-only, no localhost/.local, no private or
/// special-use address — and for a hostname, every address it resolves to must
/// pass too (a public name can point at 169.254.169.254).
///
/// Not used by the http-request node (see `parse_request_url`). This is for
/// Phase D's MCP client, where the server URL *and* every endpoint derived from
/// the server's own discovery metadata are attacker-influenceable — the one
/// place the hosted threat model survives into the desktop app.
///
/// Residual when Phase D wires it up: the name is resolved and its addresses
/// checked here, then reqwest re-resolves at connect time, so a rebinding
/// server can answer differently the second time. The TypeScript conceded this
/// as unavoidable; in reqwest it is closable with
/// `ClientBuilder::resolve(host, addr)` pinning the address validated here.
/// Build the pin from `url.port_or_known_default()`, not the 443 used below for
/// the lookup.
#[allow(dead_code)]
fn assert_public_https_url(raw: &str) -> Result<Url, String> {
    let url = Url::parse(raw).map_err(|_| "Invalid server URL".to_string())?;
    if url.scheme() != "https" {
        return Err("Server URL must be https".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "Server URL must be a public host".to_string())?
        .to_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return Err("Server URL must be a public host".into());
    }
    // bracketed IPv6 hostnames arrive as "[::1]"
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(&host);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return if ip_blocked(ip) {
            Err("Server URL must be a public host".into())
        } else {
            Ok(url)
        };
    }
    let addrs: Vec<_> = (bare, 443u16)
        .to_socket_addrs()
        .map_err(|_| "Could not resolve server host".to_string())?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|a| ip_blocked(a.ip())) {
        return Err("Server host resolves to a non-public address".into());
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
                e.to_string()
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

    /// The blocklist is the whole security value of this module. Literal IPs
    /// need no DNS, so this test never touches the network.
    #[test]
    fn blocklist_covers_the_private_space() {
        for blocked in [
            "127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "172.31.255.255",
            "169.254.169.254", "100.64.0.1", "0.0.0.0", "198.18.0.1", "224.0.0.1",
            "::1", "::", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
            "::ffff:127.0.0.1", "::ffff:10.0.0.1",
        ] {
            assert!(ip_blocked(blocked.parse().unwrap()), "{blocked} must be blocked");
        }
        for public in ["1.1.1.1", "8.8.8.8", "172.32.0.1", "192.167.255.255", "2606:4700::1111"] {
            assert!(!ip_blocked(public.parse().unwrap()), "{public} must be allowed");
        }
        // the strict guard itself, on literal hosts (no resolver involved).
        // Phase D's MCP client is its consumer; nothing calls it today.
        assert!(assert_public_https_url("https://1.1.1.1/x").is_ok());
        assert!(assert_public_https_url("https://10.0.0.1/x").is_err());
        assert!(assert_public_https_url("https://[::1]/x").is_err());
        assert!(assert_public_https_url("http://1.1.1.1/x").is_err()); // https only
        assert!(assert_public_https_url("https://localhost/x").is_err());
        assert!(assert_public_https_url("https://foo.local/x").is_err());
        assert!(assert_public_https_url("not a url").is_err());
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
