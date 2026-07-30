//! Saturn Agent: the streaming chat that is the app's front door, its persisted
//! sessions, and the tool surface it drives Saturn's own data with.
//!
//! One file on purpose. A session has exactly one reader and one writer, the
//! tool surface has exactly one caller, and `run_turn` is the thing that binds
//! them — splitting it into `sessions.rs` / `tools.rs` / `loop.rs` would buy
//! three `use` blocks and a circular urge. `mcp.rs` is 1,426 lines in one file;
//! the precedent holds.
//!
//! Recovered from `b6d0f71` (`lib/agentChat.server.ts` + `app/mcp/tools.ts`),
//! which the desktop pivot deleted wholesale — see `docs/open-decisions.md`
//! §3.9. What came back is the turn loop, the prompts and 12 of the 28 tools
//! (plus `call_mcp_tool`, which is new — the chat calls the user's MCP servers
//! directly instead of only authoring graphs that would);
//! what did not is every tool whose subject (tiers, credits, the hosted webhook
//! URL, skill/variable CRUD) no longer exists.
//!
//! **Every tool wraps something that already exists.** There is no business
//! logic in `dispatch` — it validates arguments and calls `store`, `registry`,
//! `workflow` or `runner`. That is what keeps `events::subscriptions_changed()`
//! firing on every graph write (it lives on the store methods) and what keeps
//! `save_graph` and the designer's issues panel unable to disagree: both call
//! `workflow::validate_graph_strict`.
//!
//! Blocking throughout — SQLite, the Keychain and `openrouter::stream_chat`'s
//! blocking reqwest client. Callers must be on a plain std thread, never a tokio
//! worker (`main.rs::saturn_send` spawns one, exactly as `test_run` does).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde::Serialize;
use serde_json::{json, Value};

use crate::agent::{MAX_AGENT_MESSAGES, MAX_TOOL_CALLS_PER_TURN};
use crate::interpreter::{utf16_prefix, CatalogEntry, CATALOG};
use crate::mcp::McpToolParamType as T;
use crate::memory::{param, spec};
use crate::openrouter::{
    build_tool_defs, stream_chat, AgentMessage, Delta, StreamRequest, ToolSpec, WireMessage,
    WireToolCall,
};
use crate::registry;
use crate::secrets::Vault;
use crate::store::{RunTrigger, Store};

/// Saturn Agent's own memory store. Seeded by `store.rs`'s `SCHEMA` (in SQL, so
/// it reaches a `saturn.db` that already exists) and refused by
/// `registry::delete_entry`. Mirrored in `lib/registry.ts` as `SATURN_MEMORY_ID`.
pub const MEMORY_ID: &str = "00000000-0000-4000-8000-000000000001";
/// Saturn Agent's own tool surface, as a `registry_entry` row of kind `saturn`.
/// Seeded by `store.rs`'s `SCHEMA` beside `MEMORY_ID` and refused by
/// `registry::delete_entry` for the same reason.
///
/// Being a registry row is the whole feature: the settings tool list, the stored
/// `{name, access, enabled}` allowlist, `registry::parse_tools`,
/// `registry::can_call_tool` and the off/read/read+write tri-state all apply to
/// Saturn's builtins with no second implementation. The row holds ONLY the
/// user's overrides — `merge_tools` supplies the names, the descriptions and the
/// defaults from `all_specs`, so the two can never drift.
pub const TOOLS_ID: &str = "00000000-0000-4000-8000-000000000002";
/// What the `saturn-agent` node runs on when its model field is blank.
// The node itself is Phase 5; this and `session_by_name` are the seam it binds
// to, pinned by `sessions_are_named_and_bound_by_name` in the meantime.
pub const DEFAULT_MODEL: &str = "anthropic/claude-sonnet-4.5";
/// `ToolRef.entry_id` for Saturn's own tools. Never used to route anything —
/// `dispatch` matches on the tool *name* — but `build_tool_defs` wants a ref,
/// and a constant keeps Saturn's tools distinguishable from a memory tool's ref
/// (whose entry_id is `MEMORY_ID`) in a debugger.
const TOOL_ENTRY: &str = "saturn";

/// Per-message cap on what the composer may send.
const MAX_CHAT_MESSAGE: usize = 24_000;
/// Tool result fed back to the model.
const MAX_TOOL_RESULT: usize = 20_000;
// ponytail: still a fixed slice with no token accounting. `compact` bounds the
// window *between* turns; one turn's own tool results are unbounded (8 turns ×
// 5 calls × this = 800k, more than the whole compacted history). Budget them
// too if a tool-heavy turn starts overflowing.
/// Tool result and arguments as the client's tool row renders them.
const MAX_TOOL_ARGS_FRAME: usize = 2_000;
const MAX_TOOL_RESULT_FRAME: usize = 4_000;
/// Session name cap — `registry::MAX_NAME`, same reason.
const MAX_SESSION_NAME: usize = 60;
/// Window size, in UTF-16 units, that trips `compact` — the guard for a few
/// enormous turns, not the common path (see `over_budget`). A char budget rather
/// than a token one because nothing here knows any model's context length:
/// `parse_models` does not read `context_length`. ~4 chars per token puts this
/// near 25k tokens, well inside every model the picker lists. The calibration
/// knob: lower it if turns still overflow, raise it to summarize less often.
const COMPACT_AT: usize = 100_000;
/// Turns at the end of the window that `compact` will never fold. The anti-
/// lobotomy floor — the live thread always reaches the model verbatim.
const KEEP_RECENT: usize = 12;
/// Ceiling on the text handed to the summarizer in one call. Only reachable on a
/// session that grew before compaction existed; steady state is `COMPACT_AT`.
const MAX_COMPACT_INPUT: usize = 200_000;
/// `list_runs` default and ceiling.
const MAX_LIST_RUNS: i64 = 50;

/// The chat's stop button, one flag per session. Keyed rather than process-wide
/// (which is what `TEST_RUN_CANCEL` still is) because two chats genuinely do
/// stream at once now: the client caches a transcript per session, so switching
/// away from a running turn leaves it running, and the composer of the chat you
/// land on will start its own. A shared flag would make either stop button kill
/// both turns, and — since `cancel_flag` clears on the way in — make a second
/// send silently un-stop the first.
///
/// An entry per session sent to this process, never removed: it is one
/// `AtomicBool`, and keeping it is what lets `cancel_flag` reset the flag
/// instead of a stale `true` cancelling the next turn instantly.
static CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// This turn's cancel flag, cleared — a stop belongs to the turn that was running
/// when it was pressed, never to the next one. Call once per turn, at the start.
pub fn cancel_flag(session_id: &str) -> Arc<AtomicBool> {
    let mut map = cancels().lock().unwrap_or_else(|e| e.into_inner());
    let flag = map.entry(session_id.to_string()).or_default();
    flag.store(false, Ordering::Relaxed);
    Arc::clone(flag)
}

/// Stop the turn streaming in one session. Stopping nothing is a no-op — the
/// session may never have sent, or its turn may already be over.
pub fn cancel_session(session_id: &str) {
    if let Some(flag) = cancels().lock().unwrap_or_else(|e| e.into_inner()).get(session_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

// --- sessions ----------------------------------------------------------------

/// Owned here, not in `store.rs`'s `SCHEMA` — `github.rs`'s cursor table set the
/// precedent, and a new *table* is free on an existing `saturn.db` where a new
/// column would not be.
///
/// One row per message rather than a JSON blob per session: two writers (the
/// chat and a `saturn-agent` node run) both append, and a read-modify-write of
/// one blob loses whichever landed first.
pub fn init(store: &Store) -> rusqlite::Result<()> {
    store.conn().execute_batch(
        "create table if not exists saturn_session (
             id text primary key, name text not null unique,
             created_at integer not null, updated_at integer not null
         );
         create table if not exists saturn_message (
             id integer primary key autoincrement,
             session_id text not null references saturn_session(id) on delete cascade,
             role text not null,                -- 'user' | 'assistant'
             content text not null default '',  -- plain text; the ONLY thing re-sent upstream
             parts text not null default '[]',  -- JSON Part[] — display only
             created_at integer not null
         );
         create index if not exists saturn_message_session on saturn_message (session_id, id);",
    )?;
    // The one column added after the table shipped, so it cannot ride in the
    // batch above — `create table if not exists` is a no-op on an existing
    // `saturn.db` and would leave the column missing. There is no migration
    // machinery (`store.rs`) and this does not earn one: re-running it fails
    // with "duplicate column name", which is the success case on every boot
    // after the first.
    let _ = store
        .conn()
        .execute("alter table saturn_session add column cwd text not null default ''", []);
    Ok(())
}

/// The session's working directory, as stored — `""` means `$HOME`, which
/// `bash::cwd_dir` resolves. Fails open to `""` for the same reason
/// `entry_config` does: a missing row must leave the shell on the default
/// rather than fail the turn.
pub fn session_cwd(store: &Store, session_id: &str) -> String {
    store
        .conn()
        .query_row("select cwd from saturn_session where id = ?1", [session_id], |r| {
            r.get::<_, String>(0)
        })
        .unwrap_or_default()
}

/// Store the directory the user picked. Validated through `bash::valid_cwd`
/// rather than a second copy of the rule — a path this accepts and `run_command`
/// then refuses is one the user cannot fix from the picker. Stored
/// tilde-abbreviated so a home directory that moves still resolves.
pub fn set_session_cwd(store: &Store, session_id: &str, cwd: &str) -> Result<(), String> {
    let cwd = cwd.trim();
    if !crate::bash::valid_cwd(cwd) {
        return Err("directory must be an absolute path".into());
    }
    // resolve now, so an unreachable path is rejected while the user is looking
    // at the picker rather than three turns later inside a tool result
    let stored = if cwd.is_empty() {
        String::new()
    } else {
        crate::bash::abbreviate(&crate::bash::cwd_dir(cwd)?)
    };
    let changed = store
        .conn()
        .execute(
            "update saturn_session set cwd = ?2 where id = ?1",
            params![session_id, stored],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Not found".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// stored turns — the sessions page's only column the picker doesn't show.
    /// A correlated subquery rather than a second command: every caller that
    /// lists sessions is already paying for the row.
    pub messages: i64,
}

/// One stored turn as the chat re-renders it. `content` is the plain text (the
/// only thing ever re-sent upstream); `parts` is the display list —
/// reasoning blocks, text blocks and tool rows in the order they happened.
#[derive(Serialize)]
pub struct StoredMessage {
    pub role: String,
    pub content: String,
    pub parts: Value,
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

pub fn list_sessions(store: &Store) -> Result<Vec<SessionRow>, String> {
    let conn = store.conn();
    let mut stmt = conn
        .prepare(
            "select id, name, created_at, updated_at,
                    (select count(*) from saturn_message m where m.session_id = s.id)
               from saturn_session s order by updated_at desc",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
                messages: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}

/// `None` picks the first free `"chat N"`. A caller-supplied name that collides
/// is an error rather than a silent bump — the user typed it and deserves to
/// know it is taken.
pub fn create_session(store: &Store, name: Option<&str>) -> Result<SessionRow, String> {
    let row = SessionRow {
        id: uuid::Uuid::new_v4().to_string(),
        name: match name.map(str::trim).filter(|n| !n.is_empty()) {
            Some(n) => check_name(n)?.to_string(),
            None => next_chat_name(store)?,
        },
        created_at: now(),
        updated_at: now(),
        messages: 0,
    };
    insert_session(store, &row)?;
    Ok(row)
}

fn insert_session(store: &Store, row: &SessionRow) -> Result<(), String> {
    store
        .conn()
        .execute(
            "insert into saturn_session (id, name, created_at, updated_at) values (?1, ?2, ?3, ?4)",
            params![row.id, row.name, row.created_at, row.updated_at],
        )
        .map(|_| ())
        .map_err(|e| match e {
            // the unique index on `name` is the only constraint here
            rusqlite::Error::SqliteFailure(f, _)
                if f.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                "a chat with that name already exists".to_string()
            }
            other => other.to_string(),
        })
}

fn check_name(name: &str) -> Result<&str, String> {
    if registry::len16(name) > MAX_SESSION_NAME {
        return Err(format!("name too long (max {MAX_SESSION_NAME} chars)"));
    }
    Ok(name)
}

/// `"chat 1"`, `"chat 2"`, … bumped past whatever is taken. Linear, and it stops
/// at the session cap a human could plausibly reach.
fn next_chat_name(store: &Store) -> Result<String, String> {
    let taken: Vec<String> = list_sessions(store)?.into_iter().map(|s| s.name).collect();
    Ok((1..)
        .map(|n| format!("chat {n}"))
        .find(|n| !taken.contains(n))
        .expect("the range is unbounded"))
}

pub fn rename_session(store: &Store, id: &str, name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name is required".into());
    }
    check_name(name)?;
    let changed = store
        .conn()
        .execute(
            "update saturn_session set name = ?2, updated_at = ?3 where id = ?1",
            params![id, name, now()],
        )
        .map_err(|e| match e {
            rusqlite::Error::SqliteFailure(f, _)
                if f.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                "a chat with that name already exists".to_string()
            }
            other => other.to_string(),
        })?;
    if changed == 0 {
        return Err("Not found".into());
    }
    Ok(())
}

/// Deleting the last session is allowed — the UI creates a fresh one. Messages
/// cascade on the FK (`foreign_keys` is on per connection in `Store::open`).
pub fn delete_session(store: &Store, id: &str) -> Result<(), String> {
    store
        .conn()
        .execute("delete from saturn_session where id = ?1", [id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Get-or-create by NAME. The `saturn-agent` node binds this way so placing one
/// costs zero UI: type a name, get a session.
///
// ponytail: bound by session NAME — renaming in the chat dropdown orphans the
// node onto a fresh session of the old name. Upgrade: an id picker popover,
// same shape as systemPopover.tsx.
pub fn session_by_name(store: &Store, name: &str) -> Result<String, String> {
    let name = check_name(name.trim())?;
    if name.is_empty() {
        return Err("session name is required".into());
    }
    let existing: Option<String> = store
        .conn()
        .query_row("select id from saturn_session where name = ?1", [name], |r| r.get(0))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|e| e.to_string())?;
    match existing {
        Some(id) => Ok(id),
        None => Ok(create_session(store, Some(name))?.id),
    }
}

/// The last `MAX_AGENT_MESSAGES` turns, oldest first — the record, not the
/// window: a compacted chat still renders every turn it ever had, and only
/// `window` stops re-sending them.
///
/// A `summary` row sorts by the watermark it covers rather than by its own id.
/// It is *appended* — it lands at the end while standing for the beginning — so
/// ordering it by id would draw the compaction marker under the newest message
/// and claim the whole conversation had been folded.
pub fn get_messages(store: &Store, session_id: &str) -> Result<Vec<StoredMessage>, String> {
    let conn = store.conn();
    let mut stmt = conn
        .prepare(
            "select id, role, content, parts from saturn_message
              where session_id = ?1 order by id desc limit ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session_id, MAX_AGENT_MESSAGES as i64], |r| {
            let id: i64 = r.get(0)?;
            let parts: String = r.get(3)?;
            // a row whose parts blob somehow will not parse still renders as
            // its text — never a failed page load
            let parts: Value = serde_json::from_str(&parts).unwrap_or_else(|_| json!([]));
            let at = parts.get("upto").and_then(Value::as_i64).unwrap_or(id);
            Ok((at, StoredMessage { role: r.get(1)?, content: r.get(2)?, parts }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    out.reverse();
    out.sort_by_key(|(at, _)| *at);
    Ok(out.into_iter().map(|(_, m)| m).collect())
}

// ponytail: append-only, no per-session lock. What is NOT handled: two turns in
// flight at once produce a transcript whose tool_call ids straddle turns
// (tolerated — every call is answered inside its own append, and only `content`
// is re-sent). Upgrade if it bites: a `busy` column, or fork node runs onto a
// child session.
fn append(
    store: &Store,
    session_id: &str,
    role: &str,
    content: &str,
    parts: &Value,
) -> Result<(), String> {
    let conn = store.conn();
    conn.execute(
        "insert into saturn_message (session_id, role, content, parts, created_at)
         values (?1, ?2, ?3, ?4, ?5)",
        params![session_id, role, content, parts.to_string(), now()],
    )
    .map_err(|e| e.to_string())?;
    // the session list is ordered by this, so an appended turn floats its chat
    conn.execute(
        "update saturn_session set updated_at = ?2 where id = ?1",
        params![session_id, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// What the window is built from: the newest summary's text, if `compact` has
/// ever run, and the messages it does not cover as `(id, role, content)` oldest
/// first. Reads one column per message with no JSON parse — which is why
/// `content` is stored alongside `parts` rather than derived from it. Tool rows
/// are deliberately NOT replayed: a `tool` message must answer a `tool_call` id
/// the same request shows the assistant making, and those ids belong to turns
/// that are over.
///
/// The watermark lives inside the summary row's own `parts` blob because the row
/// is *appended* — it sits at the highest id while covering the lowest ones, so
/// row order cannot imply what it replaces.
fn window_rows(
    store: &Store,
    session_id: &str,
) -> Result<(Option<String>, Vec<(i64, String, String)>), String> {
    let conn = store.conn();
    let mut head = conn
        .prepare(
            "select content, parts from saturn_message
              where session_id = ?1 and role = 'summary' order by id desc limit 1",
        )
        .map_err(|e| e.to_string())?;
    let latest = head
        .query_map(params![session_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?
        .next()
        .transpose()
        .map_err(|e| e.to_string())?;
    // a summary row we cannot read the watermark out of is ignored outright,
    // summary and all: replaying the full window costs context, replaying a
    // summary whose reach is unknown alongside the messages it already covers
    // costs it twice
    let (summary, upto) = match latest
        .and_then(|(content, parts)| Some((content, serde_json::from_str::<Value>(&parts).ok()?)))
        .and_then(|(content, parts)| Some((content, parts.get("upto")?.as_i64()?)))
    {
        Some((content, upto)) => (Some(content), upto),
        None => (None, 0),
    };

    let mut stmt = conn
        .prepare(
            "select id, role, content from saturn_message
              where session_id = ?1 and id > ?2 and role != 'summary'
              order by id desc limit ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![session_id, upto, MAX_AGENT_MESSAGES as i64], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    out.reverse();
    Ok((summary, out))
}

/// The window re-sent upstream, as `(role, content)` oldest first. A summary
/// rides in front as a plain user message, so every projection below maps it
/// without knowing compaction exists.
fn window(store: &Store, session_id: &str) -> Result<Vec<(String, String)>, String> {
    let (summary, rows) = window_rows(store, session_id)?;
    let mut out: Vec<(String, String)> = summary
        .into_iter()
        .map(|s| ("user".to_string(), format!("{SUMMARY_PREFIX}{s}")))
        .collect();
    out.extend(rows.into_iter().map(|(_, role, content)| (role, content)));
    Ok(out)
}

/// Whether the window has outgrown what should be replayed verbatim.
///
/// Two budgets because two different chats overflow: a handful of enormous turns
/// trips the char one, and a long ordinary conversation trips the count. **The
/// count is the one that fires in practice** — `window_rows` hard-limits to
/// `MAX_AGENT_MESSAGES` and drops the oldest turn *silently*, so a char-only
/// budget would sit there unreached while the cliff it exists to prevent took
/// the conversation apart one message at a time. Measured on a real session:
/// 44 turns averaging ~1 000 chars is 45k, under half of `COMPACT_AT`, and only
/// 16 turns from the cliff.
fn over_budget(spent: usize, count: usize) -> bool {
    spent > COMPACT_AT || count > MAX_AGENT_MESSAGES - KEEP_RECENT
}

/// Fold everything before the newest `KEEP_RECENT` turns into one summary row.
///
/// Append-only, like every other write here: no `saturn_message` row is deleted
/// or rewritten, so the chat keeps rendering its whole history and only the
/// upstream projection moves past it. `get_messages` is the record; `window` is
/// what the model gets.
///
/// Cumulative — the prefix being folded starts at the previous summary, which is
/// therefore re-summarized into the new one. Nothing falls off a cliff, and the
/// live tail is never touched.
///
/// Blocking: one `chat_complete` between two `store.conn()` guards, never
/// holding one across the socket. Callers ignore the `Err` — a chat that cannot
/// summarize is a chat that runs exactly as it did before compaction existed.
fn compact(store: &Store, session_id: &str, api_key: &str, model: &str) -> Result<(), String> {
    let (summary, rows) = window_rows(store, session_id)?;
    let spent = summary.as_deref().map_or(0, registry::len16)
        + rows.iter().map(|(_, _, c)| registry::len16(c)).sum::<usize>();
    if !over_budget(spent, rows.len()) {
        return Ok(());
    }
    // a window that is *all* live tail — twelve enormous turns — has nothing to
    // fold. The per-message cap is what bounds that case, not this one.
    let folded = rows.len().saturating_sub(KEEP_RECENT);
    if folded == 0 {
        return Ok(());
    }
    let upto = rows[folded - 1].0;

    let mut blob = String::new();
    if let Some(prev) = &summary {
        blob.push_str("Notes from before this excerpt:\n");
        blob.push_str(prev);
        blob.push_str("\n\n");
    }
    for (_, role, content) in &rows[..folded] {
        blob.push_str(role);
        blob.push_str(":\n");
        blob.push_str(content);
        blob.push_str("\n\n");
    }

    let result = crate::openrouter::chat_complete(
        api_key,
        &crate::openrouter::ChatRequest {
            model,
            system: COMPACT_SYSTEM,
            messages: &[AgentMessage::User { content: cut(&blob, MAX_COMPACT_INPUT) }],
            tools: &[],
            output_image: false,
            reasoning: None,
        },
    )?;
    // an empty summary would erase everything it covers from the window — the
    // one outcome worse than not compacting at all
    let text = result.content.trim();
    if text.is_empty() {
        return Err("summarizer returned nothing".into());
    }
    append(store, session_id, "summary", text, &json!({ "kind": "summary", "upto": upto }))
}

/// The chat's own window, in the shape `stream_chat` wants.
fn transcript(store: &Store, session_id: &str) -> Result<Vec<WireMessage>, String> {
    Ok(window(store, session_id)?
        .into_iter()
        .map(|(role, content)| {
            if role == "assistant" {
                WireMessage::Assistant { content, tool_calls: Vec::new() }
            } else {
                WireMessage::User { content }
            }
        })
        .collect())
}

/// The same window in the shape an `agent` node's loop wants — what a `session`
/// chip wired into an agent buys: the conversation outlives the run.
pub fn history(store: &Store, session_id: &str) -> Result<Vec<AgentMessage>, String> {
    Ok(window(store, session_id)?
        .into_iter()
        .map(|(role, content)| {
            if role == "assistant" {
                AgentMessage::Assistant { content, tool_calls: Vec::new() }
            } else {
                AgentMessage::User { content }
            }
        })
        .collect())
}

/// One `agent` node exchange appended to a chat, so the next run — and the chat
/// window itself — sees it. Only the final text: the agent node's own tool loop
/// is a run-console concern, and `parts` here is what the chat re-renders.
pub fn record_exchange(
    store: &Store,
    session_id: &str,
    prompt: &str,
    reply: &str,
) -> Result<(), String> {
    append(store, session_id, "user", prompt, &json!([]))?;
    append(store, session_id, "assistant", reply, &json!([{ "kind": "text", "text": reply }]))
}

/// Chat chips for the designer toolbox and every `by_key` map: one per session,
/// keyed `session:<uuid>`, a single "session" value output that only an agent's
/// `session` port accepts. Mirrored in `lib/registry.ts` as `sessionEntry`.
///
/// Not a registry kind — sessions have their own table, their own CRUD and a
/// unique name — so this is a fourth source of catalog entries alongside
/// `CATALOG`, `build_user_catalog` and the designer's placeholders.
pub fn session_catalog(store: &Store) -> HashMap<String, CatalogEntry> {
    // a failed read resolves every chip as "(deleted)", which is the safe
    // direction and the same call `build_user_catalog`'s callers make
    list_sessions(store)
        .unwrap_or_default()
        .into_iter()
        .map(|s| {
            let key = format!("session:{}", s.id);
            (
                key.clone(),
                CatalogEntry {
                    key,
                    category: "session".to_string(),
                    label: s.name,
                    inputs: Vec::new(),
                    outputs: vec![registry::value_port("session")],
                    config: Vec::new(),
                    required_config: Vec::new(),
                    tools: Vec::new(),
                    missing: false,
                    tool_name: None,
                },
            )
        })
        .collect()
}

// --- the tool surface --------------------------------------------------------

/// Per-builtin `(read_only, default_enabled)` — the policy the user's stored
/// grants are merged over.
///
/// `read_only` is the same field an MCP server's `readOnlyHint` fills, and it is
/// read by the same two consumers, which is why the table needs no mapping of
/// its own: `registry::can_call_tool` blocks a `Some(false)` tool granted only
/// "read", and `toolListEditor.tsx` disables the "read" segment on `Some(false)`
/// and "read+write" on `Some(true)`. So `Some(true)` is a tool that is off or
/// read, `Some(false)` one that is off or read+write, and `None` one where all
/// three positions mean something: `call_mcp_tool` (the *target* tool's own
/// grant is the thing being read or written) and `run_command` (read = a
/// read-only workspace).
///
/// `run_command` is the only builtin that ships OFF. Everything else was already
/// reachable before the surface became configurable, and defaulting it off would
/// be a silent capability removal on an existing install.
///
/// A name missing from this table is not a builtin — `merge_tools` derives the
/// list from `all_specs`, so this only has to answer for what is there.
const POLICY: &[(&str, Option<bool>, bool)] = &[
    // off / read
    ("list_workflows", Some(true), true),
    ("get_workflow", Some(true), true),
    ("get_catalog", Some(true), true),
    ("get_docs", Some(true), true),
    ("validate_graph", Some(true), true),
    ("list_runs", Some(true), true),
    ("list_registry", Some(true), true),
    ("memory_search", Some(true), true),
    // off / read+write
    ("create_workflow", Some(false), true),
    ("update_workflow", Some(false), true),
    ("delete_workflow", Some(false), true),
    ("save_graph", Some(false), true),
    ("run_workflow", Some(false), true),
    ("memory_save", Some(false), true),
    ("memory_forget", Some(false), true),
    // off / read / read+write
    ("call_mcp_tool", None, true),
    ("run_command", None, false),
];

fn policy(name: &str) -> (Option<bool>, bool) {
    POLICY
        .iter()
        .find(|(n, _, _)| *n == name)
        .map_or((None, true), |(_, read_only, enabled)| (*read_only, *enabled))
}

/// The stored grants merged over `POLICY` — the list settings renders, and the
/// list `tool_specs` and `dispatch` both answer to. Pure, so the merge is
/// testable without a database.
///
/// Derived from `all_specs` rather than from a second name list: a builtin added
/// later appears in settings on its own, and a stored name that no longer exists
/// is dropped instead of haunting the tri-state with a tool nothing dispatches.
pub fn merge_tools(stored: &[registry::McpTool]) -> Vec<registry::McpTool> {
    all_specs(false)
        .into_iter()
        .map(|s| {
            let name = s.tool_ref.tool_name;
            let (read_only, default_enabled) = policy(&name);
            let prev = stored.iter().find(|t| t.name == name);
            registry::McpTool {
                // the full grant by default — a read-only builtin has nothing to
                // write, and everything else was unconditional before the
                // surface became configurable
                access: prev.map_or_else(
                    || if read_only == Some(true) { "read" } else { "write" }.to_string(),
                    |t| t.access.clone(),
                ),
                enabled: prev.map_or(default_enabled, |t| t.enabled),
                name,
                read_only,
                // settings renders this, and it is the same text the model gets
                description: s.description,
                // the arg specs reach the model through `ToolSpec`, never
                // through the stored row — no reason to duplicate them into the
                // config blob
                params: None,
            }
        })
        .collect()
}

/// The `saturn` row's config blob — `{tools, workspace}` — or `{}`.
///
/// One SELECT and no Keychain: `get_user_registry` would walk every entry and
/// probe the vault for booleans nothing here reads. Fails open, because a
/// missing row or a blob that will not parse must leave Saturn on the policy
/// defaults rather than silently take every tool away.
fn entry_config(store: &Store) -> Value {
    store
        .conn()
        .query_row("select config from registry_entry where id = ?1", [TOOLS_ID], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| json!({}))
}

/// What the user has actually granted, for one turn. Read once per turn and
/// threaded to `tool_specs` and `dispatch` both, so the offered surface and the
/// dispatch gate cannot disagree.
pub fn tool_state(store: &Store) -> Vec<registry::McpTool> {
    let stored: Vec<registry::McpTool> =
        serde_json::from_value(entry_config(store)["tools"].clone()).unwrap_or_default();
    merge_tools(&stored)
}

/// The tools this turn may actually reach: every builtin the user left on and
/// whose grant `registry::can_call_tool` accepts.
///
/// `nested` still drops `run_workflow` on top of that — a `saturn-agent` node is
/// already inside a run, and letting that turn start another is the recursion
/// (`runner.rs`'s `nested: true`). That is unrelated to the user's grants, which
/// is why it is a parameter and not a row in `POLICY`.
fn tool_specs(state: &[registry::McpTool], nested: bool) -> Vec<ToolSpec> {
    all_specs(nested)
        .into_iter()
        .filter(|s| {
            state.iter().any(|t| {
                t.name == s.tool_ref.tool_name && t.enabled && registry::can_call_tool(t)
            })
        })
        .collect()
}

/// Every builtin Saturn has, before any grant is applied — the names, the
/// descriptions and the argument specs, and therefore the source `merge_tools`
/// builds the settings list from.
///
/// `ToolSpec` literals rather than `json!` or a schema file — `McpToolParam` and
/// `to_parameters` already emit `{type, properties, required}`, and every name
/// here is snake_case ASCII so `wire_safe` is the identity. Accepted loss versus
/// the hosted server: no `additionalProperties: false`. Harmless — `dispatch`
/// validates its own arguments and an invented key is simply ignored.
fn all_specs(nested: bool) -> Vec<ToolSpec> {
    let id = || param("id", T::String, true, "workflow id (uuid)");
    let graph = || {
        param(
            "graph",
            T::Object,
            true,
            "complete workflow graph: { nodes: [{id, type, config}], edges: [{id, from: {nodeId, portId}, to: {nodeId, portId}, kind}] }. Omit node x/y — Saturn places them. See get_docs and get_catalog.",
        )
    };
    let mut specs = vec![
        spec(TOOL_ENTRY, "list_workflows",
            "List the user's workflows: id, name, emoji, description, active flag and last run time. The schedule lives inside the graph (a 'schedule' event node) — fetch it with get_workflow.",
            vec![]),
        spec(TOOL_ENTRY, "get_workflow",
            "Fetch one workflow: metadata plus the full node graph JSON. Each node carries a read-only `label` — the node type resolved to its human name (e.g. which MCP server an mcp:<uuid>:* grant is); trust it over guessing from the type string. Labels are informational and ignored on save.",
            vec![id()]),
        spec(TOOL_ENTRY, "create_workflow",
            "Create a workflow. It starts with an empty graph — author it with save_graph. To run on a schedule, add a 'schedule' event node (its config.cron is a 5-field UTC expression) and wire its flow output onward.",
            vec![
                param("name", T::String, true, "workflow name"),
                param("emoji", T::String, false, "single emoji icon (optional, default ⚙️)"),
                param("description", T::String, false, "short description (optional)"),
            ]),
        spec(TOOL_ENTRY, "update_workflow",
            "Update workflow metadata (name, emoji, description, active). The schedule lives in the graph's 'schedule' node — change it with save_graph. active gates whether any events fire.",
            vec![
                id(),
                param("name", T::String, false, "new name"),
                param("emoji", T::String, false, "new emoji"),
                param("description", T::String, false, "new description"),
                param("active", T::Boolean, false, "true = events fire (scheduled runs enabled), false = paused (manual runs still work)"),
            ]),
        spec(TOOL_ENTRY, "delete_workflow",
            "Permanently delete a workflow. Irreversible — the graph and the entire run history are removed.",
            vec![id()]),
        spec(TOOL_ENTRY, "get_catalog",
            "The node catalog available to this user (their registered MCP servers, skills, memory stores and variables, plus every built-in node) with each node's ports and config fields. Call this before writing any graph; get_docs has the graph-format authoring guide.",
            vec![]),
        spec(TOOL_ENTRY, "get_docs",
            "The authoring guide for the workflow graph format: node/edge shapes, port kinds, wiring rules, event nodes and scheduling. Read it before writing your first graph; get_catalog has the concrete node types.",
            vec![]),
        spec(TOOL_ENTRY, "validate_graph",
            "Dry-run validation of a graph without saving: structural errors (bad ports, kind mismatches, duplicate edges, fan-in on single-edge value inputs) and warnings (unknown node types, no event node, blank/invalid schedule cron, unresolvable agent grants).",
            vec![graph()]),
        spec(TOOL_ENTRY, "save_graph",
            "Replace a workflow's entire graph. Rejects on structural errors; returns warnings that don't block saving. Validate with validate_graph first if unsure.",
            vec![id(), graph()]),
        spec(TOOL_ENTRY, "list_runs",
            "Run history of a workflow, newest first: trigger, status, error, timing and the full console log.",
            vec![
                param("workflow_id", T::String, true, "workflow id (uuid)"),
                param("limit", T::Number, false, &format!("max rows, 1-{MAX_LIST_RUNS} (default {MAX_LIST_RUNS})")),
            ]),
        spec(TOOL_ENTRY, "list_registry",
            "Everything registered on this machine: MCP servers (with their tool allowlists), skills, memory stores and variables — the ids behind the \"mcp:<id>:*\", \"skill:<id>\", \"memory:<id>\" and \"variable:<id>\" node types. Secrets are never returned: MCP tokens and variable values surface only as booleans.",
            vec![]),
        spec(TOOL_ENTRY, "call_mcp_tool",
            "Call a tool on one of the user's registered MCP servers right now and return its result — the direct way to do a one-off action or lookup, with no workflow involved. list_registry has the server ids and, per tool, its description and parameters; only enabled tools can be called. Real side effects.",
            vec![
                param("server_id", T::String, true, "registry entry id of the MCP server (uuid, from list_registry)"),
                param("tool", T::String, true, "tool name, exactly as list_registry spells it"),
                param("arguments", T::Object, false, "the tool's own arguments object (default {})"),
            ]),
        // The description is the model's ONLY briefing on the sandbox — there is
        // no system-prompt paragraph for it — so every constraint it has to
        // plan around is stated here rather than discovered by failing.
        spec(TOOL_ENTRY, "run_command",
            "Run a shell command on this machine and return its combined output. The command line is executed with /bin/sh -c, so pipes, redirection and && all work. This is also how you read and write files — there is no separate file tool: use cat, ls, grep, sed and heredocs. The command starts in this chat's working directory (stated in your system prompt), and that tree is the ONLY path you may write to — the rest of the disk is readable but not writable, credential directories (~/.ssh, ~/.aws, ~/.gnupg, ~/.config/gh, the keychain) are neither, and writes are refused entirely unless this tool is granted read+write. Each call is a fresh shell: cd does not persist between calls, so write paths relative to the working directory or absolute. Commands are killed after 60 seconds and long output is truncated. There is no interactive input: never run anything that waits at a prompt, a pager or a password (pass --yes/--no-pager style flags, and redirect from /dev/null if unsure). A non-zero exit is returned to you as output, not as a tool error — read it.",
            vec![param("command", T::String, true, "the shell command line to run")]),
    ];
    if !nested {
        specs.push(spec(TOOL_ENTRY, "run_workflow",
            "Execute a workflow now, exactly like a scheduled run (real MCP tool calls, real model calls, real messages sent) and return the console log. Fires every event node in the graph with a sample payload. Recorded in the run history with trigger 'manual'.",
            vec![id()]));
    }
    specs.extend(crate::memory::memory_tool_specs(MEMORY_ID));
    specs
}

/// Executes one tool. Every arm wraps an existing store/registry/workflow/runner
/// entry point — there is no logic here that is not argument checking.
///
/// `Err` is a tool *failure* fed back to the model (the old server's `isError`
/// result), never a panic and never a reason to end the turn.
fn dispatch(
    store: &Store,
    vault: &dyn Vault,
    state: &[registry::McpTool],
    // the session's working directory, read once per turn by `run_turn` — a
    // parameter rather than a lookup here so a 60s command is not holding the
    // connection guard every other reader in the process is queued behind
    cwd: &str,
    name: &str,
    args: &Value,
    // this turn's cancel flag, threaded through rather than looked up: the
    // `run_workflow` arm hands it to the run it starts, so the chat's stop button
    // stops that run too — and it must be THIS session's flag, not another's
    cancel: Option<&AtomicBool>,
    emit: &mut dyn FnMut(&str, &str),
) -> Result<String, String> {
    // Re-resolved by NAME before anything runs, exactly as `runner.rs` re-checks
    // a granted MCP tool: filtering the offered specs is not enough, because a
    // model can name a tool it saw earlier in this transcript (the surface is
    // read per turn, so a tool switched off mid-chat is still in the history) or
    // one it invented outright. Unknown and disabled collapse to the same
    // answer, which is a tool failure fed back to the model — never a panic, and
    // deliberately not a hint about which builtins exist.
    let me = state
        .iter()
        .find(|t| t.name == name)
        .filter(|t| t.enabled && registry::can_call_tool(t))
        .ok_or_else(|| format!("tool \"{name}\" is not enabled"))?;

    // model-written arguments: absent is "", never a type error
    let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
    let uuid_arg = |key: &str| {
        let v = text(key);
        registry::is_uuid(&v).then_some(v).ok_or_else(|| format!("invalid {key}"))
    };

    match name {
        n if crate::memory::MEMORY_TOOL_NAMES.contains(&n) => {
            crate::memory::execute_memory_tool(store, MEMORY_ID, n, &args.to_string())
        }

        "list_workflows" => {
            let cards = store.list_workflow_cards().map_err(|e| e.to_string())?;
            json_out(&cards)
        }

        "get_workflow" => {
            let id = uuid_arg("id")?;
            let mut wf = store.workflow(&id).map_err(|e| e.to_string())?.ok_or("workflow not found")?;
            // annotate every node with its resolved catalog label — `mcp:<uuid>:*`
            // is opaque, and a model guesses (wrongly) which server a uuid is
            // without it. Re-resolved on every read, so a label echoed back into
            // save_graph is harmless: extra node keys pass the shape guard.
            let by_key = by_key(store, vault)?;
            for node in wf.graph["nodes"].as_array_mut().into_iter().flatten() {
                let label = node["type"]
                    .as_str()
                    .and_then(|t| by_key.get(t))
                    .map_or("(unknown — deleted or invalid type)", |e| e.label.as_str());
                node["label"] = label.into();
            }
            json_out(&wf)
        }

        "create_workflow" => {
            let name = text("name");
            if name.is_empty() {
                return Err("name is required".into());
            }
            let emoji = match text("emoji").as_str() {
                "" => "⚙️".to_string(),
                e => e.to_string(),
            };
            let wf = store.create_workflow_with(
                &name,
                &emoji,
                &text("description"),
                json!({ "nodes": [], "edges": [] }),
            )?;
            json_out(&json!({
                "id": wf.id,
                "note": "the graph is empty — author it with save_graph (add a 'schedule' event node to run on a schedule; call get_docs and get_catalog first)",
            }))
        }

        "update_workflow" => {
            let id = uuid_arg("id")?;
            let current = store.workflow(&id).map_err(|e| e.to_string())?.ok_or("workflow not found")?;
            // absent field keeps the stored value; `active` folds in `set_active`
            // rather than being a second tool, because `update_workflow` is what
            // a model reaches for
            let patch = |key: &str, stored: &str| match args.get(key).and_then(Value::as_str) {
                Some(v) if !v.trim().is_empty() => v.trim().to_string(),
                _ => stored.to_string(),
            };
            let name = patch("name", &current.name);
            if name.is_empty() {
                return Err("name cannot be empty".into());
            }
            let description = match args.get("description").and_then(Value::as_str) {
                Some(v) => v.trim().to_string(),
                None => current.description.clone(),
            };
            store
                .update_workflow_meta(&id, &name, &patch("emoji", &current.emoji), &description)
                .map_err(|e| e.to_string())?;
            if let Some(active) = args.get("active") {
                let active = active.as_bool().ok_or("active must be a boolean")?;
                // set_active is what wakes the three transports
                store.set_active(&id, active).map_err(|e| e.to_string())?;
            }
            json_out(&json!({ "updated": true }))
        }

        "delete_workflow" => {
            let id = uuid_arg("id")?;
            if store.workflow(&id).map_err(|e| e.to_string())?.is_none() {
                return Err("workflow not found".into());
            }
            store.delete_workflow(&id).map_err(|e| e.to_string())?;
            json_out(&json!({ "deleted": true }))
        }

        "get_catalog" => {
            // The static catalog verbatim (compacted — the file is pretty-printed
            // and the model pays for the whitespace), plus this machine's registry
            // chips. `build_user_catalog` is the same function the designer and
            // the interpreter build their `byKey` from, so the keys cannot drift.
            let builtin: Value =
                serde_json::from_str(include_str!("../../catalog.json")).map_err(|e| e.to_string())?;
            let rows = registry::get_user_registry(store, vault)?;
            let mut yours: Vec<Value> = registry::build_user_catalog(&rows)
                .into_values()
                // chat chips ride along: same shape, different table
                .chain(session_catalog(store).into_values())
                .map(|e| {
                    json!({
                        "key": e.key,
                        "label": e.label,
                        "category": e.category,
                        "outputs": e.outputs.iter().map(|p| json!({ "id": p.id, "kind": p.kind })).collect::<Vec<_>>(),
                        // an mcp chip's grantable tools — names only; the full
                        // descriptions reach the agent at run time
                        "tools": e.tools.iter().map(|t| t.name.clone()).collect::<Vec<_>>(),
                    })
                })
                .collect();
            // deterministic, so two calls in one conversation read the same
            yours.sort_by(|a, b| a["key"].as_str().cmp(&b["key"].as_str()));
            json_out(&json!({
                "note": "graph-format authoring guide: call get_docs",
                "yourEntries": yours,
                "nodes": builtin,
            }))
        }

        "get_docs" => Ok(GRAPH_DOCS.to_string()),

        "validate_graph" => {
            let mut graph = args.get("graph").cloned().ok_or("graph is required")?;
            crate::workflow::fill_coords(&mut graph);
            let v = crate::workflow::check_graph(&graph)
                .err()
                .map(|reject| json!({ "valid": false, "errors": [reject], "warnings": [] }));
            if let Some(rejected) = v {
                return json_out(&rejected);
            }
            let result = crate::workflow::validate_graph_strict(
                &graph,
                &by_key(store, vault)?,
                Some(crate::secrets::has(&crate::secrets::KEYCHAIN, &crate::secrets::Secret::GithubPat)),
            );
            json_out(&json!({
                "valid": result.errors.is_empty(),
                "errors": result.errors,
                "warnings": result.warnings,
            }))
        }

        "save_graph" => {
            let id = uuid_arg("id")?;
            let mut graph = args.get("graph").cloned().ok_or("graph is required")?;
            // coordinates first — the model is told to omit them, and a
            // coordinate-less graph fails the shape guard on both ends
            crate::workflow::fill_coords(&mut graph);
            crate::workflow::check_graph(&graph).map_err(|e| format!("invalid graph: {e}"))?;
            let result = crate::workflow::validate_graph_strict(
                &graph,
                &by_key(store, vault)?,
                Some(crate::secrets::has(&crate::secrets::KEYCHAIN, &crate::secrets::Secret::GithubPat)),
            );
            if !result.errors.is_empty() {
                return Err(format!("graph has structural errors:\n{}", result.errors.join("\n")));
            }
            // set_graph, not a direct UPDATE: it carries `check_graph` and the
            // `subscriptions_changed()` wake, and no tool may route around either
            if !store.set_graph(&id, &graph)? {
                return Err("workflow not found".into());
            }
            // hand the STORED graph to a designer showing this workflow, so its
            // canvas repaints live. Sent for every workflow — the id rides along
            // and the client keeps only its own, so a chat that started on the
            // dashboard still lands its next save after the handoff.
            emit("g", &json!({ "id": id, "graph": graph }).to_string());
            json_out(&json!({ "saved": true, "warnings": result.warnings }))
        }

        "run_workflow" => {
            let id = uuid_arg("id")?;
            let wf = store.workflow(&id).map_err(|e| e.to_string())?.ok_or("workflow not found")?;
            // `None` app handle: nothing is streaming this run to a webview, and
            // the console comes back off the persisted row below. The cancel flag
            // is the chat's — stopping the turn stops the run it started.
            crate::runner::execute_run(
                None,
                store,
                vault,
                &wf,
                RunTrigger::Manual,
                None,
                None,
                cancel,
            )?;
            let runs = store.list_runs(&id, 1).map_err(|e| e.to_string())?;
            let run = runs.into_iter().next().ok_or("the run left no history row")?;
            json_out(&json!({
                "status": run.status,
                "error": run.error,
                "log": run.log,
            }))
        }

        "list_runs" => {
            let id = uuid_arg("workflow_id")?;
            let limit = args
                .get("limit")
                .and_then(Value::as_f64)
                .map(f64::floor)
                .filter(|n| n.is_finite())
                .unwrap_or(MAX_LIST_RUNS as f64)
                .clamp(1.0, MAX_LIST_RUNS as f64) as i64;
            json_out(&store.list_runs(&id, limit).map_err(|e| e.to_string())?)
        }

        "list_registry" => {
            let rows = registry::get_user_registry(store, vault)?;
            // Projected, not returned whole: `Entry.value` carries the plaintext
            // of a non-secret variable, and a model has no use for one — it
            // writes `{{var:<uuid>}}` into the graph and Saturn substitutes at
            // the point of consumption. Booleans only, in both directions.
            let out: Vec<Value> = rows
                .iter()
                .map(|r| {
                    json!({
                        "id": r.id,
                        "kind": r.kind,
                        "name": r.name,
                        "description": r.description,
                        "serverUrl": r.server_url,
                        "tools": r.tools,
                        "hasToken": r.has_token,
                        "connected": r.connected,
                        "secret": r.secret,
                    })
                })
                .collect();
            json_out(&out)
        }

        // The one tool that reaches off this machine. Same entry point the agent
        // node's granted tools use, so the enabled/read-write gate, the token
        // refresh and the URL policy are the run pipeline's, not a second copy.
        "call_mcp_tool" => {
            let entry_id = uuid_arg("server_id")?;
            let tool = text("tool");
            let input = match args.get("arguments") {
                None | Some(Value::Null) => "{}".to_string(),
                Some(v @ Value::Object(_)) => v.to_string(),
                Some(_) => return Err("arguments must be a JSON object".into()),
            };
            // What makes "read" a real position on this tool rather than
            // decoration: the target's OWN stored grant is the thing being read
            // or written, so a read-only call_mcp_tool may not reach a tool the
            // user themselves classified read+write. `can_call_tool` cannot say
            // this — it answers about the target's grant against the *server's*
            // annotation, not against Saturn's.
            if me.access == "read" {
                let rows = registry::get_user_registry(store, vault)?;
                let granted_write = rows
                    .iter()
                    .find(|r| r.id == entry_id)
                    .and_then(|r| r.tools.iter().find(|t| t.name == tool))
                    .is_some_and(|t| t.access == "write");
                if granted_write {
                    return Err(format!(
                        "\"{tool}\" is granted read+write on that server, and call_mcp_tool is granted read-only — allow read+write on call_mcp_tool in settings"
                    ));
                }
            }
            crate::runner::execute_mcp_tool(store, vault, &entry_id, &tool, &input)
        }

        // The other tool that leaves Saturn's own data, and the sandbox in
        // `bash.rs` is the whole boundary. Deliberately NOT dropped when nested,
        // unlike `run_workflow`: that omission guards against unbounded run
        // recursion, which a shell command cannot cause, and the sandbox is
        // identical whether a person or a `saturn-agent` node asked.
        "run_command" => {
            let command = text("command");
            if command.is_empty() {
                return Err("command is required".into());
            }
            crate::bash::run(&command, me.access == "write", cwd)
        }

        other => Err(format!("unknown tool \"{other}\"")),
    }
}

/// Tool results are JSON strings the model reads. Compact, not pretty: the
/// caller's per-result cap is measured in characters and pretty-printing spends
/// 2-3× of it on indentation.
fn json_out<S: Serialize>(value: &S) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

/// The static catalog plus this machine's registry entries — the same map the
/// designer's `validate_graph` command builds, from the same two sources, which
/// is what makes the two unable to disagree about one graph.
fn by_key(store: &Store, vault: &dyn Vault) -> Result<HashMap<String, CatalogEntry>, String> {
    let rows = registry::get_user_registry(store, vault)?;
    let mut map: HashMap<String, CatalogEntry> =
        CATALOG.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
    map.extend(registry::build_user_catalog(&rows));
    map.extend(session_catalog(store));
    Ok(map)
}

// --- the turn loop -----------------------------------------------------------

pub struct TurnRequest<'a> {
    pub session_id: &'a str,
    pub model: &'a str,
    pub reasoning: Option<&'a str>,
    pub text: &'a str,
    /// client hint: the workflow open in the designer right now
    pub workflow_id: Option<&'a str>,
    /// this turn was started by a `saturn-agent` node inside a workflow run
    pub nested: bool,
}

/// One user message → one assistant turn, tool loop included.
///
/// `emit` takes the frame shape unchanged from the hosted NDJSON stream —
/// `("r"|"c"|"e"|"ts"|"te"|"g", payload)` — because the client's `apply()` is
/// recovered verbatim and has to keep parsing it.
///
/// Both the user message and the assistant reply are appended to
/// `saturn_message`, including on the error path: a turn that failed halfway
/// still happened, and dropping it would leave the transcript claiming the user
/// never spoke.
pub fn run_turn(
    store: &Store,
    vault: &dyn Vault,
    req: &TurnRequest,
    emit: &mut dyn FnMut(&str, &str),
    cancel: Option<&AtomicBool>,
) -> Result<String, String> {
    if !crate::runner::valid_model_id(req.model) {
        return Err("invalid model id".into());
    }
    let text = req.text.trim();
    if text.is_empty() {
        return Err("no message".into());
    }
    if registry::len16(text) > MAX_CHAT_MESSAGE {
        return Err("message too long".into());
    }
    // by slug, not unconditionally: a turn on a local provider needs no OpenRouter
    // key at all, and reading one here gated the whole chat on a key the model
    // about to be called never sees.
    let api_key = crate::runner::model_key(vault, req.model)?;

    append(store, req.session_id, "user", text, &json!([]))?;
    // before the transcript, so the turn that trips the budget is already the
    // compacted one. Ignored on failure: a summarizer that 500s must not cost
    // the user their message
    let _ = compact(store, req.session_id, &api_key, req.model);
    // read the transcript and DROP the connection guard before any socket —
    // `store.conn()` serializes every reader in the process
    let mut wire = transcript(store, req.session_id)?;
    // read once, off the connection, and used twice: the system prompt states it
    // and loads the project's own instruction files out of it, and `dispatch`
    // hands it to the sandbox as `run_command`'s cwd and write carve-out.
    let cwd = session_cwd(store, req.session_id);
    let system = system_prompt(req, &cwd);
    // ONE read of the user's grants for the whole turn, off the connection and
    // done before any socket. `tool_specs` decides what is offered and
    // `dispatch` re-checks what is called, both against this same list.
    let mut state = tool_state(store);
    if req.nested {
        // the recursion guard has to reach `dispatch` too, not just the offered
        // specs: the model can name a tool it was never offered.
        state.retain(|t| t.name != "run_workflow");
    }
    let defs = build_tool_defs(&tool_specs(&state, req.nested)).defs;

    let mut parts: Vec<Value> = Vec::new();
    let mut full_text = String::new();
    // no initializer: every exit from the loop below is a `break` that assigns
    // this first, and letting the compiler prove that is what stops a future
    // break path from silently returning an empty reply
    let outcome: Result<String, String>;

    // Unbounded, deliberately — the chat runs until the model stops calling
    // tools, the stream errors, or the user hits stop. A chat is watched while
    // it runs and has a stop button; the `agent` node keeps `MAX_AGENT_TURNS`
    // because a cron-fired run has neither.
    //
    // ponytail: the remaining ceiling is the provider's context window. `wire`
    // grows all turn and compaction only runs *before* a turn, so a loop that
    // never converges ends on a context-length 400, which breaks out through
    // the stream-error path below rather than gracefully. Upgrade: re-compact
    // inside the loop when `wire` crosses COMPACT_AT.
    loop {
        let mut turn_text = String::new();
        let calls = {
            // the emit closure and the part accumulator both borrow mutably, so
            // the stream lives in its own scope
            let mut on_delta = |d: Delta| match d {
                Delta::Reasoning(r) => {
                    emit("r", r);
                    grow(&mut parts, "reasoning", r);
                }
                Delta::Content(c) => {
                    turn_text.push_str(c);
                    full_text.push_str(c);
                    emit("c", c);
                    grow(&mut parts, "text", c);
                }
            };
            match stream_chat(
                &api_key,
                &StreamRequest {
                    model: req.model,
                    system: &system,
                    messages: &wire,
                    tools: &defs,
                    reasoning: req.reasoning,
                    cancel,
                },
                &mut on_delta,
            ) {
                Ok(calls) => calls,
                Err(err) => {
                    outcome = Err(err);
                    break;
                }
            }
        };
        if calls.is_empty() {
            outcome = Ok(full_text.clone());
            break;
        }

        wire.push(WireMessage::Assistant {
            content: turn_text,
            tool_calls: calls
                .iter()
                .map(|c| WireToolCall::new(c.id.clone(), c.name.clone(), c.arguments.clone()))
                .collect(),
        });

        // EVERY call id must get a `tool` reply — a missing one makes the next
        // turn a 400, so over-budget calls are answered, not skipped
        for (i, call) in calls.iter().enumerate() {
            emit(
                "ts",
                &json!({
                    "id": call.id,
                    "name": call.name,
                    "args": cut(&call.arguments, MAX_TOOL_ARGS_FRAME),
                })
                .to_string(),
            );
            let result = if i >= MAX_TOOL_CALLS_PER_TURN {
                Err("tool-call budget exceeded this turn".to_string())
            } else if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
                Err("stopped".to_string())
            } else {
                match parse_args(&call.arguments) {
                    Some(args) => dispatch(store, vault, &state, &cwd, &call.name, &args, cancel, emit),
                    None => Err("invalid tool arguments — expected a JSON object".into()),
                }
            };
            let (ok, body) = match &result {
                Ok(text) => (true, text.clone()),
                Err(err) => (false, err.clone()),
            };
            wire.push(WireMessage::Tool {
                tool_call_id: call.id.clone(),
                content: cut(&body, MAX_TOOL_RESULT),
            });
            emit(
                "te",
                &json!({ "id": call.id, "ok": ok, "result": cut(&body, MAX_TOOL_RESULT_FRAME) })
                    .to_string(),
            );
            parts.push(json!({
                "kind": "tool",
                "id": call.id,
                "name": call.name,
                "args": cut(&call.arguments, MAX_TOOL_ARGS_FRAME),
                "status": if ok { "ok" } else { "err" },
                "result": cut(&body, MAX_TOOL_RESULT_FRAME),
            }));
        }
        if cancel.is_some_and(|c| c.load(Ordering::Relaxed)) {
            outcome = Ok(full_text.clone());
            break;
        }
    }

    append(store, req.session_id, "assistant", &full_text, &json!(parts))?;
    outcome
}

/// Grow the trailing part when it is the same kind, start a new one otherwise —
/// a tool row in between breaks the block, which is what keeps a turn's
/// reasoning/text interleave readable. Mirrors `agentChatStore.apply()`.
fn grow(parts: &mut Vec<Value>, kind: &str, text: &str) {
    match parts.last_mut().filter(|p| p["kind"] == kind) {
        Some(last) => {
            let grown = format!("{}{text}", last["text"].as_str().unwrap_or(""));
            last["text"] = grown.into();
        }
        None => parts.push(json!({ "kind": kind, "text": text })),
    }
}

fn cut(s: &str, max: usize) -> String {
    utf16_prefix(s, max).unwrap_or_else(|| s.to_string())
}

/// Tool arguments arrive as a model-written JSON string. Anything that is not a
/// plain object is a model error, reported back as a failed tool result.
fn parse_args(raw: &str) -> Option<Value> {
    if raw.trim().is_empty() {
        return Some(json!({}));
    }
    match serde_json::from_str::<Value>(raw) {
        Ok(v @ Value::Object(_)) => Some(v),
        _ => None,
    }
}

/// Instruction files a project keeps at its root, in the order they are read.
/// Both spellings of the agent-neutral one: `AGENTS.md` is the convention, and
/// `AGENT.md` is common enough in the wild that missing it reads as the feature
/// being broken.
const PROJECT_FILES: [&str; 3] = ["CLAUDE.md", "AGENTS.md", "AGENT.md"];
/// Chars of project instructions carried into one system prompt, across all of
/// `PROJECT_FILES` together. A large `CLAUDE.md` is a few thousand; this is
/// generous for that and still nowhere near the transcript budget the turn loop
/// is actually spending.
const MAX_PROJECT_INSTRUCTIONS: usize = 16_000;

/// The project's own instruction files, read from the session's directory.
///
/// Root only — no walk up to a parent and no recursive scan of subdirectories.
/// The directory the user picked in the composer is the project they said they
/// are working in, and a walk would silently pull in a `CLAUDE.md` from a
/// parent they did not choose.
///
/// Read at the top of every turn rather than cached: the user edits these files
/// while the chat is open, and a stale copy is worse than none. Failures are
/// silent — an unreadable file means the turn runs without it, never that the
/// turn fails.
fn project_instructions(cwd: &str) -> String {
    let Ok(dir) = crate::bash::cwd_dir(cwd) else { return String::new() };
    let mut out = String::new();
    for name in PROJECT_FILES {
        let Ok(body) = std::fs::read_to_string(dir.join(name)) else { continue };
        let body = body.trim();
        if body.is_empty() {
            continue;
        }
        let room = MAX_PROJECT_INSTRUCTIONS.saturating_sub(out.chars().count());
        if room == 0 {
            break;
        }
        let end = body.char_indices().nth(room).map_or(body.len(), |(i, _)| i);
        out.push_str(&format!("\n\n--- {name} ---\n{}", &body[..end]));
    }
    out
}

fn system_prompt(req: &TurnRequest, cwd: &str) -> String {
    let mut system = SATURN_SYSTEM.to_string();
    let shown = crate::bash::cwd_dir(cwd)
        .map_or_else(|_| cwd.to_string(), |d| crate::bash::abbreviate(&d));
    system.push_str(&format!(
        "\nThe working directory for this chat is {shown}. run_command starts there, and with the \
         read+write grant that tree is the only place you may write."
    ));
    let project = project_instructions(cwd);
    if !project.is_empty() {
        system.push_str(&format!(
            "\n\nThe following instruction files are at the root of that directory. They are the \
             user's standing instructions for work done there — follow them as if the user had \
             written them in this chat, and prefer them over your own defaults where they \
             disagree. They are not a task.{project}"
        ));
    }
    if let Some(id) = req.workflow_id {
        system.push_str(&format!(
            "\nThe user has workflow {id} open in the designer right now — a save_graph on that \
             id appears on their canvas immediately."
        ));
    }
    if req.nested {
        system.push_str(
            "\nThis turn was started by a saturn-agent node inside a workflow run, not by the \
             user typing.",
        );
    }
    system
}

// --- the prompts -------------------------------------------------------------

/// Recovered from `b6d0f71:lib/agentChat.server.ts` and rewritten for the
/// desktop reframing: Saturn Agent is the app's centre, not a workflow tool's
/// helper. Gone with the hosted product: accounts, tiers, credits and sandboxes,
/// and the skills/variables/memory-store CRUD the capability sentence listed.
/// New: the memory paragraph (a persistent store is new) and the coordinate
/// rule, which `workflow::fill_coords` now enforces where `layoutGraph` used to
/// do it silently. Kept verbatim: the get_docs/get_catalog hard rule, the
/// validate-before-save rule, the write-only-secrets rule, the destructive-ops
/// rule and the no-markdown rule.
///
/// The capability tour it opened with is now a routing list — which tool for
/// which kind of request — because the failure mode was never that the model did
/// not know a builtin existed, it was reaching for the wrong one (a graph for a
/// one-off action, a save without a validate). Per-tool detail deliberately does
/// not appear here: `all_specs` already carries it, and `run_command`'s
/// description is by design the only briefing on the sandbox.
const SATURN_SYSTEM: &str = "You are Saturn Agent, the centre of Saturn — a native macOS app where \
one person's automations live as event-driven agent workflows, authored as node graphs on a \
canvas. You are how they talk to it.\n\
You are a general assistant first: answer questions, think things through, do one-off work \
directly. Most turns are not about a graph at all. Finish what is asked — don't gold-plate, don't \
leave it half-done.\n\
Your tools act on this machine's real data. Pick by what the user actually wants:\n\
Something that should happen again, on a schedule or an event → a workflow. get_docs and \
get_catalog first, then validate_graph, then save_graph, then run_workflow to see it work.\n\
Something that should happen once, now → just do it: call_mcp_tool for a registered server's \
tool, run_command for the shell. Never author a workflow as a way of calling a tool once.\n\
A question about their setup → list_workflows, get_workflow, list_runs, list_registry. Read \
before you claim.\n\
Something worth having next time → memory_save. And memory_search before assuming you do not know \
something about this person or their setup — durable facts, preferences and decisions, not \
transcripts, and not what they told you to forget.\n\
The tool descriptions are exact — read the one you are about to use instead of guessing its \
arguments. The rules that cost you a turn when broken:\n\
Never write a graph before calling get_docs and get_catalog. Node keys, ports and config fields \
differ per machine; a guessed one fails validation.\n\
Omit x and y on nodes — Saturn places them. Send coordinates on EVERY node only when you are \
round-tripping a graph out of get_workflow and want to keep the arrangement the user dragged into \
place.\n\
validate_graph before save_graph, and fix the errors rather than saving a broken graph. Warnings \
are usually worth mentioning to the user.\n\
The registry is read live from this machine, so an earlier list_registry goes stale: if a call \
fails with a server or tool that is not found, re-call list_registry before telling the user \
anything is missing.\n\
run_command is sandboxed and is also your only way to read or write a file: this chat's working \
directory is the only writable path, each call is a fresh shell so cd does not persist, there is \
no interactive input, and a non-zero exit comes back as output rather than an error — read it. \
Look before you edit — cat the file you are about to change.\n\
Secret values (variable secrets, MCP auth tokens) are write-only. You can never read one; never \
echo, guess or invent one.\n\
Deletes and runs have real side effects. When a request is destructive or ambiguous, ask first.\n\
Be concise and practical. The chat renders your text verbatim, so write plain text only — no \
markdown at all (no **bold**, no # headings, no backticks); they show up as literal characters.";

/// What the summary the model writes has to preserve for the chat to keep
/// working afterwards. The whole point of compaction is here: a summary that
/// describes the conversation instead of carrying its contents is what makes a
/// compacted chat feel lobotomized. Identifiers verbatim, decisions with their
/// reasons, and the threads still open.
const COMPACT_SYSTEM: &str = "You are compacting the earlier part of a conversation between a \
user and Saturn Agent, an assistant that edits and runs workflow automations on the user's \
machine. What you write REPLACES that text — the assistant will see your notes and nothing else \
of what happened before.\n\
Write handover notes for whoever picks this up mid-conversation. Carry over: what the user is \
building and why; decisions made, and options considered and rejected, with the reason; every \
identifier exactly as written (workflow ids, session and node names, registry entries, model ids, \
file paths); what has already been done to their data; what the user asked for that is still \
unfinished; and their stated preferences and constraints.\n\
Drop pleasantries, restatements and anything already superseded by a later message. Never \
summarize a decision into 'they discussed X' — record what was decided. Copy identifiers and \
literal values character for character; never paraphrase, abbreviate or invent one. If earlier \
notes are included, fold them in rather than describing them.\n\
Plain text, no markdown. Write only the notes.";

/// The line that introduces a summary in the replayed window. Prefixed rather
/// than sent as a system message so `transcript` and `history` map it with the
/// branch they already have.
const SUMMARY_PREFIX: &str = "Notes on the earlier part of this conversation, which has been \
compacted and is no longer shown in full:\n";

/// Recovered from `b6d0f71:app/mcp/tools.ts` and edited: the tier/credit lines
/// and the hosted webhook trigger URL are gone with the hosted product, the
/// `${MAX_*}` interpolations are inlined, and the per-event bullets — which the
/// TypeScript `.map()`ped off `EXTENSION_EVENTS` — are frozen as prose.
///
// ponytail: the event bullets below are a hand-written copy of the descriptors
// in lib/integrations.ts, which Rust cannot reach (catalog.json carries ports
// and config, not `payloadDoc`). Ceiling: adding or reshaping an event node
// means editing this string too, and nothing fails if you forget — the model
// just reads a stale payload shape. Upgrade: emit `payloadDoc` into
// catalog.json from gen-catalog.mjs and build these bullets from it.
const GRAPH_DOCS: &str = r#"# Authoring Saturn workflow graphs

A graph is {"nodes": [...], "edges": [...]}.
Node: {"id": "<unique string>", "type": "<catalog key>", "config": {"<fieldId>": "<string value>"}}.
OMIT x and y — Saturn lays the graph out itself (nodes render at sizes you cannot predict, so hand-picked coordinates overlap). If ANY node omits them the whole graph is re-laid-out left to right; only send x/y on EVERY node when you are round-tripping a graph from get_workflow and want to preserve the arrangement the user made on the canvas.
Edge: {"id": "<unique string>", "from": {"nodeId", "portId"}, "to": {"nodeId", "portId"}, "kind": "flow" | "value"} — from is always an output port, to an input port, and kind must match both ports' kind.

## Ports
- flow ports sequence execution. A flow output may fan out into several edges: the branches run CONCURRENTLY.
- value ports carry data (always strings; JSON for structured data). A value input accepts exactly ONE incoming edge — except ports marked "multi" (only await.values).
- A graph triggers from an event node (category "events"). The main one is "schedule" — its config.cron (5-field UTC expression: each field "*" or a plain integer, "*/n" with n 2-30 in the minute field only, e.g. "0 9 * * *" daily 09:00, "*/5 * * * *" every 5 min) sets when it fires; the platform "event:<id>" nodes (see below) fire in real time instead; "run" fires ONLY on manual runs (run_workflow / a designer test run) — never scheduled, never real-time. A graph holds AT MOST ONE event node — it is the single entry point and execution follows flow edges from it (saving a graph with two or more is rejected). No event node ⇒ the workflow never triggers (a manual run_workflow still fires the event node).

## Config vs ports
Config fields hold literal strings. A field with "overriddenBy" is ignored when its named input port is connected. Numbers/booleans are written as strings.

## Built-in nodes
- schedule: scheduled entry point (config.cron, see above). run: manual entry point — fires only on run_workflow or a designer test run, no config. if: routes flow to true/false comparing the left ("l") vs right ("r") operand value ports (config.operator). loop: runs body once per item of the JSON array on items, then done; item carries the current element. and/or/not: boolean values. string: emits config.value verbatim on its "out" value output. number: emits config.value coerced to a number ("out"). print: logs its "message" input — the connected port overrides the config.message literal (overriddenBy). concat: joins the "a" and "b" value inputs into one string on "out". extract: pulls a field out of a JSON value via config.path, dot-separated with numeric array indices ("data.results.0.price"). await: join barrier for parallel branches — continues when ALL incoming flow edges arrive; results = JSON array of its values edges (multi port), in edge order. model: emits config.model (an OpenRouter model id) on its "model" value output — connect it to an agent's model input.

## MCP server nodes (keys "mcp:<entryId>:*"), skill nodes (keys "skill:<uuid>") and memory nodes (keys "memory:<uuid>")
Grant chips — one MCP server node per registered server, one skill node per skill, one memory node per registered memory store. They have NO flow ports and are NOT executable on their own: a server node has a single value output "tool", a skill node a single value output "skill", a memory node a single value output "memory". That output connects nowhere except an agent's matching grant port ("tool" → agent "tools", "skill" → agent "skills", "memory" → agent "memory"); wiring it there grants the agent that server's tools / that skill / that memory store. Chips are never run or evaluated as values — the grant resolves statically from the node type. MCP tools therefore run only through agents.
A server node grants every enabled tool that passes the read/write gate (off or write-mismatched tools are silently skipped; the grantable list is each catalog entry's "tools" field). Optional config.exclude — a JSON array of tool names AS A STRING (e.g. "[\"delete_file\"]") — withholds specific tools from the grant: unknown names are ignored, and tools discovered later are granted automatically unless excluded. Old per-tool keys ("mcp:<entryId>:<toolName>") no longer exist — they render as inert "(deleted)" placeholders and grant nothing.
## Chat nodes (keys "session:<uuid>")
Grant chips like the ones above, one per Saturn Agent chat (the sessions the user manages at /dashboard/sessions/ and talks to in the app). No flow ports, a single value output "session", and it connects nowhere except an agent's "session" port. Wiring one makes that agent's conversation PERSIST: the chat's prior turns are prepended to every run's transcript, and each run appends its prompt and reply to the same chat — so a scheduled agent remembers the last run, and the user can read (and answer) it in the app. The port takes a SINGLE edge; without one an agent node starts from nothing every run, which is what you usually want for a one-shot summarizer. Chats are created in the app, never by a graph: use an existing one from get_catalog's yourEntries.
A memory node connects ONLY to an agent's "memory" port, and that port takes a SINGLE edge — one memory store per agent (wiring a second memory node replaces the first). At runtime the attached store gives the agent three built-in tools it calls itself — memory_search (semantic recall), memory_save (store a durable fact) and memory_forget (delete an item by id) — and injects the store's name into the system prompt. These three occupy tool slots, so an agent with a memory store attached can be granted at most 17 MCP tools (the tool cap is 20).

## Variable nodes (keys "variable:<uuid>")
Read-only secret value boxes, one per variable the user added in the designer toolbox. No inputs; a single value output "value" that connects to any ordinary value input. The output evaluates to an opaque placeholder {{var:<uuid>}} — NEVER the secret itself. Saturn substitutes the real value only where secrets are consumed: inside integration nodes (config fields and message) at send time, and inside event-node config at subscription time (the always-on listener resolves a variable wired into botToken/filters). Everywhere else (print, agent prompts, MCP tool args, logs) the placeholder passes through literally. Use them to feed botToken/webhookUrl-style config ports without putting secrets in the graph.

## Agent node (type "agent")
LLM loop on the user's own OpenRouter key. Inputs: flow in; prompt (value); system (value, usually from a "string" node — config.system holds the system prompt, edited in the designer via the node's system button, and is used when the port is unconnected); model (value, usually from a "model" node — config.model is a legacy fallback honored only when the port is unconnected); tools (value, multi — accepts ONLY MCP server node outputs); skills (value, multi — accepts ONLY skill node outputs); memory (value, SINGLE edge — accepts ONLY a memory node output; a second edge replaces the first, so an agent has at most ONE memory store, and the memory_search/memory_save/memory_forget tools it adds count against the tool cap); session (value, SINGLE edge — accepts ONLY a chat node output; the conversation then persists across runs, see "Chat nodes"). Config: output ("text" | "image" — image works only on models whose OpenRouter output modalities include image; any other value runs as text; image mode ignores tool grants and returns the first generated image) and reasoning ("off" | "low" | "medium" | "high" — maps to OpenRouter's reasoning parameter: "off" disables it, a level sets the effort, blank or any other value leaves the model default; only meaningful on models that support reasoning, and ignored entirely when output=image). Grants come from the connected chips: at most 20 tools (after server-node expansion) and 10 skills, resolved from each chip's node type; the agent may call granted tools itself during its loop. Output "result" carries the final text, or a data:image/… URL when output=image.

## Integration nodes (keys "integration:<provider>")
Outbound action nodes. Inputs: flow in, plus one value port PER CONFIG FIELD (same id) that overrides the field's literal when connected — so tokens, channel/chat ids, and messages can all be wired from upstream nodes (e.g. an extract node pulling chatId out of an event payload). Output: flow out; read-style actions additionally have a value output carrying their result, readable downstream only after the node's flow step ran. Messages truncate to the platform's cap (Discord 2000 chars, Telegram 4096); a message that is a data:image/… URL is uploaded as a file attachment/photo instead of text.
- integration:discord-webhook: config.webhookUrl must be a real https://discord.com/api/webhooks/… URL (validated at run time).
- integration:discord-send-message: posts via the Discord bot API. config.botToken is a bot token (the same one an event:discord-mentioned node uses), config.channelId the numeric id of the channel to post in; the bot needs Send Messages permission there.
- integration:discord-read-messages: reads the channel's recent history via the Discord bot API (the bot needs Read Message History there). config.count = how many (1-100, default 20). Value output "messages" = a JSON array string, oldest first: [{id, author, bot, content, timestamp, attachments: [url]}] — wire it into an extract node or an agent's prompt. Telegram has no counterpart (its Bot API has no history endpoint).
- integration:discord-typing: triggers the bot's typing indicator in config.channelId (same botToken/channelId config, no message). config.status "on" fires it (Discord auto-expires it after ~10s or when the bot sends a message); "off" is a no-op — Discord has no cancel call.
- integration:telegram-send-message: posts via the Telegram bot API (sendMessage, or sendPhoto for an image data URL). config.botToken is a bot token from @BotFather (the same one an event:telegram-message node uses), config.chatId a numeric chat id (negative for groups) or @channelusername.
- integration:telegram-typing: triggers the bot's typing indicator in config.chatId (same botToken/chatId config, no message). config.status "on" fires it (Telegram auto-expires it after ~5s or when the bot sends a message); "off" is a no-op — Telegram has no cancel call.
- integration:http-request: makes one HTTPS request to any API. config.method (GET/POST/PUT/PATCH/DELETE), config.url (required), config.headers (a JSON object string), config.body (sent on non-GET only) — all port-wireable like any action node. Value output "response" = a JSON string {status, contentType, body}: body is the parsed JSON when the response is JSON, else the raw text; a non-2xx status comes back as data (not an error), so branch on it by wiring "response" into an extract node (path "status") and an if node.

## Event nodes (keys "event:<id>")
Inbound platform triggers that fire a run in real time (no cron). Category "events" like "schedule", so the one-event-per-graph rule applies: an event graph uses this node as its single entry point and has no "schedule" node. Each has a flow output "out" and a value output "payload" carrying the event as a JSON string. Delivery is gated by the workflow's active flag; every delivered event runs (no cooldown).
Each config field also has a same-id value input port that overrides the field's literal when connected — but event config is read by the always-on listener BEFORE any run, so only statically-resolvable sources apply: a variable node (recommended for botToken — the secret stays out of the graph), or a string/number node. Any other source (extract, concat, agent…) cannot resolve pre-run; the edge is ignored, the field counts as blank, and validate_graph warns.
- event:discord-mentioned (discord "was mentioned"): config botToken, guildId, channelId — required botToken, optional filters guildId, channelId. Its "payload" value output is a JSON string shaped {content, authorId, authorUsername, channelId, guildId, messageId, timestamp} — wire it into an extract node to pull a field (e.g. path "content").
- event:telegram-message (telegram "got a message"): config botToken, chatId — required botToken, optional filter chatId. Payload shape {text, chatId, chatType, userId, username, firstName, messageId, date}.
- event:github-push (github "code pushed"): config repo, branch — required repo, optional filter branch. Payload shape {repo, ref, branch, pusher, commitCount, headSha, beforeSha, messages, compareUrl, timestamp}.
- event:github-issue (github "issue opened"): config repo — required repo. Payload shape {repo, number, title, body, author, labels, url, timestamp}.
- event:github-pr (github "pull request opened"): config repo — required repo. Payload shape {repo, number, title, body, author, sourceBranch, targetBranch, draft, url, timestamp}.
- event:github-release (github "release published"): config repo — required repo. Payload shape {repo, tag, name, body, author, prerelease, url, timestamp}.
- event:github-star (github "got a star"): config repo — required repo. Payload shape {repo, user, timestamp}. This one REQUIRES a GitHub personal access token in settings — it cannot be polled without one, and validate_graph warns when none is stored.
event:discord-mentioned fires when the user's Discord bot is @-mentioned in a server it belongs to; messages authored by any bot are ignored (loop guard). Leave guildId/channelId blank to fire on every mention, or set them to restrict to one server/channel.
event:telegram-message fires on any message the user's Telegram bot receives — direct messages always; group messages only when the bot's privacy mode is disabled via @BotFather (or the bot is a group admin). Leave chatId blank to fire on every chat, or set it (numeric id or @channelusername) to restrict to one chat.
The github event nodes poll the GitHub Events API rather than receiving webhooks, so delivery lags roughly 1 min (the poll interval) plus up to ~5 min of GitHub's own event lag. config.repo is "owner/repo" (required); a GitHub personal access token stored in settings is optional for push/issue/pr/release — public repos poll tokenless — but reaches private repos and raises the rate limit when many repos are watched. event:github-push fires on every push, tag pushes included (config.branch is then empty and ref is "refs/tags/…"); set config.branch to restrict to pushes to that one branch. event:github-issue and event:github-pr fire only when an issue/pull request is opened; event:github-release only when a release is published; event:github-star fires once per star.
event:webhook has NO transport on the desktop app — there is no HTTP server to receive one. It still parses and still renders, but it never fires. Do not author new graphs with it.

## Limits
Max 300 nodes, 600 edges, 262144 bytes of graph JSON. Unknown node types are saved but render as inert "(deleted)" placeholders and do nothing at runtime."#;

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("saturn-chat-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&dir.join("saturn.db")).unwrap();
        init(&store).unwrap();
        (store, dir)
    }

    /// Two chats stream at once as soon as the client stops clearing `streaming`
    /// on a session switch, so a stop must reach exactly one turn. Also the
    /// reset: `cancel_flag` is the only thing that clears, and if it stopped
    /// doing so the next turn in a stopped session would die on its first frame.
    #[test]
    fn stopping_one_session_leaves_the_other_running() {
        let a = cancel_flag("session-a");
        let b = cancel_flag("session-b");

        cancel_session("session-a");
        assert!(a.load(Ordering::Relaxed), "the stopped session's turn must unwind");
        assert!(!b.load(Ordering::Relaxed), "the other session's turn must keep running");

        // stopping a session that never sent is a no-op, not a panic
        cancel_session("session-never-sent");
        // and the stopped session's NEXT turn starts uncancelled — same flag,
        // cleared, which is why nothing has to remove the entry
        assert!(!cancel_flag("session-a").load(Ordering::Relaxed));
        assert!(!a.load(Ordering::Relaxed));
    }

    /// `create_session(None)` has to find the first FREE "chat N", not
    /// `count + 1` — deleting "chat 1" out of three would otherwise hand the
    /// next create the taken name "chat 3" and fail on the unique index.
    /// `session_by_name` is the node's whole binding story: it must return the
    /// SAME id the second time, or every run of a `saturn-agent` node would
    /// start a fresh conversation.
    #[test]
    fn sessions_are_named_and_bound_by_name() {
        let (store, dir) = store();

        assert_eq!(create_session(&store, None).unwrap().name, "chat 1");
        assert_eq!(create_session(&store, None).unwrap().name, "chat 2");
        let third = create_session(&store, None).unwrap();
        assert_eq!(third.name, "chat 3");
        // the gap is reused, not skipped
        delete_session(&store, &create_session(&store, Some("chat 1 dup")).unwrap().id).unwrap();
        rename_session(&store, &third.id, "renamed").unwrap();
        assert_eq!(create_session(&store, None).unwrap().name, "chat 3");

        // an explicit collision is refused rather than silently bumped
        assert_eq!(
            // `.err()`, not `unwrap_err()` — SessionRow has no Debug and does
            // not need one for a test to read the error side
            create_session(&store, Some("chat 2")).err().unwrap(),
            "a chat with that name already exists"
        );
        assert!(create_session(&store, Some(&"x".repeat(MAX_SESSION_NAME + 1))).is_err());
        assert!(rename_session(&store, &third.id, "  ").is_err());
        assert_eq!(rename_session(&store, "nope", "x").unwrap_err(), "Not found");

        // get-or-create: same name, same id, every time
        let bound = session_by_name(&store, "nightly").unwrap();
        assert_eq!(session_by_name(&store, "  nightly  ").unwrap(), bound);
        assert!(list_sessions(&store).unwrap().iter().any(|s| s.id == bound));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The window re-sent upstream is the LAST MAX_AGENT_MESSAGES turns in
    /// chronological order. `order by id desc limit N` reversed is the only way
    /// to get that; `order by id asc limit N` would hand the model the oldest
    /// turns and drop everything recent, which reads as amnesia rather than a bug.
    #[test]
    fn the_transcript_keeps_the_newest_turns_oldest_first() {
        let (store, dir) = store();
        let a = create_session(&store, None).unwrap().id;
        let b = create_session(&store, None).unwrap().id;

        for i in 0..MAX_AGENT_MESSAGES + 10 {
            append(&store, &a, "user", &format!("m{i}"), &json!([])).unwrap();
        }
        append(&store, &b, "user", "other session", &json!([])).unwrap();

        let wire = transcript(&store, &a).unwrap();
        assert_eq!(wire.len(), MAX_AGENT_MESSAGES);
        let text = |m: &WireMessage| match m {
            WireMessage::User { content } | WireMessage::Assistant { content, .. } => content.clone(),
            _ => unreachable!(),
        };
        assert_eq!(text(&wire[0]), "m10", "the window kept the oldest turns");
        assert_eq!(text(&wire[MAX_AGENT_MESSAGES - 1]), format!("m{}", MAX_AGENT_MESSAGES + 9));
        // sessions do not bleed into each other
        assert_eq!(transcript(&store, &b).unwrap().len(), 1);

        // role decides the wire variant, and parts survive the round trip
        append(&store, &b, "assistant", "hi", &json!([{ "kind": "text", "text": "hi" }])).unwrap();
        assert!(matches!(transcript(&store, &b).unwrap()[1], WireMessage::Assistant { .. }));
        let stored = get_messages(&store, &b).unwrap();
        assert_eq!((stored[0].role.as_str(), stored[1].role.as_str()), ("user", "assistant"));
        assert_eq!(stored[1].parts[0]["text"], "hi");

        // deleting a session takes its messages with it (FK cascade)
        delete_session(&store, &b).unwrap();
        assert!(get_messages(&store, &b).unwrap().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The count budget has to fire BEFORE `window_rows`' own
    /// `MAX_AGENT_MESSAGES` limit, or compaction never runs on the chats that
    /// need it — the limit drops the oldest turn silently and the char budget
    /// sits unreached. Measured against a real 44-turn session: 45k chars, under
    /// half of `COMPACT_AT`, 16 turns from losing its first message.
    #[test]
    fn the_count_budget_trips_before_the_window_silently_drops_a_turn() {
        assert!(MAX_AGENT_MESSAGES - KEEP_RECENT < MAX_AGENT_MESSAGES, "fold leaves headroom");
        // the real session that exposed this: nothing on chars, folded on count
        assert!(!over_budget(45_671, 44));
        assert!(over_budget(45_671, MAX_AGENT_MESSAGES - KEEP_RECENT + 1));
        // and the boundary itself, in both directions
        assert!(!over_budget(COMPACT_AT, MAX_AGENT_MESSAGES - KEEP_RECENT));
        assert!(over_budget(COMPACT_AT + 1, 2));
    }

    /// Compaction's whole contract in one place: the model's window starts at
    /// the summary and skips only what the watermark covers, while the record
    /// keeps every row. Get the split wrong in either direction and it is silent
    /// — a stale watermark replays folded turns twice, and a summary that shadows
    /// the live tail is the amnesia this feature exists to prevent.
    ///
    /// The summary row is written by hand rather than by `compact`, which would
    /// need a live OpenRouter key; what is under test is the watermark, not the
    /// model call.
    #[test]
    fn a_summary_replaces_what_its_watermark_covers_and_nothing_else() {
        let (store, dir) = store();
        let s = create_session(&store, None).unwrap().id;

        for i in 0..30 {
            append(&store, &s, "user", &format!("m{i}"), &json!([])).unwrap();
        }
        // the id of m19 — everything up to and including it is folded
        let upto: i64 = {
            let conn = store.conn();
            conn.query_row(
                "select id from saturn_message where session_id = ?1 order by id limit 1 offset 19",
                params![s],
                |r| r.get(0),
            )
            .unwrap()
        };
        append(&store, &s, "summary", "they built a nightly workflow", &json!({ "kind": "summary", "upto": upto })).unwrap();

        let win = window(&store, &s).unwrap();
        assert_eq!(win.len(), 11, "the summary plus m20..m29");
        assert_eq!(win[0].0, "user", "a summary rides as a user message");
        assert!(win[0].1.ends_with("they built a nightly workflow"));
        assert_eq!(win[1].1, "m20", "the tail past the watermark is verbatim");
        assert_eq!(win[10].1, "m29");
        assert!(!win.iter().any(|(_, c)| c == "m19"), "folded turns are not replayed");

        // the record is untouched: 30 messages plus the summary row itself, and
        // the marker sorts to the boundary it covers rather than to its own id
        let stored = get_messages(&store, &s).unwrap();
        assert_eq!(stored.len(), 31);
        assert_eq!(stored[19].content, "m19");
        assert_eq!(stored[20].role, "summary");
        assert_eq!(stored[21].content, "m20");

        // a second summary supersedes the first, and only the newest is read
        append(&store, &s, "summary", "newer notes", &json!({ "kind": "summary", "upto": upto + 5 })).unwrap();
        let win = window(&store, &s).unwrap();
        assert!(win[0].1.ends_with("newer notes"));
        assert_eq!(win[1].1, "m25");

        // an unreadable watermark falls back to replaying everything rather than
        // to a summary of unknown reach
        append(&store, &s, "summary", "broken", &json!({ "kind": "summary" })).unwrap();
        let win = window(&store, &s).unwrap();
        assert_eq!(win.len(), 30);
        assert_eq!(win[0].1, "m0");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The `session` port end to end, against a real store: the chat's prior
    /// turns must reach the model, and the run's own exchange must land back in
    /// the same chat — that round trip IS the feature. The second half pins the
    /// live-entry gate: a chip the catalog can't resolve grants nothing, so a
    /// deleted chat cannot silently keep collecting runs.
    #[test]
    fn a_chat_chip_carries_an_agent_conversation_across_runs() {
        use crate::agent::content;
        use crate::interpreter::{run_workflow, Effects, Graph};

        let (store, dir) = store();
        let chat = create_session(&store, Some("nightly")).unwrap();
        record_exchange(&store, &chat.id, "hello", "hi there").unwrap();

        let graph: Graph = serde_json::from_value(json!({
            "nodes": [
                { "id": "r", "type": "run", "x": 0, "y": 0, "config": {} },
                { "id": "c", "type": format!("session:{}", chat.id), "x": 0, "y": 0, "config": {} },
                { "id": "p", "type": "string", "x": 0, "y": 0, "config": { "value": "and now?" } },
                { "id": "a", "type": "agent", "x": 0, "y": 0, "config": { "model": "stub" } },
            ],
            "edges": [
                { "id": "e1", "from": { "nodeId": "r", "portId": "out" }, "to": { "nodeId": "a", "portId": "in" }, "kind": "flow" },
                { "id": "e2", "from": { "nodeId": "c", "portId": "session" }, "to": { "nodeId": "a", "portId": "session" }, "kind": "value" },
                { "id": "e3", "from": { "nodeId": "p", "portId": "out" }, "to": { "nodeId": "a", "portId": "prompt" }, "kind": "value" },
            ],
        }))
        .unwrap();

        // the model echoes the transcript it was handed, so a dropped or
        // mis-ordered history fails here rather than somewhere downstream
        let model = |req: &crate::agent::Request| crate::agent::Turn::Reply {
            content: req.messages.iter().map(content).collect::<Vec<_>>().join("|"),
            tool_calls: Vec::new(),
            image: None,
        };
        let send = |_: &str, _: &HashMap<String, String>, _: &str| Err("unused".to_string());
        let tool = |_, _: &str, _: &str, _: &str| Err("unused".to_string());
        let saturn = |_: &crate::interpreter::SaturnTurn| Err("unused".to_string());
        let history = |id: &str| history(&store, id);
        let record = |id: &str, prompt: &str, reply: &str| {
            record_exchange(&store, id, prompt, reply)
        };
        let run = |registry| {
            let (tx, rx) = std::sync::mpsc::channel();
            let values = run_workflow(
                &graph,
                None,
                None,
                registry,
                &tx,
                Effects {
                    send: &send,
                    model: &model,
                    tool: &tool,
                    saturn: &saturn,
                    history: &history,
                    record: &record,
                },
                None,
            );
            drop(tx);
            rx.into_iter().count(); // drain, or the run blocks on a full channel
            values
        };

        let catalog = session_catalog(&store);
        let values = run(Some(&catalog));
        let result = values.iter().find(|(n, p, _)| n == "a" && p == "result").unwrap();
        assert_eq!(result.2, "hello|hi there|and now?", "the chat's window must seed the turn");

        // and the exchange is now part of the chat both surfaces read
        let stored = get_messages(&store, &chat.id).unwrap();
        assert_eq!(stored.len(), 4);
        assert_eq!((stored[2].role.as_str(), stored[2].content.as_str()), ("user", "and now?"));
        assert_eq!(stored[3].parts[0]["text"], result.2.as_str());
        assert_eq!(list_sessions(&store).unwrap()[0].messages, 4);

        // no catalog ⇒ the chip resolves as deleted ⇒ no history, no append
        let values = run(None);
        let result = values.iter().find(|(n, p, _)| n == "a" && p == "result").unwrap();
        assert_eq!(result.2, "and now?", "an unresolved chip must not grant a chat");
        assert_eq!(get_messages(&store, &chat.id).unwrap().len(), 4);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `parts` is what the reloaded chat renders, and `apply()` on the client
    /// grows a trailing part only when the kind matches — a tool row in between
    /// has to start a fresh block or the interleave collapses into one wall.
    #[test]
    fn parts_group_by_kind_until_something_interrupts() {
        let mut parts = Vec::new();
        grow(&mut parts, "reasoning", "hm");
        grow(&mut parts, "reasoning", "m…");
        grow(&mut parts, "text", "he");
        grow(&mut parts, "text", "llo");
        parts.push(json!({ "kind": "tool", "id": "c1" }));
        grow(&mut parts, "text", "done");

        assert_eq!(parts.len(), 4);
        assert_eq!(parts[0], json!({ "kind": "reasoning", "text": "hmm…" }));
        assert_eq!(parts[1], json!({ "kind": "text", "text": "hello" }));
        assert_eq!(parts[3], json!({ "kind": "text", "text": "done" }));
    }

    /// The tool surface is what the model can reach, so its shape is a contract:
    /// `nested` must drop `run_workflow` (that omission IS the recursion guard),
    /// the three memory tools must always be present, and every name must
    /// survive `build_tool_defs` unmangled — a renamed tool is one `dispatch`
    /// answers "unknown tool" to on every call.
    ///
    /// On a fresh install the offered list is what it was before the surface
    /// became configurable: every builtin except `run_command`, which ships OFF
    /// and therefore appears in settings without being offered to the model.
    /// `POLICY` must also answer for every builtin — a spec with no row in it
    /// silently defaults to "on, read+write, all three positions".
    #[test]
    fn the_tool_surface_is_stable_and_nesting_drops_run_workflow() {
        let (store, dir) = store();
        let state = tool_state(&store);
        assert_eq!(state.len(), 17, "every builtin belongs in the settings list");
        assert_eq!(state.len(), POLICY.len(), "POLICY and all_specs must list the same tools");
        for t in &state {
            assert!(POLICY.iter().any(|(n, _, _)| *n == t.name), "{} has no policy row", t.name);
            assert!(t.description.is_some(), "{} reaches settings with no description", t.name);
        }
        let off: Vec<&str> =
            state.iter().filter(|t| !t.enabled).map(|t| t.name.as_str()).collect();
        assert_eq!(off, vec!["run_command"], "only run_command ships off");

        let names = |nested| {
            build_tool_defs(&tool_specs(&state, nested))
                .defs
                .into_iter()
                .map(|d| d.function.name)
                .collect::<Vec<_>>()
        };
        let top = names(false);
        assert_eq!(top.len(), 16, "{top:?}");
        for want in [
            "list_workflows", "get_workflow", "create_workflow", "update_workflow",
            "delete_workflow", "get_catalog", "get_docs", "validate_graph", "save_graph",
            "list_runs", "list_registry", "call_mcp_tool", "run_workflow",
            "memory_search", "memory_save", "memory_forget",
        ] {
            assert!(top.contains(&want.to_string()), "{want} is missing from {top:?}");
        }
        let nested = names(true);
        assert!(!nested.contains(&"run_workflow".to_string()), "nesting must drop run_workflow");
        assert_eq!(nested.len(), top.len() - 1);
        // memory tools route by name, so they must be exactly the ones
        // execute_memory_tool answers to
        for name in crate::memory::MEMORY_TOOL_NAMES {
            assert!(nested.contains(&name.to_string()));
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Turning a tool off has to take it off BOTH surfaces. Dropping it from the
    /// offered specs alone is not enough: the surface is read per turn, so a
    /// tool switched off mid-chat is still sitting in the transcript for the
    /// model to name — and `dispatch` running it anyway would make the settings
    /// switch cosmetic on exactly the call that matters.
    #[test]
    fn disabled_tools_are_neither_offered_nor_dispatchable() {
        let (store, dir) = store();
        let vault = crate::secrets::FakeVault::default();
        let mut emit = |_: &str, _: &str| {};
        let empty = || json!({ "nodes": [], "edges": [] });

        // the default grant deletes
        let doomed = store.create_workflow_with("doomed", "⚙️", "", empty()).unwrap();
        let state = tool_state(&store);
        assert!(
            dispatch(&store, &vault, &state, "", "delete_workflow", &json!({ "id": doomed.id }), None, &mut emit)
                .is_ok()
        );

        // the save the settings form makes, with delete_workflow switched off
        let submitted: Vec<Value> = state
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "access": t.access,
                    "enabled": t.enabled && t.name != "delete_workflow",
                })
            })
            .collect();
        let tools = registry::parse_tools(&serde_json::to_string(&submitted).unwrap()).unwrap();
        registry::set_saturn_tools(&store, tools).unwrap();

        let state = tool_state(&store);
        let offered = build_tool_defs(&tool_specs(&state, false))
            .defs
            .into_iter()
            .map(|d| d.function.name)
            .collect::<Vec<_>>();
        assert!(!offered.contains(&"delete_workflow".to_string()), "{offered:?}");
        assert_eq!(offered.len(), 15, "only delete_workflow left");

        // ...and naming it anyway is a tool failure, not a delete
        let spared = store.create_workflow_with("spared", "⚙️", "", empty()).unwrap();
        assert_eq!(
            dispatch(&store, &vault, &state, "", "delete_workflow", &json!({ "id": spared.id }), None, &mut emit),
            Err("tool \"delete_workflow\" is not enabled".into())
        );
        assert!(store.workflow(&spared.id).unwrap().is_some(), "a disabled tool ran anyway");
        // an invented name is the same answer, and never a panic
        assert!(dispatch(&store, &vault, &state, "", "rm_rf", &json!({}), None, &mut emit).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The session's directory reaches the model two ways — as a stated cwd and
    /// as the project's own instruction files — and both are silent when they
    /// break: a prompt that simply lacks the paragraph reads exactly like one
    /// where the user wrote no CLAUDE.md.
    #[test]
    fn the_system_prompt_carries_the_cwd_and_the_projects_instruction_files() {
        let dir = std::env::temp_dir().join(format!("saturn-prompt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_str().unwrap();
        let req = TurnRequest {
            session_id: "s",
            model: "m",
            reasoning: None,
            text: "hi",
            workflow_id: None,
            nested: false,
        };

        // no files: the directory is stated, and nothing claims instructions
        let bare = system_prompt(&req, cwd);
        assert!(bare.contains("working directory for this chat"), "{bare}");
        assert!(!bare.contains("instruction files are at the root"), "{bare}");

        // every spelling is read, and each is labelled with the name it came
        // from — an unlabelled concatenation reads as one contradictory file
        std::fs::write(dir.join("CLAUDE.md"), "prefer tabs").unwrap();
        std::fs::write(dir.join("AGENTS.md"), "run the linter").unwrap();
        std::fs::write(dir.join("AGENT.md"), "  ").unwrap();
        let loaded = system_prompt(&req, cwd);
        assert!(loaded.contains("--- CLAUDE.md ---\nprefer tabs"), "{loaded}");
        assert!(loaded.contains("--- AGENTS.md ---\nrun the linter"), "{loaded}");
        assert!(!loaded.contains("AGENT.md"), "a whitespace-only file is not a block: {loaded}");

        // the cap bounds the whole set, not each file, and cuts on a char
        // boundary — a byte slice through a multi-byte char panics
        std::fs::write(dir.join("CLAUDE.md"), "é".repeat(MAX_PROJECT_INSTRUCTIONS * 2)).unwrap();
        let capped = project_instructions(cwd);
        assert!(capped.chars().count() < MAX_PROJECT_INSTRUCTIONS + 200, "{}", capped.len());
        assert!(!capped.contains("run the linter"), "the cap must stop the later files");

        // an unreadable directory costs the turn nothing
        assert_eq!(project_instructions("/nope/does/not/exist"), "");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The whole `run_command` seam in one pass: the stored grant reaches the
    /// sandbox as the sandbox, not as a flag `dispatch` interprets.
    ///
    /// `bash.rs` already proves the profile confines writes; what is unproven
    /// there is the wiring — that the settings save lands in the row, that
    /// `tool_state` reads it back, that the tri-state's third position becomes
    /// `write: true`, and that the session's own directory is the one the
    /// command actually runs in. A bug in any of those makes the switch
    /// cosmetic while every test on either side of it still passes.
    #[test]
    fn the_run_command_grant_reaches_the_sandbox() {
        let (store, dir) = store();
        let vault = crate::secrets::FakeVault::default();
        let mut emit = |_: &str, _: &str| {};

        // a directory OUTSIDE $TMPDIR, or the profile's temp carve-out would let
        // the write through and prove nothing (the trap `bash.rs`'s own test
        // documents). Stored on a real session, which is where `run_turn` reads
        // it from — not passed straight to `dispatch`.
        let ws = crate::bash::cwd_dir("").unwrap().join(format!(".saturn-test-{}", std::process::id()));
        let ws = crate::bash::cwd_dir(ws.to_str().unwrap()).unwrap();
        let session = create_session(&store, Some("cwd chat")).unwrap().id;
        set_session_cwd(&store, &session, ws.to_str().unwrap()).unwrap();
        let cwd = session_cwd(&store, &session);
        assert_eq!(crate::bash::cwd_dir(&cwd).unwrap(), ws, "the stored cwd must round-trip");

        let run = |state: &[registry::McpTool], store: &Store, emit: &mut dyn FnMut(&str, &str)| {
            dispatch(store, &vault, state, &cwd, "run_command", &json!({ "command": "echo hi > w.txt && cat w.txt" }), None, emit)
        };

        // ships off: naming it is a tool failure even though it exists
        assert_eq!(
            run(&tool_state(&store), &store, &mut emit),
            Err("tool \"run_command\" is not enabled".into()),
            "run_command must ship off"
        );

        // the save the settings form makes, at each position of the switch
        let save = |access: &str, store: &Store| {
            let submitted: Vec<Value> = tool_state(store)
                .iter()
                .map(|t| {
                    // every other tool submitted exactly as it stands; the one
                    // under test switched on at the position being exercised
                    let others = t.name != "run_command";
                    json!({
                        "name": t.name,
                        "access": if others { t.access.clone() } else { access.to_string() },
                        "enabled": if others { t.enabled } else { true },
                    })
                })
                .collect();
            let tools = registry::parse_tools(&serde_json::to_string(&submitted).unwrap()).unwrap();
            registry::set_saturn_tools(store, tools).unwrap();
            tool_state(store)
        };

        // read+write: the command runs and the file lands in the SESSION's
        // directory, not in whatever directory the app was launched from
        let granted = run(&save("write", &store), &store, &mut emit).unwrap();
        assert!(granted.contains("exit code: 0"), "{granted}");
        assert!(granted.contains("hi"), "{granted}");
        assert!(ws.join("w.txt").exists(), "the write did not land in the session's directory");

        // read: same tool, same command, refused by the kernel rather than by a
        // branch here — the call still succeeds, the write inside it does not
        std::fs::remove_file(ws.join("w.txt")).ok();
        let denied = run(&save("read", &store), &store, &mut emit).unwrap();
        assert!(!denied.contains("exit code: 0"), "read must not write: {denied}");
        assert!(!ws.join("w.txt").exists(), "the directory is writable at read");

        std::fs::remove_dir_all(&ws).ok();
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The seeded `saturn` row is the storage the tri-state writes to, so it has
    /// to behave like the memory store: present on a fresh database, idempotent
    /// across boots, and undeletable — a delete would silently reset every grant
    /// the user made. It must also stay out of the designer toolbox: the chip
    /// would resolve to a tool ref no run pipeline can execute.
    #[test]
    fn the_tools_row_is_seeded_undeletable_and_not_grantable() {
        let (store, dir) = store();
        let vault = crate::secrets::FakeVault::default();
        assert!(registry::is_uuid(TOOLS_ID));
        assert_eq!(
            registry::delete_entry(&store, &vault, TOOLS_ID).unwrap_err(),
            "Saturn's own tools cannot be deleted"
        );

        let rows = registry::get_user_registry(&store, &vault).unwrap();
        let row = rows.iter().find(|r| r.id == TOOLS_ID).expect("the saturn row must be seeded");
        assert_eq!(row.kind, "saturn");
        assert_eq!(row.tools.len(), 17, "settings reads the merged list off list_registry");
        assert_eq!(rows[0].id, TOOLS_ID, "created_at 0 pins Saturn first in settings");
        assert!(!registry::build_user_catalog(&rows).values().any(|e| e.category == "saturn"));

        // an empty stored list still merges back to the full surface
        registry::set_saturn_tools(&store, registry::parse_tools("[]").unwrap()).unwrap();
        let rows = registry::get_user_registry(&store, &vault).unwrap();
        let row = rows.iter().find(|r| r.id == TOOLS_ID).unwrap();
        assert_eq!(row.tools.len(), 17);
        assert_eq!(tool_state(&store).len(), 17);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// `call_mcp_tool` is the one tool that reaches off this machine, so what it
    /// hands `execute_mcp_tool` is the contract: a checked uuid, the tool name
    /// verbatim, and `arguments` re-encoded as an object — absent meaning `{}`,
    /// anything else refused here rather than at the server. Nothing below opens
    /// a socket: each call stops at a pre-flight guard.
    #[test]
    fn call_mcp_tool_hands_the_run_pipeline_a_checked_call() {
        let (store, dir) = store();
        let vault = crate::secrets::FakeVault::default();
        let mut emit = |_: &str, _: &str| {};
        let state = tool_state(&store);
        let call = |args: Value, emit: &mut dyn FnMut(&str, &str)| {
            dispatch(&store, &vault, &state, "", "call_mcp_tool", &args, None, emit)
        };

        assert_eq!(
            call(json!({ "server_id": "nope", "tool": "read" }), &mut emit),
            Err("invalid server_id".into()),
        );
        let id = registry::save_mcp_server_with(
            &store,
            &vault,
            None,
            "internal",
            "ws://example.com/mcp",
            "",
            false,
            r#"[{"name":"read","access":"read","enabled":true}]"#,
            |_| Ok(()),
        )
        .unwrap();
        assert_eq!(
            call(json!({ "server_id": id, "tool": "read", "arguments": [1] }), &mut emit),
            Err("arguments must be a JSON object".into()),
        );
        assert_eq!(
            call(json!({ "server_id": id, "tool": "write" }), &mut emit),
            Err("tool \"write\" is not enabled".into()),
        );
        // no `arguments` is `{}`, not a refusal — a zero-parameter tool sends
        // nothing, and the call must reach the fetch-time scheme check
        assert_eq!(
            call(json!({ "server_id": id, "tool": "read" }), &mut emit),
            Err("Server URL must be http or https".into()),
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A model writes tool arguments as a string. Everything that is not a JSON
    /// object is a model error, not a crash — and an empty string means "no
    /// arguments", which is what a zero-parameter tool sends.
    #[test]
    fn tool_arguments_must_be_a_json_object() {
        assert_eq!(parse_args("").unwrap(), json!({}));
        assert_eq!(parse_args("  ").unwrap(), json!({}));
        assert_eq!(parse_args(r#"{"id":"x"}"#).unwrap()["id"], "x");
        for junk in ["[]", "null", "7", "\"q\"", "{oops}"] {
            assert!(parse_args(junk).is_none(), "{junk} must not parse as arguments");
        }
    }

    /// The seeded store has to exist on a fresh database, be idempotent across
    /// boots, and refuse deletion — the guard lives on `registry::delete_entry`
    /// so no IPC command or tool can route around it.
    #[test]
    fn saturns_memory_store_is_seeded_and_undeletable() {
        let dir = std::env::temp_dir().join(format!("saturn-seed-{}", uuid::Uuid::new_v4()));
        let db = dir.join("saturn.db");
        let store = Store::open(&db).unwrap();
        let count = |store: &Store| -> i64 {
            store
                .conn()
                .query_row(
                    "select count(*) from registry_entry where id = ?1",
                    [MEMORY_ID],
                    |r| r.get(0),
                )
                .unwrap()
        };
        assert_eq!(count(&store), 1);
        assert!(registry::is_uuid(MEMORY_ID), "the seeded id must pass the shape check");
        drop(store);

        // reopening runs SCHEMA again — `insert or ignore`, so still one row
        let store = Store::open(&db).unwrap();
        assert_eq!(count(&store), 1);
        assert_eq!(
            registry::delete_entry(&store, &crate::secrets::FakeVault::default(), MEMORY_ID)
                .unwrap_err(),
            "Saturn's memory store cannot be deleted"
        );
        assert_eq!(count(&store), 1);

        std::fs::remove_dir_all(&dir).ok();
    }
}
