//! Port of lib/agent.server.ts — the OpenRouter chat-completions client behind
//! both the agent node (`chat_complete`) and the Agent-page chat
//! (`stream_chat`). OpenAI-compatible wire format.
//!
//! The wire-format function names never leave this module: a tool call comes
//! back decoded to `{entry_id, tool_name}` before any caller sees it, exactly as
//! the TypeScript did. That decode is also the only thing that stops a model
//! from naming a tool it was never granted — `by_wire_name` is the allowlist.
//!
//! BYOK only. The hosted product asked OpenRouter for per-call cost (`usage:
//! {include: true}`) and wrote it to a credits ledger; the ledger, the plan
//! tiers and the platform key are all gone, so the key arrives as a parameter
//! (Keychain is the secrets module's business) and nothing is metered.
//!
//! Blocking reqwest, like http.rs and integrations.rs: `chat_complete` is called
//! from the synchronous interpreter. Callers must run both entry points on a
//! plain std thread — building a blocking client on a tokio worker panics.

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::blocking::Client;
use serde::Serialize;
use serde_json::Value;

use crate::agent::ToolRef;

const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/chat/completions";
/// A non-streaming completion that hasn't landed in 60s is hung: the
/// interpreter's run thread and the workflow's whole step are blocked on it, so
/// waiting longer just holds a run open. Set explicitly because reqwest's
/// blocking client defaults to a 30s timeout — inheriting that default would
/// silently halve the budget and cut slow reasoning models off mid-thought.
const TIMEOUT: Duration = Duration::from_secs(60);
/// Output cap per reply. Bounds what one turn can spend on the user's own key,
/// and keeps a runaway generation from blowing the transcript budget the agent
/// loop re-sends every turn (MAX_AGENT_MESSAGES).
const MAX_COMPLETION_TOKENS: u32 = 8192;
/// OpenAI's function-name limit; the API rejects a longer one outright, so the
/// sanitizer truncates rather than letting a long MCP tool name 400 the call.
const MAX_WIRE_NAME: usize = 64;

/// Reasoning modes an agent node may ask for. This allowlist is the guard: the
/// mode is a graph-supplied string, and passing it straight into the request
/// body would let a graph inject arbitrary keys into OpenRouter's `reasoning`
/// object. Unknown or blank means "model default", i.e. send nothing.
const REASONING_MODES: [&str; 4] = ["off", "low", "medium", "high"];

// --- types -----------------------------------------------------------------

/// One tool argument, derived from an MCP tool's inputSchema at discovery
/// (`deriveParams` in lib/mcp.ts) and stored on the registry entry.
/// `param_type` is the JSON Schema type string ("string" | "number" |
/// "boolean" | "array" | "object"), kept as a string because it round-trips
/// through the registry's stored JSON untouched.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, Serialize)]
pub struct ToolParam {
    pub name: String,
    #[serde(rename = "type")]
    pub param_type: String,
    #[serde(default)]
    pub required: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A granted tool as the caller resolved it against the registry. `params` is
/// `None` for a manually-added tool with no discovered schema — which means
/// "accepts any object", not "accepts nothing".
pub struct ToolSpec {
    pub tool_ref: ToolRef,
    pub description: Option<String>,
    pub params: Option<Vec<ToolParam>>,
}

/// A model-requested tool call decoded back to registry terms. `id` is the wire
/// call id: the `tool` role message answering this call must carry it back, and
/// OpenRouter 400s the next turn if any id goes unanswered.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCall {
    pub id: String,
    pub entry_id: String,
    pub tool_name: String,
    /// raw JSON-object string, as the model wrote it
    pub arguments: String,
}

/// The agent-loop transcript (lib/agent.ts `AgentMessage`). Distinct from the
/// wire form: it holds registry-side tool refs, and `chat_complete` re-encodes
/// them to wire names on every call.
pub enum AgentMessage {
    User { content: String },
    Assistant { content: String, tool_calls: Vec<ToolCall> },
    Tool { tool_call_id: String, content: String },
}

/// OpenAI-compatible message. Public because the Agent-page chat builds its own
/// transcripts against `stream_chat`.
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "role", rename_all = "lowercase")]
pub enum WireMessage {
    System {
        content: String,
    },
    User {
        content: String,
    },
    Assistant {
        content: String,
        #[serde(skip_serializing_if = "Vec::is_empty")]
        tool_calls: Vec<WireToolCall>,
    },
    Tool {
        tool_call_id: String,
        content: String,
    },
}

#[derive(Clone, Debug, Serialize)]
pub struct WireToolCall {
    pub id: String,
    #[serde(rename = "type")]
    kind: &'static str,
    pub function: WireCallFunction,
}

#[derive(Clone, Debug, Serialize)]
pub struct WireCallFunction {
    pub name: String,
    pub arguments: String,
}

impl WireToolCall {
    pub fn new(id: String, name: String, arguments: String) -> Self {
        Self { id, kind: "function", function: WireCallFunction { name, arguments } }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WireToolDef {
    #[serde(rename = "type")]
    kind: &'static str,
    pub function: WireFunctionDef,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct WireFunctionDef {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub parameters: Value,
}

impl WireToolDef {
    pub fn new(name: String, description: Option<String>, parameters: Value) -> Self {
        Self { kind: "function", function: WireFunctionDef { name, description, parameters } }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Reasoning {
    /// mode "off" — reasoning disabled outright, not merely un-requested
    Disabled { enabled: bool },
    Effort { effort: String },
}

/// Allowlist a graph-supplied reasoning mode into OpenRouter's `reasoning`
/// param. Anything not in `REASONING_MODES` (including `None` and "") is the
/// model default, i.e. the key is omitted entirely.
fn to_reasoning_param(mode: Option<&str>) -> Option<Reasoning> {
    let mode = mode.filter(|m| REASONING_MODES.contains(m))?;
    Some(if mode == "off" {
        Reasoning::Disabled { enabled: false }
    } else {
        Reasoning::Effort { effort: mode.to_string() }
    })
}

// --- tool definitions ------------------------------------------------------

/// The decode/encode maps alongside the definitions sent on the wire.
pub struct ToolDefs {
    pub defs: Vec<WireToolDef>,
    /// wire name → registry ref. Also the allowlist: a call naming anything
    /// absent here is refused rather than dispatched.
    pub by_wire_name: HashMap<String, ToolRef>,
    /// "<entry_id>:<tool_name>" → wire name, so an assistant message replayed
    /// from an earlier turn re-encodes to the name it was issued under.
    pub wire_name_of: HashMap<String, String>,
}

/// JS `s.replace(/[^a-zA-Z0-9_-]/g, "_")`. Iterates UTF-16 code units, not
/// chars: a non-BMP character is two units in JS and becomes two underscores, so
/// a char-wise port would produce a different name — and the name is the dedupe
/// key that decides whether two tools collide.
fn wire_safe(name: &str) -> String {
    name.encode_utf16()
        .map(|u| match char::from_u32(u32::from(u)) {
            Some(c) if c.is_ascii_alphanumeric() || c == '_' || c == '-' => c,
            _ => '_',
        })
        .collect()
}

/// `{type:"object", properties, required}` from the stored param spec. A tool
/// with no discovered params accepts any object — bare `{type:"object"}` with no
/// `properties` is JSON Schema for "anything", which is what a manually-added
/// MCP tool needs.
fn to_parameters(params: Option<&[ToolParam]>) -> Value {
    let params = match params {
        Some(p) if !p.is_empty() => p,
        _ => return serde_json::json!({ "type": "object" }),
    };
    let mut properties = serde_json::Map::new();
    for p in params {
        let mut schema = serde_json::Map::new();
        schema.insert("type".into(), Value::String(p.param_type.clone()));
        // an absent description is omitted, never sent as null
        if let Some(d) = p.description.as_ref().filter(|d| !d.is_empty()) {
            schema.insert("description".into(), Value::String(d.clone()));
        }
        properties.insert(p.name.clone(), Value::Object(schema));
    }
    let required: Vec<Value> =
        params.iter().filter(|p| p.required).map(|p| Value::String(p.name.clone())).collect();
    serde_json::json!({ "type": "object", "properties": properties, "required": required })
}

/// Deterministic wire-safe function names: sanitize the tool name, then dedupe a
/// cross-server collision with an entry-id prefix. Determinism is the point —
/// the same grant set must produce the same names every turn, or a replayed
/// assistant message would reference a name this turn's `tools` array no longer
/// contains.
pub fn build_tool_defs(specs: &[ToolSpec]) -> ToolDefs {
    let mut out =
        ToolDefs { defs: Vec::new(), by_wire_name: HashMap::new(), wire_name_of: HashMap::new() };
    for spec in specs {
        let sanitized: String =
            wire_safe(&spec.tool_ref.tool_name).chars().take(MAX_WIRE_NAME).collect();
        let base = if sanitized.is_empty() { "tool".to_string() } else { sanitized };
        let mut name = base.clone();
        if out.by_wire_name.contains_key(&name) {
            let prefix: String = spec.tool_ref.entry_id.chars().take(8).collect();
            name = format!("{prefix}_{base}").chars().take(MAX_WIRE_NAME).collect();
        }
        if out.by_wire_name.contains_key(&name) {
            continue; // same server+tool sent twice — skip the duplicate
        }
        out.by_wire_name.insert(name.clone(), spec.tool_ref.clone());
        out.wire_name_of
            .insert(format!("{}:{}", spec.tool_ref.entry_id, spec.tool_ref.tool_name), name.clone());
        out.defs.push(WireToolDef::new(
            name,
            spec.description.clone().filter(|d| !d.is_empty()),
            to_parameters(spec.params.as_deref()),
        ));
    }
    out
}

// --- request body ----------------------------------------------------------

#[derive(Serialize)]
struct Body<'a> {
    model: &'a str,
    messages: &'a [WireMessage],
    max_tokens: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<&'a [WireToolDef]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    modalities: Option<[&'static str; 2]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<Reasoning>,
}

/// User-renderable error from a non-2xx OpenRouter response body.
///
/// 401 is called out by name: on a BYOK desktop app a rejected key is the single
/// most common failure, and OpenRouter's own wording ("No auth credentials
/// found") reads like a Saturn bug rather than "go fix your key in settings".
/// Every other status keeps the provider's message verbatim.
fn model_error(body: Option<&Value>, status: u16) -> String {
    let message = body
        .and_then(|b| b.get("error"))
        .filter(|e| e.is_object())
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str);
    if status == 401 {
        return match message {
            Some(m) => format!("model call failed: OpenRouter rejected your API key (401) — {m}"),
            None => "model call failed: OpenRouter rejected your API key (401) — check it in settings"
                .to_string(),
        };
    }
    match message {
        Some(m) => format!("model call failed: {m}"),
        None => format!("model call failed: HTTP {status}"),
    }
}

/// A transport failure (DNS, TLS, timeout) never reached OpenRouter, so there is
/// no body to quote. The TypeScript let the raw fetch rejection escape here;
/// prefixing it keeps every failure out of this module reading the same way in a
/// run log.
fn transport_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        format!("model call failed: timed out after {}s", TIMEOUT.as_secs())
    } else {
        format!("model call failed: {err}")
    }
}

// --- chat_complete ---------------------------------------------------------

pub struct ChatRequest<'a> {
    pub model: &'a str,
    pub system: &'a str,
    pub messages: &'a [AgentMessage],
    pub tools: &'a [ToolSpec],
    pub output_image: bool,
    /// raw mode off the agent node; allowlisted here, never passed through
    pub reasoning: Option<&'a str>,
}

#[derive(Debug)]
pub struct ChatResult {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    /// generated images as `data:image/…` URLs, only on an image-output turn
    pub images: Vec<String>,
}

/// One chat-completions turn. `Err` carries a user-renderable message for
/// HTTP/decode failures and for a model calling a tool it wasn't given.
pub fn chat_complete(api_key: &str, req: &ChatRequest) -> Result<ChatResult, String> {
    let ToolDefs { defs, by_wire_name, wire_name_of } = build_tool_defs(req.tools);

    let mut wire = vec![WireMessage::System { content: req.system.to_string() }];
    for m in req.messages {
        wire.push(match m {
            AgentMessage::Assistant { content, tool_calls } => WireMessage::Assistant {
                content: content.clone(),
                tool_calls: tool_calls
                    .iter()
                    .map(|c| {
                        WireToolCall::new(
                            c.id.clone(),
                            // grants can change between turns; a stale replayed
                            // name still round-trips through the sanitizer
                            wire_name_of
                                .get(&format!("{}:{}", c.entry_id, c.tool_name))
                                .cloned()
                                .unwrap_or_else(|| wire_safe(&c.tool_name)),
                            c.arguments.clone(),
                        )
                    })
                    .collect(),
            },
            AgentMessage::Tool { tool_call_id, content } => {
                WireMessage::Tool { tool_call_id: tool_call_id.clone(), content: content.clone() }
            }
            AgentMessage::User { content } => WireMessage::User { content: content.clone() },
        });
    }

    let body = Body {
        model: req.model,
        messages: &wire,
        max_tokens: MAX_COMPLETION_TOKENS,
        stream: None,
        tools: (!defs.is_empty()).then_some(defs.as_slice()),
        modalities: req.output_image.then_some(["image", "text"]),
        reasoning: to_reasoning_param(req.reasoning),
    };

    let client = Client::builder().timeout(TIMEOUT).build().map_err(|e| e.to_string())?;
    let res = client
        .post(OPENROUTER_URL)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .map_err(|e| transport_error(&e))?;

    let status = res.status().as_u16();
    // a body that isn't JSON is simply absent, exactly as `.catch(() => null)`
    let body: Option<Value> = res.json().ok();
    if !(200..300).contains(&status) {
        return Err(model_error(body.as_ref(), status));
    }
    parse_completion(body.as_ref(), &by_wire_name)
}

fn parse_completion(
    body: Option<&Value>,
    by_wire_name: &HashMap<String, ToolRef>,
) -> Result<ChatResult, String> {
    let message = body
        .and_then(|b| b.get("choices"))
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .and_then(|c| c.get("message"))
        .and_then(Value::as_object)
        .ok_or("model call failed: malformed response")?;

    let content = message.get("content").and_then(Value::as_str).unwrap_or("").to_string();

    // image-output models return generated images as data URLs on
    // message.images — keep only well-formed ones
    let mut images = Vec::new();
    if let Some(list) = message.get("images").and_then(Value::as_array) {
        for raw in list {
            let url = raw
                .get("image_url")
                .filter(|u| u.is_object())
                .and_then(|u| u.get("url"))
                .and_then(Value::as_str);
            if let Some(url) = url.filter(|u| u.starts_with("data:image/")) {
                images.push(url.to_string());
            }
        }
    }

    let mut tool_calls = Vec::new();
    if let Some(list) = message.get("tool_calls").and_then(Value::as_array) {
        for raw in list {
            let function = raw.get("function").filter(|f| f.is_object());
            let name = function.and_then(|f| f.get("name")).and_then(Value::as_str).unwrap_or("");
            // the allowlist: a name absent from the defs we sent means the model
            // invented a tool, and dispatching it would call something the graph
            // never granted
            let Some(reference) = by_wire_name.get(name) else {
                return Err(format!("model requested unknown tool \"{name}\""));
            };
            let id = raw.get("id").and_then(Value::as_str).filter(|s| !s.is_empty());
            let arguments = function
                .and_then(|f| f.get("arguments"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("{}");
            tool_calls.push(ToolCall {
                id: id.map_or_else(|| uuid::Uuid::new_v4().to_string(), str::to_string),
                entry_id: reference.entry_id.clone(),
                tool_name: reference.tool_name.clone(),
                arguments: arguments.to_string(),
            });
        }
    }
    Ok(ChatResult { content, tool_calls, images })
}

// --- stream_chat -----------------------------------------------------------
//
// The Agent-page chat, and it has NO caller: lib/agentChat.server.ts (242 LOC,
// the turn loop that drives this) was named in the Phase D plan but no lane
// ported it, so the streaming client is complete and cold. Nothing else in the
// app streams — the agent NODE uses `chat_complete`. Each item carries its own
// allow rather than a blanket one on the module, so anything that goes dead in
// the rest of this file still warns.

/// One incremental delta. Reasoning and content are separate channels because
/// the Agent page renders them differently (grey vs white); `chat_complete`
/// discards reasoning entirely.
#[allow(dead_code)] // Agent-page chat — see the block comment above
pub enum Delta<'a> {
    Reasoning(&'a str),
    Content(&'a str),
}

/// A tool call accumulated off the stream, still in wire terms — the streaming
/// caller owns dispatch and answers by id, so nothing is decoded here.
#[derive(Clone, Debug, PartialEq)]
#[allow(dead_code)] // Agent-page chat — see the block comment above
pub struct StreamToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

#[allow(dead_code)] // Agent-page chat — see the block comment above
pub struct StreamRequest<'a> {
    pub model: &'a str,
    pub system: &'a str,
    pub messages: &'a [WireMessage],
    pub tools: &'a [WireToolDef],
    /// raw mode; allowlisted here, same as `chat_complete`
    pub reasoning: Option<&'a str>,
    /// the chat's stop button. Checked between reads; set it and the stream
    /// unwinds with no tool calls, which ends the caller's turn loop cleanly.
    pub cancel: Option<&'a AtomicBool>,
}

/// Incremental SSE decoder. Split out of `stream_chat` so frame handling is
/// testable without a socket — a chunk boundary can fall anywhere, including
/// mid-`data:`, mid-JSON and mid-UTF-8, and getting that wrong works for short
/// replies and corrupts long ones.
#[derive(Default)]
#[allow(dead_code)] // Agent-page chat — see the block comment above
struct SseDecoder {
    /// bytes, not a String: a multi-byte character split across two chunks is
    /// not valid UTF-8 on its own. Only complete lines are ever decoded, and a
    /// `\n` can never land inside a multi-byte sequence, so every line this
    /// yields is whole.
    buf: Vec<u8>,
    /// tool calls arrive as fragments keyed by `index` — the provider splits the
    /// arguments JSON across frames, so every field concatenates in arrival
    /// order. BTreeMap so the finished list comes out in index order.
    calls: BTreeMap<i64, StreamToolCall>,
}

#[allow(dead_code)] // Agent-page chat — see the block comment above
impl SseDecoder {
    fn push(&mut self, chunk: &[u8], on_delta: &mut dyn FnMut(Delta)) {
        self.buf.extend_from_slice(chunk);
        while let Some(nl) = self.buf.iter().position(|b| *b == b'\n') {
            let mut line: Vec<u8> = self.buf.drain(..=nl).collect();
            line.pop(); // the newline itself
            let line = String::from_utf8_lossy(&line);
            self.frame(line.trim(), on_delta);
        }
    }

    fn frame(&mut self, line: &str, on_delta: &mut dyn FnMut(Delta)) {
        if line.is_empty() || line.starts_with(':') {
            return; // keep-alive comment
        }
        let Some(data) = line.strip_prefix("data:") else { return };
        let data = data.trim();
        if data == "[DONE]" {
            return;
        }
        // a partial or garbled frame is skipped, never fatal: one bad frame must
        // not lose the deltas already delivered or the ones still coming
        let Ok(json) = serde_json::from_str::<Value>(data) else { return };
        let delta = json
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|c| c.first())
            .and_then(|c| c.get("delta"))
            .filter(|d| d.is_object());
        let Some(delta) = delta else { return };

        if let Some(r) = delta.get("reasoning").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            on_delta(Delta::Reasoning(r));
        }
        if let Some(c) = delta.get("content").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            on_delta(Delta::Content(c));
        }
        let Some(list) = delta.get("tool_calls").and_then(Value::as_array) else { return };
        for raw in list {
            if !raw.is_object() {
                continue;
            }
            // as_f64, not as_i64: a provider writing `1.0` would otherwise fall
            // to the default slot and interleave two calls' arguments
            let index = raw.get("index").and_then(Value::as_f64).unwrap_or(0.0) as i64;
            let slot = self.calls.entry(index).or_insert_with(|| StreamToolCall {
                id: String::new(),
                name: String::new(),
                arguments: String::new(),
            });
            if slot.id.is_empty() {
                if let Some(id) = raw.get("id").and_then(Value::as_str) {
                    slot.id = id.to_string();
                }
            }
            let function = raw.get("function").filter(|f| f.is_object());
            if let Some(n) = function.and_then(|f| f.get("name")).and_then(Value::as_str) {
                slot.name.push_str(n);
            }
            if let Some(a) = function.and_then(|f| f.get("arguments")).and_then(Value::as_str) {
                slot.arguments.push_str(a);
            }
        }
    }

    /// A fragment that never carried a name is not a call — providers emit
    /// argument-only continuation frames, and a slot with no name at all means
    /// the stream was cut before that call was announced.
    fn finish(self) -> Vec<StreamToolCall> {
        self.calls
            .into_values()
            .map(|mut c| {
                if c.id.is_empty() {
                    c.id = uuid::Uuid::new_v4().to_string();
                }
                c
            })
            .filter(|c| !c.name.is_empty())
            .collect()
    }
}

/// Streaming sibling of `chat_complete` for the Agent-page chat: surfaces
/// reasoning tokens and takes wire-shaped messages + tool defs directly — the
/// caller owns the multi-turn loop and tool dispatch. Deltas go to `on_delta` as
/// they arrive; the accumulated tool calls come back at the end.
#[allow(dead_code)] // Agent-page chat — see the block comment above
pub fn stream_chat(
    api_key: &str,
    req: &StreamRequest,
    on_delta: &mut dyn FnMut(Delta),
) -> Result<Vec<StreamToolCall>, String> {
    let mut wire = vec![WireMessage::System { content: req.system.to_string() }];
    wire.extend(req.messages.iter().cloned());

    let body = Body {
        model: req.model,
        messages: &wire,
        max_tokens: MAX_COMPLETION_TOKENS,
        stream: Some(true),
        tools: (!req.tools.is_empty()).then_some(req.tools),
        modalities: None,
        reasoning: to_reasoning_param(req.reasoning),
    };

    // reqwest's blocking timeout covers reading the body too, so this cannot be
    // the ~60s of a single request or it would cut a long generation off
    // mid-stream. But it must not be `None` either: a blocking `read` on a
    // black-holed TLS connection — the laptop changing networks mid-generation —
    // never returns, and nothing downstream can interrupt it. The `cancel` flag
    // is only checked *between* reads, and `read_timeout` is not exposed on the
    // blocking builder. That wedged thread is joined by `run_due_workflows`'s
    // `thread::scope`, which the scheduler awaits, so one dead socket silently
    // stops every cron in the app until relaunch.
    //
    // 600s is `RUN_TIMEOUT_MS` from lib/runner.server.ts:220 — the whole-run
    // bound the TypeScript had and the port dropped. A single model call that
    // outlives it is already pathological.
    const STREAM_DEADLINE: Duration = Duration::from_secs(600);
    let client = Client::builder()
        .timeout(STREAM_DEADLINE)
        .build()
        .map_err(|e| e.to_string())?;
    let mut res = client
        .post(OPENROUTER_URL)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .map_err(|e| transport_error(&e))?;

    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        let body: Option<Value> = res.json().ok();
        return Err(model_error(body.as_ref(), status));
    }

    let mut decoder = SseDecoder::default();
    let mut chunk = [0u8; 8192];
    loop {
        if req.cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            return Ok(Vec::new());
        }
        match res.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => decoder.push(&chunk[..n], on_delta),
            Err(e) => return Err(format!("model call failed: {e}")),
        }
    }
    Ok(decoder.finish())
}

// --- the model catalogue ---------------------------------------------------

/// One row of the designer's model picker. `output_modalities` is
/// `architecture.output_modalities` filtered to the two values the designer
/// understands (it drives the agent node's output select); `supports_reasoning`
/// comes off `supported_parameters` and drives the reasoning select.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    pub output_modalities: Vec<String>,
    pub supports_reasoning: bool,
}

const MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const MODELS_TTL: Duration = Duration::from_secs(3600);
/// The response is several MB and ~2 000 entries; the designer renders a
/// toolbox chip per row, so the tail is unreachable UI either way.
const MAX_MODELS: usize = 1000;
/// `MODEL_ID`'s length cap in lib/agent.ts — a longer id could never be run.
const MAX_MODEL_ID: usize = 128;

/// Same shape as `events::CACHE`: the whole parsed list behind one mutex, with
/// the lock held across the load so a designer and a settings page opening
/// together produce one fetch and one hit rather than two fetches.
///
/// A failure is NOT cached (`load_models` returns Err and nothing is stored), so
/// the next call retries — that is what the TypeScript's `loadModels` throwing
/// past the memo did.
static MODELS: std::sync::Mutex<Option<(std::time::Instant, Vec<Model>)>> =
    std::sync::Mutex::new(None);

/// The public models endpoint. Deliberately unauthenticated — the response is
/// identical for every caller and no key is sent, which is why this is safe to
/// cache process-wide.
///
/// Blocking reqwest: the caller must be on a plain std thread.
pub fn list_models() -> Result<Vec<Model>, String> {
    // `into_inner` on poison, not `unwrap`: the lock is held across a network
    // call, and a panic under it would otherwise wedge the picker for the life
    // of the process.
    let mut cache = MODELS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some((at, models)) = cache.as_ref() {
        if at.elapsed() < MODELS_TTL {
            return Ok(models.clone());
        }
    }
    let models = load_models()?;
    *cache = Some((std::time::Instant::now(), models.clone()));
    Ok(models)
}

fn load_models() -> Result<Vec<Model>, String> {
    let client = Client::builder().timeout(TIMEOUT).build().map_err(|e| e.to_string())?;
    let res = client.get(MODELS_URL).send().map_err(crate::http::net_error)?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("openrouter models: {status}"));
    }
    let body: Value = res.json().map_err(crate::http::net_error)?;
    Ok(parse_models(&body))
}

fn parse_models(body: &Value) -> Vec<Model> {
    let data = body.get("data").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let mut models: Vec<Model> = data
        .iter()
        // the cap applies AFTER the filter and BEFORE the map, exactly as the
        // TypeScript's .filter().slice(0, 1000).map() chain did — filtering
        // after slicing would silently shrink the list below 1 000
        .filter_map(|m| {
            let id = m
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && s.encode_utf16().count() <= MAX_MODEL_ID)?;
            Some((m, id))
        })
        .take(MAX_MODELS)
        .map(|(m, id)| Model {
            id: id.to_string(),
            name: m
                .get("name")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(id)
                .to_string(),
            output_modalities: m
                .get("architecture")
                .and_then(|a| a.get("output_modalities"))
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .filter(|x| *x == "text" || *x == "image")
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            supports_reasoning: m
                .get("supported_parameters")
                .and_then(Value::as_array)
                .is_some_and(|p| p.iter().any(|x| x.as_str() == Some("reasoning"))),
        })
        .collect();
    // `localeCompare` has no Rust equivalent without pulling in ICU. Lowercase
    // byte order is the closest thing that keeps "Claude" next to "claude"
    // instead of sorting every capitalised name ahead of every lowercase one,
    // which is the only difference a user would actually notice in the picker.
    models.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    models
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The models list is parsed from an endpoint nobody in this project owns,
    /// so every field is optional in practice. The order of filter/cap/map is
    /// the load-bearing part: capping before the filter would hand the picker
    /// fewer than 1 000 usable models whenever OpenRouter lists a junk row early.
    #[test]
    fn model_rows_are_filtered_then_capped_then_sorted() {
        let mut rows: Vec<Value> = vec![
            serde_json::json!({ "id": "", "name": "blank id" }),
            serde_json::json!({ "id": 7, "name": "not a string" }),
            serde_json::json!({ "id": "x".repeat(MAX_MODEL_ID + 1) }),
            serde_json::json!({ "id": "zeta/one", "name": "Zeta",
                                "architecture": { "output_modalities": ["text", "video"] },
                                "supported_parameters": ["reasoning", "tools"] }),
            // no name → falls back to the id; no architecture → no modalities
            serde_json::json!({ "id": "alpha/two" }),
        ];
        let models = parse_models(&serde_json::json!({ "data": rows.clone() }));
        assert_eq!(models.len(), 2, "junk rows survived: {models:?}");
        assert_eq!(models[0].id, "alpha/two");
        assert_eq!(models[0].name, "alpha/two", "name must fall back to the id");
        assert!(models[0].output_modalities.is_empty());
        assert!(!models[0].supports_reasoning);
        assert_eq!(models[1].name, "Zeta");
        // "video" is not a modality the designer can render
        assert_eq!(models[1].output_modalities, ["text"]);
        assert!(models[1].supports_reasoning);

        // the cap counts usable rows, not raw ones: 3 junk rows above + 1005 good
        for i in 0..1005 {
            rows.push(serde_json::json!({ "id": format!("m/{i:04}") }));
        }
        let capped = parse_models(&serde_json::json!({ "data": rows }));
        assert_eq!(capped.len(), MAX_MODELS);

        // a body with no `data` array is empty, never a panic
        assert!(parse_models(&serde_json::json!({})).is_empty());
        assert!(parse_models(&serde_json::json!({ "data": "nope" })).is_empty());
    }

    fn spec(entry: &str, tool: &str, params: Option<Vec<ToolParam>>) -> ToolSpec {
        ToolSpec {
            tool_ref: ToolRef {
                entry_id: entry.to_string(),
                tool_name: tool.to_string(),
                exclude: Vec::new(),
            },
            description: None,
            params,
        }
    }

    fn param(name: &str, ty: &str, required: bool, description: Option<&str>) -> ToolParam {
        ToolParam {
            name: name.into(),
            param_type: ty.into(),
            required,
            description: description.map(str::to_string),
        }
    }

    #[test]
    fn parameters_render_the_stored_schema() {
        // no schema at all and an empty list are the same thing: any object.
        // `{type:"object", properties:{}}` would mean "no arguments accepted",
        // which silently breaks every manually-added MCP tool.
        assert_eq!(to_parameters(None), serde_json::json!({ "type": "object" }));
        assert_eq!(to_parameters(Some(&[])), serde_json::json!({ "type": "object" }));

        let params = vec![
            param("symbol", "string", true, Some("ticker")),
            param("limit", "number", false, None),
        ];
        assert_eq!(
            to_parameters(Some(&params)),
            serde_json::json!({
                "type": "object",
                "properties": {
                    "symbol": { "type": "string", "description": "ticker" },
                    "limit": { "type": "number" },
                },
                "required": ["symbol"],
            })
        );
        // every param optional still emits `required`, as an empty array
        let optional = vec![param("x", "boolean", false, None)];
        assert_eq!(to_parameters(Some(&optional))["required"], serde_json::json!([]));
    }

    #[test]
    fn wire_names_are_sanitized_deduped_and_capped() {
        let a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        let defs = build_tool_defs(&[
            spec(a, "get/price", None),
            spec(b, "get/price", None), // collision → entry-id prefix
            // A repeat of the FIRST spec. Faithful to the TypeScript, this is
            // not skipped: the prefixed fallback is still free, so the same tool
            // is defined twice under two names and wire_name_of ends up pointing
            // at the second. Only a third repeat reaches the skip. Callers
            // dedupe by "<entry>:<tool>" before building, so no real grant set
            // gets here — see the report.
            spec(a, "get/price", None),
            spec(a, "get/price", None), // now both names are taken → skipped
            spec(a, "", None),          // nothing survives sanitizing → "tool"
            spec(a, &"z".repeat(80), None),
        ]);
        let names: Vec<&str> = defs.defs.iter().map(|d| d.function.name.as_str()).collect();
        assert_eq!(
            names,
            ["get_price", "bbbbbbbb_get_price", "aaaaaaaa_get_price", "tool", &"z".repeat(64)]
        );
        assert_eq!(defs.by_wire_name["get_price"].entry_id, a);
        assert_eq!(defs.by_wire_name["bbbbbbbb_get_price"].entry_id, b);
        assert_eq!(defs.wire_name_of[&format!("{b}:get/price")], "bbbbbbbb_get_price");
        assert_eq!(defs.wire_name_of[&format!("{a}:get/price")], "aaaaaaaa_get_price");
        // a non-BMP char is two UTF-16 units in JS, so two underscores
        assert_eq!(wire_safe("a🙂b"), "a__b");

        let json = serde_json::to_value(&defs.defs[0]).unwrap();
        assert_eq!(json["type"], "function");
        assert_eq!(json["function"]["parameters"], serde_json::json!({ "type": "object" }));
        assert!(json["function"].get("description").is_none()); // omitted, not null
    }

    #[test]
    fn reasoning_modes_are_allowlisted() {
        assert_eq!(to_reasoning_param(Some("off")), Some(Reasoning::Disabled { enabled: false }));
        assert_eq!(
            to_reasoning_param(Some("high")),
            Some(Reasoning::Effort { effort: "high".into() })
        );
        // the guard: a graph-supplied string that isn't a known mode sends nothing
        for junk in ["", "HIGH", "maximum", "{\"exclude\":true}"] {
            assert_eq!(to_reasoning_param(Some(junk)), None, "{junk} must not pass");
        }
        assert_eq!(to_reasoning_param(None), None);
        assert_eq!(
            serde_json::to_value(Reasoning::Disabled { enabled: false }).unwrap(),
            serde_json::json!({ "enabled": false })
        );
    }

    #[test]
    fn a_rejected_key_is_named_as_such() {
        let body = serde_json::json!({ "error": { "message": "No auth credentials found" } });
        let err = model_error(Some(&body), 401);
        assert!(err.contains("rejected your API key (401)"), "{err}");
        assert!(err.contains("No auth credentials found"), "{err}");
        assert!(model_error(None, 401).contains("check it in settings"));
        // every other status keeps the provider's own wording
        assert_eq!(model_error(Some(&body), 429), "model call failed: No auth credentials found");
        assert_eq!(model_error(None, 502), "model call failed: HTTP 502");
        assert_eq!(model_error(Some(&serde_json::json!([])), 500), "model call failed: HTTP 500");
    }

    #[test]
    fn completions_decode_back_to_registry_terms() {
        let a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let defs = build_tool_defs(&[spec(a, "get/price", None)]);
        let body = serde_json::json!({
            "choices": [{ "message": {
                "content": "here you go",
                "tool_calls": [
                    { "id": "call_1", "function": { "name": "get_price", "arguments": "{\"s\":1}" } },
                    // no id and no arguments — both get defaults
                    { "function": { "name": "get_price" } },
                ],
                "images": [
                    { "image_url": { "url": "data:image/png;base64,QQ==" } },
                    { "image_url": { "url": "https://evil.test/x.png" } }, // not a data URL
                    { "nope": 1 },
                ],
            }}]
        });
        let out = parse_completion(Some(&body), &defs.by_wire_name).unwrap();
        assert_eq!(out.content, "here you go");
        assert_eq!(out.images, ["data:image/png;base64,QQ=="]);
        assert_eq!(out.tool_calls[0].id, "call_1");
        assert_eq!(out.tool_calls[0].entry_id, a);
        assert_eq!(out.tool_calls[0].tool_name, "get/price"); // the registry name, not the wire one
        assert_eq!(out.tool_calls[1].arguments, "{}");
        assert_eq!(out.tool_calls[1].id.len(), 36); // generated

        // a tool the graph never granted must not be dispatchable
        let rogue = serde_json::json!({
            "choices": [{ "message": { "tool_calls": [{ "function": { "name": "rm_rf" } }] } }]
        });
        assert_eq!(
            parse_completion(Some(&rogue), &defs.by_wire_name).unwrap_err(),
            "model requested unknown tool \"rm_rf\""
        );
        for bad in
            [serde_json::json!({}), serde_json::json!({ "choices": [] }), serde_json::json!([])]
        {
            assert_eq!(
                parse_completion(Some(&bad), &defs.by_wire_name).unwrap_err(),
                "model call failed: malformed response"
            );
        }
        assert!(parse_completion(None, &defs.by_wire_name).is_err());
    }

    #[test]
    fn tool_round_trip_messages_serialize_to_the_wire_shape() {
        let a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let defs = build_tool_defs(&[spec(a, "get/price", None)]);
        let name = defs.wire_name_of[&format!("{a}:get/price")].clone();
        let wire = vec![
            WireMessage::Assistant {
                content: "calling".into(),
                tool_calls: vec![WireToolCall::new("call_1".into(), name, "{}".into())],
            },
            WireMessage::Tool { tool_call_id: "call_1".into(), content: "42".into() },
            WireMessage::Assistant { content: "done".into(), tool_calls: vec![] },
        ];
        assert_eq!(
            serde_json::to_value(&wire).unwrap(),
            serde_json::json!([
                {
                    "role": "assistant",
                    "content": "calling",
                    "tool_calls": [{
                        "id": "call_1",
                        "type": "function",
                        "function": { "name": "get_price", "arguments": "{}" },
                    }],
                },
                { "role": "tool", "tool_call_id": "call_1", "content": "42" },
                // no tool calls → the key is absent, not an empty array
                { "role": "assistant", "content": "done" },
            ])
        );
    }

    /// The stream is decoded byte-wise, so this feeds one fixed SSE body at
    /// EVERY possible split point — including mid-`data:`, mid-JSON and inside a
    /// multi-byte character — and demands identical output each time. A
    /// String-based buffer passes the short-reply cases and mangles this one.
    #[test]
    fn sse_frames_survive_hostile_chunk_boundaries() {
        let body = concat!(
            ": OPENROUTER PROCESSING\n\n",
            "data: {\"choices\":[{\"delta\":{\"reasoning\":\"hmm…\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"héllo \"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"🙂 wörld\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"\"}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[",
            "{\"index\":0,\"id\":\"call_a\",\"function\":{\"name\":\"get_\",\"arguments\":\"{\\\"q\\\":\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[",
            "{\"index\":0,\"function\":{\"name\":\"price\",\"arguments\":\"1}\"}}]}}]}\n\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[",
            "{\"index\":1,\"id\":\"call_b\",\"function\":{\"name\":\"other\",\"arguments\":\"{}\"}}]}}]}\n\n",
            "data: {not json}\n\n",
            "data: {\"usage\":{\"cost\":0.01}}\n\n",
            "data: [DONE]\n\n",
        )
        .as_bytes();

        let expected = vec![
            StreamToolCall {
                id: "call_a".into(),
                name: "get_price".into(),
                arguments: "{\"q\":1}".into(),
            },
            StreamToolCall { id: "call_b".into(), name: "other".into(), arguments: "{}".into() },
        ];

        for split in 0..=body.len() {
            let (mut reasoning, mut content) = (String::new(), String::new());
            let mut decoder = SseDecoder::default();
            {
                let mut sink = |d: Delta| match d {
                    Delta::Reasoning(r) => reasoning.push_str(r),
                    Delta::Content(c) => content.push_str(c),
                };
                decoder.push(&body[..split], &mut sink);
                decoder.push(&body[split..], &mut sink);
            }
            assert_eq!(reasoning, "hmm…", "split at {split}");
            assert_eq!(content, "héllo 🙂 wörld", "split at {split}");
            assert_eq!(decoder.finish(), expected, "split at {split}");
        }

        // byte-at-a-time is the worst case a real socket can produce
        let (mut reasoning, mut content) = (String::new(), String::new());
        let mut decoder = SseDecoder::default();
        {
            let mut sink = |d: Delta| match d {
                Delta::Reasoning(r) => reasoning.push_str(r),
                Delta::Content(c) => content.push_str(c),
            };
            for b in body {
                decoder.push(&[*b], &mut sink);
            }
        }
        assert_eq!(reasoning, "hmm…");
        assert_eq!(content, "héllo 🙂 wörld");
        assert_eq!(decoder.finish(), expected);
    }

    #[test]
    fn stray_frames_are_skipped_not_fatal() {
        let mut seen = String::new();
        let mut decoder = SseDecoder::default();
        {
            let mut sink = |d: Delta| {
                if let Delta::Content(c) = d {
                    seen.push_str(c);
                }
            };
            // CRLF endings, a comment, an event: line, a malformed frame, a frame
            // with no delta, and [DONE] — then a real delta still lands
            for line in [
                ": ping\r\n",
                "event: message\r\n",
                "data: nonsense\r\n",
                "data: {\"choices\":[]}\r\n",
                "data: {\"choices\":[{\"delta\":null}]}\r\n",
                "data: [DONE]\r\n",
                "\r\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\r\n",
                // never terminated by a newline — dropped, as the TypeScript did
                "data: {\"choices\":[{\"delta\":{\"content\":\"lost\"}}]}",
            ] {
                decoder.push(line.as_bytes(), &mut sink);
            }
        }
        assert_eq!(seen, "ok");
        assert!(decoder.finish().is_empty());
    }

    #[test]
    fn argument_only_fragments_without_a_name_are_dropped() {
        let mut decoder = SseDecoder::default();
        decoder.push(
            b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{}\"}}]}}]}\n",
            &mut |_| {},
        );
        assert!(decoder.finish().is_empty());
    }
}

