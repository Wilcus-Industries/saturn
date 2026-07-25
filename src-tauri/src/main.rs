mod agent;
mod events;
mod gateway;
mod github;
mod http;
mod integrations;
mod interpreter;
mod mcp;
mod memory;
mod openrouter;
mod registry;
mod runner;
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
        Err("Invalid workflow id".into())
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
/// `event_payloads` seeds each platform event node with its canned sample
/// payload (`sampleEventPayload`, which stays in TypeScript) so a payload →
/// extract chain runs against realistic data.
#[tauri::command]
fn test_run(
    app: AppHandle,
    store: State<Store>,
    workflow_id: String,
    entry_node_ids: Option<Vec<String>>,
    event_payloads: Option<HashMap<String, String>>,
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
            event_payloads,
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

/// The GitHub poller's PAT, same write-only convention. Optional — without one
/// the poller still works on public repos, at the 60 req/hr unauthenticated
/// budget instead of 5,000.
#[tauri::command]
fn has_github_pat() -> bool {
    secrets::has(&KEYCHAIN, &Secret::GithubPat)
}

#[tauri::command]
fn set_github_pat(value: Option<String>, clear: bool) -> Result<(), String> {
    let value = trimmed_secret(value.as_deref(), registry::MAX_TOKEN, "Token too long")?;
    secrets::set(&KEYCHAIN, &Secret::GithubPat, value, clear)
}

// --- openrouter ------------------------------------------------------------

/// The model picker's catalogue. `None` (JS `null`) means LOCKED — no OpenRouter
/// key, so the toolbox hints at settings. `Some([])` means unlocked but the
/// fetch failed, which falls back to the blank model chip. The distinction
/// drives real UI, so it is one call rather than "has key" plus "list".
#[tauri::command(async)]
fn list_openrouter_models() -> Result<Option<Vec<openrouter::Model>>, String> {
    if !secrets::has(&KEYCHAIN, &Secret::OpenRouterKey) {
        return Ok(None);
    }
    // reqwest's blocking client must not be built on a runtime worker, and
    // `command(async)` hands the body to one — a plain std thread is neither.
    let models = std::thread::spawn(openrouter::list_models)
        .join()
        .map_err(|_| "openrouter models: worker panicked".to_string())?;
    // a failed fetch is [], not an error: unlocked-but-empty is a distinct UI
    // state from locked, and the TypeScript degraded the same way
    Ok(Some(models.unwrap_or_default()))
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
    registry::save_skill(&store, id.as_deref(), &name, &emoji, &description)
}

#[tauri::command]
fn save_memory_store(
    store: State<Store>,
    id: Option<String>,
    name: String,
    emoji: String,
    description: String,
) -> Result<String, String> {
    registry::save_memory_store(&store, id.as_deref(), &name, &emoji, &description)
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
/// The OAuth branch of the TypeScript is NOT here: starting the PKCE flow needs
/// a redirect target, and a desktop app has none until the loopback listener
/// lands. A 401 therefore surfaces as the connect error it always was for a
/// server with no stored token.
#[tauri::command(async)]
fn discover_mcp_tools(store: State<Store>, id: String) -> Result<usize, String> {
    let store = store.inner().clone();
    // `command(async)` keeps this off the main thread, but it hands the body to
    // a runtime-managed one — and reqwest's blocking client must not be built
    // there. A plain std thread, joined for the result, is both.
    std::thread::spawn(move || {
        let entry = registry::mcp_secrets(&store, &KEYCHAIN, &id)?.ok_or("Not found")?;
        let (token, _) = registry::fresh_mcp_token(&store, &KEYCHAIN, &entry)?;
        let discovered =
            mcp::discover_tools(&entry.server_url, token.as_deref()).map_err(|e| e.to_string())?;
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
    if !registry::is_uuid(&entry_id) {
        return Err("Invalid id".into());
    }
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
        .setup(|app| {
            // app_data_dir is ~/Library/Application Support/<bundle identifier>, so the
            // db path follows tauri.conf.json's identifier and cannot drift from it.
            let db = app.path().app_data_dir()?.join("saturn.db");
            app.manage(Store::open(&db)?);
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
                .icon(app.default_window_icon().expect("bundled icon").clone())
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
            set_workflow_active,
            delete_workflow,
            list_runs,
            test_run,
            stop_run,
            has_openrouter_key,
            set_openrouter_key,
            has_github_pat,
            set_github_pat,
            list_openrouter_models,
            list_registry,
            save_mcp_server,
            save_skill,
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
