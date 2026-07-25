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
"#;

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

// Event arrives with the ingress transports (Phase E).
#[allow(dead_code)]
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
    fn as_str(self) -> &'static str {
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

/// A `workflow_run` row, read back. Today only the tests assert on it; the run
/// history UI that renders it lands in Phase F.
#[allow(dead_code)]
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

    pub fn create_workflow(&self, name: &str, graph: Value) -> Result<Workflow> {
        let wf = Workflow {
            id: uuid(),
            name: name.into(),
            emoji: "⚙️".into(),
            description: String::new(),
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
        Ok(wf)
    }

    pub fn list_workflows(&self) -> Result<Vec<Workflow>> {
        let conn = self.0.lock().unwrap();
        let mut stmt = conn.prepare(
            "select id, name, emoji, description, graph, active, last_run_at, created_at, updated_at
             from workflow order by updated_at desc",
        )?;
        let rows = stmt.query_map([], |r| {
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
        })?;
        rows.collect()
    }

    pub fn workflow(&self, id: &str) -> Result<Option<Workflow>> {
        Ok(self.list_workflows()?.into_iter().find(|w| w.id == id))
    }

    /// Atomically claims a workflow for this tick: stamps `last_run_at` only if
    /// the workflow is active and has not run inside the guard window. `false`
    /// means someone else (a catch-up replay, a duplicate tick) already has it.
    /// One conditional UPDATE is its own transaction — SQLite is single-writer,
    /// so the Postgres original's batched `unnest` (forced by pgbouncer, which
    /// made session advisory locks unusable) buys nothing here.
    pub fn claim_workflow(&self, id: &str, guard_secs: i64) -> Result<bool> {
        let now = now();
        let changed = self.0.lock().unwrap().execute(
            "update workflow set last_run_at = ?2
              where id = ?1 and active = 1
                and (last_run_at is null or last_run_at <= ?3)",
            params![id, now, now - guard_secs * 1000],
        )?;
        Ok(changed == 1)
    }

    #[allow(dead_code)] // read path for the Phase F run history; tests assert on it today
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

    pub fn finish_run(&self, id: &str, status: RunStatus, error: &str, log: &[Value]) -> Result<()> {
        let conn = self.0.lock().unwrap();
        conn.execute(
            "update workflow_run set status = ?2, error = ?3, log = ?4, finished_at = ?5 where id = ?1",
            params![id, status.as_str(), error, Value::from(log.to_vec()), now()],
        )?;
        conn.execute(
            "update workflow set last_run_at = ?2 where id = (select workflow_id from workflow_run where id = ?1)",
            params![id, now()],
        )?;
        Ok(())
    }
}

/// sqlite-vec wants f32 vectors as a little-endian blob. Callers arrive with the
/// embedding port in Phase D.
#[allow(dead_code)]
pub fn vec_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

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
        // finish_run stamps the workflow, and the cascade is armed
        let stamped: Option<i64> = conn
            .query_row("select last_run_at from workflow where id = ?1", [&wf.id], |r| r.get(0))
            .unwrap();
        assert!(stamped.is_some());
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
