// Workflow designer data model: node catalog, graph types, validation and
// connection rules. Shared by the designer canvas and server actions.

import { MAX_GRANTED_SKILLS, MAX_GRANTED_TOOLS } from "@/lib/agent";
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
// per-tool node, "skill" = a skill node); ordinary value edges are rejected.
export type PortSpec = {
    id: string;
    label: string;
    kind: PortKind;
    multi?: boolean;
    accepts?: "tool" | "skill";
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
    logoDomain?: string; // user mcp favicon host
    missing?: boolean; // placeholder for a deleted registry entry
    // toolbox subheader (per-tool mcp node: the server name; integration node:
    // the app's name)
    group?: string;
    // the category this entry borrows its color from, overriding its own
    // (integration node: INTEGRATION_SECTIONS). See entryStyles().
    section?: NodeCategory;
    legacy?: boolean; // resolvable for saved graphs but hidden from the toolbox
    toolName?: string; // per-tool mcp node: the tool this node calls
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
        key: "print", category: "data", label: "print",
        inputs: [flowIn, v("value")], outputs: [flowOut],
        config: [text("message")],
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
    // are edges from chip nodes into the multi "tools" (mcp per-tool nodes)
    // and "skills" (skill nodes) ports. config.system/config.model are legacy
    // fallbacks honored by the interpreter when the port has no edge, but not
    // surfaced in the designer UI.
    {
        key: "agent", category: "saturn", label: "agent",
        inputs: [
            flowIn, v("prompt"), v("system"), v("model"),
            { ...v("tools"), multi: true, accepts: "tool" },
            { ...v("skills"), multi: true, accepts: "skill" },
        ],
        // "result" carries the final text, or the generated image as a
        // data:image/… URL when output=image
        outputs: [flowOut, v("result")],
        config: [
            { id: "output", label: "output", input: "select", options: ["text", "image"], dynamicOptions: true },
            { id: "reasoning", label: "reasoning", input: "select", options: ["off", "low", "medium", "high"], dynamicOptions: true },
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
        inputs: [flowIn, v("message")], outputs: [flowOut],
        config: p.config,
    })),

    // extension events — inbound trigger nodes generated from the platform
    // descriptors in lib/integrations.ts (a Discord mention etc.). They render
    // like the schedule node (events category → circle), but delivery is
    // real-time via /api/events; the single "payload" value port carries the
    // event as a JSON string. No `section` — unlike integration actions they
    // paint with the events color, and the `group` heads their Apps subsection.
    ...EXTENSION_EVENTS.map((e): CatalogEntry => ({
        key: eventNodeKey(e.id), category: "events", label: e.label,
        group: e.app, logoDomain: e.logoDomain, emoji: e.emoji,
        inputs: [], outputs: [flowOut, v("payload")],
        config: e.config,
    })),
];
// mcp and skill nodes come exclusively from the user registry (lib/registry.ts)

export const CATALOG_BY_KEY: Record<string, CatalogEntry> = Object.fromEntries(
    CATALOG.map((entry) => [entry.key, entry]),
);

// longest node type the save action accepts — per-tool mcp keys are
// "mcp:<uuid>:<toolName>" = 41 chars + tool name (names capped at 60)
export const MAX_NODE_TYPE_LENGTH = 128;

// graph persistence caps, shared by the designer's saveWorkflow action and
// the MCP server's save_graph/validate_graph tools. The JSON cap bounds every
// config string too — node/edge counts alone would still admit multi-MB values
export const MAX_NODES = 300;
export const MAX_EDGES = 600;
export const MAX_GRAPH_JSON = 262_144;

// header-only placeholder for a node whose catalog entry no longer exists
// (deleted registry entry, or a node type removed from the static catalog);
// no ports/config, so nodeHeight stays consistent with geometry.ts
export function missingEntry(type: string): CatalogEntry {
    const prefix = type.split(":")[0];
    const category: NodeCategory =
        prefix === "mcp" || prefix === "skill" || prefix === "integration" ? prefix : "logic";
    return { key: type, category, label: "(deleted)", inputs: [], outputs: [], missing: true };
}

// literal Tailwind class strings (JIT can't see computed names) + raw hex for SVG edge strokes
export const CATEGORY_STYLES = {
    events: {
        borderL: "border-l-amber-500",
        headerBg: "bg-amber-500/10",
        text: "text-amber-600 dark:text-amber-400",
        edge: "#f59e0b",
    },
    logic: {
        borderL: "border-l-blue-500",
        headerBg: "bg-blue-500/10",
        text: "text-blue-600 dark:text-blue-400",
        edge: "#3b82f6",
    },
    data: {
        borderL: "border-l-teal-500",
        headerBg: "bg-teal-500/10",
        text: "text-teal-600 dark:text-teal-400",
        edge: "#14b8a6",
    },
    mcp: {
        borderL: "border-l-purple-500",
        headerBg: "bg-purple-500/10",
        text: "text-purple-600 dark:text-purple-400",
        edge: "#a855f7",
    },
    skill: {
        borderL: "border-l-green-500",
        headerBg: "bg-green-500/10",
        text: "text-green-600 dark:text-green-400",
        edge: "#22c55e",
    },
    saturn: {
        borderL: "border-l-cyan-500",
        headerBg: "bg-cyan-500/10",
        text: "text-cyan-600 dark:text-cyan-400",
        edge: "#06b6d4",
    },
    model: {
        borderL: "border-l-rose-500",
        headerBg: "bg-rose-500/10",
        text: "text-rose-600 dark:text-rose-400",
        edge: "#f43f5e",
    },
    integration: {
        borderL: "border-l-orange-500",
        headerBg: "bg-orange-500/10",
        text: "text-orange-600 dark:text-orange-400",
        edge: "#f97316",
    },
} as const satisfies Record<NodeCategory, { borderL: string; headerBg: string; text: string; edge: string }>;

// an entry's colors: its own category, unless it declares a `section` to borrow
// from (integration nodes mirror their Blocks section — a discord webhook in
// "data" paints teal like the print node). Prefer this over indexing
// CATEGORY_STYLES by entry.category directly, or integrations lose their color.
export const entryStyles = (entry: CatalogEntry) => CATEGORY_STYLES[entry.section ?? entry.category];

type PortRef = { nodeId: string; portId: string };

const isRecord = (x: unknown): x is Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x);

const isPortRef = (x: unknown): x is PortRef =>
    isRecord(x) && typeof x.nodeId === "string" && typeof x.portId === "string";

// shape + integrity validation for graphs arriving from the client (save
// action): unique node ids, at most one start node, edges anchored to nodes
// that exist. Port ids aren't checked — registry node types resolve per-owner
// at read time, so the server can't know their port lists.
export function isWorkflowGraph(g: unknown): g is WorkflowGraph {
    if (!isRecord(g) || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) return false;

    const nodeIds = new Set<string>();
    for (const n of g.nodes) {
        if (!isRecord(n)) return false;
        if (typeof n.id !== "string" || nodeIds.has(n.id)) return false;
        nodeIds.add(n.id);
        // unknown types are allowed — they render as inert "(deleted)"
        // placeholders (user registry entries resolve per-owner at read time,
        // and removed static catalog entries must not brick saved graphs)
        if (typeof n.type !== "string" || n.type.length > MAX_NODE_TYPE_LENGTH) return false;
        // event-node count (max one per workflow) is a semantic rule enforced
        // by the designer UI and validateGraphStrict, not this shape guard
        if (typeof n.x !== "number" || !Number.isFinite(n.x)) return false;
        if (typeof n.y !== "number" || !Number.isFinite(n.y)) return false;
        if (!isRecord(n.config)) return false;
        if (Object.values(n.config).some((val) => typeof val !== "string")) return false;
    }

    for (const e of g.edges) {
        if (!isRecord(e)) return false;
        if (typeof e.id !== "string") return false;
        if (!isPortRef(e.from) || !isPortRef(e.to)) return false;
        if (!nodeIds.has(e.from.nodeId) || !nodeIds.has(e.to.nodeId)) return false;
        if (e.kind !== "flow" && e.kind !== "value") return false;
    }

    return true;
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

// grant-chip nodes: a per-tool mcp node ("tool") or a skill node ("skill"),
// whose value output feeds only an agent's matching accepts port. The legacy
// generic mcp:<uuid> entry carries no toolName, so it's an ordinary node.
function chipKind(entry: CatalogEntry | undefined): "tool" | "skill" | null {
    if (!entry || entry.missing) return null;
    if (entry.category === "mcp" && typeof entry.toolName === "string") return "tool";
    if (entry.category === "skill") return "skill";
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

// deep validation for graphs authored without the designer's UI guardrails
// (the MCP server's validate_graph/save_graph tools). Assumes the graph
// already passed isWorkflowGraph. Errors are states the canvas can't produce
// (bad ports, kind mismatches, duplicate edges, fan-in on single-edge value
// inputs, a chip wired into a mismatched accepts port, more than one event
// node); warnings are legal-but-probably-unintended states (unknown node types
// resolve as inert "(deleted)" placeholders, no event node means the workflow
// never triggers, a chip output wired into an ordinary value input grants
// nothing).
export function validateGraphStrict(
    graph: WorkflowGraph,
    byKey: Record<string, CatalogEntry>,
): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    const known = (node: WorkflowNode) => {
        const entry = byKey[node.type];
        return entry && !entry.missing ? entry : null;
    };
    for (const node of graph.nodes) {
        if (!known(node)) {
            warnings.push(
                `node "${node.id}" has unknown type "${node.type}" — it renders as an inert (deleted) placeholder`,
            );
        }
    }
    // entry points are event-category nodes (schedule, legacy start, future
    // events); a workflow must have exactly one — none can never trigger, two+
    // is disallowed (the designer permits only one)
    const isEvent = (node: WorkflowNode) => known(node)?.category === "events";
    const eventCount = graph.nodes.filter(isEvent).length;
    if (eventCount === 0) {
        warnings.push("no event node — add a 'scheduled to run' block so the workflow can trigger");
    } else if (eventCount > 1) {
        errors.push(`a workflow may have only one event node, but this graph has ${eventCount}`);
    }
    // a schedule node with a blank/invalid cron never fires
    for (const node of graph.nodes) {
        if (node.type !== "schedule") continue;
        const cron = (node.config.cron ?? "").trim();
        if (!cron) warnings.push(`schedule node "${node.id}" has no cron — it will never fire`);
        else if (!isValidCron(cron)) {
            warnings.push(`schedule node "${node.id}" has an invalid cron "${cron}" — it will never fire`);
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
            errors.push(`${label}: a node cannot connect to itself`);
            continue;
        }
        const dupKey = `${edge.from.nodeId}.${edge.from.portId}>${edge.to.nodeId}.${edge.to.portId}`;
        if (seen.has(dupKey)) {
            errors.push(`${label}: duplicate edge`);
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
            errors.push(`${label}: "${fromNode.type}" has no output port "${edge.from.portId}"`);
            continue;
        }
        if (!toPort) {
            errors.push(`${label}: "${toNode.type}" has no input port "${edge.to.portId}"`);
            continue;
        }
        if (fromPort.kind !== toPort.kind || edge.kind !== fromPort.kind) {
            errors.push(`${label}: port kinds don't match (${fromPort.kind} output → ${toPort.kind} input, edge kind "${edge.kind}")`);
            continue;
        }
        // grant-chip gating (mirrors canConnect): an accepts port takes only
        // its chip kind (hard error); a chip output wired into an ordinary
        // value input grants nothing (warning — old graphs may carry these)
        const srcChip = chipKind(fromEntry);
        if (toPort.accepts) {
            if (srcChip !== toPort.accepts) {
                errors.push(
                    `${label}: input "${toPort.id}" accepts only ${toPort.accepts} grant-chip nodes`,
                );
                continue;
            }
        } else if (srcChip) {
            warnings.push(
                `${label}: ${srcChip} nodes only grant agents — this edge into an ordinary value input is ignored`,
            );
        }
        if (toPort.kind === "value" && !toPort.multi) {
            const inKey = `${edge.to.nodeId}.${edge.to.portId}`;
            const count = (valueInDegree.get(inKey) ?? 0) + 1;
            valueInDegree.set(inKey, count);
            if (count === 2) {
                errors.push(
                    `input ${inKey} has multiple incoming value edges — this value input accepts one edge`,
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
            warnings.push(`agent "${node.id}" has no model — the run will fail`);
        }
        const grantCount = (portId: string) =>
            graph.edges.filter((e) => e.to.nodeId === node.id && e.to.portId === portId).length;
        if (grantCount("tools") > MAX_GRANTED_TOOLS) {
            warnings.push(
                `agent "${node.id}" has more than ${MAX_GRANTED_TOOLS} tool grants — extras are dropped at run time`,
            );
        }
        if (grantCount("skills") > MAX_GRANTED_SKILLS) {
            warnings.push(
                `agent "${node.id}" has more than ${MAX_GRANTED_SKILLS} skill grants — extras are dropped at run time`,
            );
        }
    }

    // integration nodes fail at run time without their required config
    for (const node of graph.nodes) {
        if (!node.type.startsWith(INTEGRATION_PREFIX)) continue;
        const provider = INTEGRATIONS_BY_ID[integrationProviderId(node.type)];
        if (!provider) continue; // unknown-type warning already covers it
        for (const field of provider.requiredConfig) {
            if (!(node.config[field] ?? "").trim()) {
                warnings.push(
                    `${provider.label} "${node.id}" has no ${field} — the run will fail`,
                );
            }
        }
    }

    // extension event nodes never fire without their required config (e.g. a
    // Discord "mentioned" node with a blank bot token)
    for (const node of graph.nodes) {
        if (!node.type.startsWith(EVENT_PREFIX)) continue;
        const event = EXTENSION_EVENTS_BY_KEY[node.type];
        if (!event) continue; // unknown-type warning already covers it
        for (const field of event.requiredConfig) {
            if (!(node.config[field] ?? "").trim()) {
                warnings.push(
                    `${event.label} "${node.id}" has no ${field} — the run will fail`,
                );
            }
        }
    }

    return { errors, warnings };
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
