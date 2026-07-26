// Workflow designer data model: node catalog, graph types, validation and
// connection rules. Shared by the designer canvas and the test-run
// interpreter; the save-time caps and shape guard live in
// src-tauri/src/workflow.rs, which is what actually gates a save.

import catalogJson from "@/catalog.json";
import { MAX_GRANTED_SKILLS, MAX_GRANTED_TOOLS, parseToolExclusions } from "@/lib/agent";
import { isValidCron } from "@/lib/cron";
import {
    EVENT_PREFIX,
    EXTENSION_EVENTS_BY_KEY,
    INTEGRATION_PREFIX,
    INTEGRATIONS_BY_ID,
    integrationKey,
    integrationProviderId,
} from "@/lib/integrations";

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
// per-tool node, "skill" = a skill node, "memory" = a memory store node);
// ordinary value edges are rejected.
export type PortSpec = {
    id: string;
    label: string;
    kind: PortKind;
    multi?: boolean;
    accepts?: "tool" | "skill" | "memory";
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
//   ports; "memory" is single-edge (one store per agent) so edgesToReplace
//   auto-swaps. config.system is authored via the system-prompt popover and the
//   same-id port overrides it; config.model is the fallback when "model" is
//   unwired. "result" carries a data:image/… URL when output=image.
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

// grant-chip nodes: an mcp server node ("tool"), a skill node ("skill"), or a
// memory store node ("memory"), whose value
// output feeds only an agent's matching accepts port. Exported so the
// designer's invalid-drop feedback can name the mismatch (chip into ordinary
// port / wrong accepts port) without re-deriving these rules.
export function chipKind(entry: CatalogEntry | undefined): "tool" | "skill" | "memory" | null {
    if (!entry || entry.missing) return null;
    if (entry.category === "mcp" && typeof entry.toolName === "string") return "tool";
    if (entry.category === "skill") return "skill";
    if (entry.category === "memory") return "memory";
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

// node types whose value output the event-subscription scan can resolve
// statically (from config.value) when reading event-node config before any run
// — every other source is dynamic and resolves to blank. Duplicated as
// STATIC_VALUE_TYPES in src-tauri/src/events.rs so this validator's warning and
// the resolver stay in lockstep.
const STATIC_VALUE_TYPES = new Set(["string", "number", "literal"]);

// deep validation for graphs authored without the designer's UI guardrails
// (the MCP server's validate_graph/save_graph tools). Assumes the graph
// already passed the Rust shape guard. Errors are states the canvas can't produce
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
    // githubLinked false = no GitHub PAT is set, which only `github-star` cares
    // about (see the star warning below). Absent leaves star nodes unwarned, so
    // every existing caller is unchanged.
    opts?: { githubLinked?: boolean },
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

    // http request headers must be a JSON object of strings — a literal that
    // isn't (and no port feeding it) fails the send at run time
    for (const node of graph.nodes) {
        if (node.type !== integrationKey("http-request")) continue;
        const headers = (node.config.headers ?? "").trim();
        if (!headers || fedPorts.has(`${node.id}:headers`)) continue;
        let ok = false;
        try {
            const parsed: unknown = JSON.parse(headers);
            ok =
                typeof parsed === "object" &&
                parsed !== null &&
                !Array.isArray(parsed) &&
                Object.values(parsed).every((v) => typeof v === "string");
        } catch {
            ok = false;
        }
        if (!ok) {
            warn(`http request "${node.id}" headers is not a JSON object of strings, the run will fail`, {
                nodeId: node.id,
            });
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

    // Only star needs the PAT. Its page-1 stargazers fetch deliberately skips
    // if-none-match, so it cannot 304, and ~120 counted requests/hour overruns
    // GitHub's 60/hr unauthenticated budget — which parks every other watch too,
    // because the rate limit is per-token and the poller holds one. The toolbox
    // greys the chip out; this catches a node placed before the PAT was removed.
    // src-tauri/src/github.rs Resource::pollable is the guard that enforces it.
    if (opts?.githubLinked === false) {
        for (const node of graph.nodes) {
            if (node.type !== STAR_EVENT_KEY) continue;
            const label = EXTENSION_EVENTS_BY_KEY[node.type]?.label ?? node.type;
            warn(
                `${label} "${node.id}" needs a GitHub token — without one it is not polled at all; add one in settings`,
                { nodeId: node.id },
            );
        }
    }

    // event config is read statically by the always-on listeners before any run
    // (src-tauri/src/events.rs), so only variable/string/number sources can feed
    // an event config port — a dynamic source silently resolves to blank
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
    byKey: Record<string, CatalogEntry>,
): string[] {
    const kind = findPort(graph, from, "outputs", byKey)?.kind;
    const toPort = findPort(graph, to, "inputs", byKey);
    if (kind !== "value" || toPort?.multi) return [];
    return graph.edges
        .filter((e) => e.to.nodeId === to.nodeId && e.to.portId === to.portId)
        .map((e) => e.id);
}
