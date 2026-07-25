mod agent;
mod http;
mod integrations;
mod interpreter;
mod runner;
mod store;

use serde_json::{json, Value};
use store::{RunTrigger, Store, Workflow};
use tauri::{AppHandle, Manager, State};

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
        if let Err(err) = runner::execute_run(Some(&app), &store, &wf, RunTrigger::Manual, None) {
            eprintln!("[run] {err}");
        }
    });
    Ok(())
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
        .invoke_handler(tauri::generate_handler![list_workflows, create_workflow, test_run])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
