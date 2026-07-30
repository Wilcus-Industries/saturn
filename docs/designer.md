# Workflow designer (canvas)

> Part of the Saturn docs set indexed in `CLAUDE.md`. Node shapes and the catalog are in `docs/nodes.md`; execution is `docs/workflows.md`.

`/dashboard/workflows/designer/?id=` — full-screen, deliberately **outside** the
`(shell)` route group so it renders without the top bar. ~20 components colocate
with it.

`page.tsx` fans out four IPC calls (`get_workflow`, `list_registry`,
`list_models`, `has_github_pat`) and passes the results to
`designer.tsx`, keyed on the workflow id so switching workflows remounts rather
than re-renders — the graph seeds a reducer at mount. It passes
`useAsync(..., { live: false })`: a background cron run firing `data-changed`
would hand the designer a fresh `userCatalog` array mid-edit and break every
memoized `Node` for nothing. Registry edits refetch explicitly.

## State

`graphReducer.ts` owns the graph with undo/redo. Selection lives **outside**
history so undo doesn't thrash it. Node and edge selection are mutually
exclusive: every node-selection change routes through `selectNodes` (which clears
the edge) and `selectEdge` does the reverse.

**Dirty tracking compares graph references, not serialized JSON.** The reducer
allocates a new `present` per mutation and undo/redo restore the exact snapshot
objects, so identity answers "dirty?" without stringifying the whole document
(agent system prompts included) at pointer-event rate. The deliberate price: an
edit landing back on a JSON-identical graph stays dirty and costs one redundant
autosave.

Autosave is debounced and flushed on unmount (`callVoid("save_workflow")` reading
`graphRef`, since an unmount cannot await). Cmd/Ctrl+S saves immediately.

**Arrow-key nudge coalescing:** a burst of presses moves the selection one grid
cell each via *transient* `moveNodes` (the same action a live drag uses
mid-gesture, no history push), and a ~500ms settle timer commits the whole burst
as **one** undo step through the drag path's `commitDrag`. It is flushed early by
any non-arrow action, a selection change, or unmount.

Other shortcuts: Cmd/Ctrl+A select-all, Cmd/Ctrl+D duplicate, Delete/Backspace
removes the selection (including a selected edge), Escape runs a ladder —
cancel an active node drag, then clear edge selection, then clear node selection.
The Escape double-fire is avoided **by phase**: `node.tsx`'s drag-cancel listener
is registered `{capture: true}` and only calls `stopPropagation()` while a drag is
actually active, so cancelling a drag no longer also clears the selection, and an
idle Escape still reaches the ladder.

## Canvas gestures

`canvas.tsx`. Placement is **free-form** — no grid snap, no dotted background
(`GRID` 24 survives only as the nudge and duplicate step).

| gesture | does |
|---|---|
| bare left-drag on empty canvas | pan (any pointer type) |
| middle-drag, space+left-drag | pan (space shows a `grab` cursor) |
| shift+left-drag (mouse/pen) | additive marquee select |
| bare left-click, no drag | clear selection |
| wheel | zoom to cursor |
| ctrl+wheel (trackpad pinch) | zoom |

Two-finger touch pinch is deferred. The space pan-modifier handler skips form
controls and `preventDefault`s so it never scrolls the page. Zoom-to-fit runs on
load, and a bottom-right control cluster holds the ⛶ fit button and the 🤖 toggle
for the docked agent panel.

**Per-node derivation lives in one `nodeProps` memo** keyed on
`[graph, byKey, modelModalities, modelReasoning]`. Nothing view-dependent belongs
in it, or every pan/zoom frame redoes all the port geometry.

`byKey` is memoized on the `\0`-joined set of node **types**, never on
`present.nodes`: a position-only change (every drag frame) must not mint a new
`byKey`, or every `Node` memo breaks at once.

## Edges

`edges.tsx`. `Edges` and each per-edge path are `React.memo`ized, and node gesture
handlers read live graph/selection through refs rather than props — keep new
per-render props off `Node` or the memo dies.

**Edge-drag feedback is honest.** During a port drag, a memo (deps = the *fixed*
drag origin + graph + byKey, never the moving pointer) runs the authoritative
`canConnect` for every opposite-direction port and threads each node a
comma-joined `connectable` string. Only genuinely connectable ports scale and
glow; the rest dim, so illegal targets no longer lie.

Port buttons carry an invisible `-inset-x-2 -inset-y-0.5` overlay for a ~26×14px
hit target. The vertical inset is small on purpose: an `if` node's l/in/r inputs
sit only 16px apart and a taller overlay would cross into the neighbour.

Invalid drops surface a terse toast through `notify` (kind mismatch, wrong
direction, self, `accepts` mismatch, chip into an ordinary port, duplicate,
generic fallback). A drop on empty canvas stays silent — that is a cancel
gesture. A successful drop that replaces a single-edge value input says so, and
is still one undo step.

**Edge selection:** clicking an edge (via an invisible 12px "fat twin" hit path)
selects it. A hovered or selected edge wears an emphasized stroke and a circular
× delete button at the bezier midpoint, computed DOM-free from the cubic control
points (`(P0+3·P1+3·P2+P3)/8`). Deletion is the × or Delete/Backspace — one undo
step. Instant-delete-on-click is gone.

## Toolbox

Four tabbed groups — `blocks` / `apps` / `agents` / `models` — over a pinned
bottom **variables** split. The `agents` group is the grant chips in category
order: the two agent nodes (`saturn` then `gateway`, both headingless), then
`tools` / `skills` / `memory` / `chats` (`AGENTS_CATEGORIES`). Chats come from `saturn_list_sessions`, not the registry,
so their empty state points at Saturn Agent rather than settings (`EMPTY_HINT`). Per-group entry lists are built in `useMemo`s, not
inline JSX.

Search matches a node's label, `key`, app/group name, description, config-field
labels and an MCP server's tool names **across every group**, not just the active
tab: each tab shows a match-count badge, and if the active tab has zero hits
while another has some, a "N matches in {Group} →" hint jumps there. The
`models` tab renders one headed section per connected provider (`list_models`
groups them; a provider that isn't connected is absent, and the tab names its fix
— an OpenRouter key, or starting the local server), each list hundreds of
entries and filtered in one `[providers, q]` memo, counted with plain `.length`
reads — never run through the other groups' match loops. The blank model chip
(editable custom slug) sits above the provider sections.

The variables split stays visible on every tab and keeps its 45% max-height even
when the query filters everything out (empty state: `no variables match "{q}"`).

**Disabled chips** use one affordance (`cursor-not-allowed opacity-40`) and one
prop: `Chip`'s `disabled?: string` — undefined means enabled, a string is the
tooltip explaining which rule applies. Two rules disable chips today: the
one-event rule, and `github-star` with no PAT stored.

Drag-spawn drops route through `designer.tsx`, which toasts on two failure paths:
dropping outside the canvas ("drop on the canvas to place the node") and dropping
a second event node ("one event node per workflow — remove the existing one
first").

## Popovers

`popoverShell.tsx` is shared by all of them: a fixed `z-50` panel over a `z-40`
backdrop (click closes; the backdrop freezes canvas pan/zoom) with
**measure-and-clamp-once** positioning — render `visibility:hidden`, measure in
`useLayoutEffect`, clamp fully into the viewport with 8px margins, then freeze.
Each popover keeps its own before-snapshot and commits through `commitConfig` in
`designer.tsx`, so an editing session is one undo step.

| popover | opened by | writes |
|---|---|---|
| `cronPopover.tsx` | the schedule circle | `config.cron` (hosts `CronBuilder` in callback mode) |
| `toolPickerPopover.tsx` | an MCP server chip | `config.exclude` — a checkbox per grantable tool |
| `systemPopover.tsx` | the agent's `system` set/— button | `config.system`; the button dims and locks when the port is wired |
| `pathPicker.tsx` | the `{}` button on `extract.path` | a dot-path, from a JSON tree of the sampled upstream value |
| `chipInfoPopover.tsx` | a skill or memory chip | nothing — read-only info + a wiring hint |
| `variableModal.tsx` | a variable box (or the toolbox row) | the registry, then `onRegistryChange` |

No chip is a dead click. `variableModal` is hosted by `designer.tsx` rather than
the toolbox so both entry points share one instance; the canvas click routes
through a memo-safe `onOpenVariable(nodeId)` that resolves the row against a live
`variablesRef` mirror.

The path picker samples the port that actually feeds the clicked config field —
its `overriddenBy` port when declared, else the node's first value input
(`extract.path` has no `overriddenBy`, so it keeps sampling `value`).

## Validation surfacing

`useDeferredValue(present)` + an effect calling `call("validate_graph", { graph })`
(Rust rebuilds `byKey` and reads the PAT itself, so neither is an argument).
The deferral **is** the debounce: `present` settles between edits and the
validator is linear over a graph capped at `MAX_NODES`, so re-running it per
settled edit is cheap. It is suppressed on an empty graph so a fresh workflow
doesn't nag about a missing event node before anything is placed.

The topbar shows a summary badge — red `✕ n` when any errors, else amber `⚠ n` —
opening an issues panel anchored at the badge. Clicking an issue that carries a
`nodeId` selects that node through `selectNodes` and closes the panel. If every
issue clears while the panel is open it closes **during render** rather than in an
effect: the badge that anchored it is gone, and a stale anchor must not linger.

`designer.tsx` also derives `issuesByNode: Map<nodeId, "error" | "warning">`
(error wins), threaded to the canvas as a comparable `issueLevel` string.
`issueDot.tsx` paints a small top-**right** dot on every shape branch — right, so
it never collides with the top-left entry badge, and a dot rather than an outline,
because an outline means selection.

The PAT matters for exactly one node — `github-star`, which cannot be polled
without one. Push/issue/pr/release fire either way, so nothing else warns.

## Test runs

The topbar's right cluster carries a static amber-dot event label (the one-event
rule; a `<select>` appears only for legacy multi-event graphs, and schedules are
labelled by `describeCron`), a runs-history link, and the run button.

Running does three things in order:

1. **subscribes before anything can emit** — `test_run` is the only producer, but
   the run starts in Rust the moment the command returns;
2. **saves the graph first.** `test_run` executes the *saved* graph — Rust
   re-reads the row — so an unsaved edit would run the old one;
3. calls `test_run` with the selected event node as `entry_node_ids`.

Sample event payloads are **not** passed in. `execute_run` seeds every event node
from `events::sample_payload`, i.e. from the transports' own production builders
(`docs/open-decisions.md` §1.4).

Three events come back: `run-log` (console lines, streamed into the resizable
bottom `console.tsx` panel — an `image` line renders inline as an `<img>`),
`run-value` (per-port samples feeding the path picker), and `run-finished`.
The designer filters on `trigger === "manual"` so a concurrent cron run's lines
don't land in the console; `test_run`'s own early failures emit a synthetic
`run-finished` with that same trigger, or the topbar would stay stuck on "stop"
for the life of the mount.

`run-value` text is capped by Rust at exactly `MAX_SAMPLE_CHARS` UTF-16 units
with **no truncation marker** — a marker is not a JSON suffix — so the designer
tests `>=` the cap, not `>`, to know a sample was cut and will not parse.

The run button becomes ■ stop, wired to `stop_run`. Stopping is cooperative: an
in-flight HTTP request or model call finishes first.

## The agent panel

`agentPanel.tsx` docks Saturn Agent beside the canvas — the same chat as
`/dashboard/agent/`, sharing its conversation through module state
(`docs/ui.md`). Open state and width live in `designer.tsx` and are never
persisted, the same call the console panel makes. Arriving from the dashboard
chat's "open in designer →", `takeHandoff(workflow.id)` opens it in an effect,
not a lazy `useState` initializer — reading an external store during render
desyncs hydration.

A `save_graph` targeting **this** workflow arrives as a `g` frame and is adopted
by `handleAgentGraph`: `replaceGraph` (one undo step, so Cmd+Z restores whatever
the canvas had), `setSavedGraph` so the autosave doesn't write it straight back,
and a cleared selection because the new graph may reuse node ids for different
nodes. It is not re-validated here — Rust ran `validate_graph_strict` and
`check_graph` before emitting the frame.

## Geometry

`geometry.ts` is the **single source of truth** for node metrics; `node.tsx` and
`edges.tsx` must match it exactly. Edge anchors are computed, never DOM-measured.

**A node box must never carry its frame as a real CSS `border`.** Ports anchor on
the border box while absolutely-positioned children anchor on the padding box, so
a border pushes every marker inward by its width and grows the box past
`nodeHeight()`. Paint frames with the `nodeFrame.tsx` inset overlay instead, and
hang perimeter ports off the borderless outer box.

Port markers: flow ports are filled diamonds (45°-tilted squares), value ports
hollow circles. Both are rotation-agnostic; no branch rotates them.

Config rows have per-field height (`configRowHeight`: `CONFIG_ROW_H` 36,
textareas `TEXTAREA_ROW_H` 72).

`node.tsx` defines exactly **one** component. `BlockShell` (the borderless outer
wrapper + selection outline + drag handlers all eight shape branches render),
`NodeLabel` and `EntryBadge` live in their own files because a second component
in that module trips a React Compiler ref-analysis false positive on the
memoized `Node`. Non-component helpers stay inside: `outMarker` and
`clickedNotDragged` (a press under `DRAG_SLOP` is a click and opens the shape's
popover).

Selection outlines paint on each shape's outer positioned wrapper, label strips
included. One accepted quirk: an event circle's label strip is wider than its
48px wrapper and overflows the outline.
