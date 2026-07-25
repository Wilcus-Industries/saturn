mod agent;
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

use std::collections::HashMap;

use serde_json::{json, Value};
use secrets::{Secret, KEYCHAIN};
use store::{RunTrigger, Store, Workflow};
use tauri::{AppHandle, Manager, State};

// --- workflows -------------------------------------------------------------

#[tauri::command]
fn list_workflows(store: State<Store>) -> Result<Vec<Workflow>, String> {
    store.list_workflows().map_err(|e| e.to_string())
}

#[tauri::command]
fn create_workflow(store: State<Store>, name: String, graph: Option<Value>) -> Result<Workflow, String> {
    let graph = graph.unwrap_or_else(|| json!({ "nodes": [], "edges": [] }));
    store.create_workflow(&name, graph).map_err(|e| e.to_string())
}

/// Test-runs a workflow. Returns as soon as the run is spawned; console lines
/// arrive as `run-log` events while it walks, and `run-finished` closes it out.
#[tauri::command]
fn test_run(app: AppHandle, store: State<Store>, workflow_id: String) -> Result<(), String> {
    let wf = store
        .workflow(&workflow_id)
        .map_err(|e| e.to_string())?
        .ok_or("workflow not found")?;
    let store = store.inner().clone();
    // execute_run blocks until the run finishes, and reqwest's blocking client
    // must not be built on a runtime worker — a plain std thread is both
    std::thread::spawn(move || {
        if let Err(err) = runner::execute_run(
            Some(&app),
            &store,
            &KEYCHAIN,
            &wf,
            RunTrigger::Manual,
            None,
        ) {
            eprintln!("[run] {err}");
        }
    });
    Ok(())
}

// --- secrets ---------------------------------------------------------------

/// The whole read path for the OpenRouter key: a boolean. The key itself never
/// crosses IPC — that is the write-only convention, and widening it here would
/// undo the entire point of moving secrets to the Keychain.
#[tauri::command]
fn has_openrouter_key() -> bool {
    secrets::has(&KEYCHAIN, &Secret::OpenRouterKey)
}

/// Blank keeps the stored key, `clear` removes it. `saveOpenrouterKey` was
/// exactly this and nothing more.
#[tauri::command]
fn set_openrouter_key(value: Option<String>, clear: bool) -> Result<(), String> {
    secrets::set(&KEYCHAIN, &Secret::OpenRouterKey, value.as_deref(), clear)
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
        .setup(|app| {
            // app_data_dir is ~/Library/Application Support/<bundle identifier>, so the
            // db path follows tauri.conf.json's identifier and cannot drift from it.
            let db = app.path().app_data_dir()?.join("saturn.db");
            app.manage(Store::open(&db)?);
            runner::start_scheduler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_workflows,
            create_workflow,
            test_run,
            has_openrouter_key,
            set_openrouter_key,
            list_registry,
            save_mcp_server,
            save_skill,
            save_memory_store,
            save_variable,
            delete_registry_entry,
            discover_mcp_tools,
            list_memory_items,
            count_memory_items,
            wipe_memory_store,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
