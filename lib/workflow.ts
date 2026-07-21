// Workflow designer data model: node catalog, graph types, validation and
// connection rules. Shared by the designer canvas and server actions.

import { MAX_GRANTED_SKILLS, MAX_GRANTED_TOOLS, parseToolExclusions } from "@/lib/agent";
import { isValidCron } from "@/lib/cron";
import {
    EVENT_PREFIX,
    EXTENSION_EVENTS,
    EXTENSION_EVENTS_BY_KEY,
    eventNodeKey,
    INTEGRATION_PREFIX,
    INTEGRATIONS,
    INTEGRATIONS_BY_ID,
    integrationKey,
    integrationProviderId,
} from "@/lib/integrations";

export type PortKind = "flow" | "value";
export type NodeCategory =
    | "events"
    | "logic"
    | "data"
    | "mcp"
    | "skill"
    | "memory"
    | "sandbox"
    | "variable"
    | "saturn"
    | "model"
    | "integration";

// one tool argument, derived from the MCP tool's inputSchema at discovery
// (lib/mcp.ts deriveParams) and stored on the registry's McpTool entries.
// Defined here — the lowest layer — so client-safe registry code and the
// server-only mcp client can both import it.
export type McpToolParamType = "string" | "number" | "boolean" | "array" | "object";
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
// "sandbox" = a sandbox node); ordinary value edges are rejected.
export type PortSpec = {
    id: string;
    label: string;
    kind: PortKind;
    multi?: boolean;
    accepts?: "tool" | "skill" | "memory" | "sandbox";
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

// row shape of the workflow table (db/setup.sql)
export type WorkflowRow = {
    id: string;
    user_id: string;
    name: string;
    emoji: string;
    description: string;
    cron: string;
    graph: WorkflowGraph;
    active: boolean; // gates scheduled runs only; manual/test runs ignore it
    created_at: Date;
    updated_at: Date;
};

export const IF_OPERATORS = ["==", "!=", "<", ">", "<=", ">=", "contains"] as const;

export const flowIn: PortSpec = { id: "in", label: "in", kind: "flow" };
export const flowOut: PortSpec = { id: "out", label: "out", kind: "flow" };
export const valuePort = (id: string, label = id): PortSpec => ({ id, label, kind: "value" });
const v = valuePort;
const text = (id: string, label = id): ConfigField => ({ id, label, input: "text" });

export const CATALOG: CatalogEntry[] = [
    // events — workflow entry points. Each is a trigger: a scheduled tick, and
    // (future) a Discord mention etc. Entry resolution keys off the category,
    // not the type string, so new events need no interpreter/designer change.
    {
        key: "schedule", category: "events", label: "scheduled to run", emoji: "⏰",
        // cron is authored via the designer's cron popover (node.tsx event
        // branch), not this inline field — the field just declares the config key
        inputs: [], outputs: [flowOut],
        config: [{ id: "cron", label: "schedule", input: "text", default: "0 9 * * *" }],
    },
    // legacy entry point — hidden from the toolbox, still resolves so graphs
    // saved before the events framework keep running (treated as an event node)
    {
        key: "start", category: "events", label: "start", legacy: true,
        inputs: [], outputs: [flowOut],
    },
    // logic — control flow + boolean ops
    {
        key: "if", category: "logic", label: "if",
        // l / r operands on the left edge with the flow "in" between them;
        // rendered as a rounded square by node.tsx's if branch (geometry.ts
        // isIfEntry). Port order here IS the left-edge top→bottom order.
        inputs: [v("l"), flowIn, v("r")],
        outputs: [
            { id: "true", label: "true", kind: "flow" },
            { id: "false", label: "false", kind: "flow" },
        ],
        config: [
            { id: "operator", label: "operator", input: "select", options: IF_OPERATORS, default: "==" },
        ],
    },
    {
        key: "loop", category: "logic", label: "loop",
        inputs: [flowIn, v("items")],
        outputs: [
            { id: "body", label: "body", kind: "flow" },
            { id: "done", label: "done", kind: "flow" },
            v("item"),
        ],
    },
    {
        key: "and", category: "logic", label: "and",
        inputs: [v("a"), v("b")], outputs: [v("out")],
    },
    {
        key: "or", category: "logic", label: "or",
        inputs: [v("a"), v("b")], outputs: [v("out")],
    },
    {
        key: "not", category: "logic", label: "not",
        inputs: [v("in")], outputs: [v("out")],
    },
    {
        // bare header-less value boxes; the box grows with its content and
        // exposes a single value output (rendered by node.tsx's literal branch)
        key: "string", category: "data", label: "string",
        inputs: [], outputs: [v("out")],
        config: [text("value")],
    },
    {
        key: "number", category: "data", label: "number",
        inputs: [], outputs: [v("out")],
        config: [{ id: "value", label: "value", input: "number" }],
    },
    {
        // legacy pre-split "literal" (config.valueType picks string/number) —
        // still resolves + runs saved graphs, hidden from the toolbox
        key: "literal", category: "data", label: "literal", legacy: true,
        inputs: [], outputs: [v("out")],
        config: [
            { id: "valueType", label: "type", input: "select", options: ["string", "number"] },
            text("value"),
        ],
    },
    // data — values, extraction, output
    {
        // single message field with a paired port: a connected edge overrides
        // the literal (the pre-2026-07 "value" port + prefix concat is a
        // legacy interpreter fallback — see case "print")
        key: "print", category: "data", label: "print",
        inputs: [flowIn, v("message")], outputs: [flowOut],
        config: [{ ...text("message"), overriddenBy: "message" }],
    },
    {
        key: "concat", category: "data", label: "concat",
        inputs: [v("a"), v("b")], outputs: [v("out")],
    },
    {
        // pull one field out of a JSON value (e.g. an MCP tool result);
        // path is dot-separated, numbers index arrays: "data.results.0.price"
        key: "extract", category: "data", label: "extract",
        inputs: [v("value")], outputs: [v("out")],
        config: [{ ...text("path"), picker: "json-path" }],
    },
    {
        // join barrier for parallel branches: runs once every incoming flow
        // edge has arrived; "results" is a JSON array of the "values" edges'
        // values in edge order
        key: "await", category: "logic", label: "await",
        inputs: [flowIn, { ...v("values"), multi: true }],
        outputs: [flowOut, v("results")],
    },

    // saturn — LLM agent blocks, executed by the test-run interpreter via the
    // callAgentModel server action (built-in credits, BYOK fallback). Grants
    // are edges from chip nodes into the multi "tools" (mcp server nodes)
    // and "skills" (skill nodes) ports. config.system is a first-class field
    // authored via the node's system-prompt popover (the "system" input port
    // still overrides it when wired). config.model is a legacy fallback honored
    // by the interpreter when the "model" port has no edge.
    {
        key: "agent", category: "saturn", label: "agent",
        inputs: [
            flowIn, v("prompt"), v("system"), v("model"),
            { ...v("tools"), multi: true, accepts: "tool" },
            { ...v("skills"), multi: true, accepts: "skill" },
            // single-edge (no multi): one memory store per agent, so
            // edgesToReplace auto-swaps a second connection
            { ...v("memory"), accepts: "memory" },
            // single-edge (no multi): one sandbox per agent, so
            // edgesToReplace auto-swaps a second connection
            { ...v("sandbox"), accepts: "sandbox" },
        ],
        // "result" carries the final text, or the generated image as a
        // data:image/… URL when output=image
        outputs: [flowOut, v("result")],
        config: [
            { id: "output", label: "output", input: "select", options: ["text", "image"], dynamicOptions: true },
            { id: "reasoning", label: "reasoning", input: "select", options: ["off", "low", "medium", "high"], dynamicOptions: true },
            // edited via the designer's system-prompt popover (a button, not an
            // inline field); the same-id "system" input port overrides it when
            // wired. input:"textarea" documents its shape for MCP get_catalog.
            { id: "system", label: "system", input: "textarea", overriddenBy: "system" },
        ],
    },

    // model — pure-value node emitting an OpenRouter model slug; connect its
    // output to an agent's "model" input to override the agent's config.
    // Always one static node type: toolbox chips for fetched OpenRouter
    // models just prefill config.model, so graphs never reference per-model
    // keys that could disappear when the list changes
    {
        key: "model", category: "model", label: "model",
        inputs: [], outputs: [v("model")],
        config: [{ id: "model", label: "model", input: "text", placeholder: "openai/gpt-4o-mini" }],
    },

    // integration — outbound message nodes generated from the provider
    // descriptors in lib/integrations.ts; sends execute server-side in
    // lib/integrations.server.ts via the interpreter's callIntegration hook
    ...INTEGRATIONS.map((p): CatalogEntry => ({
        key: integrationKey(p.id), category: "integration", label: p.label,
        group: p.app, section: p.section, logoDomain: p.logoDomain,
        // every config field gets a same-id value input port that overrides
        // the literal when connected (overriddenBy auto-derived), so tokens /
        // channel ids can be wired from upstream nodes
        inputs: [flowIn, ...p.config.map((f) => v(f.id, f.label))],
        // read-style actions declare a value output carrying the sender's result
        outputs: p.output ? [flowOut, v(p.output.id, p.output.label)] : [flowOut],
        config: p.config.map((f) => ({ ...f, overriddenBy: f.id })),
    })),

    // extension events — inbound trigger nodes generated from the platform
    // descriptors in lib/integrations.ts (a Discord mention etc.). Delivery is
    // real-time via the in-process gateway; the single "payload" value port
    // carries the event as a JSON string. They render as normal rectangular
    // nodes (no flow input — events are entry points) with one value input per
    // config field, mirroring integration actions, so tokens/filters can be
    // wired from variable/string nodes — resolved statically by
    // getEventSubscriptions, never by the interpreter. No `section` — unlike
    // integration actions they paint with the events color, and the `group`
    // heads their Apps subsection.
    ...EXTENSION_EVENTS.map((e): CatalogEntry => ({
        key: eventNodeKey(e.id), category: "events", label: e.label,
        group: e.app, logoDomain: e.logoDomain, emoji: e.emoji,
        inputs: e.config.map((f) => v(f.id, f.label)),
        outputs: [flowOut, v("payload")],
        config: e.config.map((f) => ({ ...f, overriddenBy: f.id })),
    })),
];
// mcp and skill nodes come exclusively from the user registry (lib/registry.ts)

export const CATALOG_BY_KEY: Record<string, CatalogEntry> = Object.fromEntries(
    CATALOG.map((entry) => [entry.key, entry]),
);

// longest node type the save action accepts — kept at the old per-tool mcp
// headroom ("mcp:<uuid>:<toolName>" = 41 chars + a ≤60-char tool name) so
// graphs saved before per-server nodes still pass the shape guard
export const MAX_NODE_TYPE_LENGTH = 128;

// graph persistence caps, shared by the designer's saveWorkflow action and
// the MCP server's save_graph/validate_graph tools. The JSON cap bounds every
// config string too — node/edge counts alone would still admit multi-MB values
export const MAX_NODES = 300;
export const MAX_EDGES = 600;
export const MAX_GRAPH_JSON = 262_144;

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
        prefix === "sandbox" ||
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
    sandbox: {
        borderL: "border-l-lime-500",
        border: "border-lime-500/60",
        headerBg: "bg-lime-500/10",
        text: "text-lime-600 dark:text-lime-400",
        edge: "#84cc16",
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
export const MISSING_STYLES = {
    borderL: "border-l-gray-400",
    border: "border-gray-400/60",
    headerBg: "bg-gray-400/10",
    text: "text-gray-500 dark:text-gray-400",
    edge: "#9ca3af",
} as const satisfies CategoryStyle;

// an entry's colors: gray for a "(deleted)" placeholder, else its own category
// unless it declares a `section` to borrow from (integration nodes mirror their
// Blocks section — a discord webhook in "data" paints teal like the print
// node). Prefer this over indexing CATEGORY_STYLES by entry.category directly,
// or integrations lose their color and missing nodes lose their gray.
export const entryStyles = (entry: CatalogEntry): CategoryStyle =>
    entry.missing ? MISSING_STYLES : CATEGORY_STYLES[entry.section ?? entry.category];

type PortRef = { nodeId: string; portId: string };

const isRecord = (x: unknown): x is Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x);

const isPortRef = (x: unknown): x is PortRef =>
    isRecord(x) && typeof x.nodeId === "string" && typeof x.portId === "string";

// shape + integrity validation for graphs arriving from the client (save
// action): unique node ids, at most one start node, edges anchored to nodes
// that exist. Port ids aren't checked — registry node types resolve per-owner
// at read time, so the server can't know their port lists.
// Returns the first violation as a human/agent-readable message, or null when
// the graph is shape-valid — MCP save_graph/validate_graph surface it so a
// graph-authoring agent can self-correct instead of dead-ending on a generic
// rejection (the designer never produces these shapes, so its save action
// keeps the boolean guard).
export function graphShapeError(g: unknown): string | null {
    if (!isRecord(g)) return "graph must be a JSON object with nodes and edges arrays";
    if (!Array.isArray(g.nodes)) return "graph.nodes must be an array";
    if (!Array.isArray(g.edges)) return "graph.edges must be an array";

    const nodeIds = new Set<string>();
    for (const [i, n] of g.nodes.entries()) {
        if (!isRecord(n)) return `nodes[${i}] must be an object`;
        if (typeof n.id !== "string") return `nodes[${i}].id must be a string`;
        if (nodeIds.has(n.id)) return `duplicate node id "${n.id}"`;
        nodeIds.add(n.id);
        // unknown types are allowed — they render as inert "(deleted)"
        // placeholders (user registry entries resolve per-owner at read time,
        // and removed static catalog entries must not brick saved graphs)
        if (typeof n.type !== "string" || n.type.length > MAX_NODE_TYPE_LENGTH) {
            return `node "${n.id}": type must be a string of at most ${MAX_NODE_TYPE_LENGTH} chars`;
        }
        // event-node count (max one per workflow) is a semantic rule enforced
        // by the designer UI and validateGraphStrict, not this shape guard
        if (
            typeof n.x !== "number" || !Number.isFinite(n.x) ||
            typeof n.y !== "number" || !Number.isFinite(n.y)
        ) {
            return `node "${n.id}": x and y must be finite numbers`;
        }
        if (!isRecord(n.config)) return `node "${n.id}": config must be an object`;
        for (const [key, val] of Object.entries(n.config)) {
            if (typeof val !== "string") {
                return `node "${n.id}": config.${key} must be a string, got ${typeof val} — numbers and booleans are written as strings (e.g. "20", "true")`;
            }
        }
    }

    for (const [i, e] of g.edges.entries()) {
        if (!isRecord(e)) return `edges[${i}] must be an object`;
        if (typeof e.id !== "string") return `edges[${i}].id must be a string`;
        if (!isPortRef(e.from) || !isPortRef(e.to)) {
            return `edge "${e.id}": from and to must each be {nodeId, portId} with string values`;
        }
        if (!nodeIds.has(e.from.nodeId)) {
            return `edge "${e.id}": from.nodeId "${e.from.nodeId}" is not a node in this graph`;
        }
        if (!nodeIds.has(e.to.nodeId)) {
            return `edge "${e.id}": to.nodeId "${e.to.nodeId}" is not a node in this graph`;
        }
        if (e.kind !== "flow" && e.kind !== "value") {
            return `edge "${e.id}": kind must be "flow" or "value"`;
        }
    }

    return null;
}

export function isWorkflowGraph(g: unknown): g is WorkflowGraph {
    return graphShapeError(g) === null;
}

function findPort(
    graph: WorkflowGraph,
    ref: PortRef,
    dir: "inputs" | "outputs",
    byKey: Record<string, CatalogEntry> = CATALOG_BY_KEY,
): PortSpec | null {
    const node = graph.nodes.find((n) => n.id === ref.nodeId);
    if (!node) return null;
    const entry = byKey[node.type];
    if (!entry) return null;
    return entry[dir].find((p) => p.id === ref.portId) ?? null;
}

// grant-chip nodes: an mcp server node ("tool"), a skill node ("skill"), a
// memory store node ("memory"), or a sandbox node ("sandbox"), whose value
// output feeds only an agent's matching accepts port. Exported so the
// designer's invalid-drop feedback can name the mismatch (chip into ordinary
// port / wrong accepts port) without re-deriving these rules.
export function chipKind(entry: CatalogEntry | undefined): "tool" | "skill" | "memory" | "sandbox" | null {
    if (!entry || entry.missing) return null;
    if (entry.category === "mcp" && typeof entry.toolName === "string") return "tool";
    if (entry.category === "skill") return "skill";
    if (entry.category === "memory") return "memory";
    if (entry.category === "sandbox") return "sandbox";
    return null;
}

// hard connection rules only — the value-input single-edge limit is handled
// by the canvas replacing the old edge via edgesToReplace
export function canConnect(
    graph: WorkflowGraph,
    from: PortRef,
    to: PortRef,
    byKey: Record<string, CatalogEntry> = CATALOG_BY_KEY,
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

// deep validation for graphs authored without the designer's UI guardrails
// (the MCP server's validate_graph/save_graph tools). Assumes the graph
// already passed isWorkflowGraph. Errors are states the canvas can't produce
// (bad ports, kind mismatches, duplicate edges, fan-in on single-edge value
// inputs, a chip wired into a mismatched accepts port, more than one event
// node); warnings are legal-but-probably-unintended states (unknown node types
// resolve as inert "(deleted)" placeholders, no event node means the workflow
// never triggers, a chip output wired into an ordinary value input grants
// nothing).
//
// Findings are collected as structured `issues` (each carrying the node/edge it
// concerns where applicable); the flat `errors`/`warnings` string arrays are
// derived from them in push order, so every existing consumer sees the exact
// same strings in the exact same order.
export function validateGraphStrict(
    graph: WorkflowGraph,
    byKey: Record<string, CatalogEntry>,
): { errors: string[]; warnings: string[]; issues: ValidationIssue[] } {
    const issues: ValidationIssue[] = [];
    const err = (message: string, ref?: { nodeId?: string; edgeId?: string }) =>
        issues.push({ level: "error", message, ...ref });
    const warn = (message: string, ref?: { nodeId?: string; edgeId?: string }) =>
        issues.push({ level: "warning", message, ...ref });

    const known = (node: WorkflowNode) => {
        const entry = byKey[node.type];
        return entry && !entry.missing ? entry : null;
    };
    for (const node of graph.nodes) {
        if (!known(node)) {
            warn(
                `node "${node.id}" has unknown type "${node.type}" — it renders as an inert (deleted) placeholder`,
                { nodeId: node.id },
            );
        }
    }
    // entry points are event-category nodes (schedule, legacy start, future
    // events); a workflow must have exactly one — none can never trigger, two+
    // is disallowed (the designer permits only one)
    const isEvent = (node: WorkflowNode) => known(node)?.category === "events";
    const eventCount = graph.nodes.filter(isEvent).length;
    if (eventCount === 0) {
        warn("no event node — add a 'scheduled to run' block so the workflow can trigger");
    } else if (eventCount > 1) {
        err(`a workflow may have only one event node, but this graph has ${eventCount}`);
    }
    // a schedule node with a blank/invalid cron never fires
    for (const node of graph.nodes) {
        if (node.type !== "schedule") continue;
        const cron = (node.config.cron ?? "").trim();
        if (!cron) warn(`schedule node "${node.id}" has no cron — it will never fire`, { nodeId: node.id });
        else if (!isValidCron(cron)) {
            warn(`schedule node "${node.id}" has an invalid cron "${cron}" — it will never fire`, {
                nodeId: node.id,
            });
        }
    }

    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const seen = new Set<string>();
    const valueInDegree = new Map<string, number>();
    for (const edge of graph.edges) {
        const fromNode = nodeById.get(edge.from.nodeId)!;
        const toNode = nodeById.get(edge.to.nodeId)!;
        const label = `edge "${edge.id}" (${edge.from.nodeId}.${edge.from.portId} → ${edge.to.nodeId}.${edge.to.portId})`;

        if (edge.from.nodeId === edge.to.nodeId) {
            err(`${label}: a node cannot connect to itself`, { edgeId: edge.id });
            continue;
        }
        const dupKey = `${edge.from.nodeId}.${edge.from.portId}>${edge.to.nodeId}.${edge.to.portId}`;
        if (seen.has(dupKey)) {
            err(`${label}: duplicate edge`, { edgeId: edge.id });
            continue;
        }
        seen.add(dupKey);

        // edges anchored on unknown-type nodes can't be port-checked
        // (placeholders have no ports) — the unknown-type warning covers them
        const fromEntry = known(fromNode);
        const toEntry = known(toNode);
        if (!fromEntry || !toEntry) continue;

        const fromPort = fromEntry.outputs.find((p) => p.id === edge.from.portId);
        const toPort = toEntry.inputs.find((p) => p.id === edge.to.portId);
        if (!fromPort) {
            err(`${label}: "${fromNode.type}" has no output port "${edge.from.portId}"`, {
                edgeId: edge.id,
            });
            continue;
        }
        if (!toPort) {
            err(`${label}: "${toNode.type}" has no input port "${edge.to.portId}"`, {
                edgeId: edge.id,
            });
            continue;
        }
        if (fromPort.kind !== toPort.kind || edge.kind !== fromPort.kind) {
            err(
                `${label}: port kinds don't match (${fromPort.kind} output → ${toPort.kind} input, edge kind "${edge.kind}")`,
                { edgeId: edge.id },
            );
            continue;
        }
        // grant-chip gating (mirrors canConnect): an accepts port takes only
        // its chip kind (hard error); a chip output wired into an ordinary
        // value input grants nothing (warning — old graphs may carry these)
        const srcChip = chipKind(fromEntry);
        if (toPort.accepts) {
            if (srcChip !== toPort.accepts) {
                err(`${label}: input "${toPort.id}" accepts only ${toPort.accepts} grant-chip nodes`, {
                    edgeId: edge.id,
                });
                continue;
            }
        } else if (srcChip) {
            warn(
                `${label}: ${srcChip} nodes only grant agents — this edge into an ordinary value input is ignored`,
                { edgeId: edge.id },
            );
        }
        if (toPort.kind === "value" && !toPort.multi) {
            const inKey = `${edge.to.nodeId}.${edge.to.portId}`;
            const count = (valueInDegree.get(inKey) ?? 0) + 1;
            valueInDegree.set(inKey, count);
            if (count === 2) {
                err(
                    `input ${inKey} has multiple incoming value edges — this value input accepts one edge`,
                    { nodeId: edge.to.nodeId, edgeId: edge.id },
                );
            }
        }
    }

    // grants are edges from chip nodes into the tools/skills ports; unresolvable
    // sources are already covered by the unknown-type warning. config.model
    // stays a fallback when the model port is unwired.
    for (const node of graph.nodes) {
        if (node.type !== "agent") continue;
        const hasModelEdge = graph.edges.some(
            (e) => e.to.nodeId === node.id && e.to.portId === "model" && e.kind === "value",
        );
        if (!hasModelEdge && !(node.config.model ?? "").trim()) {
            warn(`agent "${node.id}" has no model — the run will fail`, { nodeId: node.id });
        }
        const grantCount = (portId: string) =>
            graph.edges.filter((e) => e.to.nodeId === node.id && e.to.portId === portId).length;
        if (grantCount("tools") > MAX_GRANTED_TOOLS) {
            warn(
                `agent "${node.id}" has more than ${MAX_GRANTED_TOOLS} tool grants — extras are dropped at run time`,
                { nodeId: node.id },
            );
        }
        if (grantCount("skills") > MAX_GRANTED_SKILLS) {
            warn(
                `agent "${node.id}" has more than ${MAX_GRANTED_SKILLS} skill grants — extras are dropped at run time`,
                { nodeId: node.id },
            );
        }
    }

    // mcp server nodes: config.exclude prunes the tool grant per node — a
    // malformed value is ignored at run time (all enabled tools granted), and
    // excluded names the server doesn't have are harmless but likely typos
    for (const node of graph.nodes) {
        const entry = known(node);
        if (!entry || chipKind(entry) !== "tool") continue;
        const exclude = parseToolExclusions(node.config.exclude);
        if (exclude === null) {
            warn(
                `mcp node "${node.id}": exclude is not a JSON array of tool names — ignored, all enabled tools granted`,
                { nodeId: node.id },
            );
            continue;
        }
        const names = new Set((entry.tools ?? []).map((t) => t.name));
        for (const name of exclude) {
            if (!names.has(name)) {
                warn(
                    `mcp node "${node.id}": excluded tool "${name}" doesn't exist on ${entry.label} — ignored`,
                    { nodeId: node.id },
                );
            }
        }
    }

    // integration nodes fail at run time without their required config — a
    // connected value port overrides the literal, so a port-fed field is fine
    const fedPorts = new Set(
        graph.edges.filter((e) => e.kind === "value").map((e) => `${e.to.nodeId}:${e.to.portId}`),
    );
    for (const node of graph.nodes) {
        if (!node.type.startsWith(INTEGRATION_PREFIX)) continue;
        const provider = INTEGRATIONS_BY_ID[integrationProviderId(node.type)];
        if (!provider) continue; // unknown-type warning already covers it
        for (const field of provider.requiredConfig) {
            if (!(node.config[field] ?? "").trim() && !fedPorts.has(`${node.id}:${field}`)) {
                warn(`${provider.label} "${node.id}" has no ${field} — the run will fail`, {
                    nodeId: node.id,
                });
            }
        }
    }

    // extension event nodes never fire without their required config (e.g. a
    // Discord "mentioned" node with a blank bot token) — a port-fed field is
    // fine, same as integrations
    for (const node of graph.nodes) {
        if (!node.type.startsWith(EVENT_PREFIX)) continue;
        const event = EXTENSION_EVENTS_BY_KEY[node.type];
        if (!event) continue; // unknown-type warning already covers it
        for (const field of event.requiredConfig) {
            if (!(node.config[field] ?? "").trim() && !fedPorts.has(`${node.id}:${field}`)) {
                warn(`${event.label} "${node.id}" has no ${field} — the run will fail`, {
                    nodeId: node.id,
                });
            }
        }
    }

    // event config is read statically by the always-on listener before any run
    // (getEventSubscriptions), so only variable/string/number sources can feed
    // an event config port — a dynamic source silently resolves to blank
    const STATIC_VALUE_TYPES = new Set(["string", "number", "literal"]);
    for (const edge of graph.edges) {
        if (edge.kind !== "value") continue;
        const toNode = nodeById.get(edge.to.nodeId);
        if (!toNode?.type.startsWith(EVENT_PREFIX)) continue;
        if (!EXTENSION_EVENTS_BY_KEY[toNode.type]) continue;
        const src = nodeById.get(edge.from.nodeId);
        if (!src) continue; // dangling-endpoint error already covers it
        const srcEntry = known(src);
        if (!srcEntry) continue; // unknown-type warning already covers it
        if (srcEntry.category !== "variable" && !STATIC_VALUE_TYPES.has(src.type)) {
            warn(
                `event node "${toNode.id}": port "${edge.to.portId}" is fed by a ${srcEntry.label} node — event config resolves before any run, so only variable/string/number sources apply; this edge is ignored`,
                { nodeId: toNode.id, edgeId: edge.id },
            );
        }
    }

    // derive the flat arrays in push order so every existing consumer (the MCP
    // validate_graph/save_graph tools, saveWorkflow) sees identical strings
    const errors = issues.filter((i) => i.level === "error").map((i) => i.message);
    const warnings = issues.filter((i) => i.level === "warning").map((i) => i.message);
    return { errors, warnings, issues };
}

// edges that must be deleted before adding from→to, to keep value inputs at
// max 1 incoming edge (unless the port is multi). Flow outputs may fan out —
// the interpreter runs each downstream chain concurrently.
export function edgesToReplace(
    graph: WorkflowGraph,
    from: PortRef,
    to: PortRef,
    byKey: Record<string, CatalogEntry> = CATALOG_BY_KEY,
): string[] {
    const kind = findPort(graph, from, "outputs", byKey)?.kind;
    const toPort = findPort(graph, to, "inputs", byKey);
    if (kind !== "value" || toPort?.multi) return [];
    return graph.edges
        .filter((e) => e.to.nodeId === to.nodeId && e.to.portId === to.portId)
        .map((e) => e.id);
}
