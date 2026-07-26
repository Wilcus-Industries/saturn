//! The whole persistence layer: one SQLite file, one connection behind a Mutex.
//! Single-user desktop app and SQLite is single-writer regardless, so a pool
//! would only buy contention on the same lock one level down.

use std::path::Path;
use std::sync::{Arc, Mutex, Once};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{ffi::sqlite3_auto_extension, params, Connection, Result};
use serde::Serialize;
use serde_json::Value;
use sqlite_vec::sqlite3_vec_init;

// No CHECK constraints and no migration machinery: these enums are the source of
// truth for the text columns, and there is no deployed database to migrate. The
// Postgres original accumulated three drop/add constraint dances from enum
// widenings — exactly the drift a CHECK causes.
const SCHEMA: &str = r#"
create table if not exists workflow (
    id text primary key, name text not null,
    emoji text not null default '⚙️', description text not null default '',
    graph text not null default '{"nodes":[],"edges":[]}',
    active integer not null default 1,
    last_run_at integer, created_at integer not null, updated_at integer not null
);

create table if not exists workflow_run (
    id text primary key,
    workflow_id text not null references workflow(id) on delete cascade,
    trigger text not null,
    status  text not null,
    error text not null default '', log text not null default '[]',
    started_at integer not null, finished_at integer
);
create index if not exists workflow_run_recent on workflow_run (workflow_id, started_at desc);

create table if not exists registry_entry (
    id text primary key, kind text not null,
    name text not null, emoji text not null default '',
    description text not null default '',
    config text not null default '{}',
    created_at integer not null, updated_at integer not null
);

-- entry_id is a partition key, not metadata: every search is scoped to exactly one
-- memory store, and a partition key pre-filters the index instead of filtering hits.
-- content is auxiliary (+): never queried on, and aux columns stay out of the vector
-- index. distance_metric=cosine matches what pgvector's <=> gave us.
-- No HNSW index on purpose: brute force over tens of thousands of vectors is
-- single-digit ms, invisible next to the embedding round trip, and costs nothing on
-- write. Add it when a query is measurably slow.
create virtual table if not exists memory_item using vec0(
    embedding float[1536] distance_metric=cosine,
    entry_id text partition key,
    +content text,
    created_at integer
);

-- Saturn Agent's own memory store, seeded in SQL rather than Rust: execute_batch
-- runs on every boot, so `insert or ignore` is idempotent AND reaches a saturn.db
-- that already exists — which a new column could not. MAX_ENTRIES_PER_KIND is a
-- create-time check this deliberately bypasses: a user with 50 stores of their
-- own must still get Saturn's. registry::delete_entry refuses to remove it.
insert or ignore into registry_entry (id, kind, name, emoji, description, config, created_at, updated_at)
values ('00000000-0000-4000-8000-000000000001', 'memory', 'Saturn', '🪐',
        'What Saturn Agent remembers across conversations.', '{}',
        unixepoch() * 1000, unixepoch() * 1000);
"#;

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Copy)]
pub enum RunTrigger {
    Cron,
    Manual,
    Event,
}

#[derive(Clone, Copy)]
pub enum RunStatus {
    Running,
    Success,
    Error,
}

impl RunTrigger {
    pub fn as_str(self) -> &'static str {
        match self {
            RunTrigger::Cron => "cron",
            RunTrigger::Manual => "manual",
            RunTrigger::Event => "event",
        }
    }
}

impl RunStatus {
    fn as_str(self) -> &'static str {
        match self {
            RunStatus::Running => "running",
            RunStatus::Success => "success",
            RunStatus::Error => "error",
        }
    }
}

#[derive(Serialize, Clone)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub emoji: String,
    pub description: String,
    pub graph: Value,
    pub active: bool,
    pub last_run_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A `workflow_run` row, read back — the run-history list renders exactly this.
#[derive(Serialize)]
pub struct RunRow {
    pub id: String,
    pub trigger: String,
    pub status: String,
    pub error: String,
    pub log: Value,
    pub started_at: i64,
    pub finished_at: Option<i64>,
}

/// A workflow as the list page draws it: metadata plus the newest run's status
/// chip. Deliberately NOT a `Workflow` — the graph is the biggest column in the
/// database and the cards never look at it.
#[derive(Serialize)]
pub struct WorkflowCard {
    pub id: String,
    pub name: String,
    pub emoji: String,
    pub description: String,
    pub active: bool,
    /// "running" | "success" | "error", or null when the workflow never ran
    pub last_run_status: Option<String>,
    pub last_run_started_at: Option<i64>,
}

const WORKFLOW_SELECT: &str =
    "select id, name, emoji, description, graph, active, last_run_at, created_at, updated_at
       from workflow";

fn workflow_row(r: &rusqlite::Row) -> Result<Workflow> {
    Ok(Workflow {
        id: r.get(0)?,
        name: r.get(1)?,
        emoji: r.get(2)?,
        description: r.get(3)?,
        graph: r.get(4)?,
        active: r.get(5)?,
        last_run_at: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

/// Cloning shares the one connection — a run executes on its own thread and
/// needs an owned handle, and SQLite is single-writer anyway.
#[derive(Clone)]
pub struct Store(Arc<Mutex<Connection>>);

impl Store {
    /// `path` is the db file; its directory is created if absent.
    pub fn open(path: &Path) -> Result<Store> {
        // Static registration, not `load_extension`: bundled SQLite is compiled with
        // extension loading available but there is no .dylib to load — sqlite-vec is
        // linked in, and auto_extension runs its init on every new connection.
        static VEC: Once = Once::new();
        VEC.call_once(|| unsafe {
            sqlite3_auto_extension(Some(std::mem::transmute(sqlite3_vec_init as *const ())));
        });

        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| {
                rusqlite::Error::InvalidPath(format!("{}: {e}", dir.display()).into())
            })?;
        }
        let conn = Connection::open(path)?;
        // WAL: the UI thread reads while background loops write; WAL keeps readers
        // off the writer's lock and survives a hard quit better than the rollback
        // journal. Persisted in the file, so this is a no-op after first boot.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // Per-connection and OFF by default — without it the run cascade above is
        // decorative.
        conn.pragma_update(None, "foreign_keys", true)?;
        conn.execute_batch(SCHEMA)?;
        Ok(Store(Arc::new(Mutex::new(conn))))
    }

    /// The one connection, for modules that own their own tables. `registry` and
    /// `memory` keep their SQL next to the code that gives it meaning rather than
    /// growing this file into a grab-bag of every query in the app; what they
    /// still must share is the *connection*, because SQLite is single-writer and
    /// a second one would take the write lock against the first.
    ///
    /// Hold the guard for as short a span as possible — it serializes every
    /// reader in the process, and an embedding round trip inside one would stall
    /// the scheduler for the length of a network call.
    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap()
    }

    /// Name-and-graph only. Every caller that has nothing else to say is a test,
    /// so this is test-only — the command builds the metadata itself.
    /// Deliberately the *unvalidated* insert: several tests need a row whose
    /// graph is malformed, to prove the scanner and the runner survive one.
    #[cfg(test)]
    pub fn create_workflow(&self, name: &str, graph: Value) -> Result<Workflow> {
        self.insert_workflow(name, "⚙️", "", graph)
    }

    /// The `create_workflow` command. A create that carries a graph passes the
    /// same gate `set_graph` applies, so no write path can leave a graph in the
    /// file that the designer would refuse to save and `execute_run` would
    /// refuse to deserialize.
    pub fn create_workflow_with(
        &self,
        name: &str,
        emoji: &str,
        description: &str,
        graph: Value,
    ) -> std::result::Result<Workflow, String> {
        crate::workflow::check_graph(&graph)?;
        self.insert_workflow(name, emoji, description, graph).map_err(|e| e.to_string())
    }

    fn insert_workflow(
        &self,
        name: &str,
        emoji: &str,
        description: &str,
        graph: Value,
    ) -> Result<Workflow> {
        let wf = Workflow {
            id: uuid(),
            name: name.into(),
            emoji: emoji.into(),
            description: description.into(),
            graph,
            active: true,
            last_run_at: None,
            created_at: now(),
            updated_at: now(),
        };
        self.0.lock().unwrap().execute(
            "insert into workflow (id, name, emoji, description, graph, active, created_at, updated_at)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![wf.id, wf.name, wf.emoji, wf.description, wf.graph, wf.active, wf.created_at, wf.updated_at],
        )?;
        // The subscription feed is derived from these rows, so every workflow
        // write invalidates it and wakes the transports. It lives here rather
        // than at the call sites because a Phase F IPC command or a Phase G MCP
        // tool that forgets it leaves a deleted event node delivering, and a
        // saved bot token invisible, for a full minute. The connection guard
        // above is already dropped — `subscriptions_changed` takes a different
        // lock, and holding both in one order here and the other order in
        // `get_event_subscriptions` is a deadlock.
        crate::events::subscriptions_changed();
        Ok(wf)
    }

    pub fn list_workflows(&self) -> Result<Vec<Workflow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{WORKFLOW_SELECT} order by updated_at desc"))?;
        let rows = stmt.query_map([], workflow_row)?;
        rows.collect()
    }

    /// One row by id. Not `list_workflows().find(…)`: `graph` is the largest
    /// column in the file, and that shape read and JSON-parsed *every* workflow's
    /// graph — on the designer's page load and, worse, once per delivered
    /// Discord/Telegram message through `ingest_event`.
    pub fn workflow(&self, id: &str) -> Result<Option<Workflow>> {
        let conn = self.0.lock().unwrap();
        conn.query_row(&format!("{WORKFLOW_SELECT} where id = ?1"), [id], workflow_row)
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })
    }

    /// The workflow list, each row carrying its newest run. One query, not N+1:
    /// the correlated subquery picks the run *id* off `workflow_run_recent`
    /// (workflow_id, started_at desc) and the join then hits it by primary key,
    /// which is what the Postgres `left join lateral … limit 1` compiled to.
    ///
    /// `created_at desc` — the list page's order, not `list_workflows`'
    /// `updated_at desc`. Cards must not reshuffle under the user every time an
    /// autosave touches a row.
    pub fn list_workflow_cards(&self) -> Result<Vec<WorkflowCard>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "select w.id, w.name, w.emoji, w.description, w.active, r.status, r.started_at
               from workflow w
               left join workflow_run r on r.id = (
                   select id from workflow_run
                    where workflow_id = w.id order by started_at desc limit 1
               )
              order by w.created_at desc",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(WorkflowCard {
                id: r.get(0)?,
                name: r.get(1)?,
                emoji: r.get(2)?,
                description: r.get(3)?,
                active: r.get(4)?,
                last_run_status: r.get(5)?,
                last_run_started_at: r.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// Run history for one workflow, newest first.
    pub fn list_runs(&self, workflow_id: &str, limit: i64) -> Result<Vec<RunRow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "select id, trigger, status, error, log, started_at, finished_at
               from workflow_run where workflow_id = ?1 order by started_at desc limit ?2",
        )?;
        let rows = stmt.query_map(params![workflow_id, limit], |r| {
            Ok(RunRow {
                id: r.get(0)?,
                trigger: r.get(1)?,
                status: r.get(2)?,
                error: r.get(3)?,
                log: r.get(4)?,
                started_at: r.get(5)?,
                finished_at: r.get(6)?,
            })
        })?;
        rows.collect()
    }

    /// Metadata only — the graph is the designer's to write. No
    /// `subscriptions_changed()`: a name or emoji cannot change which events are
    /// subscribed to, and this fires on every keystroke-close of the edit modal.
    pub fn update_workflow_meta(
        &self,
        id: &str,
        name: &str,
        emoji: &str,
        description: &str,
    ) -> Result<bool> {
        let changed = self.0.lock().unwrap().execute(
            "update workflow set name = ?2, emoji = ?3, description = ?4, updated_at = ?5
              where id = ?1",
            params![id, name, emoji, description, now()],
        )?;
        Ok(changed == 1)
    }

    /// The designer's autosave. Validates before writing: a graph that fails
    /// `is_workflow_graph` deserializes into something the interpreter chokes
    /// on, and the only symptom would be "workflow graph is malformed" the next
    /// time the schedule fires.
    pub fn set_graph(&self, id: &str, graph: &Value) -> std::result::Result<bool, String> {
        let json = crate::workflow::check_graph(graph)?;
        let changed = self
            .0
            .lock()
            .unwrap()
            .execute(
                "update workflow set graph = ?2, updated_at = ?3 where id = ?1",
                params![id, json, now()],
            )
            .map_err(|e| e.to_string())?;
        // graph edits add and remove event nodes and change bot tokens. Cheap
        // by design: the transports debounce, so an autosave burst collapses.
        crate::events::subscriptions_changed();
        Ok(changed == 1)
    }

    /// Explicit desired state, never a flip — a double-click must be idempotent.
    /// `active` gates event delivery as well as cron, so the transports have to
    /// be woken.
    pub fn set_active(&self, id: &str, active: bool) -> Result<bool> {
        let changed = self.0.lock().unwrap().execute(
            "update workflow set active = ?2, updated_at = ?3 where id = ?1",
            params![id, active, now()],
        )?;
        crate::events::subscriptions_changed();
        Ok(changed == 1)
    }

    /// Idempotent: a row already gone (another window deleted it) is not an
    /// error. `workflow_run` cascades on its FK.
    pub fn delete_workflow(&self, id: &str) -> Result<()> {
        self.0.lock().unwrap().execute("delete from workflow where id = ?1", [id])?;
        // unconditional, like `registry::delete_entry`: the workflow's event
        // nodes are gone and a spurious wake costs one feed scan.
        crate::events::subscriptions_changed();
        Ok(())
    }

    /// Atomically claims a workflow for this tick: stamps `last_run_at` only if
    /// the workflow is active and has not run inside the guard window. `false`
    /// means someone else (a catch-up replay, a duplicate tick) already has it.
    /// One conditional UPDATE is its own transaction — SQLite is single-writer,
    /// so the Postgres original's batched `unnest` (forced by pgbouncer, which
    /// made session advisory locks unusable) buys nothing here.
    pub fn claim_workflow(&self, id: &str, guard_secs: i64) -> Result<bool> {
        let now = now();
        // guard 0 is the event path, and it means "no cooldown whatsoever" —
        // lib/events.server.ts's claim UPDATE carried no time predicate at all.
        // `now - 0` is not the same thing: it refuses the claim whenever
        // last_run_at sits in the FUTURE, so one NTP step backwards (a laptop
        // waking on a new network) silently drops every Discord/Telegram
        // delivery as "inactive" until wall clock catches up.
        let cutoff = if guard_secs <= 0 { i64::MAX } else { now - guard_secs * 1000 };
        let changed = self.0.lock().unwrap().execute(
            "update workflow set last_run_at = ?2
              where id = ?1 and active = 1
                and (last_run_at is null or last_run_at <= ?3)",
            params![id, now, cutoff],
        )?;
        Ok(changed == 1)
    }

    // stays test-only: the run-history UI reads `list_runs`, and the list page's
    // newest-run chip comes from `list_workflow_cards`' one correlated query
    // rather than a per-row call to this.
    #[allow(dead_code)]
    pub fn latest_run(&self, workflow_id: &str) -> Result<Option<RunRow>> {
        let conn = self.0.lock().unwrap();
        conn.query_row(
            "select id, trigger, status, error, log, started_at, finished_at
               from workflow_run where workflow_id = ?1 order by started_at desc limit 1",
            [workflow_id],
            |r| {
                Ok(RunRow {
                    id: r.get(0)?,
                    trigger: r.get(1)?,
                    status: r.get(2)?,
                    error: r.get(3)?,
                    log: r.get(4)?,
                    started_at: r.get(5)?,
                    finished_at: r.get(6)?,
                })
            },
        )
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
    }

    /// Returns the run id; the run is left `running` until `finish_run`.
    pub fn insert_run(&self, workflow_id: &str, trigger: RunTrigger) -> Result<String> {
        let id = uuid();
        self.0.lock().unwrap().execute(
            "insert into workflow_run (id, workflow_id, trigger, status, started_at)
             values (?1, ?2, ?3, ?4, ?5)",
            params![id, workflow_id, trigger.as_str(), RunStatus::Running.as_str(), now()],
        )?;
        Ok(id)
    }

    /// Deliberately does NOT touch `workflow.last_run_at`. That column is the
    /// claim ledger, not a completion record: `claim_workflow`'s guard window is
    /// measured from it, so stamping it again here would push the next eligible
    /// claim to finish+guard instead of claim+guard, and any run outlasting
    /// (interval - guard) would silently swallow the following tick. The
    /// TypeScript wrote it in the two claim UPDATEs only (acf6fc6
    /// lib/runner.server.ts:277, lib/events.server.ts:217).
    pub fn finish_run(&self, id: &str, status: RunStatus, error: &str, log: &[Value]) -> Result<()> {
        self.0.lock().unwrap().execute(
            "update workflow_run set status = ?2, error = ?3, log = ?4, finished_at = ?5 where id = ?1",
            params![id, status.as_str(), error, Value::from(log.to_vec()), now()],
        )?;
        Ok(())
    }
}

/// sqlite-vec wants f32 vectors as a little-endian blob.
pub fn vec_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A long run must not eat the next tick. `last_run_at` is the claim ledger
    /// and `claim_workflow`'s guard is measured from it, so if `finish_run` were
    /// to re-stamp it at completion, any run outlasting (interval - guard) — 10s
    /// on a `* * * * *` schedule — would make the following minute a silent
    /// no-op. `run_due_workflows` only logs when due > 0, so it would look
    /// exactly like ordinary guard suppression.
    #[test]
    fn finish_run_leaves_the_claim_stamp_alone() {
        let dir = std::env::temp_dir().join(format!("saturn-restamp-{}", uuid()));
        let store = Store::open(&dir.join("saturn.db")).unwrap();
        let wf = store.create_workflow("every minute", serde_json::json!({})).unwrap();

        // minute N: the tick claims it
        assert!(store.claim_workflow(&wf.id, 50).unwrap());
        // …60s ago, i.e. the claim belongs to the previous minute's tick
        let claimed_at = now() - 60_000;
        {
            let conn = store.0.lock().unwrap();
            conn.execute("update workflow set last_run_at = ?2 where id = ?1", params![wf.id, claimed_at])
                .unwrap();
        }
        // that run took ~60s and finishes now
        let run = store.insert_run(&wf.id, RunTrigger::Cron).unwrap();
        store.finish_run(&run, RunStatus::Success, "", &[]).unwrap();

        let stamp: i64 = store
            .0
            .lock()
            .unwrap()
            .query_row("select last_run_at from workflow where id = ?1", [&wf.id], |r| r.get(0))
            .unwrap();
        assert_eq!(stamp, claimed_at, "finish_run must not move the claim stamp");
        // minute N+1's tick: the claim is a full minute past the stamp, so it takes
        assert!(
            store.claim_workflow(&wf.id, 50).unwrap(),
            "the next minute's tick was swallowed by a re-stamped last_run_at"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The event path claims with guard 0, which must mean "no cooldown at all"
    /// — the TypeScript's claim UPDATE had no time predicate. Computing
    /// `now - 0` instead refuses every claim while `last_run_at` sits in the
    /// future, so one NTP step backwards on a waking laptop silently drops
    /// every Discord/Telegram delivery as "inactive".
    #[test]
    fn a_zero_guard_claim_survives_a_clock_step_backwards() {
        let dir = std::env::temp_dir().join(format!("saturn-skew-{}", uuid()));
        let store = Store::open(&dir.join("saturn.db")).unwrap();
        let wf = store.create_workflow("mention", serde_json::json!({})).unwrap();
        // the clock jumped back 10 minutes after the last run stamped it
        let future = now() + 600_000;
        store
            .0
            .lock()
            .unwrap()
            .execute("update workflow set last_run_at = ?2 where id = ?1", params![wf.id, future])
            .unwrap();

        assert!(store.claim_workflow(&wf.id, 0).unwrap(), "an event delivery was dropped");
        // the cron guard is unchanged: it still suppresses inside its window
        assert!(!store.claim_workflow(&wf.id, 50).unwrap());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The existing round_trip vec0 assertion only has two rows in the partition,
    /// so `k` never has to *choose*: a nearest/farthest inversion inside vec0 would
    /// still return both rows and the explicit `order by distance` would hide it.
    /// Five rows and k=2 make the selection observable.
    #[test]
    fn vec0_knn_selects_the_nearest_not_the_farthest() {
        let dir = std::env::temp_dir().join(format!("saturn-knn-{}", uuid()));
        let store = Store::open(&dir.join("saturn.db")).unwrap();
        let conn = store.0.lock().unwrap();

        let axis = |x: f32, y: f32| {
            let mut v = vec![0.0f32; 1536];
            v[0] = x;
            v[1] = y;
            v
        };
        let mut ins = conn
            .prepare("insert into memory_item (embedding, entry_id, content, created_at) values (?1, ?2, ?3, ?4)")
            .unwrap();
        // cosine distance from (1,0): 0, ~0.005, ~0.106, ~0.293, 1
        for (name, v) in [
            ("d0-exact", axis(1.0, 0.0)),
            ("d1-near", axis(1.0, 0.1)),
            ("d2", axis(1.0, 0.5)),
            ("d3", axis(1.0, 1.0)),
            ("d4-orthogonal", axis(0.0, 1.0)),
        ] {
            ins.execute(params![vec_blob(&v), "store-a", name, now()]).unwrap();
        }
        drop(ins);

        let mut q = conn
            .prepare("select content, distance from memory_item where embedding match ?1 and entry_id = ?2 and k = 2")
            .unwrap();
        let hits: Vec<(String, f64)> = q
            .query_map(params![vec_blob(&axis(1.0, 0.0)), "store-a"], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(hits.len(), 2);
        // no `order by` on purpose — vec0 must emit ascending distance itself
        assert_eq!(hits[0].0, "d0-exact", "k picked the wrong rows: {hits:?}");
        assert_eq!(hits[1].0, "d1-near", "k picked the wrong rows: {hits:?}");
        assert!(hits[0].1 <= hits[1].1, "distance is not ascending: {hits:?}");

        drop(q);
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The list page's newest-run chip. The correlated subquery has to pick the
    /// LATEST run per workflow and leave a never-run workflow null — an
    /// unscoped or mis-ordered subquery still returns *a* row, so the card would
    /// show a stale status and nothing would fail loudly.
    #[test]
    fn cards_carry_each_workflows_newest_run() {
        let dir = std::env::temp_dir().join(format!("saturn-cards-{}", uuid()));
        let store = Store::open(&dir.join("saturn.db")).unwrap();

        let a = store.create_workflow("first", serde_json::json!({})).unwrap();
        let b = store.create_workflow("second", serde_json::json!({})).unwrap();
        let never = store.create_workflow("never ran", serde_json::json!({})).unwrap();
        // all three land in the same millisecond here, and SQLite is free to
        // return tied rows in any order — space them so the ORDER BY is what is
        // actually under test
        for (i, id) in [&a.id, &b.id, &never.id].iter().enumerate() {
            store
                .0
                .lock()
                .unwrap()
                .execute("update workflow set created_at = ?2 where id = ?1", params![id, i as i64])
                .unwrap();
        }

        // two runs on `a`: an older success, then a newer error
        let old = store.insert_run(&a.id, RunTrigger::Cron).unwrap();
        store.finish_run(&old, RunStatus::Success, "", &[]).unwrap();
        let new = store.insert_run(&a.id, RunTrigger::Manual).unwrap();
        store.finish_run(&new, RunStatus::Error, "boom", &[]).unwrap();
        // insert_run stamps `now()` for both, so force the order rather than
        // relying on the millisecond clock ticking between two statements
        {
            let conn = store.0.lock().unwrap();
            conn.execute("update workflow_run set started_at = 1000 where id = ?1", [&old]).unwrap();
            conn.execute("update workflow_run set started_at = 2000 where id = ?1", [&new]).unwrap();
        }
        // one still-running run on `b`
        store.insert_run(&b.id, RunTrigger::Event).unwrap();

        let cards = store.list_workflow_cards().unwrap();
        assert_eq!(cards.len(), 3);
        // created_at desc — newest workflow first
        assert_eq!(
            cards.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["never ran", "second", "first"],
            "cards are not in created_at desc order"
        );
        let card = |id: &str| cards.iter().find(|c| c.id == id).unwrap();
        assert_eq!(card(&a.id).last_run_status.as_deref(), Some("error"), "picked the older run");
        assert_eq!(card(&a.id).last_run_started_at, Some(2000));
        assert_eq!(card(&b.id).last_run_status.as_deref(), Some("running"));
        assert_eq!(card(&never.id).last_run_status, None, "a never-run workflow leaked a run");
        assert_eq!(card(&never.id).last_run_started_at, None);

        // run history is scoped and newest-first
        let runs = store.list_runs(&a.id, 50).unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].status, "error");
        assert_eq!(runs[0].error, "boom");
        assert_eq!(runs[1].trigger, "cron");
        assert_eq!(store.list_runs(&a.id, 1).unwrap().len(), 1);
        assert!(store.list_runs(&never.id, 50).unwrap().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `set_graph` is the only writer of the `graph` column the designer can
    /// reach, so every cap has to be enforced here — a graph that gets past it
    /// is one the interpreter fails to deserialize at run time, which surfaces
    /// as a dead workflow with no save-time signal at all.
    #[test]
    fn set_graph_enforces_the_shape_and_the_caps() {
        let dir = std::env::temp_dir().join(format!("saturn-setgraph-{}", uuid()));
        let store = Store::open(&dir.join("saturn.db")).unwrap();
        let wf = store.create_workflow("wf", serde_json::json!({})).unwrap();

        let node = |i: usize| {
            serde_json::json!({ "id": format!("n{i}"), "type": "print", "x": 0, "y": 0, "config": {} })
        };
        let good = serde_json::json!({ "nodes": [node(0)], "edges": [] });
        assert!(store.set_graph(&wf.id, &good).unwrap());
        assert_eq!(store.workflow(&wf.id).unwrap().unwrap().graph, good);

        assert_eq!(store.set_graph(&wf.id, &serde_json::json!({})).unwrap_err(), "Invalid graph");
        let too_many: Vec<_> = (0..crate::workflow::MAX_NODES + 1).map(node).collect();
        assert_eq!(
            store
                .set_graph(&wf.id, &serde_json::json!({ "nodes": too_many, "edges": [] }))
                .unwrap_err(),
            "Graph too large"
        );
        // under the node cap but over the serialized-JSON cap
        let fat: Vec<_> = (0..10)
            .map(|i| {
                serde_json::json!({ "id": format!("n{i}"), "type": "print", "x": 0, "y": 0,
                                    "config": { "text": "x".repeat(crate::workflow::MAX_GRAPH_JSON / 5) } })
            })
            .collect();
        assert_eq!(
            store.set_graph(&wf.id, &serde_json::json!({ "nodes": fat, "edges": [] })).unwrap_err(),
            "Graph too large"
        );
        // a rejected save must not have touched the row
        assert_eq!(store.workflow(&wf.id).unwrap().unwrap().graph, good);
        // an id that is not there reports it rather than silently succeeding
        assert!(!store.set_graph(&uuid(), &good).unwrap());

        // the create path shares the gate: a graph the designer could not save
        // must not be creatable either, and the row must not exist afterwards
        let before = store.list_workflows().unwrap().len();
        assert_eq!(
            // `.err()`, not `unwrap_err()` — Workflow has no Debug and does not
            // need one for a test to read the error side
            store.create_workflow_with("x", "⚙️", "", serde_json::json!({})).err().unwrap(),
            "Invalid graph"
        );
        assert_eq!(store.list_workflows().unwrap().len(), before);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("saturn-test-{}", uuid()));
        let store = Store::open(&dir.join("saturn.db")).unwrap();

        let wf = store
            .create_workflow("nightly digest", serde_json::json!({ "nodes": [], "edges": [] }))
            .unwrap();
        let listed = store.list_workflows().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, wf.id);
        assert_eq!(listed[0].name, "nightly digest");
        assert!(listed[0].active);
        assert_eq!(listed[0].graph["nodes"], serde_json::json!([]));
        assert!(listed[0].last_run_at.is_none());

        let run = store.insert_run(&wf.id, RunTrigger::Manual).unwrap();
        let log = vec![serde_json::json!({ "kind": "log", "text": "hello" })];
        store.finish_run(&run, RunStatus::Error, "boom", &log).unwrap();

        let conn = store.0.lock().unwrap();
        let (status, error, log_back, finished): (String, String, Value, Option<i64>) = conn
            .query_row(
                "select status, error, log, finished_at from workflow_run where id = ?1",
                [&run],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((status.as_str(), error.as_str()), ("error", "boom"));
        assert_eq!(log_back[0]["text"], "hello");
        assert!(finished.is_some());
        // this run was never claimed, so nothing has stamped the workflow — only
        // claim_workflow writes last_run_at (see finish_run's doc comment)
        let stamped: Option<i64> = conn
            .query_row("select last_run_at from workflow where id = ?1", [&wf.id], |r| r.get(0))
            .unwrap();
        assert!(stamped.is_none());
        conn.execute("delete from workflow where id = ?1", [&wf.id]).unwrap();
        let orphans: i64 = conn
            .query_row("select count(*) from workflow_run", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0, "foreign_keys pragma is off — cascade did nothing");

        // vec0: insert two vectors in one store plus a decoy in another, then a
        // cosine KNN scoped to the first. Fails if the extension did not load, if
        // the aux/partition syntax is wrong, or if the metric is not cosine.
        let mut ins = conn.prepare(
            "insert into memory_item (embedding, entry_id, content, created_at) values (?1, ?2, ?3, ?4)",
        ).unwrap();
        let mut e1 = vec![0.0f32; 1536];
        e1[0] = 1.0;
        let mut e2 = vec![0.0f32; 1536];
        e2[1] = 1.0;
        ins.execute(params![vec_blob(&e1), "store-a", "match me", now()]).unwrap();
        ins.execute(params![vec_blob(&e2), "store-a", "orthogonal", now()]).unwrap();
        ins.execute(params![vec_blob(&e1), "store-b", "wrong store", now()]).unwrap();
        drop(ins);

        let mut q = conn.prepare(
            "select content, distance from memory_item
             where embedding match ?1 and entry_id = ?2 and k = 5 order by distance",
        ).unwrap();
        let hits: Vec<(String, f64)> = q
            .query_map(params![vec_blob(&e1), "store-a"], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(hits.len(), 2, "partition key did not scope the search");
        assert_eq!(hits[0].0, "match me");
        assert!(hits[0].1 < 0.001, "cosine distance to self should be ~0, got {}", hits[0].1);
        assert!((hits[1].1 - 1.0).abs() < 0.001, "orthogonal cosine distance should be 1");

        drop(q);
        drop(conn);
        std::fs::remove_dir_all(&dir).ok();
    }
}
