# Open decisions

Things the Rust rewrite deferred, diverged on, or left cold. Written as they
came up (Phases C–E) so the end-of-project reconciliation has a list rather than
a memory. **Reconcile this file together with the `docs/` rewrite.**

Line numbers drift; symbol and file names are the durable anchors.

Three sections:

1. **Needs a call** — a product or design question with no obviously right
   answer. Nothing below is blocking today; each one has a live default that
   will simply persist if nobody decides otherwise.
2. **Known divergences** — the Rust deliberately does something the TypeScript
   did not. Decided already; recorded so a future reader does not "fix" them.
3. **Deferred work** — things that are just not built yet, and what unblocks
   them.

---

## 1. Needs a call

### 1.1 GitHub events replay after a long sleep

**Current behaviour:** cursors persist in `github_cursor`, and there is no age
check anywhere on the GitHub path. Close the laptop Friday, open it Monday, and
one poll dispatches everything above the cursor as live events — bounded only by
page size (up to ~50 issues, ~50 PRs, 100 stars, plus a push).

**What changed:** `lib/github.server.ts` had `SKIP_OLDER_THAN_S = 900` *and* the
cursor, and called the age check "the secondary guard against replay". The
rewrite kept the cursor and dropped the guard. Telegram kept its equivalent
(`telegram.rs:64`, 300s) and Discord kept its own, so GitHub is now the odd one.

**The tension is real, not an oversight.** The plan sells the persisted cursor as
"a laptop that was asleep catches up from its cursor on wake — missed webhook
deliveries would simply have been gone." That is a genuine gain over webhooks.
But re-announcing week-old issues to Discord as if they just happened is
arguably worse than missing them, and it is not obvious the answer is the same
for every resource: catching up on a **push** you missed is useful; catching up
on 100 **stars** is noise.

The thundering-herd half is already fixed — delivery is `spawn_blocking` now, so
it no longer spawns ~200 unbounded OS threads.

**Options:** port the 900s guard as-is · apply it per resource (push/release
catch up, issue/pr/star do not) · cap fan-out per pass and keep full catch-up.

Cost: threading a clock into the currently-pure `apply()` and rewriting four
payload tests whose fixtures carry fixed timestamps.

### 1.2 `github-star` cannot work unauthenticated

Page 1 of `/stargazers` is fetched **without** `if-none-match` on purpose — it
holds the oldest stars and would 304 forever. But a 200 costs rate-limit quota
where a 304 does not, so at `POLL_S = 30` one star watch is ~120 counted
requests/hour against GitHub's 60/hr unauthenticated budget.

Consequence: guaranteed 403, and since `Poller::resume_at` is global (correctly —
one PAT, one budget) that parks *every* push/issue/pr/release watch until the
reset. Meanwhile the PAT is documented as optional in `main.rs` and in the module
header.

**Options:** require a PAT for `github-star` specifically and say so in the UI ·
gate the star poll behind a conditional GET of `/repos/{o}/{r}` and its
`stargazers_count` · raise the star interval far above 30s.

### 1.3 The http-request node reaches the local network

`http::parse_request_url` checks the scheme and nothing else — private
addresses, plain http and localhost all pass. This was your call, and the reason
holds: on a single-user desktop app the graph is the user's own, and the node's
whole point is reaching Ollama on 11434, a NAS, or Home Assistant.

Recorded here because it is a real reduction in blast radius versus the hosted
product, one reviewer asked for a second opinion on it, and it is the kind of
thing that looks like a bug to someone reading `assert_public_https_url` two
files over. The strict guard **is** still enforced on every MCP fetch, where the
URL and all metadata-derived endpoints are attacker-controlled.

No change proposed. Confirm it still reads correctly at the end.

### 1.4 Event-node payload key order is load-bearing and unenforced

All three transports' payload builders are order-preserving today (`js::J` for
Discord and GitHub, a serde struct for Telegram) and match `lib/integrations.ts`
`samplePayload` exactly. Nothing stops a future edit from using
`serde_json::Map`, which sorts, and no test would fail — the payload a graph
destructures would just quietly change shape.

**Options:** a test asserting the serialized key order of each payload builder ·
enable `serde_json`'s `preserve_order` crate-wide (see 2.1) and stop worrying.

### 1.5 Does the TypeScript interpreter stay now that nothing runs it?

Phase F deleted the designer's `import("@/lib/interpreter")`, so `lib/interpreter.ts`
(805 lines) executes nothing. Its only remaining consumers are three compile-erased
`import type { ConsoleLine }` lines and `fixtures/run.mjs`, the oracle that
generated `fixtures/expected/`.

`fixtures/README.md` — written before Phase F and already committed — says
outright: *"Phase F deletes the TypeScript interpreter. From that moment
`expected/` **is** the specification."* The deletion pass did not do it, and the
question is whether it should.

**For deleting** (the ponytail reading): it is a second implementation of
semantics only Rust now executes, so it can drift silently, and
`node fixtures/run.mjs --update` still exists and will rewrite the spec the README
forbids rewriting. It drags ~130 lines of now-dead exports with it —
`isWorkflowGraph`, `graphShapeError`, `WorkflowRow`, `MAX_EDGES`,
`MAX_GRAPH_JSON`, `mergeTools`, `cronMatches`, `MODEL_ID`, `toReasoningParam`,
`MEMORY_TOOL_NAMES` — several of which read as the live cap and are not
(`MAX_GRAPH_JSON` in TypeScript is inert; Rust's is the real one, and per §2.1 it
measures a different serialization).

**For keeping:** two independent implementations agreeing on 47 fixtures is a
stronger signal than one implementation agreeing with a file it generated. Delete
the oracle and `expected/` can never be regenerated or cross-checked again — which
is exactly the guarantee the fixtures exist to provide, and the thing that would
catch a Rust interpreter change that is wrong in the same direction as its test.

Both oracles are green today (`node fixtures/run.mjs` and `cargo test fixtures`
each 47/47). Nothing forces the decision; the cost of waiting is the dead exports.

---

## 2. Known divergences

Decided. Listed so nobody "fixes" them into a regression.

### 2.1 `to_parameters` alphabetizes the JSON Schema sent to OpenRouter

`serde_json::Map` is a `BTreeMap` — `preserve_order` is **not** enabled — so the
tool schema the model reads has sorted keys where the TypeScript preserved
declaration order.

Not a correctness break: JSON Schema `properties` is an unordered map. But it
does quietly undo the `js::J` machinery in `mcp.rs` that exists to preserve the
MCP server's declaration order through the `MAX_TOOL_PARAMS = 12` cap. Left
alone because enabling `preserve_order` swaps a crate-wide data structure and
changes how every graph is serialized to SQLite — disproportionate for a
presentational difference. Revisit if 1.4 pushes the same way.

### 2.2 The MCP session cache was dropped

`lib/mcp.ts` held a 60s TTL cache of initialized session ids (keyed by URL +
SHA-256 of the token) and retried a stale session on 400/404. `mcp::call_tool`
re-handshakes unconditionally.

Correctness is unaffected — the handshake is idempotent, and the stale-session
retry becomes moot when nothing is cached. Costs two extra round trips per tool
call, so up to 80 extra requests per run at `MAX_AGENT_MCP_CALLS = 40`. Dropping
it also removes the cross-credential-reuse risk the TypeScript had to hash the
token to avoid. Add a `Mutex<HashMap>` version (~15 lines) if latency is ever
measured to matter.

### 2.3 The event claim guard is 0 seconds, not cron's 50

`lib/events.server.ts` stamped `last_run_at` with **no time predicate** and a
comment saying "Every mention runs (no cooldown)". A 50s window would silently
drop the second of two Discord messages a minute apart, which is exactly what a
chat bot must not do. `store::claim_workflow` is reused with a 0 guard, which
now short-circuits to "no predicate" rather than `last_run_at <= now` — the
latter dropped deliveries whenever an NTP step put the clock behind the stamp.

### 2.4 MCP redirect handling is stronger than the TypeScript

`node fetch` followed redirects internally, so `assertPublicHttpsUrl` only ever
saw the first URL — a hostile MCP server answering `302 → https://169.254.169.254/`
was fetched. The Rust follows redirects manually and re-validates every hop,
pins the validated address with `ClientBuilder::resolve_to_addrs` (closing a
DNS-rebinding race Node could not), strips `authorization`/`cookie` cross-origin,
and caps the response body. These are deliberate hardenings, not port errors.

### 2.5 Smaller ones, all deliberate

- `mcp::send_guarded` duplicates `http::send`'s redirect loop and the two have
  already drifted (`http.rs` clamps the per-hop timeout, `mcp.rs` does not). The
  `mcp.rs` copy has **no test coverage** of the strip/downgrade/hop-cap logic,
  because its own guard blocks the loopback address the test server binds. One
  loop parameterized by URL policy would fix both.
- Double DNS resolution per hop on the MCP path: the guard resolves, then
  `pinned_client` resolves again and validates independently. Only the second is
  connected to, so the first is dead weight — one extra `getaddrinfo` per hop.
- `assert_https_url_shape` does not reject credentials in the URL
  (`https://good.example.com@10.0.0.1/`). Not exploitable — the guard reads the
  real host — but a phishing-shaped URL survives save-time validation and is
  shown back to the user.
- `IngestResult` has no `status` field, so the transports' "delivered to
  workflow" log lines carry less than the TypeScript's did.
- `github.rs` logs `{result:?}` untruncated where both sibling transports use a
  200-char cut. Bounded and secret-free, but inconsistent.
- `github::poll_interval` is unreachable: `X-Poll-Interval` is an Events-API-only
  header and the rewrite abandoned `/events`. `self.interval` is always `POLL_S`
  and the clamp is decoration. No dead-code warning can catch this shape — the
  function *is* called.
- `gateway.rs` resume gate is `session_id.is_some()`, where JS tested truthiness.
  A READY with `session_id: ""` would RESUME instead of IDENTIFY. Discord never
  sends one; flagged only because it is the exact `Some("")` shape that has
  already produced three real bugs in this port.
- `github::Poller::cycle` iterates `HashMap` values, so watch order is random,
  and a global rate-limit stops the pass mid-list. A repeatedly-limited PAT
  starves whichever watches land late, and the starved set changes each
  reconcile. The TypeScript spawned one task per (token, repo), so no watch could
  starve another.
- A first `github-star` poll of a repo with zero stars saves cursor `""`, which
  `load_cursor` does not filter (unlike a blank ETag), so the next poll can
  dispatch a whole page. Correct when the repo really had 0 stars; a replay if
  `starred_at` was ever missing.
- Lock ordering between `events::CACHE` and the `Store` mutex is unenforced. No
  deadlock today — every mutation drops the store guard before taking the cache —
  but nothing keeps it that way.
- `list_openrouter_models` sorts with `to_lowercase().cmp()` where the TypeScript
  used `localeCompare`. No stdlib equivalent, and ICU is not worth a dependency
  for a picker sort; accented names may order differently.

### 2.6 Dynamic route segments became query strings

`output: "export"` prerenders every route at build time, so a segment whose values
are user-created uuids cannot exist. The three that did were moved:

| was | is |
|---|---|
| `/dashboard/workflows/[id]` | `/dashboard/workflows/designer/?id=` |
| `/dashboard/workflows/[id]/runs` | `/dashboard/workflows/runs/?id=` |
| `/dashboard/memory/[id]` | `/dashboard/memory/store/?id=` |

The alternative was an SPA-fallback rewrite, which Tauri's asset protocol does not
do. Cost: every page reading an id needs `useSearchParams`, which forces a Suspense
boundary under static export. `app/dashboard/workflows/[id]/` was renamed to
`designer/` on disk, so ~20 colocated designer components moved with it.

### 2.7 There is no invalidation bus, and that is the point

23 `revalidatePath` calls did not become 23 event channels. A mutation the user
just made is awaited by its own caller, so **the caller refetches**. The only
changes nobody asked for are background ones — a cron firing, a Discord message
landing — and those emit one app-wide `data-changed` with no payload, which
`useAsync` subscribes to. Test runs deliberately do not emit it: the designer is
already following that run over `run-log`/`run-finished`, and firing it too would
make every open page refetch twice.

Revisit only if a page appears that renders something no command returns.

### 2.8 Security headers moved to the Tauri CSP

`next.config.ts`'s `headers()` is gone with the HTTP server. `frame-ancestors`,
HSTS and `Referrer-Policy` have no meaning inside a WebView with no navigation
surface; the CSP itself moves to `tauri.conf.json` `app.security.csp`, the only
layer that still sees a request. `img-src` still allows the Google favicon hosts
(MCP and model logos are fetched live) and `connect-src` adds `ipc:`.

---

## 3. Deferred work

### 3.1 Cold code, and what warms it

`cargo build` is warning-free and 27 `#[allow(dead_code)]` remain. Every one is
a claim that something is legitimately unreachable; they are worth re-auditing
at the end, because **the Phase C bug (a whole module built and never called)
would have been caught by a dead-code warning, and one Phase D bug could not
be — a function called only from a branch that can never be true.**

| where | count | warms with |
|---|---|---|
| `mcp.rs` — the OAuth/PKCE flow, ~270 LOC | 18 | a redirect target (loopback listener), Phase G/H |
| `openrouter.rs` — `stream_chat` + SSE decoder, ~200 LOC | 6 | the agent chat page, blocked on 3.3 |
| `store.rs` — `latest_run` | 1 | stays cold: `list_runs` and `list_workflow_cards` cover the UI, and tests are its only reader |
| `registry.rs` — `variable_id_from_sentinel` | 1 | stays cold; its consumer is TypeScript |

### 3.2 MCP OAuth cannot complete

`registry::write_mcp_oauth` is the only non-test writer of `Secret::McpOauth`
and it is called only from inside `fresh_mcp_token`'s own refresh branch.
Nothing ever persists an *initial* token set, because the exchange needs a
redirect target a desktop app does not have yet. So `refreshable` can never be
true in production and `connected` is permanently `false` for every entry.
A 401 surfaces as an ordinary connect error.

Unblocks with a loopback redirect listener (Phase G/H).

### 3.3 `lib/agentChat.server.ts` is not ported

Listed under Phase D in the plan, but it imports `TOOL_DEFS` and `dispatchTool`
from `app/mcp/tools.ts` — which is **Phase G**, deferred past v1. So it is
blocked, not forgotten, and the plan put it in the wrong phase.
`openrouter::stream_chat` is built and tested and waiting for it.

### 3.4 No whole-run timeout

`lib/runner.server.ts` had `RUN_TIMEOUT_MS = 600_000`; the port has no
equivalent. `MAX_STEPS` bounds the graph walk and every node has a per-call
timeout, and the streaming OpenRouter client is now bounded at 600s (it
previously had none, which wedged a run thread forever and — via the join in
`run_due_workflows` — stopped every cron in the app). But there is still no
single deadline over a whole run.

### 3.5 Cap arithmetic has no runnable check

`MAX_GRANTED_TOOLS` / `MAX_GRANTED_SKILLS` and the "20 tools + a memory store =
17 usable MCP grants" arithmetic in `agent.rs` are asserted only in a comment.
A 21-chip golden fixture would close it.

### 3.6 `subscriptions_changed()` — done

Closed by the Phase F command surface. The wake lives on the **store** methods,
not the commands, for the same reason `create_workflow` already carried it: an
IPC command or a Phase G MCP tool that forgets it leaves a deleted event node
delivering and a saved bot token invisible for a full minute.

Callers today: `store::create_workflow`, `store::set_graph`, `store::set_active`,
`store::delete_workflow`, `registry::save_variable` (both branches, after the
Keychain write) and `registry::delete_entry`. Deliberately NOT
`store::update_workflow_meta` — a name or emoji cannot change a subscription,
and it fires on every close of the metadata modal.

### 3.7 `catalog.json` carries neither `platform` nor `requiredConfig`

`scripts/gen-catalog.mjs` drops both, so `events.rs` holds a small local table
for those two facts. Config *field ids* still come from `CATALOG` and
`events_match_the_catalog` fails if the two disagree, so the drift surface is
small — but it is a second source of truth, which is the exact thing
`catalog.json` exists to prevent.

### 3.8 `docs/` — and now `CLAUDE.md` — describe the hosted product

Every file under `docs/` predates the desktop pivot. `CLAUDE.md` carries a
banner saying so. Rewrite at the end, with this file.

**`CLAUDE.md` is now wrong in ways Phase F caused**, which is worse than merely
stale, because it is the file every agent reads first and its own rule says a
change altering anything it documents must update it in the same change. It still
documents `npm run dev:full` and `psql "$DATABASE_URL" -f db/setup.sql` (both
deleted), `npx @better-auth/cli migrate` (better-auth uninstalled), `.env.example`
(deleted), the `next.config.ts` `headers()` CSP (moved to `tauri.conf.json`), "raw
`pg` Pool against Postgres", in-process background loops, and an entire **Auth**
invariants block naming `lib/auth.ts`, `lib/subscription.ts`, `SELF_HOSTED` and
`proxy.ts` — every one of which is gone.

Deliberately not patched line-by-line: fixing three commands inside a globally
stale document buys a false impression of currency. It goes in the one rewrite.

### 3.10 Duplication the parallel build left behind

Phase F's four UI lanes ran concurrently against a written contract and could not
see each other, so they solved the same problems separately. That is the known,
predictable cost of building it that way, and it was the right trade — but the
duplicates are real and worth one consolidation pass **after the app is proven to
run**, not at the tail of a change nobody has launched yet:

- **Four armed-confirm buttons**, now structurally identical (`confirmButton.tsx`,
  `deleteWorkflowButton.tsx`, and both buttons in `memory/store/itemButtons.tsx`).
  The three-way split was justified pre-Phase-F because each posted a different
  server action through a `<form>`; all four bodies are now the same
  `call(cmd, args).then(cb, cb)`. Two lanes even disagreed on the refetch idiom.
  ≈130 lines.
- **`skillModal.tsx` and `memoryModal.tsx` are the same file** — 94 and 98 lines
  whose diff is 22 lines of string literals plus the command name, and
  `workflowModal.tsx` is the same shape a third time. All three commands take the
  identical `{id, name, emoji, description}`. ≈110 lines.
- **Ten copies of an unreachable error fallback**, with four different messages
  (`"Something went wrong"` / `"Save failed"` / `"Delete failed"` /
  `"Connection failed"`). `lib/ipc.tsx`'s `call()` always rethrows an `Error`, so
  `err instanceof Error` is always true and the fallback string is dead in every
  one. One exported helper.
- **FormData scaffolding that outlived the server actions**: `ModalShell`'s
  `entryId` prop and its hidden input (no callers), `ConfirmButton`'s
  `FormData` signature and `label`/`confirm`/`title` props (no caller has ever
  passed a non-default), `cronBuilder`'s `name` prop and hidden input.
- **`relativeTime` lives in `workflowCard.tsx`** and is imported by two other
  pages, dragging `WorkflowCard` → `WorkflowModal` → `ModalShell` → `EmojiGrid`
  into their module graphs for an 8-line date formatter. Belongs in `lib/`.
- `memory/store/page.tsx`'s `load` depends on `query`, so pressing search refetches
  `list_registry` and every store's item count alongside the filtered items.

Estimated ≈390 lines. None of it is broken; all of it is code someone will read.

### 3.9 The Saturn Agent chat ships with Phase G, not v1

**The one feature Phase F removes rather than rewires**, so it is worth stating
plainly rather than leaving it to be noticed.

The agent chat is two entry points — the dashboard home page and the panel docked
beside the designer canvas — and both run the same loop: stream OpenRouter with
Saturn's own MCP toolset bound, so the agent can list workflows, read the catalog,
validate and save a graph, search memory. That toolset is `TOOL_DEFS` /
`dispatchTool` in `app/mcp/tools.ts` (1,288 LOC, 35 tools), which is Phase G and
deferred past v1 (§3.3).

Shipping the chat without the tools was considered and rejected: an agent that can
talk about your workflows but cannot read or change one is worse than no chat,
because it looks like it works.

So the routes and the components are **deleted**, not stubbed —
`app/dashboard/(shell)/page.tsx`, `agentChat.tsx`, `agentComposer.tsx`,
`agentChatStore.ts`, `agentPrefs.ts`, `designer/agentPanel.tsx`. Recover them with
`git show b6d0f71:<path>`; they need a `fetch`-to-`invoke`/`listen` swap once the
tool layer is Rust. Leaving a tree of files importing deleted modules would have
broken the build and rotted; git history is the archive. (`app/mcp/` — the hosted
server holding `TOOL_DEFS` itself — is deleted on the same terms.)

Consequence for §3.1: `openrouter::stream_chat` and its SSE decoder stay cold. The
plan expected Phase F to warm them; it cannot.

`agentPrefs` (the composer's last model + effort, in cookies) goes with it — no
cookies under static export, and nothing left to remember until the chat returns.
