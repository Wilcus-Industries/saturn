# Open decisions

Things the Rust rewrite deferred, diverged on, or left cold. Written as they
came up (Phases C–E) so the end-of-project reconciliation has a list rather than
a memory. The `docs/` rewrite it was meant to be reconciled with landed on
2026-07-25 (§3.8); this file outlives it as the standing record of what was
decided and why.

Line numbers drift; symbol and file names are the durable anchors.

Three sections:

1. **Needs a call** — a product or design question with no obviously right
   answer. Nothing below is blocking today; each one has a live default that
   will simply persist if nobody decides otherwise. **§1.1, §1.2, §1.4 and §1.5 were
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
3. **`validate_graph` warns** on a placed star node when no PAT is set,
   surfacing in the issues panel and as a per-node dot. This branch already
   existed but was dead and stale — it warned on *every* `event:github-*` node
   about "no linked GitHub App installation", infrastructure decommissioned in
   the desktop pivot, and `designer.tsx` deliberately never passed the flag.
   Repointed at star, reworded, and wired up. It catches the one case the chip
   cannot: a node placed before the PAT was removed.

`STAR_EVENT_KEY` is spelled once per process — `lib/workflow.ts` for layer 2,
`src-tauri/src/workflow.rs` for layer 3, since the validator moved to Rust. A
third spelling drifts into a chip you can place but that never polls.

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

### 1.3 The http-request node — and now the MCP client — reach the local network

`http::parse_request_url` checks the scheme and nothing else — private
addresses, plain http and localhost all pass. This was your call, and the reason
holds: on a single-user desktop app the graph is the user's own, and the node's
whole point is reaching Ollama on 11434, a NAS, or Home Assistant.

**Extended to `mcp.rs` on 2026-07-26**, for the same reason one rung further:
plenty of MCP servers are local CLIs (`hound --http` → `http://127.0.0.1:8765/mcp`),
and an https-only, public-only client cannot talk to them at all. The blocklist
(`ip_blocked` and both `assert_*_https_url` functions) is deleted rather than
bypassed, so there is one URL policy in the crate instead of two.

What it concedes: a hostile *remote* MCP server's discovery metadata can now aim
Saturn's OAuth hops at loopback or the LAN. That is the same reach an http node
already had, on a machine with one user, and nothing in the response is executed
— but it is the one place the hosted threat model still had teeth. If it ever
needs to come back, the narrow version is the right one: keep the scheme-only
policy for the *user's configured* server URL, re-apply a blocklist only to
endpoints derived from server-supplied metadata.

### 1.4 Event-node payload key order — DECIDED: Rust owns the payload

**Decided 2026-07-25.** The note as originally written was wrong twice over, so
both the diagnosis and the fix are recorded here.

**The stated risk was already covered.** All three transports had exact-string
assertions on their serialized payload (`gateway::the_payload_mirrors_the_sample`,
telegram's `event_payload` assert, five `dispatch_payload` asserts in `github`).
A swap to `serde_json::Map` sorts the keys and every one of those fails. "No test
would fail" had not been true for some time.

**The real gap was a second definition.** Production payloads were built in Rust;
designer *test-run* payloads were built in TypeScript, from a `samplePayload`
object per event in `lib/integrations.ts`, stringified by `sampleEventPayload`
and passed to `test_run` as `event_payloads`. Nothing cross-checked the two —
`samplePayload` was not in `catalog.json` and Rust never read it. The contract
was three prose comments saying "must mirror the samplePayload". The failure mode
is not cosmetic: build an extract chain against the sample, it works in the
designer, production delivers different keys.

**Fix: delete the TypeScript definition rather than add machinery to sync two.**
Each transport gained a `sample_payload()` in **production** code that runs its
real builder over a canned input — never a written-out payload literal, which
would just move the duplication across the language boundary. `github.rs`'s
`sample_item(event)` canned REST objects are now shared with the parser tests, so
the five exact-string asserts pin the samples too. `events::sample_payload(node_type)`
dispatches. `execute_run` seeds event nodes itself and `test_run` **lost its
`event_payloads` parameter**; `execute_run` keeps its own, because `ingest_event`
passes the real delivered payload through it and the fixtures drive `run_workflow`
with it directly.

Deleted from TypeScript: 8 `samplePayload` literals, the field on
`ExtensionEvent`, `sampleEventPayload`, and the designer's `eventPayloads` map.
`payloadDoc` went too — its only consumer, `GRAPH_DOCS`, no longer existed.

Two consequences worth knowing:

- **The push sample is the unenriched shape** — `pusher`, `commitCount`,
  `messages` and `timestamp` are empty, because `enrich_push` fills those from a
  compare call a sample has no network for. All keys are present, in order.
  Feeding it a canned compare response would need a second canned input for
  cosmetics only.
- **`event:webhook` gets `""` in test runs**, where it used to get a fake
  envelope. It is still a live catalog key (so `ingest_event` recognises it) but
  has no ingress and no builder since the desktop pivot, so there is no honest
  sample to produce. Authoring one would be exactly the forbidden literal.

Covered by `events::tests::every_catalog_event_has_a_builder_made_sample`: every
`event:*` key in `CATALOG` has a sample (only `event:webhook` may not, asserted
by name), each parses to a JSON object, round-trips `js::stringify` unchanged —
i.e. is in the builder's key order — and fits `MAX_EVENT_PAYLOAD`.

**Not taken:** `serde_json`'s `preserve_order` crate-wide (§2.1). It would have
swapped a crate-wide data structure and changed how every graph serializes to
SQLite, and it would have caught only key order — not the drift between the two
definitions, which was the actual exposure.

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

### 1.6 Model providers — DECIDED: a const table, editable origins

**Decided 2026-07-27.** Claude Code joined OpenRouter as a model provider, and
OmniRoute (`github.com/diegosouzapw/OmniRoute`, a self-hosted gateway over ~290
upstream providers) joined the same day. `providers.rs` is a table of `const`
rows — `ALL` — not a `Kind::Provider` and not a Keychain-as-KV; routing is a slug
prefix stripped exactly once. Both local providers are OpenAI-compatible servers,
so they cost no second HTTP client: `openrouter.rs` is the client for all three
and `extras` gates the two body keys that are OpenRouter's own.

**A table, not two consts — revised.** The first version of this decision said
"two `const` rows, not a table", on the grounds that two rows are not a
collection. A third row invalidated that: with two local providers, `resolve`, the
probe cache, `list_models` and `provider_status` each had a two-armed shape that
a table collapses. The rows are still `const` and still hand-written; only the
lookup is a loop. The trigger named there — a real second local provider — is
what fired.

**Origins are editable, and live in a process map.** Each local row ships a
`default_origin` (`127.0.0.1:8787`, `127.0.0.1:20128`); the user can point either
somewhere else from its settings tile. The override persists in a two-column
`setting` table (`provider-origin:<id>`) but is *read* from a `Mutex<Vec<..>>` in
`providers.rs`, seeded once at setup by `main.rs::load_provider_origins`.
`resolve` is called from inside `openrouter.rs`, which holds no `Store` and never
should — threading SQLite through every send site to answer "what port" is the
alternative this avoids. `set_provider_origin` validates through
`http::parse_request_url` (the app's one URL policy) and evicts that provider's
probe entry, because a cached "not detected" is an answer about the old address.
The earlier "no port setting, it is a whole persistence story" call was right
about the cost and wrong about the demand.

**Per-provider keys, all optional but OpenRouter's.** `Secret::ProviderKey(id)`
→ account `{id}-key`, which is byte-identical to the `openrouter-key` that
shipped, so no stored key was orphaned. `runner::model_key` prefers a stored key
and falls back to the dummy bearer `"saturn"` for a local provider — loopback has
nothing to authenticate, but an origin moved off loopback does, and both servers
accept one. `set_provider_key` resolves `id` through `providers::by_id` before
touching the Keychain: the id names an account, so an unvalidated one would be an
arbitrary write into the user's login Keychain.

**Memory search is FTS5, not embeddings — DECIDED 2026-07-28.** The embedding
call was the last thing in the app that *required* an OpenRouter key: an agent
running entirely on Claude Code still could not read its own memory, because
`memory.rs` POSTed every query and every save to
`openrouter.ai/api/v1/embeddings` against a `float[1536]` `vec0` table. Three
ways out were on the table — a local HTTP embedder (Ollama), Apple's
`NLEmbedding` over objc2 FFI, or dropping vectors entirely — and the third is
the only one that *removes* code instead of moving the dependency somewhere
else. `memory_item` is now an FTS5 table and search is BM25 over
`order by rank`. Gone with it: `embed`, `check_dims`, the `EMBED_*` constants,
`store::vec_blob`, the 30 s timeout that could pin a run thread, the `api_key`
parameter and both of its read sites.

The cost is real and accepted: BM25 matches words, so "car" no longer retrieves
"automobile". What made that acceptable is the shape of the thing — a
single-user store of short notes, queried by a model perfectly able to phrase a
keyword query, and told to in the tool description. If semantic recall is ever
missed, the honest fix is a local embedder behind the same `search` signature,
not a key.

Two pieces of this are load-bearing and easy to undo by accident:

- **`fts_query` is not cosmetic.** FTS5's MATCH argument is a query *language*.
  `what's the deploy pipeline?` is a hard `fts5: syntax error near "'"`, and
  `AND` / `OR` / `NOT` / `NEAR` / `*` / `^` / `:` / `-` / `"` are operators a
  model trips by accident. No model text is passed through: every alphanumeric
  run is lifted out and re-emitted as a quoted term, which cannot carry syntax.
  Terms are joined with `OR`, not FTS5's implicit `AND`, because a
  natural-language query carries filler words no saved item contains and `AND`
  would return nothing for most of them.
- **`entry_id` is UNINDEXED, so nothing scopes a query but the WHERE clause.**
  vec0's partition key used to do it structurally. Drop the `entry_id = ?` and
  every store in the file is searched at once — one agent's memories in another
  agent's context.

`search` no longer returns `score`. bm25 is an unbounded negative number, not
the 0-1 cosine similarity it replaced, and normalizing it into one would hand
the model an invented number to reason about. Rank order is the signal.

**The migration gets one chance.** `SCHEMA` is create-if-not-exists, so an
existing `vec0` `memory_item` would survive it silently and every later insert
would fail on the wrong column list. `store::take_vec0_memory_items` runs
*before* the batch, lifts `(content, entry_id, created_at)` out, and drops the
table; `Store::open` re-inserts after. `sqlite-vec` is still a dependency for
exactly one reason — SQLite cannot `drop` a virtual table whose module is
unregistered — and is marked `ponytail:` for removal along with the migration
once every install has booted once.

**`list_models` groups at the source.** It returns `Vec<ProviderModels>` —
`{provider, label, models}` carrying `Provider.id`/`Provider.name` verbatim, one
entry per *connected* provider — rather than one flat list. Both pickers render a
section per group, so nothing in TypeScript ever re-derives the slug prefix that
`providers::resolve` owns, and the per-provider search + cut is what stops
OpenRouter's hundreds of rows pushing a local provider's section off the list.
This deleted the old `Option<Vec<Model>>` tri-state: an empty vec is "nothing
connected", a present entry with empty `models` is "connected, fetch failed" —
strictly more information than the old `null`/`[]` pair, and what makes the
per-provider hints possible. `provider_status` is deliberately NOT merged into
it: Settings must not pay for OpenRouter's several-MB catalogue just to grey out
a tile.

**The probe caches its negative result**, where `openrouter::list_models`'
otherwise-identical cache does not. A failed OpenRouter fetch is a blip worth
retrying; "Claude Code is not running" is the steady state for most users, and
re-probing per call would spend 2s on every Settings render and every
model-picker open. The cost is that starting the server is invisible for up to
30s — which is why `provider_status` takes `refresh: bool` and the modal's
re-check button passes `true`. That button is the only caller that does. With two
local providers the probes run on one `std::thread` each (`main::probe_local`),
so a machine running neither still waits 2s, not 2s per row.

---

### 1.7 The shell tool's boundary — DECIDED: a seatbelt profile, not a command parser

**Decided 2026-07-27**, with the `run_command` tool. Saturn Agent can now run a
shell command, and the command text is the least trustworthy input in the app: a
model wrote it, frequently from text an MCP server or a web page handed it.

**Rejected: reading the command.** A deny-list of `rm`, `sudo`, `curl … | sh` is
theatre — `$(...)`, `eval`, a base64 pipe and "download this script and run it"
all defeat it, and each new bypass is another special case in a parser that must
be perfect to be worth anything. The boundary is the kernel's instead:
`sandbox-exec` applies the policy to **every process in the tree** no matter what
the line expands to, so nothing in `bash.rs` inspects the command. It is always
an argv element handed to `/bin/sh -c`, never interpolated into the profile.

`sandbox-exec` is deprecated (since 10.14) and still ships in Darwin 25, still
used by the browsers. The alternative — an App Sandbox entitlement — constrains
*Saturn*, not a child, and would break the app's own file and network access. If
Apple ever removes it, the fallback is a helper binary with a real entitlement,
not a parser.

**What the profile actually holds**, all four measured on 2026-07-27 rather than
assumed:

- **Paths must be canonicalized.** Seatbelt matches *resolved* paths. `$TMPDIR`
  is a symlink chain into `/private/var/folders/…`, and a rule written against
  the `/var/…` spelling matches nothing — a policy that looks right in review and
  is absent at runtime. This cost one wrong first draft.
- **`(deny file-read* ~/Library/Keychains)` is load-bearing and is not redundant
  with the write deny.** The login keychain is a *file* and the `security` CLI
  reads it directly: without that line,
  `security find-generic-password -s com.wilcus.saturn` enumerates Saturn's own
  items from inside the sandbox. Read is otherwise broad — a shell needs `/usr`,
  `/bin`, the dyld cache — and the tool has the network, so `~/.ssh` plus a
  `curl` is the entire exfiltration path. This is the invariant in `CLAUDE.md`
  ("Secrets — write-only, everywhere") held up by a file-read deny.
- **The `/dev/*` write allowances are not politeness.** `(deny file-write*
  (subpath "/"))` covers `/dev`, so without them `curl -o /dev/null` fails with
  "Failure writing output to destination" while TLS itself works — and every
  `2>/dev/null` in a one-liner breaks. To the model that reads as a broken tool.
- **`launchd` and `osascript` do not escape it.** `launchctl submit` and
  `osascript -e 'do shell script …'` were both tried as ways to have another
  process do the write; the policy is inherited through both.

**Known ceilings, in the code as `ponytail:` comments.** `child.kill()` reaps the
leader only, so a backgrounded grandchild survives the 60s deadline — still
sandboxed, still running (upgrade: `process_group(0)` plus a negative `kill`,
which needs `libc`). Reads stay broad, so `saturn.db` itself is readable; it
holds no secrets, and the agent has tools for its contents anyway.

**The read/write grant is the sandbox, not a flag.** `access = "read"` emits the
profile without the cwd carve-out, so the identical write is refused by the
kernel rather than by a branch in `saturn.rs`. `bash::sandbox_confines_writes_to_the_cwd`
is the test that fails if the profile regresses, and it deliberately puts its
directory outside `$TMPDIR` — inside, the temp carve-out would let every write
through and the test would pass while proving nothing.

### 1.7a The working directory is per session — DECIDED: 2026-07-28

The shell shipped with one workspace per install (`config.workspace`, default
`~/Saturn`, a text field in settings). That was wrong on the first real use: the
directory you are working in changes per conversation, and a text field is the
wrong gesture for something picked that often. It is now `saturn_session.cwd`,
set from a native folder picker in the composer beside the model and effort
chips, blank meaning `$HOME`. The per-install setting is **deleted**, not kept as
a fallback — two places to configure one path is how the chat and the sandbox end
up disagreeing about where the command ran.

**Moving the default from `~/Saturn` to `$HOME` moved a security boundary, and
that cost a real fix.** `$HOME` encloses every credential directory the profile
denies. Seatbelt is last-match-wins, and the denies were emitted *before* the
`allow file-write*` carve-out — correct while the carve-out was `~/Saturn`,
silently void the moment the carve-out became `~`. Measured, not reasoned about:
with the old ordering and a read+write grant, `cat ~/.ssh/*` succeeds from a home
cwd. The denies now land last, and there are two tests rather than one because
the failure is invisible from either side alone —
`sandbox_denies_credentials_even_when_the_cwd_is_home` reads the generated
profile text, `a_read_write_grant_on_the_home_cwd_still_cannot_touch_credentials`
runs the real kernel. Both were mutation-tested by restoring the old ordering;
both fail.

**No `read_file` / `write_file` tools.** `run_command` with `cat`, `sed` and a
heredoc already is one, and the empirical case for the narrower surface is
mini-swe-agent, which outscores far more elaborate harnesses on one bash tool.
Two tool surfaces onto the same filesystem is also two things to keep inside one
sandbox. If they are ever added, they must take the same `cwd` and the same
grant, not a second path of their own.

**`CLAUDE.md` / `AGENTS.md` / `AGENT.md` are read from the cwd root every turn**
(`saturn::project_instructions`), capped at 16k chars across all three. Root
only: no walk up to a parent, which would silently pull in instructions from a
directory the user did not pick, and no recursive scan. Re-read per turn rather
than cached — the user edits these while the chat is open, and a stale copy is
worse than none. Every failure is silent; a turn never fails because a file
would not read.

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
presentational difference. §1.4 was since decided and did NOT push this way —
it removed the second payload definition instead, which `preserve_order` would
not have caught. Nothing is now waiting on this.

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
saw the first URL. The Rust follows redirects manually and re-parses every hop,
strips `authorization`/`cookie` cross-origin, and caps the response body. These
are deliberate hardenings, not port errors. The address pin
(`ClientBuilder::resolve_to_addrs`) went with the blocklist in §1.3 — it existed
only to hold an address the guard had validated, and there is nothing left to
validate.

### 2.5 Smaller ones, all deliberate

- `mcp::send_guarded` duplicates `http::send`'s redirect loop and the two have
  already drifted (`http.rs` clamps the per-hop timeout, `mcp.rs` does not). Its
  strip/downgrade/hop-cap logic still has **no test coverage** — though the
  reason is gone: now that loopback is allowed, a test server on 127.0.0.1 can
  finally drive it. Both loops share one URL policy already; merging them is the
  remaining half.
- `parse_request_url` does not reject credentials in the URL
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
- `openrouter::list_models` sorts with `to_lowercase().cmp()` where the TypeScript
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
`designer/` on disk, so ~20 colocated designer components moved with it, and
again into `(shell)/` when the designer rejoined the shell (§2.11). The URLs in
the table are unaffected by that second move — a route group adds no URL segment.

### 2.11 The designer is kept mounted and hidden, not cached — DECIDED

It used to live outside the `(shell)` group and paint its own full-screen chrome,
which meant opening a workflow hid the top bar and felt like leaving the app. It
now renders under the bar like everything else. What made that more than a
directory move is the second half of the requirement: switching to another nav
tab and back must leave the editor untouched.

An App Router page is unmounted on every navigation, so a route cannot satisfy
that. Two options:

- **Cache the state.** Lift the reducer history, the canvas viewport, the
  selection, the console buffer and the panel width into a module store keyed by
  workflow id and reseed on remount. Every one of those is a separate hoist, and
  each is a chance for the restored copy to disagree with the live one.
- **Never unmount.** Mount the designer in `(shell)/layout.tsx` — a layout
  survives its children changing — and toggle `display:none`. Nothing to hoist,
  nothing to reseed, because nothing is ever lost.

The second, and the graph was already safe either way (autosave debounces and
flushes on unmount), so this buys the *ephemeral* state specifically.

The price is real and worth stating: a mounted-but-hidden component still holds
`window` listeners. That is what the `active` prop is for, and it is not
optional — the canvas's space-as-pan handler calls `preventDefault()` on the
space bar, so an ungated hidden designer swallows space across the whole app.
`docs/designer.md` lists the three gated listeners. The other cost is that the
layout now imports the designer, so its chunk parses on every dashboard page;
over the asset protocol that is a few ms and not worth a `next/dynamic` seam.

Consequences elsewhere: the top bar's Workflows chip has to point at the open
editor (leaving is a hide, so the chip is the way back), and both delete sites —
the designer's own topbar and the list card — must call `closeDesigner(id)`, or a
hidden designer retries `save_workflow` against a deleted row forever.

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

### 2.9 `validate_graph_strict` skips a dangling edge where the TypeScript threw

`lib/workflow.ts:477-478` did `nodeById.get(edge.from.nodeId)!` and then read
`.type` off it, so an edge naming a node id that does not exist threw a
TypeError out of the validator. A throw has no `expected` shape, so **no case in
`fixtures/validation.json` covers it** — the oracle cannot arbitrate this one and
never could. The Rust skips the edge instead: every command returns
`Result<T, String>` and a panic is not an option, and `check_graph`'s dangling-edge
rejection means no graph in the database can reach the branch anyway.

The related comments at `lib/workflow.ts:682` (`toNode?.` optional chain) and
`:685` (`if (!src) continue; // dangling-endpoint error already covers it`) were
**false**: there was no dangling-endpoint check, and the earlier edge loop threw
before either line could run. They were dead defensive code and were not ported.

### 2.10 `providerModal.tsx` uses a native `<dialog>`, not `modalShell.tsx`

Every other modal in the app is `ModalShell`. This one cannot be: ModalShell
wraps its children in its own `<form>` so it can own the submit action, and the
OpenRouter provider's body is `SecretForm` — itself a `<form>`. Nested forms are
invalid HTML and React will not render them meaningfully.

The two ways out were to re-implement `SecretForm`'s write-only convention inline
so it fits ModalShell's action, or to use the platform. Re-implementing puts the
"blank means keep, checkbox means clear" rule in two places, and that rule is a
secrets invariant (`CLAUDE.md` → Secrets), not a detail — a second copy is how it
drifts. A native `<dialog>` gives the backdrop, Escape-to-close and focus trap
that ModalShell exists to provide, with a `ref` and no state at all.

The one thing it re-implements is the backdrop click, which `<dialog>` does not
give for free: the click handler closes only when `e.target` is the dialog
element itself, and the inner panel carries the padding so nothing inside can be
mistaken for the backdrop.

---

## 3. Deferred work

### 3.1 Cold code, and what warms it

`cargo build` is warning-free and 3 `#[allow(dead_code)]` remain. Every one is
a claim that something is legitimately unreachable; they are worth re-auditing
at the end, because **the Phase C bug (a whole module built and never called)
would have been caught by a dead-code warning, and one Phase D bug could not
be — a function called only from a branch that can never be true.**

| where | count | warms with |
|---|---|---|
| ~~`mcp.rs` — the OAuth/PKCE flow, ~270 LOC~~ | ~~18~~ **1** | **warm.** `mcp::authorize` drives it from `discover_mcp_tools`; the redirect target it waited for is a loopback listener (§3.2). `probe_auth_server_meta` is the one holdout |
| ~~`openrouter.rs` — `stream_chat` + SSE decoder~~ | ~~6~~ **0** | **warm.** `saturn::run_turn` drives it; the six markers were deleted, which is the proof |
| `store.rs` — `latest_run` | 1 | stays cold: `list_runs` and `list_workflow_cards` cover the UI, and tests are its only reader |
| `registry.rs` — `variable_id_from_sentinel` | 1 | stays cold; its consumer is TypeScript |

### 3.2 MCP OAuth cannot complete — DONE

**Closed 2026-07-26.** The redirect target is a loopback listener, which is what
RFC 8252 §7.3 says a native app should have used all along — no local HTTP
origin and no registered URL scheme required. `mcp::authorize` binds
`127.0.0.1:0`, puts the resulting `http://127.0.0.1:<port>/callback` into the
dynamic client registration, opens the browser, and serves the one redirect;
`registry::store_mcp_oauth` persists the set. `discover_mcp_tools` calls it on a
401 with no stored credential, so Connect is one button for both kinds of server.

The record of the block stands, and so does its shape: the flow itself was
correct and complete, and only the *target* was missing. Phase G/H were named as
the unblock because the plan assumed the answer was a local HTTP server or a URL
scheme. It was neither.

The follow-up landed the same day. The flow worked exactly once per server: the
re-authorize guard tested the resolved token rather than the *manual* one, so a
revoked grant or a dead refresh token 401'd forever with nothing to clear it.
The guard is now `auth_token.is_none()` and a refused refresh drops the set
instead of returning `Err`, which turns the next Connect back into the browser
flow. A disconnect button was considered and skipped — it is UI for a state the
user can no longer reach.

What is still deferred: a server with no `registration_endpoint` (no dynamic
client registration) cannot be connected — there is nowhere to get a client id,
and a manual auth token is the way through. And a 401 that arrives at *tool-call*
time still fails the call rather than authorizing, which is why
`probe_auth_server_meta` stays cold: a run is the wrong place to open a browser
and block for five minutes.

### 3.3 `lib/agentChat.server.ts` is not ported — DONE

**Closed 2026-07-25.** It is `saturn::run_turn`, and the tool layer it was blocked
on (`TOOL_DEFS` / `dispatchTool`) is `saturn::tool_specs` / `saturn::dispatch` —
13 tools, not 35 (§3.9). `openrouter::stream_chat` is its only caller and is no
longer cold.

The record of the block stands: it was listed under Phase D, it depended on Phase
G, and the plan put it in the wrong phase.

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

### 3.7 `catalog.json` carries no `platform` — `requiredConfig` is now emitted

**Half closed.** `gen-catalog.mjs` now emits `requiredConfig` on both derived
maps, which is how `workflow::validate_graph_strict` learns it without a
hand-written table. `events.rs`'s `EventDescriptor.required` **stays** — it is
read at `events.rs:316` on the live delivery path, and rewiring that is a
separate change. `platform` is still local to `events.rs`. Config *field ids*
still come from `CATALOG` and `events_match_the_catalog` fails if the two
disagree, so the remaining drift surface is the `required` lists alone.

### 3.8 `docs/` and `CLAUDE.md` described the hosted product — DONE

**Closed 2026-07-25.** `CLAUDE.md` and all five surviving subsystem docs were
rewritten against the code. `docs/auth-billing.md` and `docs/mcp-server.md` were
**deleted** rather than rewritten — better-auth, Stripe, the tier system and the
hosted `/mcp` server no longer exist, and a doc describing nothing is worse than
no doc.

It was done as one rewrite rather than line-by-line patches on purpose: fixing
three commands inside a globally stale document buys a false impression of
currency.

The shape changed as well as the content. The old files were single mega-bullets
that duplicated what the code already said; the Rust modules now carry their
reasoning in `//!` headers, which is the durable location, so `docs/` indexes and
connects rather than restating. `CLAUDE.md`'s closing convention says so
explicitly.

`README.md` was deliberately left out of this pass — it is the owner's copy and
still advertises `pgvector` memory and a hosted product.

Two things the rewrite surfaced, both recorded rather than fixed:

- **`workflow_run` is never pruned.** The hosted runner trimmed to the newest 50
  per workflow; nothing does here. Every row is individually bounded (the 300 ×
  2 000 log cap, images persisted as placeholders), so it is a disk-usage
  question, not a correctness one. Noted in `docs/workflows.md`.
- ~~**`geometry.ts`'s `layoutGraph` has no callers.**~~ **It went.** Its only
  consumer was `save_graph`, which comes back as a Rust tool using
  `workflow::fill_coords` — a geometry-free column grid — rather than a second
  source of node metrics.

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
- ~~**FormData scaffolding that outlived the server actions**~~ — **done.**
  `ConfirmButton`'s `FormData` signature and its `label`/`confirm`/`title` props
  went in the audit pass; `ModalShell`'s `entryId` prop and hidden input and
  `cronBuilder`'s `name` prop and hidden input — all four callerless — went in
  the dead-weight sweep of 2026-07-25.
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

### 3.9 The Saturn Agent chat ships with Phase G, not v1 — DONE

**Closed 2026-07-25 — it shipped**, and with more than was deferred: persistent
sessions (the hosted chat was in-memory and died with the tab), a `saturn-agent`
canvas node, and one undeletable Saturn memory store. The tool layer is
`src-tauri/src/saturn.rs` — **13 tools, not 35** (12 recovered plus
`call_mcp_tool`, which the hosted product had no equivalent of: the chat calls
the user's own MCP servers through `runner::execute_mcp_tool`, so a one-off
action no longer has to be dressed up as a workflow). The other 16 wrapped things
that no longer exist (tiers, credits, the hosted webhook URL) or that Saturn
does not need one of (memory-store CRUD, when Saturn has exactly one store); they
are listed as deliberately-not-built in the change's own plan, and the trigger
for each is a user asking Saturn and being told no.

Two files did not come back: `agentPrefs.ts` (cookies are structurally impossible
under static export — model and effort are `localStorage` now) and
`app/api/agent/chat/route.ts` (there is no server). Everything else was recovered
from `b6d0f71` exactly as this section promised.

The rest of this section is the record of why it was deferred. It was the right
call at the time; what changed is that Phases D–F built the operations underneath.

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

That bet paid: the recovery was `git show b6d0f71:<path>` per file, and the
`fetch`-to-`invoke`/`listen` swap was ~60 lines deleted from `agentChatStore.ts`.

~~Consequence for §3.1: `openrouter::stream_chat` and its SSE decoder stay cold. The
plan expected Phase F to warm them; it cannot.~~ **They are warm** — the six
`#[allow(dead_code)]` markers are gone, which is what proves it.

**The cost estimate this was deferred on is stale.** The plan sized Phase G at
"1,288 LOC / 35 tools, mechanical but not an afternoon". Phases D–F have since
built nearly every operation those tools wrap — `list_workflows`, `get_workflow`,
`save_workflow`, `list_runs`, `list_registry`, the four `save_*`,
`list_memory_items`, `execute_run` — so the tool layer itself is now mostly JSON
schemas and a dispatch match over commands that already exist.

~~The one piece genuinely unported is **deep graph validation**.~~ **Ported.**
`workflow::validate_graph_strict` is now the only implementation; the TypeScript
`validateGraphStrict` is deleted and `fixtures/validation.json` holds the 30
golden cases captured from it before it went. The agent's system prompt leans on
`validate_graph` hard ("prefer validate_graph before save_graph"), and it is the
same code the designer's issues panel renders — so the port had to agree with the
TypeScript exactly, or the two would disagree about the same graph. That, not the
35 wrappers, was what Phase G actually cost, and it is why the oracle was captured
*before* a line of TypeScript was deleted. Deleting it took ~309 lines out of
`lib/workflow.ts` (with `layoutGraph` and `isValidCron`), which bears on §1.5.

~~`agentPrefs` (the composer's last model + effort, in cookies) goes with it~~ —
it came back as `localStorage`, read in a mount effect. Cookies remain impossible;
the preference did not.

**Context compaction is a fold, not a trim.** A 60-row window of 24 000-char
messages could reach the model as ~1.4M chars, and nothing here counts tokens —
`parse_models` does not read `context_length`, `chat_complete` does not read
`usage`, and a provider's context-length 400 arrives as an opaque string with no
shrink-and-retry. The obvious fix — drop the oldest turns — is what makes a chat
feel lobotomized, so `saturn::compact` summarizes them instead and appends the
result as a `role = 'summary'` row watermarked with the last id it covers
(`docs/ui.md`). Three deliberate calls: **a char budget, not a token one**
(nothing knows any model's window, and a budget wrong by 2× still prevents the
400); **no schema change** — the watermark rides in the existing `parts` blob,
because `store.rs` has no migration machinery and a new column would not reach an
existing `saturn.db`; and **`window` as the only edit site**, so the `agent`
node's `session` chip (`history`) inherits it without a second implementation.

Not done, and the reason: **one turn's own tool results are still unbounded** —
5 calls per turn × `MAX_TOOL_RESULT` compounds past what the history compaction
folds, because `wire` grows in place across the tool loop and never re-reads the
window. Compaction bounds what a turn *starts* with, not what it accumulates.
This got sharper on 2026-07-28 when the chat's `MAX_AGENT_TURNS` cap came off
(below): the multiplier is now however many turns the model takes, so a chat that
does not converge ends on a provider context-length 400 rather than on a cap.
That error breaks the loop and is shown, so it fails visibly — but the fix, when
it is wanted, is to re-compact *inside* the loop once `wire` crosses `COMPACT_AT`
rather than to put the turn cap back. Compaction also never
fires on the `agent`-node write path (`record_exchange` has no key or model); it
reads compacted windows but cannot make one, so that path stays bounded by the
60-row cap exactly as before.

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
