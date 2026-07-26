# Node catalog + the Saturn (agent) node

> Part of the Saturn docs set indexed in `CLAUDE.md`. Canvas in `docs/designer.md`, execution in `docs/workflows.md`, senders/events in `docs/integrations.md`.

## The catalog is data

`catalog.json` is the single source of truth for what nodes exist. TypeScript
reads it with `import`, Rust with `include_str!`, so the two runtimes cannot
drift.

Its `integration:*` / `event:*` tail is **generated** from the platform
descriptors in `lib/integrations.ts` by `scripts/gen-catalog.mjs`. Before the
Rust port those two `.map()`s were spread into `CATALOG` at runtime and drift was
impossible; freezing the expansion into JSON made it possible and silent, which
is what `npm run lint`'s `--check` mode guards. Add an action, rename a config
field, add an event → regenerate.

`lib/workflow.ts` wraps the JSON with everything it cannot express: the types,
the colors, the connection rules, and the deep validator. Its `CATALOG` comment
block carries the per-entry facts JSON has no room for — read it before adding a
node type.

### Categories and shapes

Eleven categories (`events`, `logic`, `data`, `mcp`, `skill`, `memory`,
`session`, `variable`, `saturn`, `model`, `integration`), each with a color in
`CATEGORY_STYLES`. Four shapes are not rectangles:

| shape | who | geometry.ts |
|---|---|---|
| circle | input-less `events` nodes (`schedule`, legacy `start`), `model` | `isEventEntry`, `isModelEntry` |
| bare value box | `string`, `number`, variable chips | `isLiteralEntry` |
| rounded square | grant chips — mcp (60px, favicon), skill/memory/chat (48px, emoji) | `isChipEntry`, `chipSize` |
| rounded square | `if` | `isIfEntry` |

Extension event nodes have config inputs, so they render as ordinary rectangles
despite being in the `events` category — but they still wear the amber
entry-point badge (`entryBadge.tsx`).

**Every non-rectangular shape draws its frame from `entryStyles(entry).border`**,
never a per-branch inline hex or literal class. `entryStyles` handles three cases
indexing `CATEGORY_STYLES` directly would get wrong: a `missing` placeholder
(gray), a non-secret variable (sky, split from secret violet), and an integration
node borrowing its `section`'s color so a Discord webhook in "data" paints teal
like the print node.

### Legacy entries

`start` and `literal` are `legacy: true` — hidden from the toolbox, still
resolvable so graphs saved before the events framework and before the
string/number split keep running. The interpreter keeps their cases.

A node whose type has no catalog entry at all (a deleted registry chip, a graph
from a newer build) resolves to `missingEntry(type)`: a header-only "(deleted)"
placeholder with no ports. The interpreter warns and walks on rather than
failing.

## Connection rules

`canConnect` is the hard gate, `edgesToReplace` handles the soft one:

- kinds must match (`flow`↔`flow`, `value`↔`value`), no self-edges, no duplicates;
- **flow outputs may fan out** — the interpreter runs each downstream chain
  concurrently;
- **value inputs take one edge**, unless the port is `multi` (`await.values`,
  agent `tools`/`skills`). The canvas replaces the old edge rather than rejecting
  the drop;
- **`accepts` ports take only grant chips of that kind** (`"tool"`, `"skill"`,
  `"memory"`, `"session"`), and a chip output connects nowhere else. Gated in both directions,
  so a chip cannot feed an ordinary value input.

`chipKind(entry)` is the shared derivation, exported so the designer's
invalid-drop toast can name the mismatch without re-deriving the rules.

## `validate_graph`

Deep validation for graphs authored without the designer's guardrails
(`workflow::validate_graph_strict`, reached over IPC). It assumes the graph
already passed the shape gate `check_graph` in the same module and adds the
semantic layer. `fixtures/validation.json` pins all 30 branches.

**Errors** are states the canvas cannot produce: bad port ids, kind mismatches,
duplicate edges, fan-in on a single-edge value input, a chip wired into a
mismatched `accepts` port, more than one event node.

**Warnings** are legal but probably unintended: an unknown node type, no event
node at all, a blank or invalid schedule cron, a chip output wired into an
ordinary value input, over-cap grants, a malformed or stale `config.exclude`,
blank `requiredConfig` on an integration or event node (unless a value edge feeds
that field's port), `http-request` headers that are not a JSON object of strings,
and two that are worth spelling out:

- **A `github-star` node with no PAT.** Star cannot be polled unauthenticated at
  all (`docs/open-decisions.md` §1.2), so this is the case the greyed-out toolbox
  chip cannot catch: a node placed *before* the PAT was removed. `STAR_EVENT_KEY`
  is spelled twice on purpose — `workflow.rs` for the validator, `lib/workflow.ts`
  for the toolbox — because the two run in different processes. A third spelling
  drifts into a chip you can place but that never polls.
- **A dynamic source feeding an event node's config port.** Event config is
  resolved statically by `events.rs` before any run, so only variable / string /
  number sources apply; anything else silently resolves to blank. The validator
  imports `events.rs`'s own `STATIC_VALUE_TYPES`, so the warning and the resolver
  cannot disagree.

Findings are collected as structured `issues` carrying the node or edge they
concern; the flat `errors`/`warnings` arrays are derived from them in push order.
The designer surfaces `issues` live — topbar badge → issues panel → click to
select the node, plus a per-node dot.

## The Saturn node (`agent`)

Cyan, toolbox section "agents". An LLM loop, fully **port-driven**:

| port | kind | notes |
|---|---|---|
| `prompt`, `system`, `model` | value in | usually fed by string/model nodes |
| `tools` | value in, multi, accepts `tool` | mcp chip outputs |
| `skills` | value in, multi, accepts `skill` | skill chip outputs |
| `memory` | value in, **single**, accepts `memory` | one store per agent; a second edge replaces the first |
| `session` | value in, **single**, accepts `session` | one chat per agent; makes the conversation persist across runs |
| `result` | value out | final text, or a `data:image/…` URL when `output=image` |

Grants resolve **statically from the source node's type** — chips are never
evaluated as values. `config.system` is the fallback when the `system` port is
unwired (authored via the system-prompt popover), and `config.model` likewise for
`model`. Old JSON config grants (`config.tools`/`config.skills`) no longer apply.

Two config selects are gated on the resolved model: `output` (the model's output
modalities) and `reasoning` (`off`/`low`/`medium`/`high` for a capable model,
`off` only for a known non-reasoning one, locked for an unknown slug). The canvas
resolves the slug once and passes both option sets as comma-joined strings, the
same memo-safe pattern as `overriddenIds`.

`reasoning` threads through as a raw string; `runner.rs` allowlists it against
`REASONING_MODES` and maps it to OpenRouter's `reasoning` param (`off` →
`{enabled:false}`, a level → `{effort}`, blank or invalid → omitted). It is
dropped entirely for `output=image`, which is single-turn.

`output=image` sends `modalities: ["image","text"]`, drops tool grants with a
console warning (image models don't accept `tools`), and puts the first returned
`data:image/` URL fitting `MAX_IMAGE_DATA_URL` (4 MB) on `result` — riding its
own field past the `MAX_MODEL_CONTENT` slice, never folded into `content`. No
image returned → warn and fall back to text.

### The model node

One static node type (`model`, rose), rendering as a 54px circle with the
company's logo inside (`modelLogo.tsx` maps the slug's author segment to an apex
domain and then to a Google s2 favicon, with a robot fallback). The toolbox's
per-model chips just prefill `config.model` on spawn, so **graphs never reference
per-model keys** that would vanish with the list. A preset-spawned node carries
`config.preset = "1"` and shows a read-only name; a blank one keeps an editable
slug input.

`MODEL_PRESET` is deliberately not declared as a `ConfigField` — a field named
`preset` would surface in any catalog export and leak an internal UI flag.

### Execution

Entirely Rust. `agent.rs` holds the graph semantics (the loop, the caps, grant
resolution) with the model turn and the tool call injected as parameters, which
is what lets the golden fixtures exercise it against frozen transcripts with
nothing on the network. `runner.rs` wires the real clients:
`openrouter::chat_complete`, `mcp::call_tool`, `memory::execute_memory_tool`.

Grants are **re-resolved against the registry on every request** — `enabled` and
`can_call_tool` are re-checked, and a mismatch rejects. Skills are injected by
id, server-side: the client never sends instruction text.

Wire-format tool names never leave `openrouter.rs`. A tool call comes back
decoded to `{entry_id, tool_name}` before any caller sees it, and that decode
(`by_wire_name`) is also the allowlist that stops a model naming a tool it was
never granted.

### Memory

A memory store is a `registry_entry` of kind `memory`; attaching one prepends
three tools — `memory_search` / `memory_save` / `memory_forget` — to the agent's
tool array (head position, so the wire-name builder reserves clean names) and
injects a `## Memory: <name>` system block. Calls route by
`entry_id == memory_id` to `memory.rs`, which embeds through OpenRouter's
`/api/v1/embeddings` (`openai/text-embedding-3-small`, 1536 dims) and searches
the local `vec0` table.

Every failure comes back as a value the caller renders, never a panic — those
strings are fed back to the model and printed to the run console.

Two things the hosted version had are gone on purpose: the `MAX_MEMORY_ITEMS`
per-store cap (stores are uncapped now — that limit existed because Postgres had
no ANN index and the table was shared), and the platform-credits/BYOK fork
(BYOK only, so the key is a parameter and nothing is metered). There is no HNSW
index either: `vec0` brute force over tens of thousands of vectors is single-digit
milliseconds, invisible next to the ~200 ms embedding round trip, and costs
nothing on write. Adding one later is one line in `store.rs`'s `create virtual
table` — do it when a search is measurably slow.

One store is always present: Saturn Agent's own, seeded by `store.rs`'s `SCHEMA`
and undeletable (`docs/registry.md`). It is an ordinary `memory:<uuid>` chip in
the toolbox like any other, so an `agent` node can be granted exactly what Saturn
remembers.

### Chats (the `session` port)

A chat chip is a `saturn_session` row — the same conversations the sessions page
lists and Saturn Agent talks in — and the **only catalog entry whose subject is
not a `registry_entry`**. `saturn::session_catalog` builds them Rust-side and
`lib/registry.ts`'s `sessionEntry` mirrors it; both have to be merged wherever
`by_key` is assembled (`main.rs` `validate_graph`, `runner::execute_run`,
`saturn.rs`'s `by_key`, and the designer page's fan-out).

Wiring one into an agent's `session` port is what makes the agent's conversation
outlive the run:

- the chat's window (`MAX_AGENT_MESSAGES` turns, oldest first) seeds
  `req.messages` before `run_loop` pushes this run's prompt onto it;
- the prompt and the final text are appended back to the same chat, so the next
  run — and the user, in the app — sees them.

Both directions are **injected effects** (`Effects.history` / `Effects.record`),
not store calls in the interpreter: the golden fixtures stub them like every
other side effect. Deliberately NOT a field on `agent::Request` — six frozen
`agent-*` expected files digest that struct's key list, and a new key would
invalidate all of them for nothing.

Failures degrade rather than abort: an unreadable chat warns and starts fresh, a
failed append warns and the run keeps its result. An `output=image` result is
recorded as its `describe_image` line — a data URL in a transcript is megabytes
the next run would re-send.

### The `saturn-agent` node

The `agent` node's shape, but it **is** Saturn Agent: Saturn's own system prompt,
its twelve tools and its one memory store. No `system` port and no grant ports —
that is the point. A custom prompt would make it an `agent` node with extra steps.

| port / field | notes |
|---|---|
| `in` / `out` | flow, left and right edge |
| `prompt` | value in, bottom |
| `result` | value out — the assistant's final text |
| `config.session` | session **name**; blank → `"workflow"` |
| `config.model` | OpenRouter slug; blank → `saturn::DEFAULT_MODEL` |

Both defaults live in `interpreter::exec_saturn` rather than in the injected
effect, so the golden fixture pins them — `fixtures/cases/saturn-agent.json`'s
second node leaves both fields blank, which is a thing a port can silently get
wrong.

**Sessions bind by name, not id.** `saturn::session_by_name` get-or-creates
against the unique index, so placing the node costs no UI at all. The ceiling
that buys: renaming that session in the chat's dropdown orphans the node onto a
fresh session of the old name. Cron runs then append to a chat the user reads —
chosen deliberately.

The node's turn runs with `nested: true`, which **drops `run_workflow` from the
tool surface**. That is the recursion guard: a workflow run cannot start another
workflow run. Everything else, memory included, is the chat's surface exactly.

It renders with **zero designer code**: `geometry.ts`'s `isAgentEntry` keys on
`category === "saturn"`, so the horizontal layout, the left-edge flow in, the
stacked right-edge outputs, the bottom `prompt` port and the two `ConfigControl`
text rows all fall out of the catalog entry.

Execution is a fourth `Effects` field (`SaturnFn`), wired in `runner.rs` — the
whole turn behind one closure, which is why `agent::Request` and the six frozen
`agent-*` expected files are untouched. The turn's deltas go nowhere: the run
console gets the final text, the session transcript gets all of it
(`docs/ui.md`).

### Caps

Mirrored on both sides of the language boundary. Rust enforces; `lib/agent.ts`
carries the copies the designer needs for its warnings and tool picker.

| cap | value | where |
|---|---|---|
| `MAX_AGENT_TURNS` | 8 | `agent.rs` |
| `MAX_TOOL_CALLS_PER_TURN` | 5 | `agent.rs` |
| `MAX_AGENT_MCP_CALLS` | 40 | `agent.rs` — memory calls debit the same budget |
| `MAX_AGENT_MESSAGES` | 60 | `agent.rs` — transcript length per model call |
| `COMPACT_AT` / `KEEP_RECENT` | 100 000 / 12 | `saturn.rs` — chat window chars before folding, and the tail never folded |
| `MAX_GRANTED_TOOLS` / `MAX_GRANTED_SKILLS` | 20 / 10 | `agent.rs` + `lib/agent.ts` |
| `MAX_MODEL_RESULT_CHARS` | 24 000 | `agent.rs` — tool result fed back to the model |
| `MAX_MODEL_CONTENT` | 20 000 | `runner.rs` — model output kept per turn |
| `MAX_SYSTEM_PROMPT` | 8 192 | `runner.rs` |
| `MAX_TOOL_INPUT` | 65 536 | `runner.rs` — the model writes this blob, so it is bounded before parsing |
| `MAX_COMPLETION_TOKENS` | 8 192 | `openrouter.rs` |
| `MAX_IMAGE_DATA_URL` | 4 MiB | `runner.rs` |

A memory store leaves at most 17 usable MCP grants (20 − 3 memory tools). That
arithmetic is asserted only in a comment; a 21-chip golden fixture would close it
(`docs/open-decisions.md` §3.5).
