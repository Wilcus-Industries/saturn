// Workflow designer data model: node catalog, graph types, validation and
// connection rules. Shared by the designer canvas and the test-run
// interpreter; the save-time caps and shape guard live in
// src-tauri/src/workflow.rs, which is what actually gates a save.

import catalogJson from "@/catalog.json";

// The one GitHub event that a PAT is not optional for. Shared with the designer
// toolbox, which greys the chip out on the same condition — two spellings of
// this string would drift into a chip you can place but that never polls.
export const STAR_EVENT_KEY = "event:github-star";

export type PortKind = "flow" | "value";
export type NodeCategory =
    | "events"
    | "logic"
    | "data"
    | "mcp"
    | "skill"
    | "memory"
    | "session"
    | "variable"
    | "saturn"
    | "model"
    | "integration";

// one tool argument, derived from the MCP tool's inputSchema at discovery
// (lib/mcp.ts deriveParams) and stored on the registry's McpTool entries.
// Defined here — the lowest layer — so client-safe registry code and the
// server-only mcp client can both import it.
type McpToolParamType = "string" | "number" | "boolean" | "array" | "object";
export type McpToolParam = {
    name: string;
    type: McpToolParamType;
    required: boolean;
    description?: string;
};

// multi: value input that accepts many incoming edges (await "values", agent
// "tools"/"skills") — every other value input stays single-edge via
// edgesToReplace.
// accepts: value input that takes grant-chip outputs only ("tool" = an mcp
// per-tool node, "skill" = a skill node, "memory" = a memory store node,
// "session" = a chat node); ordinary value edges are rejected.
export type PortSpec = {
    id: string;
    label: string;
    kind: PortKind;
    multi?: boolean;
    accepts?: "tool" | "skill" | "memory" | "session";
};

export type ConfigField = {
    id: string;
    label: string;
    input: "text" | "number" | "select" | "textarea";
    options?: readonly string[];
    placeholder?: string;
    // json-path: config row gets a pick-from-sample button (extract.path)
    picker?: "json-path";
    // input port that takes precedence when connected — the designer dims
    // the field so a literal never looks live while an edge overrides it
    overriddenBy?: string;
    // the designer computes this select's options per node (agent output
    // modalities); the static `options` list is the full universe, kept as
    // documentation for MCP get_catalog consumers
    dynamicOptions?: boolean;
    // seeded into a freshly spawned node's config (defaultNodeConfig) — e.g.
    // the if operator defaults to "==" so a new if node is runnable at once
    default?: string;
};

// initial config for a node spawned from `entry` — the config fields' `default`
// values keyed by field id (empty when none declare one). Merged UNDER any
// toolbox preset at spawn so a preset still wins.
export const defaultNodeConfig = (entry: CatalogEntry): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const f of entry.config ?? []) if (f.default !== undefined) out[f.id] = f.default;
    return out;
};

export type CatalogEntry = {
    key: string;
    category: NodeCategory;
    label: string;
    inputs: PortSpec[];
    outputs: PortSpec[];
    config?: ConfigField[];
    emoji?: string; // user skill icon
    // user skill / memory store description — shown in the designer's chip info
    // popover. Additive only: the hosted MCP get_catalog field-picks its output,
    // so this never leaks there.
    description?: string;
    logoDomain?: string; // user mcp favicon host
    missing?: boolean; // placeholder for a deleted registry entry
    // toolbox subheader (integration node: the app's name)
    group?: string;
    // the category this entry borrows its color from, overriding its own
    // (integration node: INTEGRATION_SECTIONS). See entryStyles().
    section?: NodeCategory;
    // variable entries only: false = regular (sky), true/undefined = secret
    // (violet). entryStyles reads it to split the two variable modes by color.
    secret?: boolean;
    legacy?: boolean; // resolvable for saved graphs but hidden from the toolbox
    toolName?: string; // mcp server node: the ALL_TOOLS "*" sentinel
    // mcp server node: the enabled + callable tools it can grant — exactly
    // the runtime expansion set (feeds the designer's tool picker and the
    // hosted MCP get_catalog)
    tools?: { name: string; description?: string }[];
};

export type WorkflowNode = {
    id: string;
    type: string; // CatalogEntry key
    x: number;
    y: number;
    config: Record<string, string>;
};

export type WorkflowEdge = {
    id: string;
    from: { nodeId: string; portId: string }; // output port
    to: { nodeId: string; portId: string }; // input port
    kind: PortKind;
};

export type WorkflowGraph = { nodes: WorkflowNode[]; edges: WorkflowEdge[] };

export const valuePort = (id: string, label = id): PortSpec => ({ id, label, kind: "value" });

// The node catalog is data, not code: catalog.json is the single source of
// truth, read here by import and by the Rust interpreter with include_str!, so
// the two runtimes can never drift. It is a serialized snapshot — the
// integration:* / event:* entries at its tail were generated from
// lib/integrations.ts's INTEGRATIONS / EXTENSION_EVENTS, so changing a
// descriptor there means regenerating the JSON.
//
// What the JSON can't say (it has no comments), per entry:
// - events category = the entry points. Resolution keys off the category, not
//   the type string, so a new event needs no interpreter/designer change.
// - schedule: `cron` is authored via the designer's cron popover (node.tsx
//   event branch), not the inline field — the field just declares the key.
// - run: manual entry point. The cron runner keys on type "schedule" and
//   transports on event:<id>, so this type is invisible to both by
//   construction.
// - start, literal: legacy. Hidden from the toolbox, still resolve so graphs
//   saved before the events framework / the string+number split keep running.
// - if: port order IS the left-edge top→bottom order (l, in, r); rendered as a
//   rounded square by node.tsx's if branch (geometry.ts isIfEntry).
// - string, number: bare header-less value boxes, node.tsx's literal branch.
// - print: the "message" port overrides the literal; the pre-2026-07 "value"
//   port + prefix concat survives only as an interpreter fallback.
// - extract: dot-separated path, numbers index arrays ("data.results.0.price").
// - await: join barrier for parallel branches, runs once every incoming flow
//   edge arrived; "results" is a JSON array of the "values" edges in edge order.
// - agent: grants are edges from chip nodes into the multi "tools"/"skills"
//   ports; "memory" and "session" are single-edge (one store, one chat per
//   agent) so edgesToReplace auto-swaps. A wired "session" makes the agent's
//   conversation persist across runs — the chat's window seeds the transcript
//   and the exchange is appended back (src-tauri/src/saturn.rs). config.system
//   is authored via the system-prompt popover and the same-id port overrides it; config.model is the fallback when "model" is
//   unwired. "result" carries a data:image/… URL when output=image.
// - saturn-agent: the agent node's shape, but it IS Saturn Agent — Saturn's own
//   prompt, tools and memory, so there is no system/tools/skills/memory port to
//   wire. config.session binds a chat by NAME (get-or-create, blank →
//   "workflow"); blank config.model → src-tauri/src/saturn.rs's DEFAULT_MODEL.
// - model: always one static node type — per-model toolbox chips just prefill
//   config.model, so graphs never reference keys that vanish with the list.
// - integration:*: every config field has a same-id value input that overrides
//   the literal (overriddenBy), so tokens/ids can be wired; read-style actions
//   add a value output carrying the sender's result.
// - event:*: no flow input (they're entry points), one value input per config
//   field, "payload" carries the event as a JSON string. Their config is
//   resolved statically by src-tauri/src/events.rs, never by the interpreter. No
//   `section`: unlike integration actions they paint with the events color.
export const CATALOG = catalogJson as CatalogEntry[];
// mcp and skill nodes come exclusively from the user registry (lib/registry.ts)

export const CATALOG_BY_KEY: Record<string, CatalogEntry> = Object.fromEntries(
    CATALOG.map((entry) => [entry.key, entry]),
);

// per-model toolbox chips spawn a plain "model" node carrying config.preset set
// to this flag, which flips the node's name to read-only (the slug came from
// the OpenRouter list, not free-typed — see node.tsx's model branch and
// toolbox.tsx's ModelChip). Deliberately NOT declared as a ConfigField: a
// ConfigField named "preset" would surface in the hosted MCP get_catalog and
// leak an internal UI flag to external agents. Kept as a bare config key.
export const MODEL_PRESET = "1";

// header-only placeholder for a node whose catalog entry no longer exists
// (deleted registry entry, or a node type removed from the static catalog);
// no ports/config, so nodeHeight stays consistent with geometry.ts
export function missingEntry(type: string): CatalogEntry {
    const prefix = type.split(":")[0];
    const category: NodeCategory =
        prefix === "mcp" ||
        prefix === "skill" ||
        prefix === "memory" ||
        prefix === "session" ||
        prefix === "variable" ||
        prefix === "integration"
            ? prefix
            : "logic";
    return { key: type, category, label: "(deleted)", inputs: [], outputs: [], missing: true };
}

// literal Tailwind class strings (JIT can't see computed names) + raw hex for
// SVG edge strokes. `borderL` is the left-accent class (generic rects/toolbox
// chips); `border` is the full-perimeter class in the same hue (Phase 2 wires
// it into the non-rectangular node shapes).
type CategoryStyle = {
    borderL: string;
    border: string;
    headerBg: string;
    text: string;
    edge: string;
};

export const CATEGORY_STYLES = {
    events: {
        borderL: "border-l-amber-500",
        border: "border-amber-500/60",
        headerBg: "bg-amber-500/10",
        text: "text-amber-600 dark:text-amber-400",
        edge: "#f59e0b",
    },
    logic: {
        borderL: "border-l-blue-500",
        border: "border-blue-500/60",
        headerBg: "bg-blue-500/10",
        text: "text-blue-600 dark:text-blue-400",
        edge: "#3b82f6",
    },
    data: {
        borderL: "border-l-teal-500",
        border: "border-teal-500/60",
        headerBg: "bg-teal-500/10",
        text: "text-teal-600 dark:text-teal-400",
        edge: "#14b8a6",
    },
    mcp: {
        borderL: "border-l-purple-500",
        border: "border-purple-500/60",
        headerBg: "bg-purple-500/10",
        text: "text-purple-600 dark:text-purple-400",
        edge: "#a855f7",
    },
    skill: {
        borderL: "border-l-green-500",
        border: "border-green-500/60",
        headerBg: "bg-green-500/10",
        text: "text-green-600 dark:text-green-400",
        edge: "#22c55e",
    },
    memory: {
        borderL: "border-l-fuchsia-500",
        border: "border-fuchsia-500/60",
        headerBg: "bg-fuchsia-500/10",
        text: "text-fuchsia-600 dark:text-fuchsia-400",
        edge: "#d946ef",
    },
    session: {
        borderL: "border-l-indigo-500",
        border: "border-indigo-500/60",
        headerBg: "bg-indigo-500/10",
        text: "text-indigo-600 dark:text-indigo-400",
        edge: "#6366f1",
    },
    variable: {
        borderL: "border-l-violet-500",
        border: "border-violet-500/60",
        headerBg: "bg-violet-500/10",
        text: "text-violet-600 dark:text-violet-400",
        edge: "#8b5cf6",
    },
    saturn: {
        borderL: "border-l-cyan-500",
        border: "border-cyan-500/60",
        headerBg: "bg-cyan-500/10",
        text: "text-cyan-600 dark:text-cyan-400",
        edge: "#06b6d4",
    },
    model: {
        borderL: "border-l-rose-500",
        border: "border-rose-500/60",
        headerBg: "bg-rose-500/10",
        text: "text-rose-600 dark:text-rose-400",
        edge: "#f43f5e",
    },
    integration: {
        borderL: "border-l-orange-500",
        border: "border-orange-500/60",
        headerBg: "bg-orange-500/10",
        text: "text-orange-600 dark:text-orange-400",
        edge: "#f97316",
    },
} as const satisfies Record<NodeCategory, CategoryStyle>;

// gray styling for "(deleted)" placeholder nodes (missingEntry). A dedicated
// neutral palette so a missing registry entry reads as inert — this frees
// orange to mean integration again (missing integration nodes used to borrow
// CATEGORY_STYLES.integration's orange).
const MISSING_STYLES = {
    borderL: "border-l-gray-400",
    border: "border-gray-400/60",
    headerBg: "bg-gray-400/10",
    text: "text-gray-500 dark:text-gray-400",
    edge: "#9ca3af",
} as const satisfies CategoryStyle;

// regular (non-secret) variables paint sky, distinct from the violet
// CATEGORY_STYLES.variable that secrets keep — a value box's color tells the two
// modes apart at a glance. Not a NodeCategory: entryStyles selects it directly.
const VARIABLE_REGULAR_STYLES = {
    borderL: "border-l-sky-500",
    border: "border-sky-500/60",
    headerBg: "bg-sky-500/10",
    text: "text-sky-600 dark:text-sky-400",
    edge: "#0ea5e9",
} as const satisfies CategoryStyle;

// an entry's colors: gray for a "(deleted)" placeholder, then a regular variable
// (sky, split from secret violet), else its own category unless it declares a
// `section` to borrow from (integration nodes mirror their Blocks section — a
// discord webhook in "data" paints teal like the print node). Prefer this over
// indexing CATEGORY_STYLES by entry.category directly, or integrations lose
// their color and missing nodes lose their gray.
export const entryStyles = (entry: CatalogEntry): CategoryStyle =>
    entry.missing
        ? MISSING_STYLES
        : entry.category === "variable" && entry.secret === false
          ? VARIABLE_REGULAR_STYLES
          : CATEGORY_STYLES[entry.section ?? entry.category];

type PortRef = { nodeId: string; portId: string };

function findPort(
    graph: WorkflowGraph,
    ref: PortRef,
    dir: "inputs" | "outputs",
    byKey: Record<string, CatalogEntry>,
): PortSpec | null {
    const node = graph.nodes.find((n) => n.id === ref.nodeId);
    if (!node) return null;
    const entry = byKey[node.type];
    if (!entry) return null;
    return entry[dir].find((p) => p.id === ref.portId) ?? null;
}

// grant-chip nodes: an mcp server node ("tool"), a skill node ("skill"), a
// memory store node ("memory") or a chat node ("session"), whose value
// output feeds only an agent's matching accepts port. Exported so the
// designer's invalid-drop feedback can name the mismatch (chip into ordinary
// port / wrong accepts port) without re-deriving these rules.
export function chipKind(
    entry: CatalogEntry | undefined,
): "tool" | "skill" | "memory" | "session" | null {
    if (!entry || entry.missing) return null;
    if (entry.category === "mcp" && typeof entry.toolName === "string") return "tool";
    if (entry.category === "skill") return "skill";
    if (entry.category === "memory") return "memory";
    if (entry.category === "session") return "session";
    return null;
}

// hard connection rules only — the value-input single-edge limit is handled
// by the canvas replacing the old edge via edgesToReplace
export function canConnect(
    graph: WorkflowGraph,
    from: PortRef,
    to: PortRef,
    byKey: Record<string, CatalogEntry>,
): boolean {
    if (from.nodeId === to.nodeId) return false;

    const fromPort = findPort(graph, from, "outputs", byKey);
    const toPort = findPort(graph, to, "inputs", byKey);
    if (!fromPort || !toPort) return false;
    if (fromPort.kind !== toPort.kind) return false;

    // grant-chip gating: an accepts port takes only its chip kind, and a chip
    // output feeds only an accepts port (never an ordinary value input)
    const srcNode = graph.nodes.find((n) => n.id === from.nodeId);
    const srcChip = chipKind(srcNode ? byKey[srcNode.type] : undefined);
    if (toPort.accepts) {
        if (srcChip !== toPort.accepts) return false;
    } else if (srcChip) {
        return false;
    }

    const duplicate = graph.edges.some(
        (e) =>
            e.from.nodeId === from.nodeId && e.from.portId === from.portId &&
            e.to.nodeId === to.nodeId && e.to.portId === to.portId,
    );
    return !duplicate;
}

// one validation finding: a level + human message, plus the node or edge it
// concerns (when the check is node/edge-specific — most are). The designer
// surfaces these live (topbar badge → issues panel → click-to-select a node's
// issue, plus a per-node dot); the MCP tools (validate_graph/save_graph) still
// read the flat errors/warnings string arrays, which are derived from these.
export type ValidationIssue = {
    level: "error" | "warning";
    message: string;
    nodeId?: string;
    edgeId?: string;
};

// edges that must be deleted before adding from→to, to keep value inputs at
// max 1 incoming edge (unless the port is multi). Flow outputs may fan out —
// the interpreter runs each downstream chain concurrently.
export function edgesToReplace(
    graph: WorkflowGraph,
    from: PortRef,
    to: PortRef,
    byKey: Record<string, CatalogEntry>,
): string[] {
    const kind = findPort(graph, from, "outputs", byKey)?.kind;
    const toPort = findPort(graph, to, "inputs", byKey);
    if (kind !== "value" || toPort?.multi) return [];
    return graph.edges
        .filter((e) => e.to.nodeId === to.nodeId && e.to.portId === to.portId)
        .map((e) => e.id);
}
