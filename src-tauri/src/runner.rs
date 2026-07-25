//! Run execution + the cron scheduler. Ports executeWorkflowRun,
//! executeAgentTurn, executeMcpTool and runDueWorkflows (lib/runner.server.ts),
//! startScheduler (lib/scheduler.server.ts) and cronMatches (lib/cron.ts).
//!
//! This is also where the interpreter's three effects are wired to the real
//! clients — `integrations::execute`, `openrouter::chat_complete`, and
//! `mcp::call_tool` / `memory::execute_memory_tool`. The seam stays a parameter
//! rather than a hard-coded call so the golden fixtures keep driving the same
//! walk with deterministic stubs.
//!
//! lib/cron.ts is ported rather than replaced by a cron crate on purpose: it
//! deliberately ANDs day-of-month with day-of-week where standard cron ORs them
//! (the visual builder never restricts both), and it accepts only the grammar
//! that builder emits. A crate would silently disagree on exactly that rule.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::channel;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent;
use crate::interpreter::{js, run_workflow, utf16_prefix, ConsoleLine, Effects, Graph, Kind};
use crate::mcp::McpError;
use crate::openrouter::{self, ChatRequest, ToolParam, ToolSpec};
use crate::registry::{self, Entry};
use crate::secrets::{self, Secret, Vault};
use crate::store::{RunStatus, RunTrigger, Store, Workflow};

const MAX_RUNS_PER_TICK: usize = 25;
// duplicate-tick protection: a catch-up burst or a stray second tick for the
// same minute must be a no-op, not a second run
const CLAIM_GUARD_S: i64 = 50;
const MAX_CATCHUP_MINUTES: i64 = 5; // a long sleep must not burst-fire history
const MINUTE_MS: i64 = 60_000;
const MAX_LOG_LINES: usize = 300;
const MAX_LOG_LINE_CHARS: usize = 2_000;
/// Per-port sample cap for the `run-value` events. Deliberately NOT
/// `MAX_LOG_LINE_CHARS`: these feed the designer's extract path-picker, which
/// JSON.parses them, and every real event payload is longer than 2 000 chars —
/// cutting there would leave the picker with nothing to walk. This is the
/// picker's own MAX_SAMPLE_CHARS, so the cap costs nothing it was going to use.
/// No "… (truncated)" marker either: a marker is not a JSON suffix.
const MAX_SAMPLE_CHARS: usize = 500_000;
/// The model writes this argument blob, so it is bounded before it is parsed.
const MAX_TOOL_INPUT: usize = 65_536;
/// The system prompt is graph-authored and re-sent on every turn of the loop.
const MAX_SYSTEM_PROMPT: usize = 8192;
/// Model output kept per turn. Bounds what one reply can push into the
/// transcript the next turn re-sends, and into the run log.
const MAX_MODEL_CONTENT: usize = 20_000;
/// A generated-image data URL (~3 MB decoded). An image over this is dropped,
/// and the agent loop falls back to text with a warning.
const MAX_IMAGE_DATA_URL: usize = 4_194_304;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

// --- cron ------------------------------------------------------------------

/// plain non-negative integer within [min, max], else None (no ranges/steps/lists)
fn num(field: &str, min: u32, max: u32) -> Option<u32> {
    if field.is_empty() || !field.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: u32 = field.parse().ok()?;
    (n >= min && n <= max).then_some(n)
}

/// "*/n" step (minute field only), n a plain integer in [2, 30]
fn minute_step(field: &str) -> Option<u32> {
    num(field.strip_prefix("*/")?, 2, 30)
}

const FIELD_RANGES: [(u32, u32); 5] = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)];

fn is_valid_cron(fields: &[&str]) -> bool {
    fields.len() == 5
        && fields.iter().enumerate().all(|(i, f)| {
            *f == "*"
                || num(f, FIELD_RANGES[i].0, FIELD_RANGES[i].1).is_some()
                || (i == 0 && minute_step(f).is_some())
        })
}

/// Howard Hinnant's civil_from_days: days since the epoch -> (year, month, day).
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

/// [minute, hour, day-of-month, month, day-of-week] in UTC, matching the order
/// of cron's five fields.
fn utc_fields(at_ms: i64) -> [u32; 5] {
    let secs = at_ms.div_euclid(1000);
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (_, month, dom) = civil_from_days(days);
    // 1970-01-01 was a Thursday (getUTCDay() == 4)
    let dow = (days + 4).rem_euclid(7) as u32;
    [(sod / 60 % 60) as u32, (sod / 3600) as u32, dom, month, dow]
}

/// Does the cron fire at this instant? Evaluated against UTC fields. Plain AND
/// across all 5 fields — the standard dom/dow OR rule is deliberately skipped
/// because the builder never restricts both. Invalid cron never matches.
fn cron_matches(cron: &str, at_ms: i64) -> bool {
    let fields: Vec<&str> = cron.split_whitespace().collect();
    if !is_valid_cron(&fields) {
        return false;
    }
    let values = utc_fields(at_ms);
    fields.iter().enumerate().all(|(i, f)| {
        if *f == "*" {
            return true;
        }
        match if i == 0 { minute_step(f) } else { None } {
            Some(step) => values[i] % step == 0,
            None => f.parse::<u32>().is_ok_and(|n| n == values[i]),
        }
    })
}

// --- the effects -----------------------------------------------------------

/// The user's OpenRouter key. BYOK only: there is no platform key, no credits
/// ledger and no fallback — a missing key is a user-facing error at the point of
/// use, exactly where `getOpenrouterKey` returned null.
pub fn openrouter_key(vault: &dyn Vault) -> Option<String> {
    secrets::get(vault, &Secret::OpenRouterKey)
}

/// `MODEL_ID` from lib/agent.ts (`/^[\w.:/-]{1,128}$/`). The slug is graph-
/// authored and goes straight into the request body, so it is shape-checked
/// before it can carry anything else.
fn valid_model_id(s: &str) -> bool {
    (1..=128).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:/-".contains(&b))
}

fn to_param(p: &crate::mcp::McpToolParam) -> ToolParam {
    use crate::mcp::McpToolParamType as T;
    ToolParam {
        name: p.name.clone(),
        // the discovery-side enum and the wire-side JSON Schema type are the
        // same vocabulary; this is the one place they meet
        param_type: match p.param_type {
            T::String => "string",
            T::Number => "number",
            T::Boolean => "boolean",
            T::Array => "array",
            T::Object => "object",
        }
        .to_string(),
        required: p.required,
        description: p.description.clone(),
    }
}

/// `memoryToolSpecs` output in the shape `buildToolDefs` consumes. The two
/// modules describe a tool with different structs (memory's is `'static`, the
/// registry's is owned); this is the seam, not a third spec type.
fn memory_spec(m: crate::memory::ToolSpec) -> ToolSpec {
    ToolSpec {
        tool_ref: agent::ToolRef {
            entry_id: m.entry_id,
            tool_name: m.tool_name.to_string(),
            exclude: Vec::new(),
        },
        description: Some(m.description.to_string()),
        params: Some(
            m.params
                .iter()
                .map(|p| ToolParam {
                    name: p.name.to_string(),
                    param_type: p.kind.to_string(),
                    required: p.required,
                    description: Some(p.description.to_string()),
                })
                .collect(),
        ),
    }
}

/// One MCP tool call for a workflow run (`executeMcpTool`). Returns errors as
/// values, never as a panic, so the console and the run log can render them.
pub fn execute_mcp_tool(
    store: &Store,
    vault: &dyn Vault,
    entry_id: &str,
    tool_name: &str,
    input: &str,
) -> Result<String, String> {
    if !registry::is_uuid(entry_id) {
        return Err("invalid entry id".into());
    }
    if tool_name.is_empty() {
        return Err("no tool selected".into());
    }
    if input.encode_utf16().count() > MAX_TOOL_INPUT {
        return Err("input too long".into());
    }

    let entry = registry::mcp_secrets(store, vault, entry_id)?.ok_or("MCP server not found")?;
    let tool = entry.tools.iter().find(|t| t.name == tool_name);
    if !tool.is_some_and(|t| t.enabled) {
        return Err(format!("tool \"{tool_name}\" is not enabled"));
    }
    if !registry::can_call_tool(tool.expect("checked above")) {
        return Err(format!(
            "the server declares \"{tool_name}\" write-capable but it's granted read-only — allow read+write in settings"
        ));
    }

    // the model wrote this; anything that is not a JSON *object* is refused
    // before it can reach the server (an array or a scalar is not arguments)
    let args = match js::trim(input) {
        "" => js::J::O(Vec::new()),
        text => match js::parse(text) {
            Ok(parsed @ js::J::O(_)) => parsed,
            _ => return Err(r#"input must be a JSON object, e.g. {"symbol":"NVDA"}"#.into()),
        },
    };

    let (token, _) = registry::fresh_mcp_token(store, vault, &entry)?;
    crate::mcp::call_tool(&entry.server_url, tool_name, args, token.as_deref()).map_err(|err| {
        match err {
            // the OAuth connect flow needs a redirect target the desktop app
            // does not have yet — a manual auth token is the way through today
            McpError::AuthRequired(_) => {
                "authorization required — connect the server in settings".to_string()
            }
            McpError::Failed(message) => message,
        }
    })
}

/// The `tool` effect: an agent's granted-tool call, routed to the local memory
/// store or to its MCP server. `is_memory` is decided by the interpreter (the
/// decoded call's entryId is the attached store's id), never re-derived here.
pub fn execute_tool(
    store: &Store,
    vault: &dyn Vault,
    is_memory: bool,
    entry_id: &str,
    tool_name: &str,
    input: &str,
) -> Result<String, String> {
    if is_memory {
        // read per call, not per run: a key pasted into settings mid-run must
        // work on the next tool call, and `embed` names the missing-key error
        let key = openrouter_key(vault).unwrap_or_default();
        return crate::memory::execute_memory_tool(store, &key, entry_id, tool_name, input);
    }
    execute_mcp_tool(store, vault, entry_id, tool_name, input)
}

/// One LLM turn of an agent node's loop (`executeAgentTurn`): resolve grants
/// against the registry, inject skill instructions **by id** (never
/// caller-supplied text), call OpenRouter on the user's own key.
///
/// `registry` is read once per run rather than per turn. The hosted version
/// re-read it behind a TTL cache, so it was already stale within a run; on a
/// single-user desktop app nothing else can be editing it mid-run.
pub fn execute_agent_turn(vault: &dyn Vault, rows: &[Entry], req: &agent::Request) -> agent::Turn {
    match agent_turn(vault, rows, req) {
        Ok(turn) => turn,
        Err(message) => agent::Turn::Failed(message),
    }
}

fn agent_turn(
    vault: &dyn Vault,
    rows: &[Entry],
    req: &agent::Request,
) -> Result<agent::Turn, String> {
    if !valid_model_id(&req.model) {
        return Err("invalid model id".into());
    }
    if req.system.encode_utf16().count() > MAX_SYSTEM_PROMPT {
        return Err("system prompt too long".into());
    }
    if req.skill_ids.len() > agent::MAX_GRANTED_SKILLS {
        return Err("too many skills".into());
    }
    if !req.skill_ids.iter().all(|id| registry::is_uuid(id)) {
        return Err("invalid skill id".into());
    }
    if req.memory_id.as_deref().is_some_and(|id| !registry::is_uuid(id)) {
        return Err("invalid memory store".into());
    }
    if req.tools.len() > agent::MAX_GRANTED_TOOLS {
        return Err("too many tools".into());
    }

    // Resolve grants against the registry — reject outright on any mismatch
    // instead of silently dropping (a granted-but-unavailable tool is a
    // misconfiguration the user must see, not something the model should
    // hallucinate around). `execute_mcp_tool` re-checks at execution time.
    //
    // A server chip (tool_name == ALL_TOOLS) is the exception: it expands to
    // every enabled + callable tool minus the node's exclude selection,
    // silently skipping off, write-mismatched or excluded ones — "all the tools
    // that are usable", never an error. Stale excluded names simply never match.
    let mcp_row = |id: &str| rows.iter().find(|r| r.id == id && r.kind == "mcp");
    let mut specs: Vec<ToolSpec> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new(); // "<entry>:<tool>", across chips
    for grant in &req.tools {
        let row = mcp_row(&grant.entry_id);
        if grant.tool_name == agent::ALL_TOOLS {
            let row = row.ok_or("MCP server not found")?;
            for tool in &row.tools {
                if !tool.enabled
                    || !registry::can_call_tool(tool)
                    || grant.exclude.contains(&tool.name)
                {
                    continue;
                }
                if seen.insert(format!("{}:{}", grant.entry_id, tool.name)) {
                    specs.push(ToolSpec {
                        tool_ref: agent::ToolRef {
                            entry_id: grant.entry_id.clone(),
                            tool_name: tool.name.clone(),
                            exclude: Vec::new(),
                        },
                        description: tool.description.clone(),
                        params: tool.params.as_ref().map(|p| p.iter().map(to_param).collect()),
                    });
                }
            }
            continue;
        }
        let tool = row.and_then(|r| r.tools.iter().find(|t| t.name == grant.tool_name));
        if !tool.is_some_and(|t| t.enabled) {
            return Err(format!("tool \"{}\" is not enabled", grant.tool_name));
        }
        let tool = tool.expect("checked above");
        if !registry::can_call_tool(tool) {
            return Err(format!(
                "the server declares \"{}\" write-capable but it's granted read-only — allow read+write in settings",
                grant.tool_name
            ));
        }
        if seen.insert(format!("{}:{}", grant.entry_id, grant.tool_name)) {
            specs.push(ToolSpec {
                tool_ref: grant.clone(),
                description: tool.description.clone(),
                params: tool.params.as_ref().map(|p| p.iter().map(to_param).collect()),
            });
        }
    }
    // one general-server chip is a single edge but expands past the grant cap
    specs.truncate(agent::MAX_GRANTED_TOOLS);

    let mut system = req.system.clone();
    for id in &req.skill_ids {
        let row = rows
            .iter()
            .find(|r| &r.id == id && r.kind == "skill")
            .ok_or("skill not found")?;
        system.push_str(&format!("\n\n## Skill: {}\n{}", row.name, row.description));
    }
    // A missing memory store is rejected outright, never silently dropped — a
    // granted-but-gone resource is a misconfiguration the user must see. Its
    // tools are prepended AFTER the MAX_GRANTED_TOOLS truncation above, so they
    // always survive the cap AND sit at the head: head position reserves the
    // clean wire names (build_tool_defs renames the later collider, not the
    // first). With memory attached an agent gets at most 17 MCP tools.
    if let Some(memory_id) = &req.memory_id {
        let row = rows
            .iter()
            .find(|r| &r.id == memory_id && r.kind == "memory")
            .ok_or("memory store not found")?;
        system.push_str(&format!(
            "\n\n## Memory: {}\n{}\nSearch before answering questions that may involve prior context; save durable facts (not transcripts); forget stale items by id.",
            row.name, row.description
        ));
        let memory_specs: Vec<ToolSpec> =
            crate::memory::memory_tool_specs(memory_id).into_iter().map(memory_spec).collect();
        specs.splice(0..0, memory_specs);
    }

    let api_key =
        openrouter_key(vault).ok_or("model calls need an OpenRouter key: add one in settings")?;

    let openrouter::ChatResult { content, tool_calls, images } = openrouter::chat_complete(
        &api_key,
        &ChatRequest {
            model: &req.model,
            system: &system,
            messages: &req.messages,
            tools: &specs,
            output_image: req.output_image,
            // image output is single-turn — reasoning does not apply
            reasoning: req.reasoning.as_deref().filter(|_| !req.output_image),
        },
    )?;

    // the image rides its own field so the content cap never touches the data
    // URL; an oversized one is dropped and the loop falls back to text
    let image = images
        .into_iter()
        .find(|u| u.encode_utf16().count() <= MAX_IMAGE_DATA_URL)
        .filter(|_| req.output_image);
    Ok(agent::Turn::Reply {
        content: utf16_prefix(&content, MAX_MODEL_CONTENT).unwrap_or(content),
        tool_calls,
        image,
    })
}

// --- one run ---------------------------------------------------------------

/// Executes one workflow and persists its `workflow_run` row. Blocks until the
/// run finishes; console lines stream to the webview as they are produced, not
/// batched at the end.
///
/// The interpreter gets its own std thread and this one drains the channel.
/// That is not decoration: reqwest's blocking client must not be built on a
/// tokio worker, and a fresh std thread is guaranteed clean of runtime context.
#[allow(clippy::too_many_arguments)] // every one of these is a real run seam
pub fn execute_run(
    app: Option<&AppHandle>,
    store: &Store,
    vault: &dyn Vault,
    wf: &Workflow,
    trigger: RunTrigger,
    entry_node_ids: Option<Vec<String>>,
    // node id → the trigger payload JSON that node's value port hands the graph.
    // Only the event path seeds this; cron and manual runs pass None, and an
    // event node with no entry here evaluates to "" exactly as before.
    event_payloads: Option<HashMap<String, String>>,
    // the designer's stop button. Only `test_run` passes one — a cron or event
    // run has no UI to press it from.
    cancel: Option<&'static AtomicBool>,
) -> Result<String, String> {
    let graph: Graph = serde_json::from_value(wf.graph.clone())
        .map_err(|e| format!("workflow graph is malformed: {e}"))?;
    let run_id = store.insert_run(&wf.id, trigger).map_err(|e| e.to_string())?;
    // a run that nobody asked for has just appeared in the history — nudge any
    // open page. Manual runs already have a caller that will refetch.
    data_changed(app, trigger);

    // One registry read per run feeds both the chip overlay (so an `mcp:…` node
    // renders as itself rather than "(deleted)") and every agent turn's grant
    // resolution. A read failure is not fatal: the walk still runs, chips just
    // resolve as missing, which is the safe direction.
    let rows = registry::get_user_registry(store, vault).unwrap_or_default();
    let catalog = registry::build_user_catalog(&rows);
    // Plaintext variable resolution happens ONLY here, at the point of
    // consumption. Without this lookup every `{{var:<uuid>}}` reaches the sender
    // literally and each sender's own validator rejects it.
    let lookup = registry::variable_lookup(store, vault);
    let send = |provider: &str, config: &_, message: &str| {
        crate::integrations::execute(provider, config, message, &lookup)
    };
    let model = |req: &agent::Request| execute_agent_turn(vault, &rows, req);
    let tool = |is_memory, entry_id: &str, tool_name: &str, input: &str| {
        execute_tool(store, vault, is_memory, entry_id, tool_name, input)
    };
    let effects = Effects { send: &send, model: &model, tool: &tool };

    let (tx, rx) = channel::<ConsoleLine>();

    // capped log capture — lines past the cap are counted, not stored; the last
    // error is tracked incrementally so truncation cannot lose it
    let mut log: Vec<Value> = Vec::new();
    let mut dropped = 0usize;
    let mut last_error = String::new();
    // A scope, not `thread::spawn`: the effects borrow the store, the vault and
    // the registry, and a detached thread would force all three to be 'static.
    // It is still a plain std thread — which is the requirement, since reqwest's
    // blocking client must not be built on a tokio worker.
    let (panicked, samples) = std::thread::scope(|scope| {
        let worker = scope.spawn(move || {
            run_workflow(
                &graph,
                entry_node_ids.as_deref(),
                event_payloads.as_ref(),
                Some(&catalog),
                &tx,
                effects,
                cancel,
            )
        });
        for line in rx {
            // An image line is a data:image/… URL the designer console renders
            // as an <img>, so it goes out whole: the char cap would corrupt the
            // base64. Its size is already bounded at the source by
            // MAX_IMAGE_DATA_URL, so no cap of its own is needed here.
            let is_image = line.kind == Kind::Image;
            let capped = if is_image {
                None
            } else {
                crate::interpreter::utf16_prefix(&line.text, MAX_LOG_LINE_CHARS)
            };
            // `trigger` rides along on all three run events so the designer can
            // tell its own test run from a cron or event run that happens to be
            // streaming on the same channel. Filtering on `runId` alone cannot:
            // `test_run` returns before the run row exists, so the id is unknown
            // until the first line arrives, and "first id wins" latches whichever
            // run spoke first — possibly the background one, which would silently
            // swallow every line the user was waiting for.
            if let Some(app) = app {
                let text = capped.as_deref().unwrap_or(&line.text);
                let _ =
                    app.emit("run-log", json!({ "runId": run_id, "trigger": trigger.as_str(), "kind": line.kind, "text": text }));
            }
            // never persist an image data URL — the char cap would corrupt the
            // base64 and bloat the stored log; keep a description instead
            let (kind, text) = if is_image {
                (Kind::Info, agent::describe_image(&line.text))
            } else {
                (line.kind, capped.unwrap_or(line.text))
            };
            if kind == Kind::Error {
                last_error = text.clone();
            }
            if log.len() >= MAX_LOG_LINES {
                dropped += 1;
                continue;
            }
            log.push(json!({ "kind": kind, "text": text }));
        }
        match worker.join() {
            Ok(values) => (false, values),
            Err(_) => (true, Vec::new()),
        }
    });

    // Per-port samples for the designer's extract path-picker (the TypeScript's
    // `onValue` hook). Emitted after the walk rather than streamed: the picker
    // reads them only when it opens, which is necessarily after the run, and the
    // designer kept them in a Map keyed "nodeId:portId" — so last-writer-wins
    // is the state it ends up in either way. Deduping to that state here turns
    // one IPC message per *evaluation* (up to MAX_STEPS of them) into one per
    // port. Ordering is guaranteed: every `run-value` precedes `run-finished`.
    if let Some(app) = app {
        let mut seen: HashMap<String, String> = HashMap::new();
        let mut order: Vec<(String, String)> = Vec::new();
        for (node_id, port_id, text) in samples {
            let key = format!("{node_id}:{port_id}");
            if seen.insert(key, text).is_none() {
                order.push((node_id, port_id));
            }
        }
        for (node_id, port_id) in order {
            let text = seen.remove(&format!("{node_id}:{port_id}")).unwrap_or_default();
            let text = utf16_prefix(&text, MAX_SAMPLE_CHARS).unwrap_or(text);
            let _ = app.emit(
                "run-value",
                json!({ "runId": run_id, "trigger": trigger.as_str(), "nodeId": node_id, "portId": port_id, "text": text }),
            );
        }
    }
    if dropped > 0 {
        log.push(json!({ "kind": "info", "text": format!("({dropped} lines truncated)") }));
    }

    // the interpreter *returns* after emitting its abort error line, so the
    // presence of an error line (not just a panic) decides the status
    let failed = panicked || !last_error.is_empty();
    let status = if failed { RunStatus::Error } else { RunStatus::Success };
    let error = if panicked {
        "run failed".to_string()
    } else {
        last_error
    };
    store
        .finish_run(&run_id, status, &error, &log)
        .map_err(|e| e.to_string())?;
    if let Some(app) = app {
        let _ = app.emit(
            "run-finished",
            json!({ "runId": run_id, "trigger": trigger.as_str(), "status": if failed { "error" } else { "success" }, "error": error }),
        );
    }
    data_changed(app, trigger);
    Ok(run_id)
}

/// The one app-wide "something changed behind your back, refetch" signal. No
/// payload and no per-table channels: the pages that care already refetch
/// everything they render, and a background run is the only thing that mutates
/// without an IPC caller standing by to refetch for itself.
///
/// Manual runs are excluded on purpose — `test_run`'s caller is the designer,
/// which is already following the run over `run-log`/`run-finished`, and firing
/// this too would make every page refetch twice.
fn data_changed(app: Option<&AppHandle>, trigger: RunTrigger) {
    if matches!(trigger, RunTrigger::Manual) {
        return;
    }
    if let Some(app) = app {
        let _ = app.emit("data-changed", ());
    }
}

// --- the tick --------------------------------------------------------------

/// Runs every active workflow whose schedule node matches the UTC minute
/// containing `at_ms`. Returns (due, ran) — ran is lower when the claim guard
/// rejects a workflow that already ran inside the guard window.
pub fn run_due_workflows(
    app: Option<&AppHandle>,
    store: &Store,
    vault: &dyn Vault,
    at_ms: i64,
) -> (usize, usize) {
    let Ok(workflows) = store.list_workflows() else {
        return (0, 0);
    };
    // match once and carry the node ids through — a workflow may hold several
    // schedule nodes with different crons, and only the matching ones fire
    let matched: Vec<(Workflow, Vec<String>)> = workflows
        .into_iter()
        .filter(|w| w.active)
        .filter_map(|w| {
            let graph: Graph = serde_json::from_value(w.graph.clone()).ok()?;
            let ids: Vec<String> = graph
                .nodes
                .iter()
                .filter(|n| {
                    n.node_type == "schedule"
                        && cron_matches(n.config.get("cron").map_or("", |c| c.trim()), at_ms)
                })
                .map(|n| n.id.clone())
                .collect();
            (!ids.is_empty()).then_some((w, ids))
        })
        .collect();
    if matched.is_empty() {
        return (0, 0);
    }

    // SQLite is single-writer, so each conditional UPDATE is already its own
    // atomic claim — the Postgres original only batched them into one statement
    // because pgbouncer made session advisory locks unusable.
    // scoped so the vault can be borrowed rather than cloned into each thread
    let ran = std::thread::scope(|scope| {
        let mut running = Vec::new();
        for (wf, entry_node_ids) in matched.iter().take(MAX_RUNS_PER_TICK) {
            if !matches!(store.claim_workflow(&wf.id, CLAIM_GUARD_S), Ok(true)) {
                continue;
            }
            let (app, store, wf, ids) =
                (app.cloned(), store.clone(), wf.clone(), entry_node_ids.clone());
            // one thread per claimed workflow: a slow HTTP node must not stall
            // its siblings or the next tick
            running.push(scope.spawn(move || {
                let _ =
                    execute_run(app.as_ref(), &store, vault, &wf, RunTrigger::Cron, Some(ids), None, None);
            }));
        }
        let ran = running.len();
        for handle in running {
            let _ = handle.join();
        }
        ran
    });
    (matched.len(), ran)
}

/// Self-arming per-minute tick, aligned just past :00. The next arm happens only
/// after the current tick finishes, so ticks never overlap. A long tick or a
/// laptop sleep skips minutes; the last processed minute is tracked and each
/// missed one is replayed (capped) so a sparse cron like "0 9 * * *" recovers.
/// Tight crons collapse: the claim guard turns the retro burst into one run.
pub fn start_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // the boot minute counts as handled — nothing before this process ran
        let mut last_minute = now_ms() - now_ms().rem_euclid(MINUTE_MS);
        loop {
            // +250ms past :00 absorbs timer drift either side of the boundary
            let wait = MINUTE_MS - now_ms().rem_euclid(MINUTE_MS) + 250;
            tokio::time::sleep(Duration::from_millis(wait as u64)).await;

            let now_minute = now_ms() - now_ms().rem_euclid(MINUTE_MS);
            let from =
                (last_minute + MINUTE_MS).max(now_minute - MAX_CATCHUP_MINUTES * MINUTE_MS);
            let mut minute = from;
            while minute <= now_minute {
                let app = app.clone();
                let store = app.state::<Store>().inner().clone();
                // the tick body is blocking (SQLite + joining run threads), so
                // it must not sit on a runtime worker
                let _ = tauri::async_runtime::spawn_blocking(move || {
                    let (due, ran) =
                        run_due_workflows(Some(&app), &store, &secrets::KEYCHAIN, minute);
                    if due > 0 {
                        println!("[scheduler] minute {minute} due={due} ran={ran}");
                    }
                })
                .await;
                last_minute = minute;
                minute += MINUTE_MS;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2023-11-14T22:15:00Z — minute 15, hour 22, dom 14, month 11, Tuesday (2)
    const T: i64 = 1_700_000_100_000;

    #[test]
    fn cron_fields_and_matching() {
        assert_eq!(utc_fields(0), [0, 0, 1, 1, 4]); // 1970-01-01 was a Thursday
        assert_eq!(utc_fields(T), [15, 22, 14, 11, 2]);
        assert_eq!(civil_from_days(19_782), (2024, 2, 29)); // leap day

        assert!(cron_matches("* * * * *", T));
        assert!(cron_matches("15 22 * * *", T));
        assert!(cron_matches("*/5 * * * *", T));
        assert!(cron_matches("15 22 14 11 2", T));
        assert!(!cron_matches("16 22 * * *", T));
        assert!(!cron_matches("*/4 * * * *", T)); // 15 % 4 != 0
        // dom AND dow, not the standard OR: a graph restricting both must match
        // both, which is what the visual builder's grammar means
        assert!(!cron_matches("15 22 14 11 3", T));
        // grammar the builder cannot emit never matches, it does not throw
        assert!(!cron_matches("0-30 * * * *", T));
        assert!(!cron_matches("1,2 * * * *", T));
        assert!(!cron_matches("*/5 */5 * * *", T)); // steps are minute-only
        assert!(!cron_matches("60 * * * *", T)); // out of range
        assert!(!cron_matches("* * * *", T)); // wrong arity
        assert!(!cron_matches("", T));
    }

    /// A FakeVault, never the real Keychain: `execute_run` reads the registry
    /// (and therefore secrets) on every run, and a test must not touch the
    /// user's login keychain.
    fn temp_store() -> (std::path::PathBuf, Store, secrets::FakeVault) {
        let dir = std::env::temp_dir().join(format!("saturn-runner-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&dir.join("saturn.db")).unwrap();
        (dir, store, secrets::FakeVault::default())
    }

    /// The whole slice: a schedule node the cron tick selects, an http-request
    /// node that really talks to a socket, and a print node rendering its
    /// response — claimed, executed, and persisted as a workflow_run row.
    #[test]
    fn schedule_http_print_end_to_end() {
        let port = crate::http::spawn_test_server(vec![concat!(
            "HTTP/1.1 200 OK\r\n",
            "content-type: application/json\r\n",
            "content-length: 17\r\n",
            "connection: close\r\n\r\n",
            "{\"greeting\":\"hi\"}"
        )]);
        let (dir, store, vault) = temp_store();
        let graph = json!({
            "nodes": [
                { "id": "s", "type": "schedule", "x": 0, "y": 0, "config": { "cron": "*/5 * * * *" } },
                { "id": "h", "type": "integration:http-request", "x": 0, "y": 0,
                  "config": { "method": "GET", "url": format!("http://127.0.0.1:{port}/") } },
                { "id": "p", "type": "print", "x": 0, "y": 0, "config": { "message": "unused" } },
            ],
            "edges": [
                { "id": "e1", "from": { "nodeId": "s", "portId": "out" },
                  "to": { "nodeId": "h", "portId": "in" }, "kind": "flow" },
                { "id": "e2", "from": { "nodeId": "h", "portId": "out" },
                  "to": { "nodeId": "p", "portId": "in" }, "kind": "flow" },
                { "id": "e3", "from": { "nodeId": "h", "portId": "response" },
                  "to": { "nodeId": "p", "portId": "message" }, "kind": "value" },
            ],
        });
        let wf = store.create_workflow("slice", graph).unwrap();

        let (due, ran) = run_due_workflows(None, &store, &vault, T);
        assert_eq!((due, ran), (1, 1));

        let run = store.latest_run(&wf.id).unwrap().expect("no run row");
        assert_eq!(run.status, "success", "log: {:#}", run.log);
        assert_eq!(run.error, "");
        assert!(run.finished_at.unwrap() >= run.started_at);
        assert_eq!(run.trigger, "cron");

        let texts: Vec<&str> = run.log.as_array().unwrap()
            .iter().map(|l| l["text"].as_str().unwrap()).collect();
        assert_eq!(texts[0], "▶ run started");
        assert_eq!(texts[1], "running http request…");
        assert!(texts[2].starts_with("http request → {"), "{}", texts[2]);
        // the print node rendered the http node's response value, not its config
        // — in JSON.stringify's key order, which is not alphabetical
        assert_eq!(
            texts[3],
            r#"{"status":"200","contentType":"application/json","body":{"greeting":"hi"}}"#
        );
        assert_eq!(texts[4], "run finished (2 steps)");

        // the 50s claim guard makes a duplicate tick for the same minute a no-op
        let (due, ran) = run_due_workflows(None, &store, &vault, T);
        assert_eq!((due, ran), (1, 0));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A failed run still lands, with the error carried onto the row.
    #[test]
    fn a_failing_node_persists_as_an_error_run() {
        let (dir, store, vault) = temp_store();
        let graph = json!({
            "nodes": [
                { "id": "s", "type": "schedule", "x": 0, "y": 0, "config": { "cron": "* * * * *" } },
                { "id": "h", "type": "integration:http-request", "x": 0, "y": 0,
                  "config": { "url": "file:///etc/passwd" } },
            ],
            "edges": [
                { "id": "e1", "from": { "nodeId": "s", "portId": "out" },
                  "to": { "nodeId": "h", "portId": "in" }, "kind": "flow" },
            ],
        });
        let wf = store.create_workflow("bad scheme", graph).unwrap();
        execute_run(None, &store, &vault, &wf, RunTrigger::Manual, None, None, None).unwrap();

        let run = store.latest_run(&wf.id).unwrap().unwrap();
        assert_eq!(run.status, "error");
        assert_eq!(run.trigger, "manual");
        // the interpreter's own last error line wins, exactly as the TypeScript
        // recorded it; the cause is the line above it in the log
        assert_eq!(run.error, "run aborted");
        let texts: Vec<&str> = run.log.as_array().unwrap()
            .iter().map(|l| l["text"].as_str().unwrap()).collect();
        assert!(
            // the sender's message keeps the node label prefix the TypeScript
            // added on top of executeIntegration's own prefix
            texts.contains(&"http request: http request: Server URL must be http or https"),
            "{texts:?}",
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An image line is a data URL, and the 2 000-char cap would corrupt its
    /// base64 — so the persisted log keeps a description instead of the data.
    /// The `run-log` event is the other half (it carries the URL whole, for the
    /// designer's `<img>`); asserting that needs an AppHandle, which a test has
    /// no way to build, so this pins the sink that writes to the file.
    #[test]
    fn an_image_line_persists_as_a_description() {
        let (dir, store, vault) = temp_store();
        let url = format!("data:image/png;base64,{}", "Q".repeat(4001));
        let graph = json!({
            "nodes": [
                { "id": "s", "type": "schedule", "x": 0, "y": 0, "config": {} },
                { "id": "v", "type": "string", "x": 0, "y": 0, "config": { "value": url } },
                { "id": "p", "type": "print", "x": 0, "y": 0, "config": { "message": "" } },
            ],
            "edges": [
                { "id": "e1", "from": { "nodeId": "s", "portId": "out" },
                  "to": { "nodeId": "p", "portId": "in" }, "kind": "flow" },
                { "id": "e2", "from": { "nodeId": "v", "portId": "out" },
                  "to": { "nodeId": "p", "portId": "message" }, "kind": "value" },
            ],
        });
        let wf = store.create_workflow("image", graph).unwrap();
        execute_run(None, &store, &vault, &wf, RunTrigger::Manual, None, None, None).unwrap();

        let log = store.latest_run(&wf.id).unwrap().unwrap().log;
        let lines = log.as_array().unwrap();
        let image = lines
            .iter()
            .find(|l| l["text"].as_str().unwrap().starts_with("[image"))
            .unwrap_or_else(|| panic!("no image line: {lines:?}"));
        assert_eq!(image["kind"], "info");
        assert_eq!(image["text"], "[image · image/png · 3 KB]");
        // and not a single byte of the payload reached the row
        assert!(!lines.iter().any(|l| l["text"].as_str().unwrap().contains("QQQ")), "{lines:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    fn run_log(store: &Store, vault: &dyn Vault, graph: Value) -> Vec<String> {
        let wf = store.create_workflow("wiring", graph).unwrap();
        execute_run(None, store, vault, &wf, RunTrigger::Manual, None, None, None).unwrap();
        store
            .latest_run(&wf.id)
            .unwrap()
            .unwrap()
            .log
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l["text"].as_str().unwrap().to_string())
            .collect()
    }

    /// PHASE C's BUG, PINNED. A fully built module that nothing calls is
    /// invisible to every other test in the tree, so these assert that a *graph*
    /// reaches each Phase D module — through the interpreter's effects, not by
    /// calling the module directly.
    ///
    /// Each stops at the last deterministic step before a socket: a missing
    /// OpenRouter key for the model turn, and the egress guard for MCP. No test
    /// here touches the network or the real Keychain.
    #[test]
    fn a_graph_reaches_the_agent_and_registry_modules() {
        let (dir, store, vault) = temp_store();
        // registry.rs + secrets.rs: a memory store and a secret variable, saved
        // through the real CRUD, with the value landing in the vault
        let memory_id = registry::save_memory_store(&store, None, "notes", "", "").unwrap();
        let variable_id =
            registry::save_variable(&store, &vault, None, "endpoint", "http://x", false, true)
                .unwrap();
        assert!(secrets::has(&vault, &Secret::Variable(&variable_id)));

        // the memory chip resolves through build_user_catalog: without the
        // registry overlay the agent node would warn "memory store unavailable"
        let log = run_log(
            &store,
            &vault,
            json!({
                "nodes": [
                    { "id": "s", "type": "schedule", "x": 0, "y": 0, "config": {} },
                    { "id": "m", "type": format!("memory:{memory_id}"), "x": 0, "y": 0, "config": {} },
                    { "id": "a", "type": "agent", "x": 0, "y": 0,
                      "config": { "model": "anthropic/claude-3.5-haiku", "system": "hi" } },
                ],
                "edges": [
                    { "id": "e1", "from": { "nodeId": "s", "portId": "out" },
                      "to": { "nodeId": "a", "portId": "in" }, "kind": "flow" },
                    { "id": "e2", "from": { "nodeId": "m", "portId": "memory" },
                      "to": { "nodeId": "a", "portId": "memory" }, "kind": "value" },
                ],
            }),
        );
        assert!(!log.iter().any(|l| l.contains("memory store unavailable")), "{log:?}");
        // openrouter.rs's entry point is one line past this: BYOK, and the key
        // gate is the last thing before the socket
        assert!(
            log.contains(&"agent: model calls need an OpenRouter key: add one in settings".into()),
            "{log:?}",
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The variable sentinel resolves at the point of consumption and nowhere
    /// else: the graph carries `{{var:<uuid>}}`, the Keychain holds the URL, and
    /// the http sender receives the plaintext. A broken `lookup` wiring leaves
    /// the sentinel literal and the sender says "Invalid server URL".
    #[test]
    fn a_secret_variable_resolves_only_inside_the_sender() {
        let port = crate::http::spawn_test_server(vec![
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok",
        ]);
        let (dir, store, vault) = temp_store();
        let id = registry::save_variable(
            &store,
            &vault,
            None,
            "endpoint",
            &format!("http://127.0.0.1:{port}/"),
            false,
            true,
        )
        .unwrap();

        let log = run_log(
            &store,
            &vault,
            json!({
                "nodes": [
                    { "id": "s", "type": "schedule", "x": 0, "y": 0, "config": {} },
                    { "id": "v", "type": format!("variable:{id}"), "x": 0, "y": 0, "config": {} },
                    { "id": "h", "type": "integration:http-request", "x": 0, "y": 0,
                      "config": { "method": "GET" } },
                ],
                "edges": [
                    { "id": "e1", "from": { "nodeId": "s", "portId": "out" },
                      "to": { "nodeId": "h", "portId": "in" }, "kind": "flow" },
                    { "id": "e2", "from": { "nodeId": "v", "portId": "value" },
                      "to": { "nodeId": "h", "portId": "url" }, "kind": "value" },
                ],
            }),
        );
        assert!(log.iter().any(|l| l.contains(r#""body":"ok""#)), "{log:?}");
        // and the plaintext never entered the log — only the sentinel ever does
        assert!(!log.iter().any(|l| l.contains("127.0.0.1")), "{log:?}");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The tool effect, both branches. `is_memory` picks the module, and each
    /// one's own first guard fires — which is only possible if the call arrived.
    #[test]
    fn the_tool_effect_reaches_memory_and_mcp() {
        let (dir, store, vault) = temp_store();
        let memory_id = registry::save_memory_store(&store, None, "notes", "", "").unwrap();
        // memory.rs: dispatch guard, then embed's BYOK gate — no key, no socket
        assert_eq!(
            execute_tool(&store, &vault, true, &memory_id, "memory_nope", "{}"),
            Err("unknown memory operation".into()),
        );
        assert_eq!(
            execute_tool(&store, &vault, true, &memory_id, "memory_search", r#"{"query":"x"}"#),
            Err("model calls need an OpenRouter key: add one in settings".into()),
        );

        // mcp.rs: saved past the save-time URL guard through the injected seam,
        // so the *fetch-time* egress guard is what refuses it. A literal private
        // address needs no resolver, so nothing leaves this process.
        let mcp_id = registry::save_mcp_server_with(
            &store,
            &vault,
            None,
            "internal",
            "https://169.254.169.254/mcp",
            "",
            false,
            r#"[{"name":"read","access":"read","enabled":true}]"#,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(
            execute_tool(&store, &vault, false, &mcp_id, "read", "{}"),
            Err("Server URL must be a public host".into()),
        );
        // and the pre-flight checks that never reach the client at all
        assert_eq!(
            execute_tool(&store, &vault, false, &mcp_id, "write", "{}"),
            Err("tool \"write\" is not enabled".into()),
        );
        assert_eq!(
            execute_tool(&store, &vault, false, &mcp_id, "read", "[1]"),
            Err(r#"input must be a JSON object, e.g. {"symbol":"NVDA"}"#.into()),
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `executeAgentTurn`'s validation order and its grant resolution, which is
    /// the only thing standing between a graph and a tool it was never granted.
    #[test]
    fn agent_turns_validate_before_they_resolve() {
        let (dir, _store, vault) = temp_store();
        let rows = Vec::new();
        let req = |f: &dyn Fn(&mut agent::Request)| {
            let mut r = agent::Request {
                model: "anthropic/claude-3.5-haiku".into(),
                system: String::new(),
                skill_ids: vec![],
                tools: vec![],
                memory_id: None,
                messages: vec![],
                output_image: false,
                reasoning: None,
            };
            f(&mut r);
            r
        };
        let failure = |r: agent::Request| match execute_agent_turn(&vault, &rows, &r) {
            agent::Turn::Failed(message) => message,
            _ => panic!("expected a failure"),
        };

        assert_eq!(failure(req(&|r| r.model = "gpt 4".into())), "invalid model id");
        assert_eq!(failure(req(&|r| r.model = "a".repeat(129))), "invalid model id");
        assert_eq!(
            failure(req(&|r| r.system = "x".repeat(MAX_SYSTEM_PROMPT + 1))),
            "system prompt too long",
        );
        assert_eq!(
            failure(req(&|r| r.skill_ids = vec!["nope".into()])),
            "invalid skill id",
        );
        assert_eq!(
            failure(req(&|r| r.memory_id = Some("nope".into()))),
            "invalid memory store",
        );
        // a grant against an empty registry is an error, never a silent drop
        let grant = |name: &str| agent::ToolRef {
            entry_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into(),
            tool_name: name.into(),
            exclude: vec![],
        };
        assert_eq!(failure(req(&|r| r.tools = vec![grant("read")])), "tool \"read\" is not enabled");
        assert_eq!(failure(req(&|r| r.tools = vec![grant("*")])), "MCP server not found");
        assert_eq!(
            failure(req(&|r| r.skill_ids = vec!["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into()])),
            "skill not found",
        );
        assert_eq!(
            failure(req(&|r| r.memory_id = Some("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".into()))),
            "memory store not found",
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
