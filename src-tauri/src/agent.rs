//! Port of the agent half of lib/interpreter.ts, plus the client-safe helpers
//! from lib/agent.ts and the two variable-sentinel helpers from lib/registry.ts
//! that the interpreter's chip handling needs.
//!
//! GRAPH SEMANTICS ONLY. The model turn and the tool call are injected as `fn`
//! pointers: the golden fixtures wire the deterministic stubs from
//! `fixtures/run.mjs`, production wires `unavailable_*` until Phase D lands the
//! OpenRouter and MCP clients. That split is the whole reason this file is
//! checkable — the loop, the caps and the grant resolution are exercised for
//! real against the frozen transcripts, with nothing on the network.

use crate::interpreter::{truncate, utf16_prefix, Kind};

pub const MAX_AGENT_TURNS: u32 = 8; // LLM calls per agent loop
pub const MAX_AGENT_MESSAGES: usize = 60; // transcript length cap per model call
pub const MAX_TOOL_CALLS_PER_TURN: usize = 5;
// agent-initiated MCP calls (the only MCP execution path) — keep a busy agent
// loop from hammering an MCP server
pub const MAX_AGENT_MCP_CALLS: u32 = 40;
// grants are edges from chip nodes into the agent's tools/skills ports. A memory
// store adds three tools of its own server-side, so 20 tools + a store is 17
// usable MCP grants — see docs/nodes.md.
pub const MAX_GRANTED_TOOLS: usize = 20;
pub const MAX_GRANTED_SKILLS: usize = 10;
pub const MAX_EXCLUDED_TOOLS: usize = 40;
// tool output fed back to the model — larger than the console cap, the model
// usually needs more of the result than a human skimming a log
const MAX_MODEL_RESULT_CHARS: usize = 24_000;

/// Sentinel toolName of the MCP server grant chip (node type `mcp:<uuid>:*`).
/// No real tool is ever named `*`, so it cannot collide.
pub const ALL_TOOLS: &str = "*";

/// A granted MCP tool, resolved to its registry entry. `exclude` is meaningful
/// only on an ALL_TOOLS ref (empty = grant everything the server enables).
#[derive(Clone)]
pub struct ToolRef {
    pub entry_id: String,
    pub tool_name: String,
    pub exclude: Vec<String>,
}

/// A model-requested tool call, decoded back to registry terms. The wire-format
/// call id has no graph-observable effect (a transcript message is opaque to the
/// fixtures), so Phase D adds it with the OpenRouter client that needs it.
pub struct ToolCall {
    pub entry_id: String,
    pub tool_name: String,
    pub arguments: String,
}

// The model-call payload. Everything below is built and budgeted for real here,
// but only the fixture stub reads it back — production's `unavailable_turn`
// never looks. Drop the three allows with the Phase D OpenRouter client.
#[allow(dead_code)]
pub struct Message {
    pub role: &'static str, // "user" | "assistant" | "tool"
    pub content: String,
}

#[allow(dead_code)]
pub struct Request {
    pub model: String,
    pub system: String,
    pub skill_ids: Vec<String>,
    pub tools: Vec<ToolRef>,
    /// the attached memory store, if any — its three tools are prepended
    /// server-side, and a tool call naming it routes to the local store
    pub memory_id: Option<String>,
    pub messages: Vec<Message>,
    pub output_image: bool,
    /// raw mode from the agent node ("off"|"low"|"medium"|"high"); the model
    /// client allowlists it
    pub reasoning: Option<String>,
}

#[allow(dead_code)]
pub enum Turn {
    Reply {
        content: String,
        tool_calls: Vec<ToolCall>,
        /// a data:image/… URL, only ever set on an output=image turn
        image: Option<String>,
    },
    Failed(String),
}

pub fn unavailable_turn(_: &Request) -> Turn {
    Turn::Failed("model calls land in Phase D".into())
}

pub fn unavailable_tool(_: bool, _: &str, _: &str, _: &str) -> Result<String, String> {
    Err("tool calls land in Phase D".into())
}

/// "[image · image/png · 154 KB]" — log-safe stand-in for a data URL.
pub fn describe_image(url: &str) -> String {
    // `get` not indexing: the data URL comes back from the model, and a
    // multi-byte char straddling offset 5 would panic the run's thread
    let mime = url
        .find(';')
        .filter(|i| *i > 5)
        .and_then(|i| url.get(5..i))
        .unwrap_or("image");
    // JS indexOf returns -1 when absent, and the arithmetic keeps going. Both
    // operands must be counted in the same units as `.length`, i.e. UTF-16 —
    // a byte offset against a UTF-16 length mis-sizes any non-ASCII data URL.
    let comma = url
        .find(',')
        .map_or(-1, |i| url[..i].encode_utf16().count() as i64);
    let kb = ((url.encode_utf16().count() as f64 - comma as f64 - 1.0) * 3.0 / 4.0 / 1024.0).round();
    format!("[image · {mime} · {kb} KB]")
}

// --- node-type parsers ------------------------------------------------------
// Grants resolve statically from the source chip node's TYPE, never by
// evaluating it as a value. Fixed-offset slices, never split: an MCP tool name
// may contain ":".

/// `mcp:` is 4 chars, so the uuid spans [4,40) and ":" sits at 40; a valid tool
/// name is the non-empty remainder from 41. Retired per-tool types still parse —
/// the interpreter's catalog-entry gate drops those grants, not the parser.
pub fn tool_ref_from_node_type(node_type: &str) -> Option<ToolRef> {
    let b = node_type.as_bytes();
    if !node_type.starts_with("mcp:") || b.get(40) != Some(&b':') || b.len() <= 41 {
        return None;
    }
    Some(ToolRef {
        entry_id: node_type[4..40].to_string(),
        tool_name: node_type[41..].to_string(),
        exclude: Vec::new(),
    })
}

/// `skill:` is 6 chars; the whole type is exactly the prefix + a 36-char uuid
pub fn skill_id_from_node_type(node_type: &str) -> Option<String> {
    (node_type.starts_with("skill:") && node_type.encode_utf16().count() == 42)
        .then(|| node_type[6..].to_string())
}

/// `memory:` is 7 chars, so 43 total
pub fn memory_id_from_node_type(node_type: &str) -> Option<String> {
    (node_type.starts_with("memory:") && node_type.encode_utf16().count() == 43)
        .then(|| node_type[7..].to_string())
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// A secret variable box evaluates to this opaque sentinel; the plaintext
/// substitutes only in `integrations::execute`, so it never enters a log.
pub fn variable_id_from_node_type(node_type: &str) -> Option<&str> {
    node_type.strip_prefix("variable:").filter(|id| is_uuid(id))
}

pub fn variable_sentinel(id: &str) -> String {
    format!("{{{{var:{id}}}}}")
}

/// A server node's `config.exclude` holds a JSON array (as a string) of tool
/// names to withhold. `""`/absent → `Some([])` (all granted); `None` = malformed,
/// which callers warn about and then grant all, matching the fail-open expansion.
pub fn parse_tool_exclusions(raw: &str) -> Option<Vec<String>> {
    if raw.trim().is_empty() {
        return Some(Vec::new());
    }
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let items = parsed.as_array()?;
    if items.len() > MAX_EXCLUDED_TOOLS {
        return None;
    }
    items
        .iter()
        .map(|x| {
            x.as_str()
                .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 60)
                .map(str::to_string)
        })
        .collect()
}

// --- the loop ---------------------------------------------------------------

/// One LLM agent loop: call the model, execute its tool calls, feed the results
/// back, repeat until it answers without tools or a cap trips.
///
/// `Ok` is the agent's result (text, or a data URL on an image run). `Err` is a
/// message the caller must `fail()` with — the loop has already emitted every
/// line up to that point, so the error line lands in order.
///
/// `mcp_calls` is the run-scoped budget, shared across every agent node in the
/// graph. `call_tool`'s first argument routes to the local memory store instead
/// of an MCP server.
pub fn run_loop(
    req: &mut Request,
    user_text: &str,
    mcp_calls: &mut u32,
    emit: &mut dyn FnMut(Kind, String),
    call_model: fn(&Request) -> Turn,
    call_tool: fn(bool, &str, &str, &str) -> Result<String, String>,
) -> Result<String, String> {
    if req.model.is_empty() {
        return Err("agent: no model set".into());
    }
    req.messages.push(Message {
        role: "user",
        content: if user_text.is_empty() { "(no input)".into() } else { user_text.into() },
    });
    let mut content = String::new();
    for _ in 0..MAX_AGENT_TURNS {
        emit(Kind::Info, format!("agent: calling {}…", req.model));
        let (all_calls, image) = match call_model(req) {
            Turn::Failed(err) => return Err(format!("agent: {err}")),
            Turn::Reply { content: c, tool_calls, image } => {
                content = c;
                (tool_calls, image)
            }
        };
        let dropped = all_calls.len().saturating_sub(MAX_TOOL_CALLS_PER_TURN);
        let calls: Vec<ToolCall> = all_calls.into_iter().take(MAX_TOOL_CALLS_PER_TURN).collect();
        if dropped > 0 {
            emit(
                Kind::Warn,
                format!("agent: {dropped} tool call(s) over the per-turn cap ({MAX_TOOL_CALLS_PER_TURN}) dropped"),
            );
        }
        if calls.is_empty() {
            if req.output_image {
                if let Some(image) = image {
                    // the data URL never goes through truncate — return it whole
                    emit(Kind::Info, format!("agent → {}", describe_image(&image)));
                    return Ok(image);
                }
                emit(Kind::Warn, "agent: model returned no image — falling back to text".into());
            }
            let shown = if content.is_empty() { "(empty)" } else { &content };
            emit(Kind::Info, truncate(&format!("agent → {shown}")));
            return Ok(content);
        }
        req.messages.push(Message { role: "assistant", content: content.clone() });
        for call in &calls {
            // memory tools ride the same wire as MCP tools; the decoded call's
            // entryId is the store id, so route to the local store instead
            let is_memory = req.memory_id.as_deref() == Some(call.entry_id.as_str());
            *mcp_calls += 1;
            if *mcp_calls > MAX_AGENT_MCP_CALLS {
                return Err(format!(
                    "agent MCP call limit ({MAX_AGENT_MCP_CALLS}) exceeded for one run"
                ));
            }
            emit(Kind::Info, format!("agent: → {}…", call.tool_name));
            let text = match call_tool(is_memory, &call.entry_id, &call.tool_name, &call.arguments) {
                // feed the error back — the model can often recover
                Err(err) => {
                    emit(Kind::Warn, format!("agent: {}: {err}", call.tool_name));
                    format!("Error: {err}")
                }
                Ok(text) => {
                    let shown = if text.is_empty() { "(empty)" } else { &text };
                    emit(Kind::Info, truncate(&format!("agent: {} → {shown}", call.tool_name)));
                    text
                }
            };
            req.messages.push(Message {
                role: "tool",
                content: match utf16_prefix(&text, MAX_MODEL_RESULT_CHARS) {
                    Some(cut) => format!("{cut}… (truncated)"),
                    None => text,
                },
            });
        }
        // keep headroom for next turn's assistant + tool messages
        if req.messages.len() > MAX_AGENT_MESSAGES - MAX_TOOL_CALLS_PER_TURN - 1 {
            emit(Kind::Warn, "agent: transcript limit reached".into());
            return Ok(content);
        }
    }
    emit(Kind::Warn, format!("agent: turn limit ({MAX_AGENT_TURNS}) reached"));
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three fixed-offset parsers, at the offsets that decide a grant. The
    /// golden fixtures cover the happy paths; these pin the off-by-ones a graph
    /// cannot easily reach.
    #[test]
    fn node_type_parsers_slice_at_fixed_offsets() {
        let uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let all = tool_ref_from_node_type(&format!("mcp:{uuid}:*")).unwrap();
        assert_eq!((all.entry_id.as_str(), all.tool_name.as_str()), (uuid, "*"));
        // a tool name may contain ":" — splitting on ":" would truncate it here
        let named = tool_ref_from_node_type(&format!("mcp:{uuid}:a:b")).unwrap();
        assert_eq!(named.tool_name, "a:b");
        assert!(tool_ref_from_node_type(&format!("mcp:{uuid}:")).is_none()); // empty name
        assert!(tool_ref_from_node_type(&format!("mcp:{uuid}")).is_none());
        assert!(tool_ref_from_node_type(&format!("skill:{uuid}")).is_none());

        assert_eq!(skill_id_from_node_type(&format!("skill:{uuid}")).unwrap(), uuid);
        assert!(skill_id_from_node_type(&format!("skill:{uuid}x")).is_none());
        assert_eq!(memory_id_from_node_type(&format!("memory:{uuid}")).unwrap(), uuid);
        assert!(memory_id_from_node_type(&format!("memory:{uuid}x")).is_none());

        // the uuid shape gates the sentinel: a malformed one is not a variable
        assert_eq!(variable_id_from_node_type(&format!("variable:{uuid}")), Some(uuid));
        assert_eq!(variable_id_from_node_type("variable:not-a-uuid"), None);
        assert_eq!(variable_id_from_node_type(&format!("variable:{}", uuid.to_uppercase())), Some(&*uuid.to_uppercase()));
        assert_eq!(variable_sentinel(uuid), format!("{{{{var:{uuid}}}}}"));
    }

    #[test]
    fn tool_exclusions_fail_open_on_junk() {
        assert_eq!(parse_tool_exclusions(""), Some(vec![]));
        assert_eq!(parse_tool_exclusions("  "), Some(vec![]));
        assert_eq!(parse_tool_exclusions("[\"a\"]"), Some(vec!["a".into()]));
        assert_eq!(parse_tool_exclusions("not json"), None);
        assert_eq!(parse_tool_exclusions("{}"), None);
        assert_eq!(parse_tool_exclusions("[\"\"]"), None); // empty name
        assert_eq!(parse_tool_exclusions("[1]"), None);
        assert_eq!(parse_tool_exclusions(&format!("[{}]", vec!["\"a\""; 41].join(","))), None);
    }

    fn request(model: &str) -> Request {
        Request {
            model: model.into(),
            system: String::new(),
            skill_ids: vec![],
            tools: vec![],
            memory_id: None,
            messages: vec![],
            output_image: false,
            reasoning: None,
        }
    }

    fn always_calls_a_tool(_: &Request) -> Turn {
        Turn::Reply {
            content: "thinking".into(),
            tool_calls: vec![ToolCall {
                entry_id: "e".into(),
                tool_name: "t".into(),
                arguments: "{}".into(),
            }],
            image: None,
        }
    }

    fn ok_tool(_: bool, _: &str, _: &str, _: &str) -> Result<String, String> {
        Ok("ok".into())
    }

    /// The two caps no graph in `fixtures/` can reach: eight turns is more than
    /// any case drives, and the 40-call MCP budget is run-scoped, so a single
    /// agent (5 calls × 8 turns = exactly 40) can never trip it on its own.
    #[test]
    fn the_loop_stops_at_its_caps() {
        let (mut req, mut calls, mut lines) = (request("m"), 0, Vec::new());
        let content = run_loop(
            &mut req,
            "go",
            &mut calls,
            &mut |k, t| lines.push((k, t)),
            always_calls_a_tool,
            ok_tool,
        );
        assert_eq!(content.unwrap(), "thinking");
        assert_eq!(calls, MAX_AGENT_TURNS); // one tool call per turn, all eight
        assert_eq!(lines.last().unwrap().1, format!("agent: turn limit ({MAX_AGENT_TURNS}) reached"));
        // the user seed, then assistant + tool per turn
        assert_eq!(req.messages.len(), 1 + 2 * MAX_AGENT_TURNS as usize);

        // an earlier agent node in the same run having spent the budget
        let (mut req, mut calls) = (request("m"), MAX_AGENT_MCP_CALLS);
        let err = run_loop(&mut req, "go", &mut calls, &mut |_, _| {}, always_calls_a_tool, ok_tool);
        assert_eq!(
            err.unwrap_err(),
            format!("agent MCP call limit ({MAX_AGENT_MCP_CALLS}) exceeded for one run")
        );

        // a blank model is refused before any turn, so nothing is emitted
        let mut req = request("");
        let err = run_loop(&mut req, "go", &mut 0, &mut |_, _| {}, always_calls_a_tool, ok_tool);
        assert_eq!(err.unwrap_err(), "agent: no model set");
        assert!(req.messages.is_empty());
    }

    /// `data:image/png;base64,` + 4001 payload chars is exactly the fixture's
    /// image, and 3 KB is what the frozen transcript says.
    #[test]
    fn image_description_matches_js_arithmetic() {
        let url = format!("data:image/png;base64,{}", "Q".repeat(4001));
        assert_eq!(describe_image(&url), "[image · image/png · 3 KB]");
        assert_eq!(describe_image("nonsense"), "[image · image · 0 KB]");
    }
}
