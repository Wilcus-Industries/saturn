# User registry: MCP servers, skills, memory stores, variables

> Part of the Saturn docs set indexed in `CLAUDE.md`. How each becomes a node is in `docs/nodes.md`; the canvas is `docs/designer.md`.

The registry is the user's own node types. One table, four kinds, three UI
surfaces:

| kind | managed at | becomes |
|---|---|---|
| `mcp` | `/dashboard/settings/` | one purple grant chip per server, `mcp:<uuid>:*` |
| `skill` | `/dashboard/settings/` | a green grant chip, `skill:<uuid>` |
| `memory` | `/dashboard/memory/` | a fuchsia grant chip, `memory:<uuid>` |
| `variable` | the **designer toolbox** | a value box, `variable:<uuid>` |

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
(though `to_parameters` re-sorts on the way out to OpenRouter — a deliberate,
presentational divergence, `docs/open-decisions.md` §2.1).

### The SSRF guard

`mcp.rs` is security-critical and was translated as-is, not improved. The server
URL is the user's own, but **everything the server hands back** —
`authorization_servers`, the authorization/token/registration endpoints, the PRM
resource URL — is the server's, i.e. attacker-controlled. A hostile server
answering `"token_endpoint": "https://169.254.169.254/…"` must not get a request.

So the module has exactly **one fetch site**, `send_guarded`, which calls
`assert_public_https_url` on the start URL and again on every redirect hop.
Adding a second fetch site is how the guard gets skipped; don't.

Two things are stronger here than in the TypeScript, both deliberate:

- Node's `fetch` followed redirects itself, so a public host could 30x the
  request onto a private address *past* the guard. Redirects are followed
  manually and re-validated.
- Node resolved the host, checked the addresses, then handed the URL to `fetch`,
  which resolved again — a rebinding server can answer differently the second
  time. `ClientBuilder::resolve_to_addrs` pins the address that was checked.

Nothing in `mcp.rs` logs. An access token, a refresh token, an authorization code
and a PKCE verifier all pass through it; `TokenSet` deliberately does not derive
`Debug`.

Save-time validation is `assert_https_url_shape` — sync, no DNS — rejecting
literal private/loopback/localhost hosts. It does *not* reject credentials in the
URL (`https://good.example.com@10.0.0.1/`); not exploitable, since the guard
reads the real host, but a phishing-shaped URL survives save and is shown back
(`docs/open-decisions.md` §2.5).

### OAuth cannot complete yet

The PKCE flow is fully ported — protected-resource metadata → authorization-server
metadata → dynamic client registration → authorization code — but nothing
persists an *initial* token set, because the exchange needs a redirect target a
desktop app does not have. `refreshable` can therefore never be true in
production and `connected` is permanently `false`. A 401 surfaces as an ordinary
connect error.

That is ~270 lines behind 18 `#[allow(dead_code)]` markers. It unblocks with a
loopback redirect listener (`docs/open-decisions.md` §3.2).

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
`vec0` table, partitioned by `entry_id`, and are managed on their own tab:
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
