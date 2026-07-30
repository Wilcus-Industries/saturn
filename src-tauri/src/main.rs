mod agent;
mod bash;
mod events;
mod gateway;
mod github;
mod http;
mod integrations;
mod interpreter;
mod mcp;
mod memory;
mod openrouter;
mod providers;
mod registry;
mod runner;
mod saturn;
mod secrets;
mod store;
mod telegram;
mod workflow;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};
use registry::len16;
use secrets::{Secret, KEYCHAIN};
use store::{RunRow, RunTrigger, Store, Workflow, WorkflowCard};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

/// The id shape every workflow and registry command checks before it reaches
/// SQL. Postgres threw 22P02 on a malformed uuid, which is why the TypeScript
/// pre-validated; SQLite would silently match nothing, which is worse — a typo'd
/// id would read as "already deleted" instead of "invalid".
fn check_id(id: &str) -> Result<(), String> {
    if registry::is_uuid(id) {
        Ok(())
    } else {
        Err("Invalid id".into())
    }
}

// --- workflows -------------------------------------------------------------

/// The workflow list, each card carrying its newest run. Does NOT include the
/// graph — the cards never draw it and it is the largest column in the file.
#[tauri::command]
fn list_workflows(store: State<Store>) -> Result<Vec<WorkflowCard>, String> {
    store.list_workflow_cards().map_err(|e| e.to_string())
}

/// The designer's page load. `Not found` is an ordinary error, not a panic —
/// a stale window pointing at a deleted workflow is a normal thing to hit.
#[tauri::command]
fn get_workflow(store: State<Store>, id: String) -> Result<Workflow, String> {
    check_id(&id)?;
    store.workflow(&id).map_err(|e| e.to_string())?.ok_or_else(|| "Not found".into())
}

#[tauri::command]
fn create_workflow(
    store: State<Store>,
    name: String,
    emoji: Option<String>,
    description: Option<String>,
    graph: Option<Value>,
) -> Result<Workflow, String> {
    let (name, emoji, description) = parse_meta(&name, emoji.as_deref(), description.as_deref())?;
    let graph = graph.unwrap_or_else(|| json!({ "nodes": [], "edges": [] }));
    store.create_workflow_with(name, emoji, description, graph)
}

/// `parseWorkflowFields` — shared by create and update in the TypeScript, and it
/// has to stay shared here. The create path dropping the emoji and description
/// the modal submits, or skipping the blank-name check, is exactly what happens
/// when only one of the two gets ported.
fn parse_meta<'a>(
    name: &'a str,
    emoji: Option<&'a str>,
    description: Option<&'a str>,
) -> Result<(&'a str, &'a str, &'a str), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Name is required".into());
    }
    let emoji = match emoji.unwrap_or("").trim() {
        "" => "⚙️",
        e => e,
    };
    Ok((name, emoji, description.unwrap_or("").trim()))
}

/// Metadata only (`updateWorkflow`) — the graph, and the schedule inside it,
/// belong to `save_workflow`.
#[tauri::command]
fn update_workflow(
    store: State<Store>,
    id: String,
    name: String,
    emoji: String,
    description: String,
) -> Result<(), String> {
    check_id(&id)?;
    let (name, emoji, description) = parse_meta(&name, Some(&emoji), Some(&description))?;
    if store
        .update_workflow_meta(&id, name, emoji, description)
        .map_err(|e| e.to_string())?
    {
        Ok(())
    } else {
        Err("Not found".into())
    }
}

/// The designer's autosave (`saveWorkflow`). Validation and the
/// `subscriptions_changed()` wake both live in `store::set_graph` so no future
/// caller can save a graph past them.
#[tauri::command]
fn save_workflow(store: State<Store>, id: String, graph: Value) -> Result<(), String> {
    check_id(&id)?;
    if store.set_graph(&id, &graph)? {
        Ok(())
    } else {
        Err("Not found".into())
    }
}

/// Deep validation for the designer's issues panel and per-node dots — the one
/// implementation there is. `byKey` is deliberately NOT an argument: Rust
/// rebuilds it from the static catalog plus the user's registry, i.e. from the
/// database, which is what makes the designer and the run pipeline *unable* to
/// disagree about the same graph. Advisory only — `save_workflow` keeps
/// `check_graph` and nothing more, because the designer autosaves half-wired
/// graphs constantly.
#[tauri::command]
fn validate_graph(store: State<Store>, graph: Value) -> Result<workflow::Validation, String> {
    let rows = registry::get_user_registry(&store, &KEYCHAIN)?;
    let mut by_key: HashMap<String, interpreter::CatalogEntry> =
        interpreter::CATALOG.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    by_key.extend(registry::build_user_catalog(&rows));
    by_key.extend(saturn::session_catalog(&store));
    Ok(workflow::validate_graph_strict(&graph, &by_key, Some(has_github_pat())))
}

/// `active` gates scheduled and event execution only — a test run still works
/// when it is off. Explicit desired state, so a double-click is idempotent.
#[tauri::command]
fn set_workflow_active(store: State<Store>, id: String, active: bool) -> Result<(), String> {
    check_id(&id)?;
    if store.set_active(&id, active).map_err(|e| e.to_string())? {
        Ok(())
    } else {
        Err("Not found".into())
    }
}

/// Idempotent: a workflow another window already deleted is not an error.
#[tauri::command]
fn delete_workflow(store: State<Store>, id: String) -> Result<(), String> {
    check_id(&id)?;
    store.delete_workflow(&id).map_err(|e| e.to_string())
}

/// Run history for one workflow, newest first. 50 was the TypeScript's fixed
/// page size and stays the default.
#[tauri::command]
fn list_runs(store: State<Store>, workflow_id: String, limit: Option<i64>) -> Result<Vec<RunRow>, String> {
    check_id(&workflow_id)?;
    store
        .list_runs(&workflow_id, limit.unwrap_or(50).clamp(1, 200))
        .map_err(|e| e.to_string())
}

/// The designer's stop button. One flag, not a map keyed by run id: the designer
/// refuses to start a second test run while one is going, and it is the only
/// surface that can start one at all. `test_run` clears it before each run, so a
/// stop can never leak into the next one.
static TEST_RUN_CANCEL: AtomicBool = AtomicBool::new(false);

/// Test-runs a workflow. Returns as soon as the run is spawned; console lines
/// arrive as `run-log` events while it walks, the extract path-picker's per-port
/// samples as `run-value`, and `run-finished` closes it out.
///
/// `entry_node_ids` is the event node the designer selected — a test run starts
/// from exactly one entry point, not from every event node in the graph.
/// Sample event payloads are not passed in: `execute_run` seeds every event node
/// from `events::sample_payload`, i.e. from the transports' own builders.
#[tauri::command]
fn test_run(
    app: AppHandle,
    store: State<Store>,
    workflow_id: String,
    entry_node_ids: Option<Vec<String>>,
) -> Result<(), String> {
    let wf = store
        .workflow(&workflow_id)
        .map_err(|e| e.to_string())?
        .ok_or("workflow not found")?;
    let store = store.inner().clone();
    TEST_RUN_CANCEL.store(false, Ordering::Relaxed);
    // execute_run blocks until the run finishes, and reqwest's blocking client
    // must not be built on a runtime worker — a plain std thread is both
    std::thread::spawn(move || {
        if let Err(err) = runner::execute_run(
            Some(&app),
            &store,
            &KEYCHAIN,
            &wf,
            RunTrigger::Manual,
            entry_node_ids,
            None,
            Some(&TEST_RUN_CANCEL),
        ) {
            eprintln!("[run] {err}");
            // execute_run's own failures (a malformed graph, a SQLite write)
            // return before it can emit `run-finished`, and the designer clears
            // `running` on nothing else — so the topbar would stay on "stop" and
            // every later test run would be blocked for the life of the mount.
            // Same payload shape as the normal close-out, and `trigger` must be
            // "manual" or the designer's filter drops it on the floor.
            let _ = app.emit(
                "run-finished",
                json!({ "runId": null, "trigger": RunTrigger::Manual.as_str(), "status": "error", "error": err }),
            );
        }
    });
    Ok(())
}

/// Stops the running test run. Cooperative: the interpreter checks the flag
/// between flow steps and between agent turns/tool calls, so an in-flight HTTP
/// request or model call still finishes before the run unwinds with
/// "run stopped". Always succeeds — stopping nothing is a no-op.
#[tauri::command]
fn stop_run() {
    TEST_RUN_CANCEL.store(true, Ordering::Relaxed);
}

// --- saturn agent ----------------------------------------------------------

/// Streams one Saturn Agent turn. Returns as soon as the turn is spawned;
/// `saturn-delta` frames arrive as the model writes, and `saturn-done` closes it
/// out — the same frame vocabulary the hosted NDJSON stream used, because the
/// client's `apply()` is recovered verbatim.
///
/// `test_run`'s shape, deliberately: `#[tauri::command(async)]` would hand the
/// body to a tokio worker, and `stream_chat` builds a *blocking* reqwest client,
/// which must never happen there. A plain std thread is the requirement.
#[tauri::command]
fn saturn_send(
    app: AppHandle,
    store: State<Store>,
    session_id: String,
    model: String,
    reasoning: Option<String>,
    text: String,
    workflow_id: Option<String>,
) -> Result<(), String> {
    let store = store.inner().clone();
    // taken before the thread starts, so a stop pressed while the turn is
    // spawning still reaches it — and cleared here, never by `saturn_stop`
    let cancel = saturn::cancel_flag(&session_id);
    std::thread::spawn(move || {
        let frame = |t: &str, d: &str| {
            let _ = app.emit(
                "saturn-delta",
                json!({ "sessionId": session_id, "t": t, "d": d }),
            );
        };
        let mut emit = frame;
        let result = saturn::run_turn(
            &store,
            &KEYCHAIN,
            &saturn::TurnRequest {
                session_id: &session_id,
                model: &model,
                reasoning: reasoning.as_deref(),
                text: &text,
                workflow_id: workflow_id.as_deref(),
                nested: false,
            },
            &mut emit,
            Some(&cancel),
        );
        if let Err(err) = result {
            frame("e", &err);
        }
        // always, on every path: the composer clears `streaming` on nothing else
        let _ = app.emit("saturn-done", json!({ "sessionId": session_id }));
    });
    Ok(())
}

/// Stops the turn streaming in ONE session. Cooperative — `stream_chat` checks
/// the flag between socket reads and `run_turn` between tool calls, so an
/// in-flight request still finishes before the turn closes out. Always succeeds;
/// stopping nothing is a no-op.
///
/// Per session because a turn keeps running when the user switches chats, so the
/// one they land on can start its own: a process-wide flag would let either stop
/// button end both.
#[tauri::command]
fn saturn_stop(session_id: String) {
    saturn::cancel_session(&session_id);
}

#[tauri::command]
fn saturn_list_sessions(store: State<Store>) -> Result<Vec<saturn::SessionRow>, String> {
    saturn::list_sessions(&store)
}

#[tauri::command]
fn saturn_create_session(
    store: State<Store>,
    name: Option<String>,
) -> Result<saturn::SessionRow, String> {
    saturn::create_session(&store, name.as_deref())
}

#[tauri::command]
fn saturn_rename_session(store: State<Store>, id: String, name: String) -> Result<(), String> {
    saturn::rename_session(&store, &id, &name)
}

#[tauri::command]
fn saturn_delete_session(store: State<Store>, id: String) -> Result<(), String> {
    saturn::delete_session(&store, &id)
}

/// Saturn Agent's own builtin tools, saved exactly like an MCP server's
/// allowlist: the same `parse_tools` trust boundary, the same
/// `{name, access, enabled}` submission, the same tri-state. The list arrives
/// whole, so a tool the client drops is simply off — and one it invents is
/// discarded on the way back out by `saturn::merge_tools`.
///
#[tauri::command]
fn saturn_save_tools(store: State<Store>, tools: String) -> Result<(), String> {
    registry::set_saturn_tools(&store, registry::parse_tools(&tools)?)
}

/// The chat's working directory, tilde-abbreviated for the composer chip. Blank
/// in storage means `$HOME`, and this resolves it rather than returning `""` —
/// the UI shows the user where the shell will actually land, never a blank.
#[tauri::command]
fn saturn_cwd(store: State<Store>, session_id: String) -> Result<String, String> {
    let stored = saturn::session_cwd(&store, &session_id);
    Ok(bash::abbreviate(&bash::cwd_dir(&stored)?))
}

/// Store the folder the user picked. The picker only ever hands back a real
/// directory, but this is an IPC command like any other and the length and shape
/// checks are the trust boundary — `bash::valid_cwd` owns the shape rule so the
/// picker and `run_command` cannot disagree about which paths are legal.
#[tauri::command]
fn saturn_set_cwd(store: State<Store>, session_id: String, cwd: String) -> Result<(), String> {
    let cwd = cwd.trim();
    if len16(cwd) > registry::MAX_TOKEN {
        return Err("Directory path too long".into());
    }
    if !bash::valid_cwd(cwd) {
        return Err("Directory must be an absolute path, or start with ~/".into());
    }
    saturn::set_session_cwd(&store, &session_id, cwd)
}

#[tauri::command]
fn saturn_get_messages(
    store: State<Store>,
    session_id: String,
) -> Result<Vec<saturn::StoredMessage>, String> {
    saturn::get_messages(&store, &session_id)
}

// --- secrets ---------------------------------------------------------------

/// The whole read path for the OpenRouter key: a boolean. The key itself never
/// crosses IPC — that is the write-only convention, and widening it here would
/// undo the entire point of moving secrets to the Keychain.
#[tauri::command]
fn has_openrouter_key() -> bool {
    secrets::has(&KEYCHAIN, &Secret::OpenRouterKey)
}

/// Blank keeps the stored key, `clear` removes it — `saveOpenrouterKey` down to
/// its length cap, and nothing more.
#[tauri::command]
fn set_openrouter_key(value: Option<String>, clear: bool) -> Result<(), String> {
    let value = trimmed_secret(value.as_deref(), registry::MAX_TOKEN, "Key too long")?;
    secrets::set(&KEYCHAIN, &Secret::OpenRouterKey, value, clear)
}

/// Trim, then cap. Both halves were in the TypeScript (`saveOpenrouterKey` did
/// `String(...).trim()` before its length check) and both matter:
///
/// - a key pasted with a trailing newline is stored verbatim otherwise, and then
///   fails at OpenRouter as an opaque 401 that looks nothing like its cause;
/// - trimming to empty means "keep the stored value", which is the write-only
///   convention's blank case — so whitespace-only input correctly changes nothing.
///
/// The cap lives here rather than in `secrets::set`, which also writes the MCP
/// OAuth blob — legitimately larger than a token. Same ceiling and the same
/// UTF-16 counting as `registry::save_variable` and `save_mcp_server`.
fn trimmed_secret<'a>(
    value: Option<&'a str>,
    max: usize,
    too_long: &str,
) -> Result<Option<&'a str>, String> {
    let value = value.map(str::trim);
    if len16(value.unwrap_or("")) > max {
        return Err(too_long.into());
    }
    Ok(value)
}

/// The GitHub poller's PAT, same write-only convention. Optional for push,
/// issue, pr and release — those poll public repos fine at the 60 req/hr
/// unauthenticated budget instead of 5,000. **Required for `github-star`**,
/// which cannot 304 and would overrun that budget on its own, parking every
/// other watch with it; `github::Resource::pollable` skips it without one.
#[tauri::command]
fn has_github_pat() -> bool {
    secrets::has(&KEYCHAIN, &Secret::GithubPat)
}

#[tauri::command]
fn set_github_pat(value: Option<String>, clear: bool) -> Result<(), String> {
    let value = trimmed_secret(value.as_deref(), registry::MAX_TOKEN, "Token too long")?;
    secrets::set(&KEYCHAIN, &Secret::GithubPat, value, clear)
}

// --- models ----------------------------------------------------------------

/// One provider's slice of the model picker — `Provider.id` and `Provider.name`
/// verbatim, so the client never re-derives the `claude-code/` slug prefix that
/// `providers::resolve` owns.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderModels {
    provider: &'static str,
    label: &'static str,
    models: Vec<openrouter::Model>,
}

/// The model picker's catalogue, grouped by provider.
///
/// **A provider that is not connected is absent from the vec** — that IS the
/// "don't render a section you can't use" rule, so no caller branches on
/// credentials. An empty vec therefore means nothing is connected at all (the
/// toolbox hints at settings); an entry whose `models` is empty means connected
/// but the fetch failed, which falls back to the blank model chip. Both states
/// drive real UI, so this is one call rather than "which providers" plus "list".
#[tauri::command(async)]
fn list_models() -> Result<Vec<ProviderModels>, String> {
    let has_key = secrets::has(&KEYCHAIN, &Secret::OpenRouterKey);
    // reqwest's blocking client must not be built on a runtime worker, and
    // `command(async)` hands the body to one — a plain std thread is neither.
    let (remote, local) = std::thread::spawn(move || {
        (has_key.then(openrouter::list_models), providers::probe_claude_code(false))
    })
    .join()
    .map_err(|_| "models: worker panicked".to_string())?;

    let mut out = Vec::new();
    if has_key {
        out.push(ProviderModels {
            provider: providers::OPENROUTER.id,
            label: providers::OPENROUTER.name,
            // a failed fetch is [], not an error: connected-but-empty is a
            // distinct UI state, and the TypeScript degraded the same way
            models: remote.and_then(Result::ok).unwrap_or_default(),
        });
    }
    if let Some(models) = local {
        out.push(ProviderModels {
            provider: providers::CLAUDE_CODE.id,
            label: providers::CLAUDE_CODE.name,
            models,
        });
    }
    Ok(out)
}

/// One tile in Settings' provider grid. `enabled` means connected: a stored key
/// for OpenRouter, a reachable local server for Claude Code.
#[derive(serde::Serialize)]
struct ProviderStatus {
    id: &'static str,
    name: &'static str,
    enabled: bool,
}

/// Shares `list_models`' probe cache, so opening Settings costs one round trip
/// even though both commands run. `refresh` bypasses that cache — the modal's
/// re-check button is the one caller that must not be answered from it.
#[tauri::command(async)]
fn provider_status(refresh: bool) -> Result<Vec<ProviderStatus>, String> {
    // blocking probe → plain std thread, same rule as `list_models`
    let connected = std::thread::spawn(move || providers::probe_claude_code(refresh))
        .join()
        .map_err(|_| "provider status: worker panicked".to_string())?
        .is_some();
    // openrouter first: the frontend renders them in order
    Ok(vec![
        ProviderStatus {
            id: providers::OPENROUTER.id,
            name: providers::OPENROUTER.name,
            enabled: secrets::has(&KEYCHAIN, &Secret::OpenRouterKey),
        },
        ProviderStatus {
            id: providers::CLAUDE_CODE.id,
            name: providers::CLAUDE_CODE.name,
            enabled: connected,
        },
    ])
}

// --- registry --------------------------------------------------------------

#[tauri::command]
fn list_registry(store: State<Store>) -> Result<Vec<registry::Entry>, String> {
    registry::get_user_registry(&store, &KEYCHAIN)
}

#[tauri::command]
fn save_mcp_server(
    store: State<Store>,
    id: Option<String>,
    name: String,
    server_url: String,
    auth_token: String,
    clear_token: bool,
    tools: String,
) -> Result<String, String> {
    registry::save_mcp_server(
        &store,
        &KEYCHAIN,
        id.as_deref(),
        &name,
        &server_url,
        &auth_token,
        clear_token,
        &tools,
    )
}

#[tauri::command]
fn save_skill(
    store: State<Store>,
    id: Option<String>,
    name: String,
    emoji: String,
    description: String,
) -> Result<String, String> {
    registry::save_entry(&store, registry::Kind::Skill, id.as_deref(), &name, &emoji, &description)
}

#[tauri::command]
fn import_skill(store: State<Store>, path: String) -> Result<String, String> {
    registry::import_skill(&store, std::path::Path::new(&path))
}

#[tauri::command]
fn save_memory_store(
    store: State<Store>,
    id: Option<String>,
    name: String,
    emoji: String,
    description: String,
) -> Result<String, String> {
    registry::save_entry(&store, registry::Kind::Memory, id.as_deref(), &name, &emoji, &description)
}

#[tauri::command]
fn save_variable(
    store: State<Store>,
    id: Option<String>,
    name: String,
    value: String,
    clear_value: bool,
    secret: bool,
) -> Result<String, String> {
    registry::save_variable(&store, &KEYCHAIN, id.as_deref(), &name, &value, clear_value, secret)
}

#[tauri::command]
fn delete_registry_entry(store: State<Store>, id: String) -> Result<bool, String> {
    registry::delete_entry(&store, &KEYCHAIN, &id)
}

/// Connects to an MCP server and merges its advertised tools into the stored
/// allowlist (`discoverMcpTools`). Blocking — reqwest again, so it runs on its
/// own std thread via Tauri's async command bridge.
///
/// A 401 with no *manual* token starts the interactive OAuth flow — browser,
/// loopback redirect, code exchange — and retries discovery with the token it
/// just persisted. That makes Connect one button for both kinds of server, and
/// it is also the only way back from a revoked grant: hitting it again
/// re-authorizes. The wait is bounded by `mcp::CALLBACK_TIMEOUT` and the caller
/// shows a spinner for all of it.
#[tauri::command(async)]
fn discover_mcp_tools(store: State<Store>, id: String) -> Result<usize, String> {
    let store = store.inner().clone();
    // `command(async)` keeps this off the main thread, but it hands the body to
    // a runtime-managed one — and reqwest's blocking client must not be built
    // there. A plain std thread, joined for the result, is both.
    std::thread::spawn(move || {
        let entry = registry::mcp_secrets(&store, &KEYCHAIN, &id)?.ok_or("Not found")?;
        let (token, _) = registry::fresh_mcp_token(&store, &KEYCHAIN, &entry)?;
        let discovered = match mcp::discover_tools(&entry.server_url, token.as_deref()) {
            Ok(tools) => tools,
            // a 401 while holding the user's *manual* token is the server
            // rejecting that token, not an invitation to authorize. A 401 on an
            // OAuth token means the grant is gone — re-authorizing is the whole
            // way back, since nothing else clears a stale set.
            Err(mcp::McpError::AuthRequired(challenge)) if entry.auth_token.is_none() => {
                let authorized = mcp::authorize(&entry.server_url, &challenge)?;
                let fresh = registry::store_mcp_oauth(&store, &KEYCHAIN, &id, &authorized)?;
                mcp::discover_tools(&entry.server_url, Some(&fresh)).map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e.to_string()),
        };
        let merged = registry::merge_tools(&entry.tools, &discovered);
        let count = merged.len();
        registry::set_mcp_tools(&store, &id, merged)?;
        Ok(count)
    })
    .join()
    .map_err(|_| "discovery failed".to_string())?
}

// --- memory ----------------------------------------------------------------

#[tauri::command]
fn list_memory_items(
    store: State<Store>,
    entry_id: String,
    q: String,
) -> Result<Vec<memory::MemoryItemRow>, String> {
    memory::list_memory_items(&store, &entry_id, &q).map_err(|e| e.to_string())
}

#[tauri::command]
fn count_memory_items(store: State<Store>) -> Result<HashMap<String, i64>, String> {
    memory::count_memory_items(&store).map_err(|e| e.to_string())
}

/// Deletes one memory item (`deleteMemoryItem`). `id` is `MemoryItemRow.id`.
#[tauri::command]
fn delete_memory_item(store: State<Store>, id: String) -> Result<(), String> {
    memory::delete_memory_item(&store, &id)
}

// --- tray, window lifetime, login item -------------------------------------

/// Every way back to a hidden window routes through here: the tray's Open item,
/// a second launch, and the macOS dock click. `show` alone leaves the window
/// behind whatever the user is looking at, and `set_focus` alone does nothing to
/// a hidden window — both, in that order, or it only works by accident.
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Whether Saturn is registered as a login item.
#[tauri::command]
fn autostart_enabled(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// The plist records the path of the binary that registered it, so toggling this
/// on from `tauri dev` pins a `target/debug` build that will not exist after the
/// next `cargo clean`. The Settings copy says so; there is nothing to enforce it
/// with, since a debug build in /Applications would be a legitimate thing to run.
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let launcher = app.autolaunch();
    if enabled { launcher.enable() } else { launcher.disable() }.map_err(|e| e.to_string())
}

/// Empties a store without deleting it (`wipeMemoryStore`). The store's own row
/// stays, so every node wired to it keeps resolving.
#[tauri::command]
fn wipe_memory_store(store: State<Store>, entry_id: String) -> Result<usize, String> {
    check_id(&entry_id)?;
    store
        .conn()
        .execute("delete from memory_item where entry_id = ?1", [&entry_id])
        .map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        // First plugin, deliberately: it has to win the race before anything
        // else in this builder touches saturn.db.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_main(app)))
        // LaunchAgent rather than AppleScript: a plist starts the app the same
        // way whether or not Finder is up, and needs no automation permission
        // prompt. `None` — Saturn takes no argv, and a login-item launch should
        // land on exactly the same state a manual one does.
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        // The composer's folder picker, and the only thing this plugin is used
        // for. A native NSOpenPanel rather than a text field: the working
        // directory is now picked per chat, and typing a path is the wrong
        // gesture for something done that often. The webview calls
        // `plugin:dialog|open` through `lib/ipc.tsx`'s `call`, so no npm
        // package rides along for what is one IPC command.
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // app_data_dir is ~/Library/Application Support/<bundle identifier>, so the
            // db path follows tauri.conf.json's identifier and cannot drift from it.
            let db = app.path().app_data_dir()?.join("saturn.db");
            let store = Store::open(&db)?;
            // Saturn Agent owns its own two tables, like github.rs's cursor
            // table — created before anything can read them, and before the
            // window is up.
            saturn::init(&store)?;
            app.manage(store);
            // The four background loops. Each one reads `Store` out of managed
            // state, so all four must be started after `manage`. No supervisor:
            // a task that dies dies alone — which is already the isolation a
            // supervisor would buy — and each loop retries internally.
            //
            // Nothing here is tied to a window. Closing the window must not stop
            // the scheduler or drop a Gateway socket (Phase H makes close hide to
            // the tray); these tasks belong to the app process and outlive it.
            runner::start_scheduler(app.handle().clone());
            gateway::start_gateway(app.handle().clone());
            telegram::start(app.handle().clone());
            github::start(app.handle().clone());

            // The tray is what makes the four loops above worth running while
            // hidden: without it a closed window is unreachable and the only way
            // out is Activity Monitor.
            let open = MenuItem::with_id(app, "open", "Open Saturn", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Saturn", true, None::<&str>)?;
            TrayIconBuilder::new()
                // A template image, not the app icon: black shapes plus alpha,
                // which AppKit inverts for a dark menu bar and fills white while
                // the menu is open. The colour icon can do neither — it would
                // stay gold on both appearances and sit there unlit on click.
                // `include_bytes!` so a missing file is a build error rather
                // than a tray that silently comes up blank at runtime.
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Saturn")
                .menu(&Menu::with_items(app, &[&open, &quit])?)
                // macOS convention: left click opens, the menu is the right-click
                // gesture. Left-click-opens-menu would make Open a two-step.
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    // The only path that actually terminates the process. Every
                    // other exit route is prevented below, so this is where the
                    // scheduler and the three listeners stop.
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        // The whole point of Phase H. Closing the window must not stop the
        // scheduler, drop the Discord socket, or strand the pollers mid-cursor —
        // so the close button hides, and only tray-Quit exits.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_workflows,
            get_workflow,
            create_workflow,
            update_workflow,
            save_workflow,
            validate_graph,
            set_workflow_active,
            delete_workflow,
            list_runs,
            test_run,
            stop_run,
            saturn_send,
            saturn_stop,
            saturn_list_sessions,
            saturn_create_session,
            saturn_rename_session,
            saturn_delete_session,
            saturn_get_messages,
            saturn_save_tools,
            saturn_cwd,
            saturn_set_cwd,
            has_openrouter_key,
            set_openrouter_key,
            has_github_pat,
            set_github_pat,
            list_models,
            provider_status,
            list_registry,
            save_mcp_server,
            save_skill,
            import_skill,
            save_memory_store,
            save_variable,
            delete_registry_entry,
            discover_mcp_tools,
            list_memory_items,
            count_memory_items,
            delete_memory_item,
            wipe_memory_store,
            autostart_enabled,
            set_autostart,
        ])
        // `build` + `run` rather than plain `run`, for one event: clicking the
        // dock icon of an app whose only window is hidden. Without this it does
        // nothing at all, which reads as a hung app rather than a hidden one.
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Reopen { has_visible_windows: false, .. } = event {
                show_main(app);
            }
        });
}
