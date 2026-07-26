# Open decisions

Things the Rust rewrite deferred, diverged on, or left cold. Written as they
came up (Phases C–E) so the end-of-project reconciliation has a list rather than
a memory. **Reconcile this file together with the `docs/` rewrite.**

Line numbers drift; symbol and file names are the durable anchors.

Three sections:

1. **Needs a call** — a product or design question with no obviously right
   answer. Nothing below is blocking today; each one has a live default that
   will simply persist if nobody decides otherwise. **§1.1, §1.2 and §1.5 were
   decided on 2026-07-25 and are kept here, marked, rather than deleted — the
   reasoning for a call already made is the part a future reader needs.**
2. **Known divergences** — the Rust deliberately does something the TypeScript
   did not. Decided already; recorded so a future reader does not "fix" them.
3. **Deferred work** — things that are just not built yet, and what unblocks
   them.

---

## 1. Needs a call

### 1.1 GitHub events replay after a long sleep — DECIDED: no replay

**Decided 2026-07-25: nothing replays.** Of the three options below, the first
was taken — the 900s guard, uniformly across all five resources, not per
resource. If something happens while the laptop is closed, it does not fire on
wake.

`github.rs` `SKIP_OLDER_THAN_S = 900` now gates issue/pr/release/star inside
`apply()` and push in `poll_watch` (the refs endpoint carries only a SHA, so a
push has no timestamp until `enrich_push`'s compare call supplies one). 900s
rather than Telegram's 300s because `X-Poll-Interval` can stretch the cadence to
`MAX_POLL_S` and a backoff or 404 park stretches one watch further — a tighter
window would drop genuinely live events.

**The cursor still advances on a skip.** Skipping means "acknowledge without
dispatching", never "leave for next time", or the same backlog would be
re-examined every poll forever.

**Known edge, accepted:** `Poller::resume_at` is global (one PAT, one budget) and
`RATE_LIMIT_MAX_SLEEP` is 3600s, so a full-length rate-limit park exceeds the
900s window by 45 minutes and the first pass after it drops events that were live
when the park began. Consistent with the decision; recorded in the
`SKIP_OLDER_THAN_S` doc comment, which is where someone debugging "why did my
issue not fire" will land.

**What this gives up**, stated plainly because the plan sold the opposite: the
persisted cursor was pitched as "a laptop that was asleep catches up from its
cursor on wake — missed webhook deliveries would simply have been gone." That
catch-up is now deliberately off. Re-announcing week-old issues to Discord as if
they just happened was judged worse than missing them.

The thundering-herd half was already fixed separately — delivery is
`spawn_blocking`, so it no longer spawns ~200 unbounded OS threads.

Covered by `github::tests::stale_events_are_acked_but_never_dispatched`, which
asserts both sides of the boundary and an identical cursor either way.

### 1.2 `github-star` cannot work unauthenticated — DECIDED: PAT required

**Decided 2026-07-25: star requires a PAT, everywhere.** Of the three options
below, the first — with the grey-out the UI half always needed.

Three layers, deliberately, because each catches a case the others cannot:

1. **`github::Resource::pollable(token)`** — `self != Star || !token.is_empty()`,
   checked in `Poller::cycle`'s watch loop next to the `retry_at` skip. This is
   the one that matters: a star node **already saved in a graph** would otherwise
   keep polling no matter what the UI shows. `continue`, not `return`, so the
   other watches in the pass still run. Warned once per process via
   `star_warned`, re-armed when the token changes — the loop runs every 30s.
2. **The toolbox chip is greyed out** when `has_github_pat` is false, using the
   same `cursor-not-allowed opacity-40` affordance as the one-event rule.
   `Chip`'s `enabled: boolean` became `disabled?: string` (undefined = enabled,
   a string = the tooltip) so the two reasons can say which applies — net fewer
   props, since the always-enabled call sites dropped theirs.
3. **`validateGraphStrict` warns** on a placed star node when no PAT is set,
   surfacing in the issues panel and as a per-node dot. This branch already
   existed but was dead and stale — it warned on *every* `event:github-*` node
   about "no linked GitHub App installation", infrastructure decommissioned in
   the desktop pivot, and `designer.tsx` deliberately never passed the flag.
   Repointed at star, reworded, and wired up. It catches the one case the chip
   cannot: a node placed before the PAT was removed.

`STAR_EVENT_KEY` in `lib/workflow.ts` is shared by layers 2 and 3 — two spellings
of that string would drift into a chip you can place but that never polls.

**Why star and nothing else:** page 1 of `/stargazers` is fetched *without*
`if-none-match` on purpose (it holds the oldest stars and would 304 forever), so
it cannot 304, and at `POLL_S = 30` one watch is ~120 counted requests/hour
against a 60/hr unauthenticated budget. `resume_at` is global — correctly, one
PAT, one budget — so the resulting 403 parks push, issue, pr and release too.
Since §1.1 shipped, events arriving during that park are **discarded**, not
delayed. An unauthenticated star watch was not noisy; it was lossy for
everything else.

Covered by `github::tests::star_watches_are_not_polled_without_a_token`.

The original analysis follows.



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

### 1.5 Does the TypeScript interpreter stay? — DECIDED: deleted

**Decided 2026-07-25: it goes.** `fixtures/interpreter.ts` (811 lines) and
`fixtures/run.mjs` (176) are deleted. `fixtures/cases/` and `fixtures/expected/`
stay, and `src-tauri/src/interpreter/fixtures.rs` is now their only reader.

This makes true what `fixtures/README.md` always claimed: *"From that moment
`expected/` **is** the specification."*

**What it bought:** a second implementation of semantics only Rust executes could
drift silently, and `node fixtures/run.mjs --update` existed and would rewrite the
spec the README forbids rewriting. That mode is gone with the harness. The
deletion also collapsed an eleven-symbol cluster in `lib/agent.ts` that only the
oracle kept alive (`AgentToolRef` was reachable only via `toolRefFromNodeType`,
`AgentToolCall` only via `AgentMessage`/`AgentModelResult`), taking that file
99 → 34 lines.

**What it gave up, knowingly:** two independent implementations agreeing on 47
fixtures was a stronger signal than one implementation agreeing with a file it
generated. `expected/` can no longer be regenerated or cross-checked, so a Rust
interpreter change that is wrong *in the same direction as its test* will no
longer be caught by anything. The mitigation is that `expected/` is frozen and
reviewed by hand: a new case's expected file is now hand-written from a failing
run's output, which was always the real requirement — the oracle only let you
skip the reading.

Surviving `lib/` exports were re-swept afterwards. `ALL_TOOLS`,
`parseToolExclusions`, `MAX_GRANTED_TOOLS`/`MAX_GRANTED_SKILLS`,
`integrationProviderId` and the variable helpers all had live designer consumers
and stayed; `eventNodeKey` and `EXTENSIONS` stayed because
`scripts/gen-catalog.mjs` imports them.

`cargo test fixtures` is 47/47.

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

**Partly closed by the ponytail audit pass of 2026-07-25** (commit `cfd8078`).
Status per item:

- ~~**Four armed-confirm buttons**~~ — **half done.** `confirmButton.tsx` and
  `deleteWorkflowButton.tsx` merged into one `ConfirmButton` taking
  `onConfirm: () => void | Promise<void>`; the form-action caller passes a
  closure. **Still open:** both buttons in `memory/store/itemButtons.tsx` are the
  same shape and were not in that pass's scope.
- ~~**`skillModal.tsx` and `memoryModal.tsx`**~~ — **done.** Merged into
  `app/dashboard/entryModal.tsx`, parameterized by `kind` against one `KINDS`
  record. **Still open:** `workflowModal.tsx` (106 lines) is the same shape a
  third time.
- **Ten copies of an unreachable error fallback** — **open, still ten.**
  `lib/ipc.tsx`'s `call()` always rethrows an `Error`, so `err instanceof Error`
  is always true and the fallback string is dead in every one. One exported
  helper.
- **FormData scaffolding that outlived the server actions** — **partly done.**
  `ConfirmButton`'s `FormData` signature and its `label`/`confirm`/`title` props
  are gone. **Still open:** `ModalShell`'s `entryId` prop and hidden input, and
  `cronBuilder`'s `name` prop and hidden input — both callerless.
- **`relativeTime` lives in `workflowCard.tsx`** — **open.** Imported by
  `memory/store/page.tsx` and `workflows/runs/page.tsx`, dragging
  `WorkflowCard` → `WorkflowModal` → `ModalShell` → `EmojiGrid` into their module
  graphs for an 8-line date formatter. Belongs in `lib/`.
- `memory/store/page.tsx`'s `load` depends on `query` — **open.** Pressing search
  refetches `list_registry` and every store's item count alongside the filtered
  items.

Roughly half the estimated ≈390 lines remain. None of it is broken; all of it is
code someone will read.

The same pass also removed `react-icons` (ten inline SVGs in
`app/dashboard/icons.tsx`), factored `app/dashboard/field.tsx` over the 9 sites
that genuinely shared the labeled-input shape, unified the three tool-param
structs on `mcp::McpToolParam`, and collapsed `registry::save_simple` into
`save_entry`. It deliberately did **not** replace Next.js with Vite: measured at
−2s build, −140 MB `node_modules` and ~−50 KB on a bundle that loads from the
local filesystem, against three new build deps and ~150 lines of hand-rolled
router, font and pending-state code. Revisit only if real dynamic route segments
are wanted.

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

**The cost estimate this was deferred on is stale.** The plan sized Phase G at
"1,288 LOC / 35 tools, mechanical but not an afternoon". Phases D–F have since
built nearly every operation those tools wrap — `list_workflows`, `get_workflow`,
`save_workflow`, `list_runs`, `list_registry`, the four `save_*`,
`list_memory_items`, `execute_run` — so the tool layer itself is now mostly JSON
schemas and a dispatch match over commands that already exist.

The one piece genuinely unported is **deep graph validation**. `validateGraphStrict`
in `lib/workflow.ts` produces the per-node error and warning messages;
`src-tauri/src/workflow.rs` is only the save-time shape-and-caps gate and says so
in its own header. The agent's system prompt leans on `validate_graph` hard
("prefer validate_graph before save_graph"), and it is the same code the
designer's issues panel renders — so the port has to agree with the TypeScript
exactly, or the two disagree about the same graph. That, not the 35 wrappers, is
what Phase G actually costs. It is also the largest remaining consumer of
`lib/workflow.ts`, so it bears on §1.5.

`agentPrefs` (the composer's last model + effort, in cookies) goes with it — no
cookies under static export, and nothing left to remember until the chat returns.

### 3.11 Signing, notarization and auto-update are cut from v1

`tauri build` produces an **unsigned, un-notarized** `Saturn.app`. On this machine
that costs one right-click → Open the first time, and nothing after. It is not a
shortcut that has to be undone later: signing is a build-time identity and a
notarization round trip, not application code, so nothing in `src-tauri/` changes
when it lands. What it gates is a *second* Mac, and there isn't one.

Two consequences worth knowing before they surprise someone:

- **`tauri-plugin-updater` is not installed.** With no signing identity there is
  nothing to verify an update against, and an updater that can't verify is a
  remote-code-execution channel wearing a convenience hat. It arrives with the
  Developer ID cert or not at all.
- **The login item records an absolute path.** `MacosLauncher::LaunchAgent` writes
  a plist naming the binary that registered it, so enabling the toggle from
  `tauri dev` pins `target/debug/saturn` — a path the next `cargo clean` deletes,
  leaving a login item that silently fails. The Settings copy says to move the app
  to `/Applications` first. Nothing enforces it, deliberately: a debug build living
  in `/Applications` is a legitimate thing to run, so any check would be guessing.

### 3.12 Both icons are generated, and the sources are the thing to edit

Everything under `src-tauri/icons/` except `source/` is derived, and the next
`npx tauri icon` will overwrite all of it without asking.

- **App icon** — the source is **`app/icon.png`**, the ASCII-saturn mark the app
  already ships as its favicon, run through `npx tauri icon` to produce the four
  sizes `tauri.conf.json` lists plus the `.icns`. It is deliberately not redrawn:
  the ASCII saturn is Saturn's identity, it appears in the UI (`asciiSaturn.tsx`
  renders the same intensity grids), and an app icon that merely resembles the
  mark is worse than one that is the mark.

  The consequence to accept: ASCII art is a texture, so the icon reads at 128 and
  64, goes faint at 32, and is unreadable at 16. Nothing fixes that short of a
  separate small-size drawing, which would reintroduce exactly the two-identities
  problem above. `app/icon.png` is 512, so the `.icns` 1024 slot is an upscale —
  visible only in Get Info, and the fix is to re-render the grids at 1024 rather
  than to enlarge the PNG.
- **Tray icon** — `source/tray.svg` → `icons/tray.png`, loaded through
  `Image::from_bytes(include_bytes!(...))` with `icon_as_template(true)`. It is a
  macOS template image: black plus alpha, nothing else, so AppKit can invert it
  for a dark menu bar and fill it white while the menu is open. A colour icon can
  do neither.

  This one **is** a separate drawing, and unlike the app icon that is the right
  call: a template is pure silhouette, and the ASCII mark downsampled to 18pt is
  a grey smudge — every glyph lands on a fraction of a pixel and becomes partial
  alpha, which macOS renders as translucent mush rather than a shape.

Two constraints that are easy to violate by "fixing" the files:

- **The tray canvas is 44x32, not square.** `tray-icon` scales to 18pt of height
  and preserves aspect (`tray-icon-0.24.1` `macos/mod.rs:296`), so a square canvas
  fits Saturn's 2:1 silhouette to 18pt wide and leaves it ~9pt tall.
- **Rasterize with Chrome, not ImageMagick.** ImageMagick's internal MSVG
  renderer drops `mask` without erroring — the tray icon comes out as a bare disc
  with no rings, and it looks like a design choice rather than a broken render.

Non-macOS output from `npx tauri icon` (`icon.ico`, the `Square*Logo` set,
`android/`, `ios/`) is deleted rather than committed. v1 is macOS only, so those
files would only ever be stale copies of an icon nobody regenerates.
