# User registry: MCP servers, skills, memory stores, variables, Saturn's own tools

> Part of the Saturn docs set indexed in `CLAUDE.md`. How each becomes a node is in `docs/nodes.md`; the canvas is `docs/designer.md`.

The registry is the user's own node types. One table, five kinds, three UI
surfaces:

| kind | managed at | becomes |
|---|---|---|
| `mcp` | `/dashboard/settings/` | one purple grant chip per server, `mcp:<uuid>:*` |
| `skill` | `/dashboard/settings/` | a green grant chip, `skill:<uuid>` |
| `memory` | `/dashboard/memory/` | a fuchsia grant chip, `memory:<uuid>` |
| `variable` | the **designer toolbox** | a value box, `variable:<uuid>` |
| `saturn` | `/dashboard/settings/` | **nothing** — see below |

## `saturn`: Saturn Agent's own tools are a registry row

Exactly one row, `saturn::TOOLS_ID` (`…-000000000002`), seeded by `store.rs`'s
`SCHEMA` beside Saturn's memory store and refused by `delete_entry` for the same
reason: the row *is* the tool surface, and deleting it would silently reset every
grant. `created_at = 0` pins it first in the settings list.

Being a registry kind is the entire design. The stored `config.tools` allowlist,
`parse_tools`, `can_call_tool` and the off / read / read+write tri-state in
`toolListEditor.tsx` all apply to Saturn's builtins with no second
implementation — the only thing written to the row is the user's overrides.
Names, descriptions and defaults come from `saturn::merge_tools`, which derives
them from `saturn::all_specs` plus the `POLICY` table, so a builtin added later
appears in settings on its own and a stored name that no longer exists is
dropped. `get_user_registry` runs that merge on the way out, which is why the
settings page needs no read command of its own.

`build_user_catalog` returns `None` for this kind: the builtins are dispatched by
name inside `saturn::run_turn`, not through `execute_tool`, so a grant chip would
resolve to something no run pipeline can execute.

The row holds tools and nothing else. `run_command`'s working directory used to
live here as `config.workspace`, one path per install; it is now **per chat
session** (`saturn_session.cwd`, picked from the composer — `docs/ui.md`), because
the directory you are working in changes far more often than a grant does and a
per-install setting made every chat share one. Writes go through
`registry::set_saturn_tools` (a sibling of `set_mcp_tools`) off a fresh read, so
nothing else in the blob is dropped on the way through.

**`run_command` is the one builtin that ships off**, and the tri-state means
something specific for it: `read` runs the command with nothing outside the
process temp dir writable, `read+write` adds the session's cwd tree. The grant is the
seatbelt profile itself, not a flag — see `docs/open-decisions.md` §1.7 for what
the sandbox holds, what was measured rather than assumed, and its known ceilings.
`call_mcp_tool` reads its third position the same way: granted `read`, it refuses
a target tool the user themselves classified `read+write`.

`rename_chat` is the one builtin that acts on the chat itself: it renames the
session the turn is running in (never one the model names), so a chat that opens
as `chat 3` ends up called what it is about. The system prompt states the chat's
current name and asks the model to scope the rename to a default one — a title
the user typed is theirs. That is a request, not a guard: refusing a non-default
name outright would also refuse "rename this chat to X", which is the one case
the user definitely meant. Switch the tool off in settings and the names stay
`chat N`; there is no other auto-naming path.

It is also the second tool `nested` drops, alongside `run_workflow` — a
`saturn-agent` node without a chat chip binds its session **by name**
(`saturn::session_by_name`), so a nested turn that renamed itself would orphan
the node onto a fresh empty chat on every run after that one.

`registry_entry` is `(id, kind, name, emoji, description, config, created_at,
updated_at)`. The five sparse kind-specific columns the Postgres schema had
(`server_url`, `tools`, `oauth`, `auth_token`, `secret`) collapsed into one
`config` JSON blob, so a new kind needs no schema change.

`lib/registry.ts` (client-safe) holds the types, `buildUserCatalog`, the uuid
regex and the sentinel helpers. `src-tauri/src/registry.rs` holds the SQL and
every mutation. Caps: `MAX_ENTRIES_PER_KIND = 50`, `MAX_MCP_TOOLS = 40`,
`MAX_NAME = 60`, `MAX_DESCRIPTION = 2000`, `MAX_TOKEN = 4096` — all counted in
UTF-16 units, matching what the browser counts.

## Secrets never enter the database

`auth_token`, the OAuth token set, and a secret variable's value are **Keychain
items** (`secrets.rs`, service `com.wilcus.saturn`), which is why no such column
exists in `store.rs`'s schema.

**The read path never returns a secret.** `get_user_registry` computes
`has_token` and `connected` from the Keychain but carries nothing out of it. The
one deliberate exception is the same one the SQL had: a *non-secret* variable's
value is viewable by the user's own choice, so it lives in `config` — never the
Keychain — and comes back as `value`.

Two rules the rest of the app depends on:

1. **Write-only.** A blank input KEEPS the stored value, an explicit clear
   removes it, and no read path hands a secret to the UI — only a boolean.
   `secrets::set` is where that is enforced, because it is the one place a
   mistake silently destroys the user's key.
2. **Nothing outlives its owner.** `registry::delete_entry` calls
   `delete_entry_secrets`, so deleting an MCP server takes its token, its OAuth
   set and (for a variable) its value with it. An orphaned Keychain item is a
   real leak — the row that gave it meaning is gone, so nothing will ever clean
   it up.

## MCP servers

`config` carries `server_url` and `tools`, the per-tool allowlist:
`[{name, access: "read"|"write", enabled, readOnly?, description?, params?}]`.

`access` is the user's grant, set per tool by a three-position switch (off /
read / read+write) in the edit modal. `readOnly`, `description` and `params` are
**discovery-derived**: the client never submits them, and a save re-attaches the
stored ones by tool name.

`readOnly` is tri-state — `true`/`false` when the server annotates the tool,
absent when it sends no annotations (most of them). `canCallTool` is the
call-time gate and blocks only a **provable** mismatch: the server explicitly
declares the tool write-capable while the user granted read-only. Unknown
capability trusts the user's grant; blocking there adds no safety, it just forces
a pointless flip to read+write.

### One chip per server

`toServerEntry` emits a single node keyed `mcp:<uuid>:*`, where `*` is the
`ALL_TOOLS` sentinel. Wired into an agent's `tools` port it grants **every
enabled + callable tool**, minus that node's own `config.exclude` — a JSON array
of names edited through the designer's tool-picker popover. It is an *exclude*
list, so tools discovered later are auto-included unless pruned.

The entry's `tools` field lists exactly the expansion set, so the picker never
shows a tool the runtime would skip. `buildUserCatalog` skips a real tool
literally named `*` so it cannot collide with the sentinel. The chip is emitted
**even with zero enabled tools** — disabling everything in settings must not flip
saved server nodes to "(deleted)".

Old per-tool node types (`mcp:<uuid>:<toolName>`) and the legacy generic
`mcp:<uuid>` are gone; those types render as inert "(deleted)" placeholders and
grant nothing, because the interpreter gates grants on the source resolving to a
live mcp chip entry rather than on parsing the type string.

### Discovery

`discover_mcp_tools` connects over Streamable-HTTP, calls `tools/list`, and
merges the result into the stored allowlist. Merge keeps the user's
`enabled`/`access` choices, caps `readOnlyHint` tools at `read`, starts new
read-only tools on and new write-capable tools off, and always overwrites
`readOnly`/`description`/`params` with freshly discovered values.

`params` come from each tool's `inputSchema` — top-level properties only,
required first, capped at `MAX_TOOL_PARAMS = 12`. The `js::J` machinery in
`mcp.rs` exists to preserve the server's declaration order through that cap
(though `to_parameters` re-sorts on the way out to the model — a deliberate,
presentational divergence, `docs/open-decisions.md` §2.1).

### The URL policy

**Scheme only.** An MCP server is as often a CLI serving
`http://127.0.0.1:8765/mcp` (`hound --http`, and everything like it) as a hosted
`https://` endpoint, so `mcp.rs` uses the same `http::parse_request_url` the
http-request node does: `http` or `https`, any host, plain or private. The
egress blocklist, the resolve-time check and the address pin the hosted product
carried are deleted, along with `ip_blocked` itself — the http-request node was
already the local-network hole they were guarding around
(`docs/open-decisions.md` §1.3).

What that concedes: **everything a server hands back** —
`authorization_servers`, the authorization/token/registration endpoints, the PRM
resource URL — is the server's, so a hostile *remote* server answering
`"token_endpoint": "http://169.254.169.254/…"` now gets its request. On a
single-user desktop that reach is the user's own machine, and any graph could
already point an http node at it.

Still exactly **one fetch site**, `send_guarded`, which re-parses the URL on the
start hop and on every redirect — a 30x must not walk the request onto `file:`
or `data:`. Adding a second fetch site is how the scheme check gets skipped;
don't. Redirects stay manual for that reason.

Nothing in `mcp.rs` logs. An access token, a refresh token, an authorization code
and a PKCE verifier all pass through it; `TokenSet` deliberately does not derive
`Debug`.

Save-time validation is the same function — sync, no DNS, so a server that is
not listening yet still saves. It does *not* reject credentials in the URL
(`https://good.example.com@10.0.0.1/`); a phishing-shaped URL survives save and
is shown back (`docs/open-decisions.md` §2.5).

### OAuth

Connect is one button for both kinds of server. `discover_mcp_tools` tries
`tools/list` with whatever credential is stored; a 401 with no *manual* token
calls `mcp::authorize`, which runs the whole PKCE flow — protected-resource
metadata → authorization-server metadata → dynamic client registration → browser
→ authorization code → token set — and discovery is retried with the token
`registry::store_mcp_oauth` just persisted.

The guard is `auth_token.is_none()`, not "no credential at all", and that
distinction is what makes the button work more than once. A 401 holding the
user's manual token is the server rejecting *that token*, so it surfaces as the
connect error it always was. A 401 holding an OAuth token means the grant is
gone, and re-authorizing is the only way back — there is no disconnect button to
clear a stale set, by design. `fresh_mcp_token` completes the loop: a refresh the
server refuses drops the set rather than returning `Err`, so the next call is a
401 with no credential, which is exactly the path that re-opens the browser.

Settings reads both credentials. `has_token` renders "token set", `connected`
(the stored set parses *and* carries a non-empty access token, so a pending
pre-redirect set reads false) renders "signed in", and either one turns the
button from "connect →" into "discover tools →".

The redirect target is a loopback listener (RFC 8252 §7.3): `127.0.0.1` on an
ephemeral port, bound *before* registration because the port is part of the
`redirect_uri` the authorization server records. It answers and ignores anything
that is not the redirect, checks `state`, and gives up after five minutes. The
authorization code it receives is useless on its own — the PKCE verifier never
leaves the thread that built it.

A server with no `registration_endpoint` still cannot be connected this way:
there is no client id to use, and a manual auth token remains the way through.

The session cache the TypeScript had was dropped: `mcp::call_tool` re-handshakes
unconditionally. Correctness is unaffected (the handshake is idempotent) and it
removes the cross-credential-reuse risk the TypeScript had to hash the token to
avoid, at a cost of two extra round trips per tool call (§2.2).

## Skills

Name, emoji, description. The description **is** the skill: it is injected into
the agent's system prompt server-side, by id. Client-sent instruction text is
never trusted.

## Memory stores

Name, emoji, description — no tools, no URL. Items live in the `memory_item`
FTS5 table, scoped by `entry_id`, and are managed on their own tab:
`/dashboard/memory/` lists the stores with item counts, `/dashboard/memory/store/?id=`
browses one (search, per-item delete, wipe). Wipe empties without deleting the
row, so every node wired to that store keeps resolving.

The agent-side mechanics are in `docs/nodes.md`.

### Saturn's own store cannot be deleted

One `memory` entry always exists — id `00000000-0000-4000-8000-000000000001`
(`saturn::MEMORY_ID`, mirrored as `lib/registry.ts`'s `SATURN_MEMORY_ID`): what
Saturn Agent remembers across conversations.

It is seeded **in SQL, inside `store.rs`'s `SCHEMA`**, not in Rust.
`execute_batch(SCHEMA)` runs on every boot, so `insert or ignore` is idempotent
*and* reaches a `saturn.db` that already exists — which a new column could not.
It bypasses `MAX_ENTRIES_PER_KIND` on purpose: a user with 50 stores of their own
must still get Saturn's.

`registry::delete_entry` refuses it, ahead of even the uuid shape check. The
guard sits on the **store method, not the command** — the same reasoning
`subscriptions_changed()` gets, so no future IPC command or Saturn tool can route
around it. `/dashboard/memory/` hides the row's delete button; the button is UI,
the guard is the rule.

Rename, wipe and per-item delete all stay allowed: the store is permanent, its
contents are the user's. It is also an ordinary `memory:<uuid>` chip in the
toolbox, so an `agent` node can be granted what Saturn remembers.

## Variables

Name + a `secret` flag. **Two modes, fixed at creation** — the checkbox is
disabled on edit, so a write-only secret can never be flipped to viewable:

- `secret = true` — the value lives in the Keychain, is never selected back, and
  the field is write-only (blank keeps, clear erases). Violet.
- `secret = false` — the value lives in `config` as plaintext and is prefilled,
  viewable and editable. Sky.

Both colors resolve through `entryStyles`, never a hardcoded hue.

**The graph carries no plaintext for either mode.** A variable node evaluates to
the opaque sentinel `{{var:<uuid>}}`. Configs, logs, prints, `run-value` samples
and agent prompts only ever carry that. Substitution happens at exactly two
points of consumption:

- **`integrations::execute`** — scans config values and the message, resolves the
  ids, and does it *before* the per-provider SSRF checks, so a substituted token
  is validated normally. A deleted or unknown uuid stays literal and the
  validator rejects it.
- **`events::get_event_subscriptions`** — resolves event-node config at
  subscription-build time, because a transport cannot dial with a sentinel. This
  is the one place a plaintext bot token exists in memory, which is why
  `EventSubscription` fingerprints it in `Debug` and is not `Serialize`.

Variables are managed in the designer toolbox's pinned bottom split (visible on
every group tab, filtered by toolbox search), and the same modal opens from
clicking a `variable:<uuid>` box on the canvas. `variableModal.tsx` is hosted by
`designer.tsx` rather than the toolbox so both entry points share one instance.

Every variable mutation calls `subscriptions_changed()` after the Keychain write
— a variable-held bot token edit must reconnect the transports within ~2s, not
in a minute.

## Cache coherence

The registry read is cached in-process. **Every mutation invalidates**, and every
workflow or variable mutation additionally calls `events::subscriptions_changed()`.
Both live on the store/registry methods, not the commands, so no future IPC
command or MCP tool can forget them.

Lock ordering between `events::CACHE` and the `Store` mutex is unenforced. No
deadlock today — every mutation drops the store guard before taking the cache —
but nothing keeps it that way (`docs/open-decisions.md` §2.5).
