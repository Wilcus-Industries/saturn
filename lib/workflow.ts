// Workflow designer data model: node catalog, graph types, validation and
// connection rules. Shared by the designer canvas and server actions.

import { parseSkillGrants, parseToolGrants } from "@/lib/agent";
import {
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

// multi: value input that accepts many incoming edges (await "values" —
// everywhere else value inputs stay single-edge via edgesToReplace)
export type PortSpec = { id: string; label: string; kind: PortKind; multi?: boolean };

export type ConfigField = {
    id: string;
    label: string;
    input: "text" | "number" | "select" | "textarea";
    options?: readonly string[];
    placeholder?: string;
    // json-path: config row gets a pick-from-sample button; tools/skills:
    // the row is a button opening the grant picker (value is a JSON string
    // array — Record<string,string> config still holds)
    picker?: "json-path" | "tools" | "skills";
    // input port that takes precedence when connected — the designer dims
    // the field so a literal never looks live while an edge overrides it
    overriddenBy?: string;
    // the designer computes this select's options per node (agent output
    // modalities); the static `options` list is the full universe, kept as
    // documentation for MCP get_catalog consumers
    dynamicOptions?: boolean;
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
    group?: string; // toolbox subheader (per-tool mcp node: the server name)
    legacy?: boolean; // resolvable for saved graphs but hidden from the toolbox
    toolName?: string; // per-tool mcp node: the tool this node calls
    params?: McpToolParam[]; // per-tool mcp node: arg spec (absent = raw-JSON input port)
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
    // events — workflow entry points
    {
        key: "start", category: "events", label: "start",
        inputs: [], outputs: [flowOut],
    },
    // logic — control flow + boolean ops
    {
        key: "if", category: "logic", label: "if",
        inputs: [flowIn, v("a"), v("b")],
        outputs: [
            { id: "true", label: "true", kind: "flow" },
            { id: "false", label: "false", kind: "flow" },
        ],
        config: [
            { id: "operator", label: "operator", input: "select", options: IF_OPERATORS },
            { ...text("b_literal", "b (literal)"), overriddenBy: "b" },
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
        key: "literal", category: "data", label: "literal",
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
    // callAgentModel server action (built-in credits, BYOK fallback).
    // "tools"/"skills" config values are JSON string arrays written by the
    // grant picker.
    {
        key: "agent", category: "saturn", label: "agent",
        inputs: [flowIn, v("prompt"), v("model")],
        // "result" carries the final text, or the generated image as a
        // data:image/… URL when output=image
        outputs: [flowOut, v("result")],
        config: [
            { id: "system", label: "system", input: "textarea" },
            { id: "model", label: "model", input: "text", placeholder: "openai/gpt-4o-mini", overriddenBy: "model" },
            { id: "output", label: "output", input: "select", options: ["text", "image"], dynamicOptions: true },
            { id: "tools", label: "tools", input: "text", picker: "tools" },
            { id: "skills", label: "skills", input: "text", picker: "skills" },
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
        logoDomain: p.logoDomain,
        inputs: [flowIn, v("message")], outputs: [flowOut],
        config: p.config,
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
    let startCount = 0;
    for (const n of g.nodes) {
        if (!isRecord(n)) return false;
        if (typeof n.id !== "string" || nodeIds.has(n.id)) return false;
        nodeIds.add(n.id);
        // unknown types are allowed — they render as inert "(deleted)"
        // placeholders (user registry entries resolve per-owner at read time,
        // and removed static catalog entries must not brick saved graphs)
        if (typeof n.type !== "string" || n.type.length > MAX_NODE_TYPE_LENGTH) return false;
        if (n.type === "start" && ++startCount > 1) return false;
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
// inputs); warnings are legal-but-probably-unintended states (unknown node
// types resolve as inert "(deleted)" placeholders, missing start node means
// the workflow never runs, agent grants that don't match a registry entry
// are rejected at execution time).
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
    if (!graph.nodes.some((n) => n.type === "start")) {
        warnings.push("no start node — the workflow can never run");
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
        if (toPort.kind === "value" && !toPort.multi) {
            const inKey = `${edge.to.nodeId}.${edge.to.portId}`;
            const count = (valueInDegree.get(inKey) ?? 0) + 1;
            valueInDegree.set(inKey, count);
            if (count === 2) {
                errors.push(
                    `input ${inKey} has multiple incoming value edges — value inputs accept one edge (only await.values is multi)`,
                );
            }
        }
    }

    // agent grant references — execution rejects grants that don't resolve
    // against the owner's registry, so flag them at authoring time
    for (const node of graph.nodes) {
        if (node.type !== "agent") continue;
        const hasModelEdge = graph.edges.some(
            (e) => e.to.nodeId === node.id && e.to.portId === "model" && e.kind === "value",
        );
        if (!hasModelEdge && !(node.config.model ?? "").trim()) {
            warnings.push(`agent "${node.id}" has no model — the run will fail`);
        }
        for (const ref of parseToolGrants(node.config.tools ?? "")) {
            if (!byKey[`mcp:${ref.entryId}:${ref.toolName}`]) {
                warnings.push(
                    `agent "${node.id}" grants tool "${ref.entryId}:${ref.toolName}" which doesn't match any registered MCP tool node`,
                );
            }
        }
        for (const skillId of parseSkillGrants(node.config.skills ?? "")) {
            if (!byKey[`skill:${skillId}`]) {
                warnings.push(
                    `agent "${node.id}" grants skill "${skillId}" which doesn't match any registered skill`,
                );
            }
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
