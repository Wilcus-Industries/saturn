//! Run execution + the cron scheduler. Ports executeWorkflowRun and
//! runDueWorkflows (lib/runner.server.ts), startScheduler
//! (lib/scheduler.server.ts) and cronMatches (lib/cron.ts).
//!
//! lib/cron.ts is ported rather than replaced by a cron crate on purpose: it
//! deliberately ANDs day-of-month with day-of-week where standard cron ORs them
//! (the visual builder never restricts both), and it accepts only the grammar
//! that builder emits. A crate would silently disagree on exactly that rule.

use std::sync::mpsc::channel;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::interpreter::{run_workflow, ConsoleLine, Graph, Kind};
use crate::store::{RunStatus, RunTrigger, Store, Workflow};

const MAX_RUNS_PER_TICK: usize = 25;
// duplicate-tick protection: a catch-up burst or a stray second tick for the
// same minute must be a no-op, not a second run
const CLAIM_GUARD_S: i64 = 50;
const MAX_CATCHUP_MINUTES: i64 = 5; // a long sleep must not burst-fire history
const MINUTE_MS: i64 = 60_000;
const MAX_LOG_LINES: usize = 300;
const MAX_LOG_LINE_CHARS: usize = 2_000;

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
fn civil_from_days(days: i64) -> (i64, u32, u32) {
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

// --- one run ---------------------------------------------------------------

/// Executes one workflow and persists its `workflow_run` row. Blocks until the
/// run finishes; console lines stream to the webview as they are produced, not
/// batched at the end.
///
/// The interpreter gets its own std thread and this one drains the channel.
/// That is not decoration: reqwest's blocking client must not be built on a
/// tokio worker, and a fresh std thread is guaranteed clean of runtime context.
pub fn execute_run(
    app: Option<&AppHandle>,
    store: &Store,
    wf: &Workflow,
    trigger: RunTrigger,
    entry_node_ids: Option<Vec<String>>,
) -> Result<String, String> {
    let graph: Graph = serde_json::from_value(wf.graph.clone())
        .map_err(|e| format!("workflow graph is malformed: {e}"))?;
    let run_id = store.insert_run(&wf.id, trigger).map_err(|e| e.to_string())?;

    let (tx, rx) = channel::<ConsoleLine>();
    let worker = std::thread::spawn(move || {
        run_workflow(&graph, entry_node_ids.as_deref(), &tx);
    });

    // capped log capture — lines past the cap are counted, not stored; the last
    // error is tracked incrementally so truncation cannot lose it
    let mut log: Vec<Value> = Vec::new();
    let mut dropped = 0usize;
    let mut last_error = String::new();
    for line in rx {
        let capped = crate::interpreter::utf16_prefix(&line.text, MAX_LOG_LINE_CHARS);
        let text = capped.unwrap_or(line.text);
        if line.kind == Kind::Error {
            last_error = text.clone();
        }
        if let Some(app) = app {
            let _ = app.emit("run-log", json!({ "runId": run_id, "kind": line.kind, "text": text }));
        }
        if log.len() >= MAX_LOG_LINES {
            dropped += 1;
            continue;
        }
        log.push(json!({ "kind": line.kind, "text": text }));
    }
    let panicked = worker.join().is_err();
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
            json!({ "runId": run_id, "status": if failed { "error" } else { "success" }, "error": error }),
        );
    }
    Ok(run_id)
}

// --- the tick --------------------------------------------------------------

/// Runs every active workflow whose schedule node matches the UTC minute
/// containing `at_ms`. Returns (due, ran) — ran is lower when the claim guard
/// rejects a workflow that already ran inside the guard window.
pub fn run_due_workflows(app: Option<&AppHandle>, store: &Store, at_ms: i64) -> (usize, usize) {
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
    let mut running = Vec::new();
    for (wf, entry_node_ids) in matched.iter().take(MAX_RUNS_PER_TICK) {
        if !matches!(store.claim_workflow(&wf.id, CLAIM_GUARD_S), Ok(true)) {
            continue;
        }
        let (app, store, wf, ids) =
            (app.cloned(), store.clone(), wf.clone(), entry_node_ids.clone());
        // one thread per claimed workflow: a slow HTTP node must not stall its
        // siblings or the next tick
        running.push(std::thread::spawn(move || {
            let _ = execute_run(app.as_ref(), &store, &wf, RunTrigger::Cron, Some(ids));
        }));
    }
    let ran = running.len();
    for handle in running {
        let _ = handle.join();
    }
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
                    let (due, ran) = run_due_workflows(Some(&app), &store, minute);
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

    fn temp_store() -> (std::path::PathBuf, Store) {
        let dir = std::env::temp_dir().join(format!("saturn-runner-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&dir.join("saturn.db")).unwrap();
        (dir, store)
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
        let (dir, store) = temp_store();
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

        let (due, ran) = run_due_workflows(None, &store, T);
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
        assert_eq!(
            texts[3],
            r#"{"body":{"greeting":"hi"},"contentType":"application/json","status":"200"}"#
        );
        assert_eq!(texts[4], "run finished (2 steps)");

        // the 50s claim guard makes a duplicate tick for the same minute a no-op
        let (due, ran) = run_due_workflows(None, &store, T);
        assert_eq!((due, ran), (1, 0));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A failed run still lands, with the error carried onto the row.
    #[test]
    fn a_failing_node_persists_as_an_error_run() {
        let (dir, store) = temp_store();
        let graph = json!({
            "nodes": [
                { "id": "s", "type": "schedule", "x": 0, "y": 0, "config": { "cron": "* * * * *" } },
                { "id": "h", "type": "integration:http-request", "x": 0, "y": 0,
                  "config": { "url": "https://169.254.169.254/latest/meta-data" } },
            ],
            "edges": [
                { "id": "e1", "from": { "nodeId": "s", "portId": "out" },
                  "to": { "nodeId": "h", "portId": "in" }, "kind": "flow" },
            ],
        });
        let wf = store.create_workflow("ssrf", graph).unwrap();
        execute_run(None, &store, &wf, RunTrigger::Manual, None).unwrap();

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
            texts.contains(&"http request: http request: Server URL must be a public host"),
            "{texts:?}",
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
