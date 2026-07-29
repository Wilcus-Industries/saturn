//! Port of lib/memory.server.ts. A memory store is a `registry_entry` of kind
//! `memory`; its items are `memory_item` rows in the sqlite-vec `vec0` table.
//! An agent with a store attached gets three tools — memory_search /
//! memory_save / memory_forget — resolved to tool specs like MCP tools but
//! executed here against the local table instead of an external server.
//!
//! Every failure comes back as a value (`Err(String)` the caller renders), never
//! a panic: these strings are fed back to the model and printed to the run
//! console, exactly as the TypeScript's `{ error }` results were.
//!
//! Search is BM25 over an FTS5 index, not vector similarity. The embedding call
//! this module used to make was the last thing in the app that *required* an
//! OpenRouter key — an agent running entirely on a local provider still could not
//! use its own memory — and it bought semantic recall the rest of the design does
//! not need: a personal store of short notes, queried by a model that is perfectly
//! able to phrase a keyword query (`docs/open-decisions.md` §1.6). The cost is
//! real and accepted: "car" no longer retrieves "automobile".
//!
//! What that bought back: no key, no network, no 30 s timeout on the run thread,
//! no vector width baked into the table, and a search that returns in microseconds
//! instead of a ~200 ms round trip.
//!
//! Two things the hosted version had are gone on purpose:
//!   - `MAX_MEMORY_ITEMS = 2000`, a per-store cap that existed because Postgres
//!     had no ANN index here and the store was a tenant's slice of a shared
//!     table. Stores are uncapped now.
//!   - the platform-key / credits-ledger fork in `embed`, along with `embed`.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::params;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::agent::ToolRef;
use crate::interpreter::js::{self, J};
use crate::interpreter::utf16_prefix;
use crate::mcp::{McpToolParam, McpToolParamType};
use crate::openrouter::ToolSpec;
// one canonical copy of each: the uuid shape check lives with UUID_RE's port,
// the civil calendar with the cron port. Two copies of a validator is one place
// to drift.
use crate::registry::is_uuid;
use crate::runner::civil_from_days;
use crate::store::Store;

/// Chars per saved item. Bounds what a model can shove into the store in one
/// call; over-cap is REJECTED rather than truncated so the model summarizes
/// instead of silently losing the tail.
pub const MAX_MEMORY_CONTENT: usize = 2000;

/// Search query length cap — same reason as MAX_MEMORY_CONTENT, and counted in
/// the same UTF-16 units as every other cap in the interpreter.
const MAX_QUERY: usize = 1000;
/// The settings list is a browse view, not the store.
const MAX_LIST_ITEMS: usize = 500;

/// The tool names that route to the local store instead of an MCP server
/// (MEMORY_TOOL_NAMES in lib/agent.ts).
pub const MEMORY_TOOL_NAMES: [&str; 3] = ["memory_search", "memory_save", "memory_forget"];
const MEMORY_SEARCH: &str = MEMORY_TOOL_NAMES[0];
const MEMORY_SAVE: &str = MEMORY_TOOL_NAMES[1];

// --- tool specs -------------------------------------------------------------

pub(crate) fn param(
    name: &str,
    param_type: McpToolParamType,
    required: bool,
    description: &str,
) -> McpToolParam {
    McpToolParam {
        name: name.to_string(),
        param_type,
        required,
        description: Some(description.to_string()),
    }
}

/// One memory tool as `buildToolDefs` consumes it — the same `ToolSpec` a
/// granted MCP tool resolves to, with the ref flattened: `entry_id` is the
/// memory store id, mirroring an MCP tool ref, and it is what makes
/// `agent::run_loop`'s `is_memory` test (`req.memory_id == call.entry_id`) fire.
pub(crate) fn spec(memory_id: &str, tool_name: &str, description: &str, params: Vec<McpToolParam>) -> ToolSpec {
    ToolSpec {
        tool_ref: ToolRef {
            entry_id: memory_id.to_string(),
            tool_name: tool_name.to_string(),
            exclude: Vec::new(),
        },
        description: Some(description.to_string()),
        params: Some(params),
    }
}

/// The three tools one attached memory store contributes.
pub fn memory_tool_specs(memory_id: &str) -> Vec<ToolSpec> {
    vec![
        spec(
            memory_id,
            MEMORY_TOOL_NAMES[0],
            "Keyword search over the attached memory store. Matches on the words in the query, so name the terms you expect to appear in a saved item rather than asking a question. Returns the best-matching items, most relevant first, with their ids, content and timestamps.",
            vec![
                param("query", McpToolParamType::String, true, "words to look for"),
                param("limit", McpToolParamType::Number, false, "max results, 1-20, default 5"),
            ],
        ),
        spec(
            memory_id,
            MEMORY_TOOL_NAMES[1],
            "Store a durable fact, preference, or summary in the memory store (max 2000 chars). For lasting knowledge worth recalling later — not raw transcripts.",
            vec![param(
                "content",
                McpToolParamType::String,
                true,
                "the fact or summary to remember",
            )],
        ),
        spec(
            memory_id,
            MEMORY_TOOL_NAMES[2],
            "Permanently delete one memory item by its id (ids come from memory_search results).",
            vec![param(
                "id",
                McpToolParamType::String,
                true,
                "id of the memory item to delete",
            )],
        ),
    ]
}

// --- dispatch ---------------------------------------------------------------

/// Executes one memory tool call. Errors are values, same contract as the MCP
/// tool path: the agent loop feeds them back to the model.
pub fn execute_memory_tool(
    store: &Store,
    memory_id: &str,
    op: &str,
    input: &str,
) -> Result<String, String> {
    if !is_uuid(memory_id) {
        return Err("invalid memory id".into());
    }
    if !MEMORY_TOOL_NAMES.contains(&op) {
        return Err("unknown memory operation".into());
    }
    if !memory_store_exists(store, memory_id)? {
        return Err("memory store not found".into());
    }

    let args = parse_args(input)?;

    if op == MEMORY_SEARCH {
        let (query, limit) = search_args(&args)?;
        search(store, memory_id, &query, limit)
    } else if op == MEMORY_SAVE {
        save(store, memory_id, &save_content(&args)?)
    } else {
        forget(store, memory_id, args.get("id").and_then(Value::as_str).unwrap_or(""))
    }
}

/// The model-built argument object. Anything that is not a JSON object (array,
/// scalar, null, junk) is refused with the shape hint — same convention as
/// `executeMcpTool`.
fn parse_args(input: &str) -> Result<Map<String, Value>, String> {
    let trimmed = js::trim(input);
    if trimmed.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_str::<Value>(trimmed) {
        Ok(Value::Object(map)) => Ok(map),
        _ => Err(r#"input must be a JSON object, e.g. {"query":"..."}"#.into()),
    }
}

fn memory_store_exists(store: &Store, memory_id: &str) -> Result<bool, String> {
    store
        .conn()
        .query_row(
            "select 1 from registry_entry where id = ?1 and kind = 'memory'",
            [memory_id],
            |_| Ok(()),
        )
        .map(|_| true)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(false),
            other => Err(other.to_string()),
        })
}

// --- the three operations ---------------------------------------------------

/// `(query, limit)`. The query is trimmed then cut to MAX_QUERY *before* the
/// emptiness test, exactly as the TypeScript ordered it.
fn search_args(args: &Map<String, Value>) -> Result<(String, i64), String> {
    let raw = js::trim(args.get("query").and_then(Value::as_str).unwrap_or(""));
    let query = utf16_prefix(raw, MAX_QUERY).unwrap_or_else(|| raw.to_string());
    if query.is_empty() {
        return Err("query must be a non-empty string".into());
    }
    // `Math.floor` of a non-number is NaN and `Number.isFinite` then falls back
    // to 5; JSON cannot carry NaN/Infinity, so only the non-number path is
    // reachable — kept anyway because that is what the original decided.
    let floored = args
        .get("limit")
        .and_then(Value::as_f64)
        .map(f64::floor)
        .filter(|n| n.is_finite())
        .unwrap_or(5.0);
    Ok((query, floored.clamp(1.0, 20.0) as i64))
}

fn save_content(args: &Map<String, Value>) -> Result<String, String> {
    let content = js::trim(args.get("content").and_then(Value::as_str).unwrap_or(""));
    if content.is_empty() {
        return Err("content must be a non-empty string".into());
    }
    // reject over-cap rather than silently truncate — the model should know
    if content.encode_utf16().count() > MAX_MEMORY_CONTENT {
        return Err(format!(
            "content too long (max {MAX_MEMORY_CONTENT} chars) — summarize it first"
        ));
    }
    Ok(content.to_string())
}

/// BM25 over one store. Constraining `entry_id` is not an optimization — it is
/// UNINDEXED, so SQLite core applies it after the match — but leaving it off
/// would search every store in the file at once, which is cross-store leakage
/// straight into the model's context. `order by rank` is FTS5's own relevance
/// order (ascending bm25, best first).
///
/// No `score` in the result: bm25 is an unbounded negative number, not the 0-1
/// similarity the vector version returned, and normalizing it into one would be
/// an invented number the model would then reason about. Rank order is the
/// signal.
fn search(store: &Store, memory_id: &str, query: &str, limit: i64) -> Result<String, String> {
    let Some(match_expr) = fts_query(query) else {
        // nothing tokenizable ("???", "…") — an empty MATCH is a syntax error
        return Ok(js::stringify(&J::A(Vec::new())));
    };
    let conn = store.conn();
    let mut stmt = conn
        .prepare(
            "select rowid, content, created_at from memory_item
              where memory_item match ?1 and entry_id = ?2
              order by rank limit ?3",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![match_expr, memory_id, limit], |r| {
            Ok(J::O(vec![
                ("id".into(), J::S(r.get::<_, i64>(0)?.to_string())),
                ("content".into(), J::S(r.get(1)?)),
                ("created_at".into(), J::S(iso(r.get(2)?))),
            ]))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<J>, _>>()
        .map_err(|e| e.to_string())?;
    // js::J, not serde_json: this string goes to the model, and serde_json's Map
    // would alphabetize the keys
    Ok(js::stringify(&J::A(rows)))
}

fn save(store: &Store, memory_id: &str, content: &str) -> Result<String, String> {
    let conn = store.conn();
    conn.execute(
        "insert into memory_item (content, entry_id, created_at) values (?1, ?2, ?3)",
        params![content, memory_id, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(js::stringify(&J::O(vec![
        ("id".into(), J::S(conn.last_insert_rowid().to_string())),
        ("saved".into(), J::B(true)),
    ])))
}

/// Scoped by entry_id as well as id, so an id lifted from another store's search
/// results cannot be forgotten through this store's tool.
fn forget(store: &Store, memory_id: &str, id: &str) -> Result<String, String> {
    // the id is a vec0 rowid, not a uuid — see the module report
    let Ok(rowid) = id.parse::<i64>() else {
        return Err("invalid memory item id".into());
    };
    let deleted = store
        .conn()
        .execute(
            "delete from memory_item where rowid = ?1 and entry_id = ?2",
            params![rowid, memory_id],
        )
        .map_err(|e| e.to_string())?;
    if deleted == 0 {
        return Err("memory not found".into());
    }
    Ok(js::stringify(&J::O(vec![("forgotten".into(), J::B(true))])))
}

// --- the match expression ---------------------------------------------------

/// Turns a model-written query into an FTS5 MATCH expression, or `None` when
/// nothing is left to match on.
///
/// This is not cosmetic. FTS5's MATCH argument is a *query language*, not a
/// string: `"what's the deploy pipeline?"` is a hard `fts5: syntax error near
/// "'"`, and `AND`, `OR`, `NOT`, `NEAR`, `*`, `^`, `:`, `-` and `"` are all
/// operators a model would otherwise trip by accident. So no user or model text
/// is ever passed through — every alphanumeric run is lifted out and re-emitted
/// as a quoted term, which cannot carry syntax.
///
/// Joined with OR, not FTS5's implicit AND: a natural-language query carries
/// filler words no saved item contains, and AND would return nothing at all for
/// most of them. OR plus `order by rank` ranks partial matches instead, which is
/// the closest BM25 gets to what the vector search used to do.
fn fts_query(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\""))
        .collect();
    (!terms.is_empty()).then(|| terms.join(" OR "))
}

// --- settings views ---------------------------------------------------------

/// `created_at` is epoch millis rather than the TypeScript's `Date` — the column
/// is an INTEGER now and the UI builds its own Date from it.
#[derive(Serialize)]
pub struct MemoryItemRow {
    pub id: String,
    pub content: String,
    pub created_at: i64,
}

/// Items in one store, newest first, optional content substring filter.
///
/// A `match`-less vec0 query is a full scan, so SQLite core applies the
/// entry_id, the LIKE and the ORDER BY itself rather than vec0 (a WHERE on an
/// auxiliary column such as `content` is outright rejected inside a KNN query).
/// Fine for a view capped at 500 rows; a KNN search never takes this path.
pub fn list_memory_items(
    store: &Store,
    entry_id: &str,
    q: &str,
) -> rusqlite::Result<Vec<MemoryItemRow>> {
    let filter = js::trim(q);
    let conn = store.conn();
    let row = |r: &rusqlite::Row| {
        Ok(MemoryItemRow {
            id: r.get::<_, i64>(0)?.to_string(),
            content: r.get(1)?,
            created_at: r.get(2)?,
        })
    };
    if filter.is_empty() {
        let mut stmt = conn.prepare(&format!(
            "select rowid, content, created_at from memory_item
              where entry_id = ?1 order by created_at desc limit {MAX_LIST_ITEMS}"
        ))?;
        let items = stmt.query_map([entry_id], row)?.collect();
        return items;
    }
    // escape LIKE metacharacters so a stray %/_ can't widen the match
    let mut pattern = String::from("%");
    for c in filter.chars() {
        if matches!(c, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern.push('%');
    // LIKE is ASCII case-insensitive by default, which is what `ilike` gave us
    let mut stmt = conn.prepare(&format!(
        "select rowid, content, created_at from memory_item
          where entry_id = ?1 and content like ?2 escape '\\'
          order by created_at desc limit {MAX_LIST_ITEMS}"
    ))?;
    let items = stmt.query_map(params![entry_id, pattern], row)?.collect();
    items
}

/// Port of `deleteMemoryItem`. The id is the vec0 rowid rendered as a string
/// (`MemoryItemRow::id`), not a uuid — there is no per-item uuid column to check
/// a shape against, so a non-numeric id is simply "Not found" rather than a SQL
/// type error.
pub fn delete_memory_item(store: &Store, id: &str) -> Result<(), String> {
    let Ok(rowid) = id.parse::<i64>() else {
        return Err("Not found".into());
    };
    let removed = store
        .conn()
        .execute("delete from memory_item where rowid = ?1", [rowid])
        .map_err(|e| e.to_string())?;
    if removed == 0 {
        return Err("Not found".into());
    }
    Ok(())
}

/// entry_id → item count, for the stores list.
pub fn count_memory_items(store: &Store) -> rusqlite::Result<HashMap<String, i64>> {
    let conn = store.conn();
    let mut stmt = conn.prepare("select entry_id, count(*) from memory_item group by entry_id")?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    rows.collect()
}

// --- small helpers ----------------------------------------------------------

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64
}

/// `Date.prototype.toISOString()` — always UTC, always three fractional digits.
/// The model reads these timestamps out of search results, so the format is part
/// of the tool's contract.
fn iso(ms: i64) -> String {
    let (days, rest) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
    let (y, mo, d) = civil_from_days(days);
    let (h, mi, s, milli) =
        (rest / 3_600_000, rest / 60_000 % 60, rest / 1000 % 60, rest % 1000);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{milli:03}Z")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const STORE_A: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const STORE_B: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    /// A store on disk in a fresh temp dir (`Store::open` creates the parent, and
    /// ":memory:" would have no parent to create). Both stores are registered in
    /// registry_entry so `execute_memory_tool`'s existence check passes.
    fn store() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("saturn-mem-{}", uuid::Uuid::new_v4()));
        let store = Store::open(&dir.join("saturn.db")).unwrap();
        for id in [STORE_A, STORE_B] {
            store
                .conn()
                .execute(
                    "insert into registry_entry (id, kind, name, created_at, updated_at)
                     values (?1, 'memory', 'notes', 0, 0)",
                    [id],
                )
                .unwrap();
        }
        (store, dir)
    }

    #[test]
    fn save_search_forget_round_trip() {
        let (store, dir) = store();

        let saved = save(&store, STORE_A, "the deploy key lives in 1password").unwrap();
        assert!(saved.contains(r#""saved":true"#));
        let id = serde_json::from_str::<Value>(&saved).unwrap()["id"].as_str().unwrap().to_string();
        save(&store, STORE_A, "unrelated note about coffee").unwrap();
        save(&store, STORE_A, "the deploy runbook").unwrap();

        let hits = search(&store, STORE_A, "deploy key", 5).unwrap();
        // key order is JSON.stringify's, i.e. the order search() writes them —
        // this whole string is what the model reads back
        assert!(hits.starts_with(r#"[{"id":"#), "{hits}");
        let parsed: Value = serde_json::from_str(&hits).unwrap();
        // the coffee note shares no term, so OR does not drag it in
        assert_eq!(parsed.as_array().unwrap().len(), 2, "{hits}");
        // and `order by rank` puts the item matching both terms above the one
        // matching only "deploy" — the whole point of ranking rather than filtering
        assert_eq!(parsed[0]["content"], "the deploy key lives in 1password");
        assert_eq!(parsed[1]["content"], "the deploy runbook");
        assert_eq!(parsed[0]["id"], id);
        assert!(parsed[0]["created_at"].as_str().unwrap().ends_with('Z'));
        // bm25 is unbounded and negative; emitting it as the old 0-1 "score" would
        // hand the model a number it would misread
        assert!(parsed[0].get("score").is_none(), "{hits}");

        let one: Value =
            serde_json::from_str(&search(&store, STORE_A, "deploy key", 1).unwrap()).unwrap();
        assert_eq!(one.as_array().unwrap().len(), 1);
        assert_eq!(one[0]["id"], id);

        assert_eq!(forget(&store, STORE_A, &id).unwrap(), r#"{"forgotten":true}"#);
        assert_eq!(forget(&store, STORE_A, &id).unwrap_err(), "memory not found");
        let after: Value =
            serde_json::from_str(&search(&store, STORE_A, "deploy key", 5).unwrap()).unwrap();
        assert_eq!(after.as_array().unwrap().len(), 1);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// entry_id is UNINDEXED, so nothing scopes a query but the WHERE clause.
    /// Forget it and every store in the file is searched at once — another agent's
    /// memories land in this agent's context. Identical text makes the leak
    /// unmissable if scoping breaks.
    #[test]
    fn stores_are_isolated_by_entry_id() {
        let (store, dir) = store();
        save(&store, STORE_A, "a-secret").unwrap();
        let b_saved = save(&store, STORE_B, "b-secret").unwrap();
        let b_id = serde_json::from_str::<Value>(&b_saved).unwrap()["id"].as_str().unwrap().to_string();

        for (entry, expected) in [(STORE_A, "a-secret"), (STORE_B, "b-secret")] {
            let hits: Value =
                serde_json::from_str(&search(&store, entry, "secret", 20).unwrap()).unwrap();
            assert_eq!(hits.as_array().unwrap().len(), 1, "search leaked across stores: {hits}");
            assert_eq!(hits[0]["content"], expected);
        }
        // the uuid itself is UNINDEXED, so it can never be matched *on*
        assert_eq!(search(&store, STORE_A, STORE_A, 20).unwrap(), "[]");

        // an id lifted from B's results cannot be forgotten through A
        assert_eq!(forget(&store, STORE_A, &b_id).unwrap_err(), "memory not found");
        assert!(forget(&store, STORE_B, &b_id).is_ok());

        // the browse views scope the same way
        let listed = list_memory_items(&store, STORE_A, "").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].content, "a-secret");
        assert!(list_memory_items(&store, STORE_A, "b-sec").unwrap().is_empty());
        assert_eq!(list_memory_items(&store, STORE_A, "SECRET").unwrap().len(), 1); // ilike
        // a bare % must not widen the match
        assert!(list_memory_items(&store, STORE_A, "%").unwrap().is_empty());
        assert_eq!(count_memory_items(&store).unwrap(), HashMap::from([(STORE_A.to_string(), 1)]));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The two caps that bound what a model can push into the store, both
    /// counted in UTF-16 units like every `.length` in the TypeScript.
    #[test]
    fn caps_bound_the_query_and_the_content() {
        // an astral char is 2 UTF-16 units, so 500 of them are exactly MAX_QUERY
        let astral = "😀".repeat(600);
        let args = json!({ "query": format!("  {astral}  ") });
        let (query, limit) = search_args(args.as_object().unwrap()).unwrap();
        assert_eq!(query.encode_utf16().count(), MAX_QUERY);
        assert_eq!(query.chars().count(), MAX_QUERY / 2, "cut in the middle of a surrogate pair");
        assert_eq!(limit, 5); // absent limit

        for (given, want) in [(0.0, 1), (0.4, 1), (7.9, 7), (999.0, 20), (-5.0, 1)] {
            let args = json!({ "query": "q", "limit": given });
            assert_eq!(search_args(args.as_object().unwrap()).unwrap().1, want);
        }
        // a non-number limit falls back to the default rather than failing
        assert_eq!(search_args(json!({"query":"q","limit":"9"}).as_object().unwrap()).unwrap().1, 5);
        assert_eq!(
            search_args(json!({ "query": "   " }).as_object().unwrap()).unwrap_err(),
            "query must be a non-empty string"
        );

        assert_eq!(save_content(json!({ "content": "  hi  " }).as_object().unwrap()).unwrap(), "hi");
        assert_eq!(
            save_content(json!({ "content": "😀".repeat(1001) }).as_object().unwrap()).unwrap_err(),
            format!("content too long (max {MAX_MEMORY_CONTENT} chars) — summarize it first")
        );
        // exactly at the cap is fine — the check is `>`, not `>=`
        assert!(save_content(json!({ "content": "😀".repeat(1000) }).as_object().unwrap()).is_ok());
        assert_eq!(
            save_content(json!({ "content": 5 }).as_object().unwrap()).unwrap_err(),
            "content must be a non-empty string"
        );
    }

    /// FTS5's MATCH argument is a query *language*, so a model writing the most
    /// ordinary question — an apostrophe, a question mark, the word "and" — is a
    /// hard SQL error unless `fts_query` rebuilds it. Every string below throws
    /// `fts5: syntax error` if passed through raw.
    #[test]
    fn a_model_written_query_never_reaches_fts5_as_syntax() {
        assert_eq!(
            fts_query("what's the deploy pipeline?").unwrap(),
            r#""what" OR "s" OR "the" OR "deploy" OR "pipeline""#
        );
        // operator words survive only because they are quoted into inert terms
        assert_eq!(fts_query(r#"a AND b* NOT "c""#).unwrap(), r#""a" OR "AND" OR "b" OR "NOT" OR "c""#);
        assert_eq!(fts_query("  ???  "), None);
        assert_eq!(fts_query(""), None);

        let (store, dir) = store();
        save(&store, STORE_A, "the deploy pipeline runs nightly").unwrap();
        // punctuation and operator characters are stripped, so the words around
        // them still find the item
        for q in ["what's the deploy pipeline?", "^pipeline:", "-deploy", "pipeline*", "NEAR(pipeline)"] {
            let hits: Value = serde_json::from_str(&search(&store, STORE_A, q, 5).expect(q)).unwrap();
            assert_eq!(hits.as_array().unwrap().len(), 1, "{q} matched nothing");
        }
        // bare operator words are terms like any other: no error, no match
        assert_eq!(search(&store, STORE_A, "AND OR NOT", 5).unwrap(), "[]");
        // and a query with nothing tokenizable is an empty result, not an empty
        // MATCH — which is itself a syntax error
        for q in ["???", r#"""""#, "…"] {
            assert_eq!(search(&store, STORE_A, q, 5).unwrap(), "[]", "{q}");
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Everything execute_memory_tool refuses before it touches the table.
    #[test]
    fn dispatch_guards_run_before_any_search() {
        let (store, dir) = store();
        let call = |id: &str, op: &str, input: &str| execute_memory_tool(&store, id, op, input);

        assert_eq!(call("not-a-uuid", "memory_search", "{}").unwrap_err(), "invalid memory id");
        assert_eq!(call(STORE_A, "memory_wipe", "{}").unwrap_err(), "unknown memory operation");
        assert_eq!(
            call("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "memory_search", "{}").unwrap_err(),
            "memory store not found"
        );
        for junk in ["[]", "null", "\"q\"", "{oops}"] {
            assert_eq!(
                call(STORE_A, "memory_search", junk).unwrap_err(),
                r#"input must be a JSON object, e.g. {"query":"..."}"#,
                "{junk} should not parse as an argument object"
            );
        }
        assert_eq!(call(STORE_A, "memory_forget", r#"{"id":"nope"}"#).unwrap_err(), "invalid memory item id");
        assert_eq!(call(STORE_A, "memory_forget", r#"{"id":"7"}"#).unwrap_err(), "memory not found");
        // and the whole surface runs with no key of any kind in scope — this is
        // what the OpenRouter embedding call used to make impossible
        assert_eq!(call(STORE_A, "memory_search", r#"{"query":"x"}"#).unwrap(), "[]");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn timestamps_and_specs_match_the_javascript() {
        // node: new Date(1753382096789).toISOString()
        assert_eq!(iso(1_753_382_096_789), "2025-07-24T18:34:56.789Z");
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");

        assert!(is_uuid(STORE_A) && is_uuid(&STORE_A.to_uppercase()));
        assert!(!is_uuid("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa") && !is_uuid(""));

        let specs = memory_tool_specs(STORE_A);
        assert!(specs.iter().all(|s| s.tool_ref.entry_id == STORE_A));
        assert_eq!(
            specs.iter().map(|s| s.tool_ref.tool_name.as_str()).collect::<Vec<_>>(),
            MEMORY_TOOL_NAMES.to_vec(),
        );
    }
}
