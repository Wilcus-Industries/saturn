# CLAUDE.md

File guides Claude Code (claude.ai/code) working with code in this repo.

@AGENTS.md

> **Keep this current:** a change altering anything documented here or in `docs/` (routes, commands, schema, conventions, invariants) → update the matching section or doc in the same change. Detail lives in `docs/`; this file stays an index plus the things that must hold everywhere.

Saturn is a **single-user native macOS desktop app**: a Tauri shell with a Rust
backend and a statically-exported Next.js frontend. There is no server, no
account, no tenant. Everything runs on one machine against one SQLite file and
the login Keychain.

## Docs

Subsystem detail lives in `docs/` — read the one your task touches, not all of them.

| file | covers |
|---|---|
| `docs/ui.md` | routes, the dashboard shell, the Saturn Agent chat, the IPC seam (`lib/ipc.tsx`), static-export constraints |
| `docs/designer.md` | designer canvas: gestures, toolbox, popovers, validation surfacing, the docked agent panel, `geometry.ts` |
| `docs/nodes.md` | node catalog (`catalog.json` / `lib/workflow.ts`) + the `agent` and `saturn-agent` nodes, grants, memory tools |
| `docs/workflows.md` | SQLite schema, the run pipeline, the cron scheduler, the interpreter and its golden fixtures |
| `docs/registry.md` | `registry_entry` — MCP servers, skills, memory stores, variables, and Saturn's own builtin tools; secrets and the Keychain |
| `docs/integrations.md` | outbound senders (Discord/Telegram/HTTP) + inbound event transports (Gateway, Telegram poller, GitHub poller) |
| `docs/open-decisions.md` | decisions taken, deliberate divergences from the TypeScript, and deferred work. **Read before "fixing" anything that looks wrong.** |

## Commands

- `npm run dev` — `tauri dev`: Next dev server on :3000 plus the Rust backend, with all four background loops live
- `npm run build` — `next build`, static-exported to `out/` (what Tauri embeds). Not a full app build
- `npm run lint` — regenerates-and-compares `catalog.json`, then ESLint. **`catalog.json` is generated** from `lib/integrations.ts`; edit a descriptor there and run `node scripts/gen-catalog.mjs` or the check fails
- `npx tauri build` — the real build: `Saturn.app` + a `.dmg` under `src-tauri/target/release/bundle/`. Unsigned and un-notarized (`docs/open-decisions.md` §3.11)
- `cd src-tauri && cargo test` — 155 tests, including the 49 golden interpreter fixtures and the 30 validator cases in `fixtures/validation.json`. **The only test suite** — there is none for TypeScript
- `npx tsc --noEmit` — the frontend's only check beyond ESLint

**No environment variables.** Nothing in `app/`, `lib/` or `src-tauri/` reads
one. Secrets live in the Keychain, reached only through `src-tauri/src/secrets.rs`.
A root `.env.local` may still exist from the hosted product; it is dead.

**No hosted deployment.** The Pi, Neon, Cloudflare Tunnel, Stripe, the GitHub App
and Google OAuth were decommissioned in the desktop pivot, along with better-auth,
Postgres, the marketing site, the billing UI and the hosted `/mcp` server.

## Stack

Tauri 2 (macOS only) + Rust 2021. Next.js 16 App Router under `output: "export"`,
React 19, Tailwind CSS 4 (no config file — theme and keyframes live in
`app/globals.css`), TypeScript. Fonts are Geist + Geist Mono, downloaded at build
time by `next/font` and emitted into the export, which is what lets them load
under a `default-src 'self'` CSP.

Rust side: `rusqlite` (bundled SQLite, FTS5 compiled in — which is what memory
search runs on), `keyring` (apple-native) for secrets, `reqwest` (rustls, blocking **and** async),
`tokio-tungstenite` for the one WebSocket, `serde_json` throughout. Every
dependency in `src-tauri/Cargo.toml` carries a comment saying why it is there;
that file is the reference, not this list.

The CSP lives in `src-tauri/tauri.conf.json` (`app.security.csp`) — the only
layer that still sees a request. `next.config.ts` explains what was removed with
the HTTP server and why.

## Architecture map

**The graph is the product.** A workflow is a node graph (`graph` json on the
`workflow` row) authored in the full-screen designer and executed by one
interpreter (`src-tauri/src/interpreter.rs`) that is pure graph-walking with
every side effect passed in as a parameter. That seam is what makes the port
checkable: `fixtures/expected/` drives the same walk with deterministic stubs.

**Runs start in four ways.** A manual test run from the designer (`test_run`),
the per-minute cron scheduler (`runner::start_scheduler`), an inbound event from
one of the three transports, or nothing at all. Events funnel through
`events::ingest_event`, which validates the delivery, claims the workflow, and
runs it inline.

**What nodes exist** comes from `catalog.json` — read by TypeScript with
`import` and by Rust with `include_str!`, so the two runtimes cannot drift —
merged with the user's own registry entries (`lib/registry.ts` `buildUserCatalog`)
and one chip per Saturn Agent chat (`saturn::session_catalog`) into one `byKey`
map threaded through designer and interpreter alike.

**Saturn Agent is the front door.** The window opens at `/dashboard/agent/`, and
the same chat docks beside the designer canvas. `src-tauri/src/saturn.rs` owns
all of it — the persisted sessions, the 17-tool surface it drives Saturn's own
data with, and the turn loop that streams over `saturn-delta` / `saturn-done`.
Every tool wraps a `store`/`registry`/`workflow`/`runner` entry point that
already exists; the same loop runs behind the `saturn-agent` canvas node. It is
a general assistant, not only a graph author: `call_mcp_tool` routes to
`runner::execute_mcp_tool` and `run_command` to `bash.rs`, so the chat can act
through the user's MCP servers and their shell directly instead of authoring a
workflow to call a tool once. **That surface is itself a registry entry** — one
row of `kind = "saturn"`, so every builtin gets the settings tri-state
(off / read / read+write) for free and `run_command` can ship off
(`docs/registry.md`). There is deliberately no `read_file` / `write_file`:
`run_command` with `cat`, `sed` and a heredoc already is one, and a shell is the
tool surface that measures best in practice (mini-swe-agent). Each chat picks a
**working directory** from its composer — where the shell starts, the only tree
it may write, and the directory whose `CLAUDE.md` / `AGENTS.md` are loaded into
the system prompt every turn.

**The frontend is a client.** Every page is `"use client"`, fetches through
`call()` in `lib/ipc.tsx` (Tauri IPC), and refetches on the app-wide
`data-changed` event that Rust emits after background mutations. There are no
server components, no server actions and no API routes.

## Invariants

Things that break non-locally when violated. Reasoning lives in the linked doc
or in the named module's header comment.

**Process model**

- **One process, one connection, one writer.** `tauri-plugin-single-instance` is the first plugin registered, deliberately — a second launch focuses the window instead of opening a second process against the same `saturn.db`. `Store` is one `rusqlite::Connection` behind a `Mutex`; hold the guard for as short a span as possible, and never across a network call.
- **Blocking reqwest clients must never be built on a tokio worker.** The interpreter is synchronous and each run owns a plain `std::thread`. `http.rs`, `integrations.rs`, `mcp.rs`, `providers::probe` and `openrouter::chat_complete` all depend on this; `#[tauri::command(async)]` hands the body to a runtime thread, so those commands spawn a std thread and join it.
- **SQLite, the Keychain and `ingest_event` are blocking** — `spawn_blocking`, always. `ingest_event` runs a whole workflow inline; it must never sit on a socket path or a runtime worker.
- Background loops belong to the app process, not the window. Closing the window hides it (`on_window_event` → `prevent_close` + `hide`); only tray-Quit exits.

**Secrets** (`docs/registry.md`)

- **Write-only, everywhere** (MCP `auth_token`, the OAuth set, secret variable values, the OpenRouter key, the GitHub PAT): blank input keeps the stored value, an explicit clear removes it, and no read path returns a secret — only a boolean. `secrets::set` enforces it; `registry::get_user_registry` projects `has_token`/`connected` and never the value.
- **Nothing outlives its owner.** Every registry delete calls `secrets::delete_entry_secrets`. An orphaned Keychain item is a real leak — the row that gave it meaning is gone.
- **Graphs and logs only ever carry the `{{var:<uuid>}}` sentinel.** Plaintext substitution happens at exactly two points of consumption: `integrations::execute` and `events::get_event_subscriptions`.
- **A bot token may only ever appear as `events::fp(token)`.** `EventSubscription` fingerprints it in `Debug` and is deliberately not `Serialize`; `telegram.rs` never formats a `reqwest::Error` (the token rides in the URL path); `gateway.rs`'s connection state holds no token at all.
- **The shell tool must never become the read path the rest of this list forbids.** `run_command` runs a model-written line on the user's own machine, so `bash.rs`'s seatbelt is what keeps write-only *write-only*: without its `(deny file-read* ~/Library/Keychains)`, `security find-generic-password -s com.wilcus.saturn` enumerates Saturn's own items from inside the sandbox and every rule above is moot. That deny is not redundant with the write deny — measured, `docs/open-decisions.md` §1.7.
- **The credential denies must be emitted *after* the cwd carve-out.** Seatbelt is last-match-wins and the default working directory is `$HOME`, which encloses `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh` and the keychain — so a deny written before the enclosing `allow file-write*` is an absent rule, and a read+write grant hands the model every credential on the machine. `bash::sandbox_denies_credentials_even_when_the_cwd_is_home` (profile text) and `bash::a_read_write_grant_on_the_home_cwd_still_cannot_touch_credentials` (the real kernel) both fail if the two lines drift back up.

**The shell** (`docs/open-decisions.md` §1.7)

- **The boundary is the kernel's, not a parser's.** Nothing reads the command to decide whether it is safe — `$(...)`, `eval` and a base64 pipe make that unwinnable. `sandbox-exec` applies the policy to the whole process tree, and the command is always an argv element to `/bin/sh -c`, never interpolated into the profile.
- **Every path in a seatbelt profile must be `canonicalize`d.** Seatbelt matches resolved paths; `$TMPDIR` is a symlink into `/private/var/folders/…`, so a rule written against the `/var/…` spelling matches nothing and the policy is silently absent at runtime.
- **The read/write grant IS the sandbox.** `access = "read"` emits the profile without the cwd carve-out, so the kernel refuses the write — not a branch in `saturn.rs`. `bash::sandbox_confines_writes_to_the_cwd` and `saturn::the_run_command_grant_reaches_the_sandbox` are what fail if either half regresses.
- **The working directory belongs to the chat session, not the install.** `saturn_session.cwd` is where `run_command` starts and — with read+write — the only tree it may write; blank means `$HOME`. It is read once per turn in `run_turn` and threaded to both `system_prompt` and `dispatch`, so what the model is *told* its directory is and what the kernel actually enforces cannot disagree. There is no global workspace setting; putting one back reintroduces the disagreement.

**Model calls**

- **The slug picks the provider, and nothing else does.** `providers::resolve` walks `providers::ALL` and strips the matching prefix exactly once — `claude-code/` runs on the local Claude Code server, `omniroute/` on the local OmniRoute gateway, a bare slug on OpenRouter — and it is called *inside* `openrouter::chat_complete` / `stream_chat`, so the URL, the timeout, the body dialect (`provider.extras` gates OpenRouter's own `reasoning` / `modalities`) and the bearer (`runner::model_key`) cannot disagree with the slug a graph stored. **No key path bypasses it**: `runner::openrouter_key` is reached only through `model_key`, so an install on a local provider needs no OpenRouter key at all — memory search is a local FTS5 index, not an embedding call (`docs/open-decisions.md` §1.6).
- **A provider's address is `providers::origin`, never a literal.** The two local providers ship a `default_origin` the user can override; the override lives in a process map seeded from the `setting` table at boot (`main.rs` `load_provider_origins`), because `resolve` is called where no `Store` is in scope. Building a URL from `default_origin` directly is how a graph ends up talking to the wrong port.

**Outbound fetch**

- One URL policy, `http::parse_request_url`: **scheme only** (`http`/`https`), shared by the http-request node and `mcp.rs`. localhost, private addresses and plain http are all allowed — an MCP server is often a local CLI (`http://127.0.0.1:8765/mcp`). The egress blocklist is gone with the tenancy (`docs/registry.md`).
- Every fetch in `mcp.rs` still goes through the single `send_guarded` site. Adding a second fetch site is how the scheme check gets skipped.
- Redirects are followed **manually** and re-parsed per hop (`http::send`, `mcp::send_guarded`). `reqwest`'s automatic following would chase a 30x off http(s) entirely.
- Per-provider senders keep untrusted config out of the fetch target — exact-host allowlists (`==`, never `contains`) and strict id/token charset checks, because a Discord channel id and a Telegram bot token are interpolated into the request path.
- The `http-request` node deliberately reaches the local network (`docs/open-decisions.md` §1.3). That is not a missing guard.

**Cache coherence**

- **Every workflow or variable mutation must call `events::subscriptions_changed()`** — it drops the cached subscription feed and wakes all three transports. It lives on the `store`/`registry` methods, not the commands, so no future IPC command or tool can forget it. Without it a saved bot token is invisible for up to 60s and a deleted event node keeps delivering.

**Module graph**

- `lib/integrations.ts` may only `import type` from `lib/workflow.ts` — a value import back cycles at runtime.
- `catalog.json` is generated, not authored. `npm run lint` fails on drift.
- `lib/agent.ts` and `lib/registry.ts` are client-safe mirrors of caps enforced in Rust (`agent.rs`, `registry.rs`). Change one, change both.

**Graph validation**

- **`validate_graph` has exactly one implementation** — `workflow::validate_graph_strict`, in Rust — and it builds `by_key` from the database itself (`CATALOG` + `registry::get_user_registry` + `saturn::session_catalog`) instead of taking it as an argument. That is what makes the designer's issues panel, the `save_graph` tool and the run pipeline *unable* to disagree about one graph. A second copy in TypeScript is what this deleted; `fixtures/validation.json` is the frozen oracle it was checked against (`docs/open-decisions.md` §3.9).

**Event payloads**

- **Rust owns every event payload shape.** There is no second definition. A designer test run seeds event nodes from `events::sample_payload`, which calls each transport's *production* builder over a canned input. Never write out a payload literal — that is the duplication this closed (`docs/open-decisions.md` §1.4).

**Interpreter**

- `fixtures/expected/` is the frozen specification. It cannot be regenerated — the TypeScript oracle is deleted. A diff means the Rust is wrong, unless the semantics were deliberately changed, in which case the expected file is hand-edited in the same commit.
- The graph walk is synchronous and recursive by design; see `interpreter.rs`'s header before making it async.

**Designer rendering** (`docs/designer.md`, `docs/nodes.md`)

- `geometry.ts` is the single source of node metrics; `node.tsx` and `edges.tsx` must match it exactly — edge anchors are computed, never DOM-measured.
- A node box must never carry its frame as a real CSS `border` — ports anchor on the border box and every marker would shift inward. Paint frames with the `nodeFrame.tsx` inset overlay.
- Resolve node colors through `entryStyles(entry)`, never by indexing `CATEGORY_STYLES` with `entry.category`.
- `Node` and per-edge paths are memoized and read live state through refs — a new per-render prop on `Node` kills the memo.

**Static export**

- No dynamic route segments: a segment whose values are user-created uuids cannot be prerendered. Ids ride the query string (`?id=`), which means `useSearchParams` and therefore a `Suspense` boundary on every page that reads one.
- `trailingSlash: true`, and every internal href must carry the slash — Tauri's asset protocol does no extensionless fallback, so a reload at a slash-less path finds no file.
- No cookies, no request headers, no `revalidatePath`. The shell keeps no UI preference at all now that the collapsible sidebar is gone — a `<head>` script plus `localStorage` is the pattern if one comes back (`docs/ui.md`).

## Conventions

- Components colocate with the route that uses them (e.g. `app/dashboard/topBar.tsx`); only cross-cutting code goes in `lib/`.
- Every Rust command returns `Result<T, String>`; `lib/ipc.tsx` `call()` normalizes the rejection into an `Error`. Expected user-facing failures are `Err(String)`, never a panic.
- Animations respect `prefers-reduced-motion` throughout.
- Rust modules carry their reasoning in a `//!` header. That is the durable location for subsystem detail — `docs/` indexes and connects, it does not duplicate.
