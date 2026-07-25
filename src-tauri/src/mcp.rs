//! Port of lib/mcp.ts — the MCP Streamable-HTTP client (tool discovery, tool
//! calls) plus the OAuth 2.1 flow MCP servers use: protected-resource metadata
//! → authorization-server metadata → dynamic client registration → PKCE
//! authorization code.
//!
//! SECURITY-CRITICAL and translated as-is, not improved. The threat model that
//! justified every guard survives the desktop pivot intact: the server URL is
//! the user's own, but *everything the server hands back* — authorization_servers,
//! the authorization/token/registration endpoints, the PRM resource URL — is the
//! server's, i.e. attacker-controlled. A hostile MCP server answering
//! `"token_endpoint": "https://169.254.169.254/…"` must not get a request.
//!
//! So this file has exactly ONE fetch site, `send_guarded`, and it calls
//! `assert_public_https_url` on the start URL and again on every redirect hop.
//! Adding a second fetch site is how the guard gets skipped; don't.
//!
//! Two things are stronger here than in the TypeScript, both deliberate and both
//! required by the same invariant the guard exists for:
//!   - node's fetch followed redirects itself, so a public host could 30x the
//!     request onto a private address *past* the guard. Redirects are followed
//!     manually here and re-validated, exactly as `http.rs::send` does.
//!   - node resolved the host, checked the addresses, then handed the URL to
//!     fetch, which resolved again — a rebinding server can answer differently
//!     the second time. `ClientBuilder::resolve` pins the address that was
//!     checked, closing the window node conceded.
//!
//! Nothing here logs. An access token, a refresh token, an authorization code
//! and a PKCE verifier all pass through this module; `TokenSet` deliberately
//! does not derive Debug so it cannot be formatted into a log line by accident.
//!
//! Blocking reqwest for the same reason as `http.rs` and `integrations.rs`: the
//! interpreter is synchronous and each run owns a plain std thread.

use std::collections::{BTreeMap, HashSet};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, ToSocketAddrs};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use reqwest::blocking::{Client, Response};
use reqwest::{redirect, Method, Url};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::http::{assert_public_https_url, ip_blocked};
use crate::interpreter::{js, utf16_prefix};

/// MCP revision this client speaks; sent as `mcp-protocol-version` and in the
/// initialize params. Servers negotiate down, so a fixed value is fine.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// `AbortSignal.timeout(15_000)` in the TypeScript — a *total* deadline per
/// logical request, so an MCP server that streams forever cannot hang a run.
/// Here it covers every redirect hop of one request together.
const TIMEOUT: Duration = Duration::from_secs(15);
/// Mirrors `http.rs`: node's fetch allowed 20 hops, but each hop is a fresh
/// SSRF decision and five is already more than any real server needs.
const MAX_REDIRECTS: usize = 5;
/// Read cap so an endless response body cannot exhaust memory. Larger than
/// `http.rs`'s 1 MiB because a legitimate `tools/list` page carrying 100+ JSON
/// Schemas is genuinely big — the cap only has to stop an infinite stream.
const MAX_RESPONSE_BYTES: u64 = 4_194_304;

/// Bound on the params a tool node exposes. Tool schemas are arbitrary JSON from
/// a third-party server, so an unbounded property list would become an
/// unbounded node config.
const MAX_TOOL_PARAMS: usize = 12;
const MAX_PARAM_NAME: usize = 60;
const MAX_PARAM_DESCRIPTION: usize = 200;
/// Stops a server paginating `tools/list` forever. Checked between pages, so a
/// single oversized page can overshoot — ported as-is.
const MAX_TOOLS: usize = 500;
const PARAM_TYPES: [&str; 5] = ["string", "number", "boolean", "array", "object"];

// --- errors ----------------------------------------------------------------

/// The one failure the caller must tell apart: a 401 means "start the OAuth
/// flow", everything else is terminal for this call. (`McpAuthRequired` in the
/// TypeScript.)
#[derive(Debug)]
pub enum McpError {
    /// carries the raw `WWW-Authenticate` header (possibly empty) — the PRM
    /// lookup reads `resource_metadata="…"` out of it, and that lookup is the
    /// cold OAuth flow below, so nothing reads it today
    AuthRequired(#[allow(dead_code)] String),
    Failed(String),
}

impl std::fmt::Display for McpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpError::AuthRequired(_) => write!(f, "MCP server requires authorization"),
            McpError::Failed(msg) => write!(f, "{msg}"),
        }
    }
}

impl From<String> for McpError {
    fn from(msg: String) -> Self {
        McpError::Failed(msg)
    }
}

// --- the single guarded fetch site -----------------------------------------

enum Body {
    None,
    /// content-type rides in the header map with the rest
    Json(String),
    /// `application/x-www-form-urlencoded`; reqwest sets the content-type
    Form(Vec<(String, String)>),
}

const REDIRECT_STATUS: [u16; 5] = [301, 302, 303, 307, 308];

/// reqwest resolves the host again at connect time, so the addresses
/// `assert_public_https_url` just approved are not necessarily the ones dialled
/// — a rebinding DNS server answers public once and private the second time.
/// Pinning the checked address closes that window. Literal-IP hosts need no pin
/// (the guard already validated the address itself).
///
/// The pin's port is the URL's, NOT the 443 the guard used for its lookup:
/// pinning `host:443` would silently re-aim an `https://host:8443/` request.
fn pinned_client(url: &Url) -> Result<Client, String> {
    let builder = Client::builder().redirect(redirect::Policy::none());
    let Some(host) = url.host_str() else {
        return builder.build().map_err(|e| e.to_string());
    };
    // bracketed IPv6 hostnames arrive as "[::1]"
    let bare = host
        .strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host);
    if bare.parse::<IpAddr>().is_ok() {
        return builder.build().map_err(|e| e.to_string());
    }
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = (bare, port)
        .to_socket_addrs()
        .map_err(|_| "Could not resolve server host".to_string())?
        .collect();
    // every address must be public, not merely the one we happen to dial: the
    // resolver order is the server's to choose
    if addrs.is_empty() || addrs.iter().any(|a| ip_blocked(a.ip())) {
        return Err("Server host resolves to a non-public address".into());
    }
    builder
        .resolve_to_addrs(host, &addrs)
        .build()
        .map_err(|e| e.to_string())
}

/// The only place this module touches the network. Runs the SSRF guard on the
/// start URL and on every redirect hop, pins the validated address, and holds
/// one wall-clock deadline across all hops.
fn send_guarded(
    method: &str,
    start_url: &str,
    mut headers: BTreeMap<String, String>,
    mut body: Body,
) -> Result<Response, String> {
    let deadline = Instant::now() + TIMEOUT;
    let mut current = start_url.to_string();
    let mut cur_method = method.to_string();
    for hop in 0..=MAX_REDIRECTS {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("timed out".into());
        }
        let url = assert_public_https_url(&current)?; // SSRF guard — every hop
        let client = pinned_client(&url)?;
        let verb = Method::from_bytes(cur_method.as_bytes()).map_err(|_| "unsupported method")?;
        let mut req = client.request(verb, url.clone()).timeout(remaining);
        for (name, value) in &headers {
            req = req.header(name.as_str(), value.as_str());
        }
        match &body {
            Body::None => {}
            Body::Json(text) => req = req.body(text.clone()),
            Body::Form(pairs) => req = req.form(pairs),
        }
        let res = req.send().map_err(|e| {
            if e.is_timeout() {
                "timed out".to_string()
            } else {
                crate::http::net_error(e)
            }
        })?;

        let status = res.status().as_u16();
        if !REDIRECT_STATUS.contains(&status) {
            return Ok(res);
        }
        let location = res
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let Some(location) = location else {
            return Ok(res); // a 30x without Location is just the response
        };
        if hop == MAX_REDIRECTS {
            return Err("too many redirects".into());
        }
        let next = url
            .join(&location)
            .map_err(|_| "invalid redirect location".to_string())?;
        // credentials never follow a cross-origin redirect (the fetch spec's
        // Authorization strip — a server must not be able to 30x our bearer
        // token, or an OAuth client secret, onto a host of its choosing)
        if next.origin() != url.origin() {
            headers.remove("authorization");
            headers.remove("cookie");
        }
        current = next.to_string();
        // 301/302/303 downgrade the method to GET and drop the request body
        if matches!(status, 301 | 302 | 303) {
            cur_method = "GET".into();
            body = Body::None;
            headers.remove("content-type");
        }
    }
    Err("too many redirects".into()) // unreachable — the loop returns first
}

fn read_body(res: Response) -> Result<String, String> {
    let mut buf = Vec::new();
    res.take(MAX_RESPONSE_BYTES)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn header(res: &Response, name: &str) -> Option<String> {
    res.headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string)
}

// --- JSON navigation --------------------------------------------------------
// Server payloads are parsed into `js::J`, not serde_json::Value, because J
// preserves object key order. That is load-bearing exactly once: `derive_params`
// walks `inputSchema.properties` in declaration order and then CAPS the list, so
// an alphabetizing map would keep a different twelve params than the TypeScript.

/// `j?.[key]` — None for a missing key or a non-object, like JS optional chaining.
fn field<'a>(j: &'a js::J, key: &str) -> Option<&'a js::J> {
    match j {
        js::J::O(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn as_str(j: Option<&js::J>) -> Option<&str> {
    match j {
        Some(js::J::S(s)) => Some(s.as_str()),
        _ => None,
    }
}

fn as_arr(j: Option<&js::J>) -> &[js::J] {
    match j {
        Some(js::J::A(items)) => items,
        _ => &[],
    }
}

/// JS truthiness, needed for `if (msg.error)`: a server that answers
/// `"error": null` alongside a result must not be read as failing.
fn truthy(j: &js::J) -> bool {
    match j {
        js::J::Null => false,
        js::J::B(b) => *b,
        js::J::N(n) => *n != 0.0 && !n.is_nan(),
        js::J::S(s) => !s.is_empty(),
        _ => true,
    }
}

// --- tool schemas ----------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum McpToolParamType {
    String,
    Number,
    Boolean,
    Array,
    Object,
}

/// One tool argument, derived from the MCP tool's inputSchema at discovery and
/// stored on the registry entry's tool list.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct McpToolParam {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: McpToolParamType,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DiscoveredTool {
    pub name: String,
    pub description: String,
    /// tri-state: Some when the server annotates the tool, None when it sends no
    /// annotations at all (capability unknown — most servers)
    #[serde(rename = "readOnly", skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    pub params: Vec<McpToolParam>,
}

/// property schema → param type. Handles the union spellings real servers use —
/// `type: ["null","array"]`, anyOf/oneOf variants — by taking the first
/// recognized non-null type; integer folds into number; anything else
/// (enum-only, $ref, missing) falls back to string.
fn param_type(p: &js::J) -> McpToolParamType {
    let mut candidates: Vec<&js::J> = Vec::new();
    match field(p, "type") {
        Some(js::J::A(items)) => candidates.extend(items.iter()),
        Some(other) => candidates.push(other),
        None => {}
    }
    for key in ["anyOf", "oneOf"] {
        for variant in as_arr(field(p, key)) {
            // `typeof variant === "object" && variant !== null` — an array is
            // still an object in JS, and field() then yields None for it
            if matches!(variant, js::J::O(_) | js::J::A(_)) {
                if let Some(t) = field(variant, "type") {
                    candidates.push(t);
                }
            }
        }
    }
    for c in candidates {
        let js::J::S(name) = c else { continue };
        if name == "integer" {
            return McpToolParamType::Number;
        }
        if name != "null" && PARAM_TYPES.contains(&name.as_str()) {
            return match name.as_str() {
                "string" => McpToolParamType::String,
                "number" => McpToolParamType::Number,
                "boolean" => McpToolParamType::Boolean,
                "array" => McpToolParamType::Array,
                _ => McpToolParamType::Object,
            };
        }
    }
    McpToolParamType::String
}

/// A canonical array index (`"0"`, `"12"`), which is what makes a JS object key
/// sort ahead of the string keys. `"01"`, `"-1"`, `""` and 2^32-1 are all plain
/// string keys, exactly as the spec's CanonicalNumericIndexString says.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}

/// Bounded param list from a tool's inputSchema — top-level properties +
/// required only; schemas are arbitrary third-party JSON, so stay defensive.
fn derive_params(schema: &js::J) -> Vec<McpToolParam> {
    let entries: Vec<(String, &js::J)> = match field(schema, "properties") {
        Some(js::J::O(props)) => {
            let mut entries: Vec<(String, &js::J)> =
                props.iter().map(|(k, v)| (k.clone(), v)).collect();
            // `Object.entries` is NOT insertion order: canonical array-index keys
            // come first, ascending, and only then the string keys in insertion
            // order. A schema with properties named "10"/"2" therefore yields a
            // different param order — and, past MAX_TOOL_PARAMS, a different
            // twelve params — if this is skipped. sort_by_key is stable, so the
            // string keys keep their insertion order among themselves.
            entries.sort_by_key(|(k, _)| array_index(k).map_or(u64::MAX, u64::from));
            entries
        }
        // an array is `typeof "object"` in JS too, and Object.entries turns it
        // into index keys — reachable from a hostile schema, so ported
        Some(js::J::A(items)) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v))
            .collect(),
        _ => return Vec::new(),
    };
    let required: HashSet<&str> = as_arr(field(schema, "required"))
        .iter()
        .filter_map(|r| match r {
            js::J::S(s) => Some(s.as_str()),
            _ => None,
        })
        .collect();

    let mut params: Vec<McpToolParam> = Vec::new();
    for (name, raw) in entries {
        // JS `.length` counts UTF-16 units
        if name.is_empty() || name.encode_utf16().count() > MAX_PARAM_NAME {
            continue;
        }
        let description = match as_str(field(raw, "description")) {
            Some(d) if !d.is_empty() => {
                Some(utf16_prefix(d, MAX_PARAM_DESCRIPTION).unwrap_or_else(|| d.to_string()))
            }
            _ => None,
        };
        params.push(McpToolParam {
            param_type: param_type(raw),
            required: required.contains(name.as_str()),
            name,
            description,
        });
    }
    // required first (stable within each group), THEN cap — the cap must never
    // drop a required param or the node could not be run at all
    params.sort_by_key(|p| !p.required);
    params.truncate(MAX_TOOL_PARAMS);
    params
}

// --- JSON-RPC ---------------------------------------------------------------

struct RpcOut {
    result: js::J,
    session_id: Option<String>,
}

#[derive(Default)]
struct RpcOpts<'a> {
    token: Option<&'a str>,
    session_id: Option<&'a str>,
    /// the TypeScript defaults this to 1
    id: Option<i64>,
}

/// Streamable HTTP responses are either plain JSON or an SSE stream whose data
/// events carry JSON-RPC messages — accept both, return the message with the
/// matching id. Split from the response so it stays unit-testable offline.
fn parse_rpc_body(content_type: &str, text: &str, id: i64) -> Option<js::J> {
    if content_type.contains("text/event-stream") {
        for line in text.split('\n') {
            let Some(data) = line.strip_prefix("data:") else {
                continue;
            };
            // a non-JSON keepalive event just doesn't parse — skip it
            let Ok(msg) = js::parse(data.trim()) else {
                continue;
            };
            // strict equality against a number: a string id never matches
            if matches!(field(&msg, "id"), Some(js::J::N(n)) if *n == id as f64) {
                return Some(msg);
            }
        }
        return None;
    }
    js::parse(text).ok()
}

fn rpc(server_url: &str, method: &str, params: js::J, opts: RpcOpts) -> Result<RpcOut, McpError> {
    let id = opts.id.unwrap_or(1);
    let is_notification = method.starts_with("notifications/");

    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    headers.insert(
        "accept".to_string(),
        "application/json, text/event-stream".to_string(),
    );
    headers.insert(
        "mcp-protocol-version".to_string(),
        PROTOCOL_VERSION.to_string(),
    );
    if let Some(token) = opts.token {
        headers.insert("authorization".to_string(), format!("Bearer {token}"));
    }
    if let Some(session) = opts.session_id {
        headers.insert("mcp-session-id".to_string(), session.to_string());
    }

    let mut body = vec![
        ("jsonrpc".to_string(), js::J::S("2.0".into())),
        ("method".to_string(), js::J::S(method.to_string())),
        ("params".to_string(), params),
    ];
    if !is_notification {
        body.push(("id".to_string(), js::J::N(id as f64)));
    }
    let res = send_guarded(
        "POST",
        server_url,
        headers,
        Body::Json(js::stringify(&js::J::O(body))),
    )?;

    if res.status().as_u16() == 401 {
        return Err(McpError::AuthRequired(
            header(&res, "www-authenticate").unwrap_or_default(),
        ));
    }
    let session_id = header(&res, "mcp-session-id").or_else(|| opts.session_id.map(String::from));
    if is_notification {
        return Ok(RpcOut {
            result: js::J::Null,
            session_id,
        });
    }
    let status = res.status();
    if !status.is_success() {
        return Err(McpError::Failed(format!(
            "MCP server responded {}",
            status.as_u16()
        )));
    }
    let content_type = header(&res, "content-type").unwrap_or_default();
    let text = read_body(res)?;
    let Some(msg) = parse_rpc_body(&content_type, &text, id) else {
        return Err(McpError::Failed(
            "MCP server sent an unreadable response".into(),
        ));
    };
    if let Some(err) = field(&msg, "error").filter(|e| truthy(e)) {
        let message = as_str(field(err, "message")).unwrap_or("unknown");
        return Err(McpError::Failed(format!("MCP error: {message}")));
    }
    let result = match field(&msg, "result") {
        Some(js::J::O(entries)) => js::J::O(entries.iter().map(clone_pair).collect()),
        Some(other) => clone_j(other),
        None => js::J::Null,
    };
    Ok(RpcOut { result, session_id })
}

// js::J is not Clone (nothing in the interpreter needed it); the RPC result has
// to outlive the parsed message, so clone it here rather than reach into a file
// this lane does not own.
fn clone_j(j: &js::J) -> js::J {
    match j {
        js::J::Null => js::J::Null,
        js::J::B(b) => js::J::B(*b),
        js::J::N(n) => js::J::N(*n),
        js::J::S(s) => js::J::S(s.clone()),
        js::J::A(items) => js::J::A(items.iter().map(clone_j).collect()),
        js::J::O(entries) => js::J::O(entries.iter().map(clone_pair).collect()),
    }
}

fn clone_pair(pair: &(String, js::J)) -> (String, js::J) {
    (pair.0.clone(), clone_j(&pair.1))
}

/// initialize → notifications/initialized; returns the server's session id (if
/// it issues one). Both rpc calls still run the SSRF guard.
fn handshake(server_url: &str, token: Option<&str>) -> Result<Option<String>, McpError> {
    let init = rpc(
        server_url,
        "initialize",
        js::J::O(vec![
            (
                "protocolVersion".to_string(),
                js::J::S(PROTOCOL_VERSION.into()),
            ),
            ("capabilities".to_string(), js::J::O(vec![])),
            (
                "clientInfo".to_string(),
                js::J::O(vec![
                    ("name".to_string(), js::J::S("saturn".into())),
                    ("version".to_string(), js::J::S("0.1.0".into())),
                ]),
            ),
        ]),
        RpcOpts {
            token,
            id: Some(1),
            ..Default::default()
        },
    )?;
    let session_id = init.session_id;
    // some servers reject the notification — the next call may still work
    let _ = rpc(
        server_url,
        "notifications/initialized",
        js::J::O(vec![]),
        RpcOpts {
            token,
            session_id: session_id.as_deref(),
            ..Default::default()
        },
    );
    Ok(session_id)
}

/// `cursor = page.nextCursor` under a `while (cursor && …)` gate — so an EMPTY
/// nextCursor is falsy and ENDS the pagination. Treating `""` as a cursor
/// re-requests the same page forever, and a page carrying no tools never grows
/// `tools` toward MAX_TOOLS, so `{"tools":[],"nextCursor":""}` would pin the run
/// thread in an unbounded request loop.
fn next_cursor(result: &js::J) -> Option<String> {
    as_str(field(result, "nextCursor"))
        .filter(|c| !c.is_empty())
        .map(str::to_string)
}

/// handshake → tools/list (paginated)
pub fn discover_tools(
    server_url: &str,
    token: Option<&str>,
) -> Result<Vec<DiscoveredTool>, McpError> {
    let session_id = handshake(server_url, token)?;

    let mut tools: Vec<DiscoveredTool> = Vec::new();
    let mut cursor: Option<String> = None;
    let mut id = 2i64;
    loop {
        let params = match &cursor {
            Some(c) => js::J::O(vec![("cursor".to_string(), js::J::S(c.clone()))]),
            None => js::J::O(vec![]),
        };
        let out = rpc(
            server_url,
            "tools/list",
            params,
            RpcOpts {
                token,
                session_id: session_id.as_deref(),
                id: Some(id),
            },
        )?;
        id += 1;
        for t in as_arr(field(&out.result, "tools")) {
            let Some(name) = as_str(field(t, "name")).filter(|n| !n.is_empty()) else {
                continue;
            };
            let annotations = field(t, "annotations");
            tools.push(DiscoveredTool {
                name: name.to_string(),
                description: as_str(field(t, "description")).unwrap_or("").to_string(),
                // no annotations object → unknown, NOT write-capable; with
                // annotations present, readOnlyHint defaults to false per spec.
                // `t.annotations ? … : undefined` is a TRUTHINESS test: a server
                // that serializes the absent field as `"annotations": null` (a
                // Go/Python encoder default) must read as unknown, not as
                // "declared write-capable" — which would start the tool at a
                // write grant and then block a read grant at call time.
                read_only: annotations
                    .filter(|a| truthy(a))
                    .map(|a| matches!(field(a, "readOnlyHint"), Some(js::J::B(true)))),
                params: field(t, "inputSchema")
                    .map(derive_params)
                    .unwrap_or_default(),
            });
        }
        cursor = next_cursor(&out.result);
        if cursor.is_none() || tools.len() >= MAX_TOOLS {
            return Ok(tools);
        }
    }
}

/// tools/call; returns the joined text content.
pub fn call_tool(
    server_url: &str,
    tool_name: &str,
    args: js::J,
    token: Option<&str>,
) -> Result<String, McpError> {
    let session_id = handshake(server_url, token)?;
    let out = rpc(
        server_url,
        "tools/call",
        js::J::O(vec![
            ("name".to_string(), js::J::S(tool_name.to_string())),
            ("arguments".to_string(), args),
        ]),
        RpcOpts {
            token,
            session_id: session_id.as_deref(),
            id: Some(2),
        },
    )?;

    let text = as_arr(field(&out.result, "content"))
        .iter()
        .filter(|c| as_str(field(c, "type")) == Some("text"))
        .filter_map(|c| as_str(field(c, "text")))
        .collect::<Vec<_>>()
        .join("\n");
    if matches!(field(&out.result, "isError"), Some(j) if truthy(j)) {
        return Err(McpError::Failed(match text.is_empty() {
            true => "Tool call failed".to_string(),
            false => text,
        }));
    }
    Ok(text)
}

// --- OAuth ------------------------------------------------------------------
//
// Everything from here to `refresh_tokens` is the interactive authorization
// code + PKCE flow, and it has NO caller yet — deliberately, not by oversight.
// Starting the flow means sending the user to the authorization server with a
// `redirect_uri` the app can receive on, and a desktop app has neither an HTTP
// origin (the local server is Phase G) nor a registered URL scheme (Phase H).
// Wiring it to a made-up redirect target would be worse than leaving it cold.
// `discover_mcp_tools` therefore surfaces a 401 as a connect error, and a manual
// bearer token is the way through today. `refresh_tokens` at the bottom IS live
// — it is reached from `registry::fresh_mcp_token`, which every MCP tool call
// goes through. Each item below carries its own allow, so a dead item that is
// NOT part of this flow still shows up as a warning.

/// Metadata fetch. A blocked URL yields None with no egress — same as the
/// TypeScript's catch-all, which swallowed the guard's throw.
#[allow(dead_code)] // OAuth flow — see the block comment above
fn fetch_json(url: &str) -> Option<js::J> {
    let mut headers = BTreeMap::new();
    headers.insert("accept".to_string(), "application/json".to_string());
    let res = send_guarded("GET", url, headers, Body::None).ok()?;
    if !res.status().is_success() {
        return None;
    }
    js::parse(&read_body(res).ok()?).ok()
}

#[derive(Clone, Debug, PartialEq)]
#[allow(dead_code)] // OAuth flow — see the block comment above
pub struct AuthServerMeta {
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub registration_endpoint: Option<String>,
    /// space-joined scopes_supported (PRM wins over AS metadata)
    pub scope: Option<String>,
}

#[allow(dead_code)] // OAuth flow — see the block comment above
fn join_scopes(value: Option<&js::J>) -> Option<String> {
    let items = as_arr(value);
    if items.is_empty() {
        return None;
    }
    let mut out: Vec<&str> = Vec::with_capacity(items.len());
    for item in items {
        match item {
            js::J::S(s) => out.push(s),
            _ => return None, // every element must be a string
        }
    }
    Some(out.join(" "))
}

/// `/resource_metadata="([^"]+)"/` — hand-rolled, no regex crate. Deliberately
/// unanchored, exactly like the original: the header is a challenge list and the
/// parameter can sit anywhere in it.
#[allow(dead_code)] // OAuth flow — see the block comment above
fn resource_metadata_param(www_authenticate: &str) -> Option<&str> {
    let start = www_authenticate.find("resource_metadata=\"")? + "resource_metadata=\"".len();
    let rest = &www_authenticate[start..];
    let end = rest.find('"')?;
    match end {
        0 => None, // [^"]+ needs at least one character
        _ => Some(&rest[..end]),
    }
}

/// RFC 9728 protected-resource metadata lookup. The 401's WWW-Authenticate may
/// name the metadata URL directly; otherwise fall back to the well-known paths.
#[allow(dead_code)] // OAuth flow — see the block comment above
fn resolve_via_prm(url: &Url, www_authenticate: &str) -> Option<(String, Option<String>)> {
    let origin = url.origin().ascii_serialization();
    let path = match url.path() {
        "/" => "",
        p => p,
    };
    let mut prm_urls: Vec<String> = Vec::new();
    if let Some(from_header) = resource_metadata_param(www_authenticate) {
        prm_urls.push(from_header.to_string());
    }
    prm_urls.push(format!("{origin}/.well-known/oauth-protected-resource{path}"));
    prm_urls.push(format!("{origin}/.well-known/oauth-protected-resource"));

    for prm_url in prm_urls {
        let Some(prm) = fetch_json(&prm_url) else {
            continue;
        };
        if let Some(js::J::S(server)) = as_arr(field(&prm, "authorization_servers")).first() {
            return Some((server.clone(), join_scopes(field(&prm, "scopes_supported"))));
        }
    }
    None
}

/// RFC 8414 / OIDC discovery against one authorization-server issuer.
#[allow(dead_code)] // OAuth flow — see the block comment above
fn fetch_as_meta(auth_server: &str, prm_scope: Option<String>) -> Option<AuthServerMeta> {
    let as_url = Url::parse(auth_server).ok()?;
    let origin = as_url.origin().ascii_serialization();
    let as_path = match as_url.path() {
        "/" => "",
        p => p,
    };
    let candidates = [
        format!("{origin}/.well-known/oauth-authorization-server{as_path}"),
        format!("{origin}/.well-known/oauth-authorization-server"),
        format!("{origin}/.well-known/openid-configuration{as_path}"),
        format!("{origin}{as_path}/.well-known/openid-configuration"),
    ];
    for candidate in candidates {
        let Some(meta) = fetch_json(&candidate) else {
            continue;
        };
        let (Some(authorize), Some(token)) = (
            as_str(field(&meta, "authorization_endpoint")),
            as_str(field(&meta, "token_endpoint")),
        ) else {
            continue;
        };
        return Some(AuthServerMeta {
            authorization_endpoint: authorize.to_string(),
            token_endpoint: token.to_string(),
            registration_endpoint: as_str(field(&meta, "registration_endpoint"))
                .map(str::to_string),
            scope: prm_scope.or_else(|| join_scopes(field(&meta, "scopes_supported"))),
        });
    }
    None
}

/// RFC 9728 protected-resource metadata → RFC 8414 authorization-server
/// metadata, for servers that answered 401.
#[allow(dead_code)] // OAuth flow — see the block comment above
pub fn get_auth_server_meta(
    server_url: &str,
    www_authenticate: &str,
) -> Result<AuthServerMeta, String> {
    let url = Url::parse(server_url).map_err(|_| "Invalid server URL".to_string())?;
    let prm = resolve_via_prm(&url, www_authenticate);
    // no PRM → assume the MCP origin is its own authorization server
    let (auth_server, prm_scope) = match prm {
        Some((server, scope)) => (server, scope),
        None => (url.origin().ascii_serialization(), None),
    };
    fetch_as_meta(&auth_server, prm_scope)
        .ok_or_else(|| "MCP server requires auth but exposes no OAuth metadata".to_string())
}

/// PRM-only probe for servers that answer discovery anonymously but 401 at
/// tools/call (e.g. Google's Gmail MCP). No PRM → None (genuinely public
/// server); deliberately no origin-as-AS fallback so public servers that merely
/// expose OIDC metadata don't false-positive.
#[allow(dead_code)] // OAuth flow — see the block comment above
pub fn probe_auth_server_meta(server_url: &str) -> Result<Option<AuthServerMeta>, String> {
    let url = Url::parse(server_url).map_err(|_| "Invalid server URL".to_string())?;
    let Some((auth_server, prm_scope)) = resolve_via_prm(&url, "") else {
        return Ok(None);
    };
    match fetch_as_meta(&auth_server, prm_scope) {
        Some(meta) => Ok(Some(meta)),
        // the server declared itself protected — saving tools that can never be
        // called would look like a successful connect
        None => Err(
            "MCP server advertises OAuth but its authorization server exposes no metadata".into(),
        ),
    }
}

#[allow(dead_code)] // OAuth flow — see the block comment above
pub struct RegisteredClient {
    pub client_id: String,
    pub client_secret: Option<String>,
}

/// RFC 7591 dynamic client registration (public client, PKCE only).
#[allow(dead_code)] // OAuth flow — see the block comment above
pub fn register_client(
    registration_endpoint: &str,
    redirect_uri: &str,
    scope: Option<&str>,
) -> Result<RegisteredClient, String> {
    let mut headers = BTreeMap::new();
    headers.insert("content-type".to_string(), "application/json".to_string());
    headers.insert("accept".to_string(), "application/json".to_string());
    let mut body = json!({
        "client_name": "Saturn",
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
    });
    if let Some(scope) = scope.filter(|s| !s.is_empty()) {
        body["scope"] = json!(scope);
    }
    let res = send_guarded(
        "POST",
        registration_endpoint,
        headers,
        Body::Json(body.to_string()),
    )?;
    if !res.status().is_success() {
        return Err("MCP authorization server refused client registration".into());
    }
    let parsed = js::parse(&read_body(res)?).unwrap_or(js::J::Null);
    let client_id = as_str(field(&parsed, "client_id"))
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "Client registration returned no client_id".to_string())?;
    Ok(RegisteredClient {
        client_id: client_id.to_string(),
        client_secret: as_str(field(&parsed, "client_secret")).map(str::to_string),
    })
}

/// A PKCE verifier and its S256 challenge. No Debug: the verifier is a secret
/// for the length of one authorization.
#[allow(dead_code)] // OAuth flow — see the block comment above
pub struct PkcePair {
    pub verifier: String,
    pub challenge: String,
}

/// base64url of SHA-256(verifier) — **unpadded**, which is what node's
/// `digest("base64url")` produces and what RFC 7636 requires. A padded or
/// standard-alphabet variant is accepted by nothing and fails at the far end.
#[allow(dead_code)] // OAuth flow — see the block comment above
fn code_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

#[allow(dead_code)] // OAuth flow — see the block comment above
pub fn pkce_pair() -> PkcePair {
    let mut bytes = [0u8; 32];
    // a failing system RNG is not a recoverable condition for an OAuth flow —
    // node's randomBytes threw here too
    getrandom::fill(&mut bytes).expect("system RNG unavailable");
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = code_challenge(&verifier);
    PkcePair {
        verifier,
        challenge,
    }
}

#[allow(dead_code)] // OAuth flow — see the block comment above
pub struct AuthorizeArgs<'a> {
    pub auth_url: &'a str,
    pub client_id: &'a str,
    pub redirect_uri: &'a str,
    pub state: &'a str,
    pub challenge: &'a str,
    pub resource: &'a str,
    pub scope: Option<&'a str>,
}

#[allow(dead_code)] // OAuth flow — see the block comment above
pub fn build_authorize_url(args: &AuthorizeArgs) -> Result<String, String> {
    let mut url = Url::parse(args.auth_url).map_err(|_| "Invalid authorize URL".to_string())?;
    let mut pairs: Vec<(String, String)> = vec![
        ("response_type".into(), "code".into()),
        ("client_id".into(), args.client_id.into()),
        ("redirect_uri".into(), args.redirect_uri.into()),
        ("state".into(), args.state.into()),
        ("code_challenge".into(), args.challenge.into()),
        ("code_challenge_method".into(), "S256".into()),
        ("resource".into(), args.resource.into()),
    ];
    if let Some(scope) = args.scope.filter(|s| !s.is_empty()) {
        pairs.push(("scope".into(), scope.into()));
    }
    // searchParams.set REPLACES: an authorization_endpoint that already carries
    // one of these keys must not end up with it twice
    let ours: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| !ours.contains(&k.as_ref()))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    url.query_pairs_mut()
        .clear()
        .extend_pairs(kept)
        .extend_pairs(pairs);
    Ok(url.to_string())
}

/// The OAuth token set. Returned to the caller (which puts it in the Keychain);
/// nothing in this module persists or logs it, and it deliberately does not
/// derive Debug.
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// epoch millis
    pub expires_at: Option<i64>,
}

/// `expires_in ? Date.now() + expires_in * 1000 : undefined`, seconds only. Two
/// JS semantics, both load-bearing: the gate is TRUTHINESS (numeric 0 means "no
/// expiry known"), and the multiplication COERCES — real token endpoints return
/// `"expires_in": "3600"` as a string, and dropping it leaves the set with no
/// expiry at all, i.e. never refreshed until it starts 401ing.
fn expires_in_secs(body: &js::J) -> Option<f64> {
    match field(body, "expires_in").filter(|j| truthy(j)) {
        Some(js::J::N(secs)) => Some(*secs),
        Some(js::J::S(secs)) => Some(js::to_number(secs)),
        _ => None,
    }
    .filter(|secs| secs.is_finite())
}

fn token_request(
    token_url: &str,
    params: Vec<(String, String)>,
    client_secret: Option<&str>,
) -> Result<TokenSet, String> {
    let mut headers = BTreeMap::new();
    headers.insert("accept".to_string(), "application/json".to_string());
    if let Some(secret) = client_secret.filter(|s| !s.is_empty()) {
        let client_id = params
            .iter()
            .find(|(k, _)| k == "client_id")
            .map(|(_, v)| v.as_str())
            .unwrap_or("");
        // standard alphabet WITH padding — Buffer.toString("base64"), which is
        // what RFC 6749 client_secret_basic expects
        let credential = STANDARD.encode(format!("{client_id}:{secret}"));
        headers.insert("authorization".to_string(), format!("Basic {credential}"));
    }
    let res = send_guarded("POST", token_url, headers, Body::Form(params))?;
    if !res.status().is_success() {
        return Err(format!("Token request failed ({})", res.status().as_u16()));
    }
    let body = js::parse(&read_body(res)?).unwrap_or(js::J::Null);
    let access_token = as_str(field(&body, "access_token"))
        .filter(|t| !t.is_empty())
        .ok_or_else(|| "Token response had no access_token".to_string())?;
    // `expires_in ? Date.now() + expires_in * 1000 : undefined`. Two JS
    // semantics, both load-bearing: the gate is TRUTHINESS (numeric 0 means "no
    // expiry known"), and the multiplication COERCES — real token endpoints
    // return `"expires_in": "3600"` as a string, and dropping it would leave the
    // set with no expiry at all, i.e. never refreshed until it starts 401ing.
    let expires_at = expires_in_secs(&body).map(|secs| now_ms() + (secs * 1000.0) as i64);
    Ok(TokenSet {
        access_token: access_token.to_string(),
        refresh_token: as_str(field(&body, "refresh_token")).map(str::to_string),
        expires_at,
    })
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[allow(dead_code)] // OAuth flow — see the block comment above
pub struct ExchangeArgs<'a> {
    pub token_url: &'a str,
    pub client_id: &'a str,
    pub client_secret: Option<&'a str>,
    pub code: &'a str,
    pub redirect_uri: &'a str,
    pub code_verifier: &'a str,
    pub resource: &'a str,
}

#[allow(dead_code)] // OAuth flow — see the block comment above
pub fn exchange_code(args: &ExchangeArgs) -> Result<TokenSet, String> {
    token_request(
        args.token_url,
        vec![
            ("grant_type".into(), "authorization_code".into()),
            ("code".into(), args.code.into()),
            ("redirect_uri".into(), args.redirect_uri.into()),
            ("client_id".into(), args.client_id.into()),
            ("code_verifier".into(), args.code_verifier.into()),
            ("resource".into(), args.resource.into()),
        ],
        args.client_secret,
    )
}

pub struct RefreshArgs<'a> {
    pub token_url: &'a str,
    pub client_id: &'a str,
    pub client_secret: Option<&'a str>,
    pub refresh_token: &'a str,
    pub resource: &'a str,
}

pub fn refresh_tokens(args: &RefreshArgs) -> Result<TokenSet, String> {
    token_request(
        args.token_url,
        vec![
            ("grant_type".into(), "refresh_token".into()),
            ("refresh_token".into(), args.refresh_token.into()),
            ("client_id".into(), args.client_id.into()),
            ("resource".into(), args.resource.into()),
        ],
        args.client_secret,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema(raw: &str) -> js::J {
        js::parse(raw).unwrap()
    }

    /// The egress guard is the whole security value of this module. Literal
    /// hosts resolve nothing, so this test never touches the network.
    #[test]
    fn the_guard_refuses_every_hostile_url_shape() {
        for bad in [
            "https://127.0.0.1/mcp",
            "https://10.1.2.3/mcp",
            "https://192.168.1.1/mcp",
            "https://172.16.0.1/mcp",
            "https://169.254.169.254/latest/meta-data/", // cloud metadata
            "https://100.64.0.1/mcp",                    // CGNAT
            "https://0.0.0.0/mcp",
            "https://[::1]/mcp",
            "https://[::ffff:127.0.0.1]/mcp", // IPv4-mapped loopback
            "https://[fe80::1]/mcp",          // link-local
            "https://[fc00::1]/mcp",          // unique-local
            "http://example.com/mcp",         // https only
            "ws://example.com/mcp",
            "file:///etc/passwd",
            "https://localhost/mcp",
            "https://api.localhost/mcp",
            "https://homeassistant.local/mcp",
            "not a url",
            // credentials do NOT make a URL invalid in either implementation —
            // what matters is that the *host* is the thing validated
            "https://good.example.com@10.0.0.1/mcp",
        ] {
            assert!(
                assert_public_https_url(bad).is_err(),
                "{bad} must be refused"
            );
        }
        for ok in ["https://1.1.1.1/mcp", "https://[2606:4700::1111]/mcp"] {
            assert!(assert_public_https_url(ok).is_ok(), "{ok} must be allowed");
        }
    }

    #[test]
    fn derives_params_from_a_schema() {
        let params = derive_params(&schema(
            r#"{
                "type": "object",
                "properties": {
                    "opt":  { "type": "string", "description": "an option" },
                    "n":    { "type": "integer" },
                    "req":  { "type": ["null", "array"] },
                    "any":  { "anyOf": [{ "type": "null" }, { "type": "boolean" }] },
                    "weird":{ "enum": ["a", "b"] },
                    "obj":  { "type": "object" }
                },
                "required": ["req", "any", 7]
            }"#,
        ));
        // required first, stable within each group — and NOT alphabetical, which
        // is what the order-preserving parse buys
        let names: Vec<&str> = params.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["req", "any", "opt", "n", "weird", "obj"]);
        assert_eq!(params[0].param_type, McpToolParamType::Array); // union, null skipped
        assert_eq!(params[1].param_type, McpToolParamType::Boolean); // anyOf variant
        assert_eq!(params[2].description.as_deref(), Some("an option"));
        assert_eq!(params[3].param_type, McpToolParamType::Number); // integer folds in
        assert_eq!(params[4].param_type, McpToolParamType::String); // enum-only fallback
        assert!(params[1].required && !params[2].required);
    }

    #[test]
    fn derive_params_is_defensive_about_junk() {
        assert!(derive_params(&schema("null")).is_empty());
        assert!(derive_params(&schema("[1,2,3]")).is_empty());
        assert!(derive_params(&schema(r#"{"properties": 4}"#)).is_empty());
        // properties as an ARRAY still yields index-named params in JS
        let indexed = derive_params(&schema(r#"{"properties":[{"type":"number"}]}"#));
        assert_eq!(indexed.len(), 1);
        assert_eq!(indexed[0].name, "0");
        // a non-object property schema is treated as {} → string, not skipped
        let loose = derive_params(&schema(r#"{"properties":{"a": "nope"}}"#));
        assert_eq!(loose[0].param_type, McpToolParamType::String);
    }

    /// `Object.entries` puts canonical array-index keys FIRST, ascending, and
    /// only then the string keys in insertion order — so a schema whose
    /// properties are numerically named orders differently than it was written,
    /// and past MAX_TOOL_PARAMS that decides which twelve survive. Verified
    /// against node: `Object.keys(JSON.parse(…))`.
    #[test]
    fn property_order_follows_object_entries_not_insertion() {
        let params = derive_params(&schema(
            r#"{"properties":{"b":{},"2":{},"a":{},"1":{},"01":{},"4294967295":{},"10":{}}}"#,
        ));
        let names: Vec<&str> = params.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["1", "2", "10", "b", "a", "01", "4294967295"]);
        // ...and the cap then keeps the JS twelve, not the first twelve written
        let props: Vec<String> = (0..20).rev().map(|i| format!(r#""{i}":{{}}"#)).collect();
        let capped = derive_params(&schema(&format!(r#"{{"properties":{{{}}}}}"#, props.join(","))));
        let kept: Vec<&str> = capped.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(kept, ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"]);
    }

    #[test]
    fn derive_params_enforces_the_caps() {
        // 60-char names pass, 61 are dropped
        let long = "x".repeat(61);
        let ok = "y".repeat(60);
        let dropped = derive_params(&schema(&format!(
            r#"{{"properties":{{"{long}":{{}},"{ok}":{{}}}}}}"#
        )));
        assert_eq!(dropped.len(), 1);
        assert_eq!(dropped[0].name, ok);

        // descriptions truncate at 200
        let desc = "d".repeat(250);
        let cut = derive_params(&schema(&format!(
            r#"{{"properties":{{"a":{{"description":"{desc}"}}}}}}"#
        )));
        assert_eq!(cut[0].description.as_deref().map(str::len), Some(200));

        // 20 props, 3 of them required and declared LAST: the cap keeps 12 but
        // must never drop a required one, which is why the sort precedes it
        let props: Vec<String> = (0..20).map(|i| format!(r#""p{i}":{{}}"#)).collect();
        let capped = derive_params(&schema(&format!(
            r#"{{"properties":{{{}}},"required":["p17","p18","p19"]}}"#,
            props.join(",")
        )));
        assert_eq!(capped.len(), MAX_TOOL_PARAMS);
        let names: Vec<&str> = capped.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(&names[..3], ["p17", "p18", "p19"]);
        assert_eq!(names[3], "p0");
    }

    /// RFC 7636 appendix B's known-answer vector. Hardcoded so swapping the
    /// base64 alphabet, or adding padding, fails here instead of at the far end
    /// of an authorization it would be impossible to debug.
    #[test]
    fn pkce_challenge_matches_the_rfc_vector() {
        assert_eq!(
            code_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let pair = pkce_pair();
        // 32 bytes, base64url, unpadded
        assert_eq!(pair.verifier.len(), 43);
        assert!(!pair.verifier.contains(['=', '+', '/']));
        assert_eq!(pair.challenge, code_challenge(&pair.verifier));
        assert_ne!(pkce_pair().verifier, pair.verifier);
    }

    #[test]
    fn builds_the_authorize_url() {
        let url = build_authorize_url(&AuthorizeArgs {
            auth_url: "https://as.example.com/authorize",
            client_id: "abc",
            redirect_uri: "https://saturn.test/cb",
            state: "st ate",
            challenge: "chal-1",
            resource: "https://mcp.example.com/mcp",
            scope: Some("read write"),
        })
        .unwrap();
        assert_eq!(
            url,
            "https://as.example.com/authorize?response_type=code&client_id=abc\
             &redirect_uri=https%3A%2F%2Fsaturn.test%2Fcb&state=st+ate\
             &code_challenge=chal-1&code_challenge_method=S256\
             &resource=https%3A%2F%2Fmcp.example.com%2Fmcp&scope=read+write"
        );
        // no scope → the parameter is absent, not empty; a pre-existing query
        // parameter survives, and one of ours is replaced rather than doubled
        let url = build_authorize_url(&AuthorizeArgs {
            auth_url: "https://as.example.com/authorize?tenant=t1&state=stale",
            client_id: "abc",
            redirect_uri: "https://saturn.test/cb",
            state: "s",
            challenge: "c",
            resource: "r",
            scope: None,
        })
        .unwrap();
        assert!(!url.contains("scope="));
        assert!(url.contains("tenant=t1"));
        assert_eq!(url.matches("state=").count(), 1);
        assert!(url.contains("state=s&"));
    }

    #[test]
    fn parses_both_streamable_http_body_shapes() {
        let plain = parse_rpc_body("application/json", r#"{"id":1,"result":{"ok":true}}"#, 1);
        assert!(matches!(field(&plain.unwrap(), "result"), Some(js::J::O(_))));
        // SSE: keepalives and other ids are skipped, the matching id wins
        let sse = concat!(
            ": keepalive\n",
            "data: not json\n",
            "data: {\"id\":9,\"result\":\"wrong\"}\n",
            "data: {\"id\":2,\"result\":\"right\"}\r\n",
        );
        let msg = parse_rpc_body("text/event-stream; charset=utf-8", sse, 2).unwrap();
        assert_eq!(as_str(field(&msg, "result")), Some("right"));
        assert!(parse_rpc_body("text/event-stream", sse, 3).is_none());
        assert!(parse_rpc_body("application/json", "<html>", 1).is_none());
        // a string id never satisfies the strict-equality match
        assert!(parse_rpc_body("text/event-stream", "data: {\"id\":\"2\"}\n", 2).is_none());
    }

    #[test]
    fn reads_the_www_authenticate_resource_metadata_param() {
        assert_eq!(
            resource_metadata_param(
                r#"Bearer error="unauthorized", resource_metadata="https://x.test/.well-known/prm""#
            ),
            Some("https://x.test/.well-known/prm")
        );
        assert_eq!(resource_metadata_param(r#"resource_metadata="""#), None);
        assert_eq!(resource_metadata_param("Bearer realm=\"x\""), None);
    }

    #[test]
    fn joins_scopes_only_when_every_element_is_a_string() {
        let j = js::parse(r#"{"a":["read","write"],"b":[],"c":["read",1]}"#).unwrap();
        assert_eq!(join_scopes(field(&j, "a")).as_deref(), Some("read write"));
        assert_eq!(join_scopes(field(&j, "b")), None);
        assert_eq!(join_scopes(field(&j, "c")), None);
        assert_eq!(join_scopes(None), None);
    }

    /// `while (cursor && …)`: an empty nextCursor ends the pagination. Without
    /// the emptiness test a server answering `{"tools":[],"nextCursor":""}`
    /// re-requests the same page forever — `tools` never grows, so the MAX_TOOLS
    /// escape never fires and the run thread hangs issuing requests.
    #[test]
    fn an_empty_next_cursor_ends_the_pagination() {
        let page = |raw: &str| next_cursor(&js::parse(raw).unwrap());
        assert_eq!(page(r#"{"tools":[],"nextCursor":"p2"}"#).as_deref(), Some("p2"));
        for terminal in [
            r#"{"tools":[]}"#,
            r#"{"tools":[],"nextCursor":""}"#,
            r#"{"tools":[],"nextCursor":null}"#,
            r#"{"tools":[],"nextCursor":0}"#,
            "null",
        ] {
            assert_eq!(page(terminal), None, "{terminal} must end pagination");
        }
    }

    /// `expires_in` decides whether the OAuth set is ever refreshed again. The
    /// gate is truthiness and the arithmetic coerces, so a string "3600" is an
    /// hour and a numeric 0 is "unknown".
    #[test]
    fn expires_in_follows_javascript_truthiness_and_coercion() {
        let secs = |raw: &str| expires_in_secs(&js::parse(raw).unwrap());
        assert_eq!(secs(r#"{"expires_in":3600}"#), Some(3600.0));
        assert_eq!(secs(r#"{"expires_in":"3600"}"#), Some(3600.0), "a string expiry is an expiry");
        assert_eq!(secs(r#"{"expires_in":"0"}"#), Some(0.0), r#""0" is truthy in JS"#);
        for none in [
            r#"{}"#,
            r#"{"expires_in":0}"#,
            r#"{"expires_in":null}"#,
            r#"{"expires_in":""}"#,
            r#"{"expires_in":"soon"}"#, // NaN — never a valid expiry
        ] {
            assert_eq!(secs(none), None, "{none} must carry no expiry");
        }
    }

    /// `t.annotations ? t.annotations.readOnlyHint === true : undefined` — a
    /// truthiness test. A server serializing the absent field as `null` (the Go
    /// and Python encoder default) must read as UNKNOWN capability, not as
    /// "declared write-capable": `merge_tools` starts a `Some(false)` tool at a
    /// *write* grant, and `can_call_tool` then refuses it under a read grant.
    #[test]
    fn absent_annotations_read_as_unknown_not_write_capable() {
        let read_only = |raw: &str| {
            let t = js::parse(raw).unwrap();
            field(&t, "annotations")
                .filter(|a| truthy(a))
                .map(|a| matches!(field(a, "readOnlyHint"), Some(js::J::B(true))))
        };
        for unknown in [r#"{}"#, r#"{"annotations":null}"#, r#"{"annotations":false}"#] {
            assert_eq!(read_only(unknown), None, "{unknown} must be unknown");
        }
        assert_eq!(read_only(r#"{"annotations":{}}"#), Some(false));
        assert_eq!(read_only(r#"{"annotations":{"readOnlyHint":false}}"#), Some(false));
        assert_eq!(read_only(r#"{"annotations":{"readOnlyHint":true}}"#), Some(true));
        // per spec only a literal `true` counts
        assert_eq!(read_only(r#"{"annotations":{"readOnlyHint":"true"}}"#), Some(false));
    }

    /// `if (msg.error)` is a truthiness test, not a presence test.
    #[test]
    fn error_truthiness_matches_javascript() {
        let j = js::parse(r#"{"a":null,"b":{},"c":"","d":0,"e":false,"f":"x"}"#).unwrap();
        for falsy in ["a", "c", "d", "e"] {
            assert!(!truthy(field(&j, falsy).unwrap()), "{falsy} must be falsy");
        }
        for t in ["b", "f"] {
            assert!(truthy(field(&j, t).unwrap()), "{t} must be truthy");
        }
    }
}
