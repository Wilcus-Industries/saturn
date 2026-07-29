# Workflows: data model, run pipeline, interpreter

> Part of the Saturn docs set indexed in `CLAUDE.md`. Node catalog lives in `docs/nodes.md`, canvas in `docs/designer.md`, senders + event transports in `docs/integrations.md`.

A workflow is a node graph. It triggers from its **event node** (any node in the
catalog's `events` category): the `schedule` node whose `config.cron` fires from
the per-minute tick, the `run` node that fires only on a manual run, or a
real-time `event:<id>` node delivered by one of the three transports.

Entry resolution is catalog-driven — `byKey[type].category === "events"` — so a
new event type is one descriptor in `lib/integrations.ts` plus its transport, and
neither the interpreter nor the designer changes.

**A workflow holds at most one event node.** The designer disables the event chip
once one exists and `validate_graph` errors on two or more. The interpreter
still walks every event-category node, so a legacy multi-event graph stays
correct.

**`active` is the master switch for triggering.** It gates scheduled runs *and*
real-time delivery — both the claim and the subscription query re-check it.
Manual and test runs ignore it.

## Storage

One SQLite file at `~/Library/Application Support/com.wilcus.saturn/saturn.db`,
opened in `store.rs` from `app_data_dir()` so the path follows
`tauri.conf.json`'s identifier and cannot drift from it. One `Connection` behind
a `Mutex` — a single-user desktop app, and SQLite is single-writer regardless, so
a pool would only buy contention on the same lock one level down.

| table | holds |
|---|---|
| `workflow` | id, name, emoji, description, `graph` (json text), `active`, `last_run_at` (the claim stamp), timestamps |
| `workflow_run` | `trigger` (cron/manual/event), `status` (running/success/error), `error`, `log` (json array of `ConsoleLine`), `started_at`/`finished_at`. Cascades from `workflow` |
| `registry_entry` | the user's own node types — see `docs/registry.md` |
| `memory_item` | an FTS5 virtual table; BM25 over `content`, scoped by an UNINDEXED `entry_id` |
| `github_cursor` | per-resource poll cursor + ETag — see `docs/integrations.md` |
| `saturn_session` | Saturn Agent's chat sessions: id, **unique** name, timestamps |
| `saturn_message` | one row per message: `session_id`, `role`, `content` (plain text), `parts` (json, display only), `created_at`. Cascades from `saturn_session` |

The two `saturn_*` tables are created by `saturn::init`, not `store.rs`'s
`SCHEMA` — `github_cursor` set that precedent, and a new *table* is free on an
existing `saturn.db` where a new column would not be.

**One row per message rather than a JSON blob per session**, because there are
two writers: the chat and a `saturn-agent` node run, both appending to the same
session. A read-modify-write of one blob loses whichever landed first. Appends
are serialized by SQLite's single-writer mutex and there is no per-session lock;
`content` is stored alongside `parts` so the re-sent transcript reads one column
with no per-message JSON parse.

No `user_id` anywhere: there is one user. The five sparse kind-specific columns
the Postgres `registry_entry` had collapsed into one `config` JSON blob, and
secrets left the database entirely for the Keychain — which is why no schema
column holds one.

`store.rs` owns the workflow and run queries; `registry.rs` and `memory.rs` keep
their own SQL next to the code that gives it meaning and share only the
*connection*. **Hold the connection guard for as short a span as possible** — it
serializes every reader in the process, and a network round trip inside one
would stall the scheduler for its full length.

## The list page

`/dashboard/workflows/` renders one card per workflow from `list_workflow_cards`
— one query, not N+1: a correlated subquery picks each workflow's newest run off
the `workflow_run_recent` index. The graph column is deliberately **not**
selected; it is the largest column in the file and the cards never draw it.

`workflowModal.tsx` is one modal for both create and edit, **metadata only** —
name, emoji, description. The schedule is authored in the graph, not here.
`activeToggle.tsx` is optimistic and calls `set_workflow_active` with an explicit
desired state, so a double-click is idempotent. Delete is idempotent too: a
workflow another window already removed is not an error.

`update_workflow` deliberately does **not** fire `subscriptions_changed()` — a
name or emoji cannot change a subscription, and it would fire on every close of
the metadata modal.

## Cron

`lib/cron.ts` (designer) and `runner.rs` (execution) implement the same grammar:
`*` or a plain integer per field, plus `*/n` for n ∈ [2,30] in the **minute field
only**. Five fields, UTC.

It is hand-written rather than delegated to a cron crate on purpose: it ANDs
day-of-month with day-of-week where standard cron ORs them (the visual builder
never restricts both), and it accepts only the grammar that builder emits. A
crate would silently disagree on exactly that rule.

`cronBuilder.tsx` is a callback component (`onChange(cron)`) hosted by the
designer's cron popover; it emits minutes / hourly / daily / weekly / monthly
shapes. `describeCron` humanizes them under the schedule node and in the topbar's
event label; `runner::is_valid_cron` backs the validator's "will never fire"
warning — the TypeScript copy went with `validateGraphStrict`.

## The scheduler

`runner::start_scheduler` is a self-arming tick aligned to :00 of each minute.
Per tick `run_due_workflows`:

1. reads the `active` workflows and keeps the `schedule` nodes whose cron matches
   that UTC minute — a workflow may hold several with different crons, and only
   the matching ones fire,
2. **claims** each candidate with a conditional `UPDATE` on `last_run_at`
   (`CLAIM_GUARD_S = 50`), which collapses a catch-up burst or a stray second
   tick for the same minute into one run,
3. executes the claimed runs on a `thread::scope`, passing the matching node ids
   as `entry_node_ids`.

Each conditional `UPDATE` is its own atomic claim — SQLite is single-writer, so
the Postgres original's reason for batching them into one statement (pgbouncer
making session advisory locks unusable) no longer applies.

`finish_run` deliberately does **not** re-stamp `last_run_at`. That column is the
claim ledger and the guard is measured from it, so re-stamping at completion
would make any run outlasting (interval − guard) turn the following minute into a
silent no-op — indistinguishable from ordinary guard suppression.

Missed-minute catch-up is capped at `MAX_CATCHUP_MINUTES = 5` so a laptop waking
from a long sleep recovers sparse crons without burst-firing history, and a tick
runs at most `MAX_RUNS_PER_TICK = 25` workflows.

## One run

`runner::execute_run(app, store, keychain, wf, trigger, entry_node_ids, event_payloads, cancel)`
is the single path. Every trigger goes through it:

| trigger | from | entry nodes |
|---|---|---|
| `cron` | the tick | the schedule nodes due this minute |
| `manual` | the designer's `test_run` | the one event node the designer selected |
| `event` | `events::ingest_event` | the node the delivery matched |

It records a `workflow_run` row, builds the `byKey` catalog, captures a log
capped at 300 lines × 2000 chars, runs the interpreter, and persists
status/error/log. It never panics.

Runs are **not pruned**. The hosted version trimmed to the newest 50 per
workflow; nothing does here, so `workflow_run` grows without bound. Each row is
bounded (the log cap above, and images persist as placeholders), so this is a
disk-usage question rather than a correctness one.

**A run owns a plain `std::thread`**, never a tokio worker. The interpreter is
synchronous and the blocking `reqwest` clients underneath it must not be
constructed on a runtime thread.

Console lines stream to the designer as `run-log` events while the walk proceeds,
per-port samples as `run-value`, and `run-finished` closes it out. An `image`
console line carries a `data:image/…` URL that the designer renders inline; the
persisted log keeps a `[image · mime · KB]` placeholder instead — base64 never
enters `workflow_run.log`.

There is **no whole-run timeout.** `MAX_STEPS` bounds the walk and every node has
a per-call timeout, but no single deadline covers a run (`docs/open-decisions.md`
§3.4).

### Stopping a run

`stop_run` sets one process-wide `AtomicBool`. Not a map keyed by run id: the
designer refuses to start a second test run while one is going and is the only
surface that can start one at all. `test_run` clears the flag before each run, so
a stop can never leak into the next one.

It is **cooperative** — the interpreter checks between flow steps and between
agent turns and tool calls, so an in-flight HTTP request or model call finishes
before the run unwinds with "run stopped".

## The interpreter

`src-tauri/src/interpreter.rs` — flow-edge traversal, per-step memoized value
resolution, per-chain visited-set cycle detection, `MAX_STEPS = 10_000`.

There is **no hook trait.** The TypeScript routed every side effect through
`RunHooks` because the same interpreter ran in two places; here there is one
process and one implementation, so effects are plain function calls. What varies
is where console lines go (a `Sender<ConsoleLine>`) and, for `run_inner` only,
the three `Effects` — which is what lets the golden fixtures drive the real walk
with deterministic stubs.

The walk is **synchronous** and recurses (fan-out, loop bodies, agent turns).
Async recursion in Rust means `Box::pin` at every nesting point for no benefit: a
run owns its own thread anyway, and the one blocking call must not sit on a
runtime worker.

Values are `js::Value`, not `String`. `interpreter/js.rs` ports JavaScript's
value semantics exactly — `String(n)`'s exponent thresholds, `Number(s)`'s
accepted forms, UTF-16 code-unit string ordering, `JSON.stringify`'s key order
and whole-float formatting. Rust agrees with none of it by default, and the
differences are visible in `fixtures/expected/extract.json`, which is why that
module carries its own JSON tree rather than fighting `serde_json`'s.

Flow outputs may fan out and branches run concurrently. `await` is a join
barrier: the last incoming flow edge to arrive continues the chain and fills
`results` with a JSON array of its `values` edges in edge order. A barrier an
upstream `if` diverged past warns once the outermost fan-out settles.

## Golden fixtures

`fixtures/cases/*.json` are graphs; `fixtures/expected/*.json` are the exact
console transcript and the exact per-port value stream each one produces.
`cargo test fixtures` replays all 47 through the Rust interpreter with the stubs
in `interpreter/fixtures.rs` and compares byte for byte.

**`expected/` is frozen.** The TypeScript oracle that produced it is deleted, so
there is nothing to regenerate from and no `--update` mode to reach for. A diff
means the Rust is wrong, unless the semantics were deliberately changed — in
which case the expected file is hand-edited in the same commit, with the reason
in the message. `docs/open-decisions.md` §1.5 records what that bought and what
it gave up.

A skipped case is **not** a pass: the summary names every skip and the node type
that caused it, so a half-finished port cannot hide behind a green run.

## Saving a graph

`store::set_graph` is the only write path, and validation plus the
`subscriptions_changed()` wake both live inside it so no future caller can save
past them. `workflow.rs` is that gate: node/edge count caps
(`MAX_NODES = 300`, `MAX_EDGES = 600`, `MAX_GRAPH_JSON = 256 KiB`), unique node
ids, edge endpoints that exist, node-type length.

It is deliberately **stricter** than the runtime model. `interpreter.rs`'s graph
deserialization ignores unknown fields, tolerates duplicate ids and never reads
`x`/`y`, because a graph already in the database must keep running. `workflow.rs`
decides what is allowed to get *in* — so it is strict about exactly the things a
designer bug or a hand-written graph could break.

Deep per-node validation is `validate_graph_strict` in the same module, reached
over IPC as `validate_graph`. It rebuilds `byKey` from the database itself
(`CATALOG` + `registry::get_user_registry`), so the designer's issues panel and
the run pipeline cannot disagree about the same graph. `fixtures/validation.json`
— 30 cases captured from the deleted TypeScript — is its frozen specification.

## Run history

`/dashboard/workflows/runs/?id=` lists the newest 50 runs (`list_runs`, clamped
1–200), each with a `<details>` log viewer. Times render as UTC, because that is
the clock the schedule runs on.
