import type {
    CatalogEntry,
    ConfigField,
    PortSpec,
    WorkflowGraph,
    WorkflowNode,
} from "@/lib/workflow";

// Single source of truth for node metrics. node.tsx must render to these
// exact values and edges.tsx computes endpoints from them — never measure
// the DOM (getBoundingClientRect) for edge geometry.

export const GRID = 24;
export const NODE_W = 176; // w-44
export const HEADER_H = 32;
export const PORT_ROW_H = 24;
export const CONFIG_ROW_H = 36;
export const TEXTAREA_ROW_H = 72; // h-[72px] textarea config rows

// model nodes render as a circle (h-18 w-18) with a name strip (h-6) below;
// node.tsx's circular branch must match these exactly too
export const MODEL_D = 54; // 3/4 of the old 72px circle
export const MODEL_LABEL_H = 24;

// event nodes render as a circle (h-12 w-12) with a label strip (h-6) below,
// mirroring the model circle; node.tsx's event branch must match these exactly
export const EVENT_W = 48; // w-12 (diameter — kept square so the node is round)
export const EVENT_H = 48; // h-12
export const EVENT_LABEL_H = 24; // h-6 name strip below (like MODEL_LABEL_H)

// agent nodes render horizontally: a header, a row of config dropdowns
// (output + reasoning), then the value inputs (prompt/system/model/tools/
// skills) along the BOTTOM edge — one per column, name centered above its
// marker. The flow input "in" sits on the LEFT edge (vertically centered on
// the top body) and the outputs "out"/"result" stack on the RIGHT edge, each
// leaving along its own normal. node.tsx's agent branch must match these
// exactly. Width grows with the bottom-port count.
export const AGENT_PORT_SLOT = 48; // width of one bottom-edge port column
export const AGENT_HEADER_H = HEADER_H; // 32
export const AGENT_CONFIG_H = 40; // output + reasoning dropdown row
export const AGENT_LABEL_H = 16; // port-name strip above the markers
export const AGENT_PORT_H = 20; // bottom-edge marker row
export const AGENT_H = AGENT_HEADER_H + AGENT_CONFIG_H + AGENT_LABEL_H + AGENT_PORT_H;
export const AGENT_TOP_H = AGENT_HEADER_H + AGENT_CONFIG_H; // 72 — the side-port band
export const AGENT_LEFT_GUTTER = 14; // config-row left pad clearing the "in" port
export const AGENT_RIGHT_GUTTER = 48; // config-row right pad clearing "result"
export const AGENT_MIN_W = AGENT_LEFT_GUTTER + AGENT_RIGHT_GUTTER + 120;

// mcp/skill grant chips render as a rounded square (60px mcp / 48px skill)
// with a label strip (h-6) below, like the model circle; node.tsx's chip
// branch must match these exactly too
export const MCP_CHIP = 60;
export const SKILL_CHIP = 48;
export const CHIP_LABEL_H = 24; // h-6 label strip below (like MODEL_LABEL_H)

// literal value nodes (string/number): a bare header-less box holding the
// editable value with one output port on the right edge. The string box
// grows with its content — width from the longest line, height from the line
// count. Deterministic from node.config.value (mono font, no soft-wrap), so
// node.tsx and edge anchors match without measuring the DOM. number is a
// fixed compact single-line box.
export const LIT_MIN_W = 80;
export const LIT_MAX_W = 260;
export const LIT_PAD_X = 18; // box h-padding + right-edge port clearance
export const LIT_LINE_H = 18; // textarea leading-[18px]
export const LIT_PAD_Y = 12; // py-1.5 top+bottom
export const LIT_CHAR_W = 7.2; // Geist Mono advance at text-xs (12px)
export const NUM_W = 80;

// the if node renders as a headerless rounded square: the operator dropdown
// sits in the center, the l/in/r inputs stack on the left edge and the
// true/false flow outputs on the right edge. node.tsx's if branch must match
// these exactly too.
export const IF_W = 92;
export const IF_H = 64;

export const isModelEntry = (entry: CatalogEntry): boolean =>
    entry.category === "model" && !entry.missing;

export const isEventEntry = (entry: CatalogEntry): boolean =>
    entry.category === "events" && !entry.missing;

// the if node renders as a rounded square (see IF_W/IF_H); only the real if
// catalog entry, never a missing placeholder mapped to "logic"
export const isIfEntry = (entry: CatalogEntry): boolean =>
    entry.category === "logic" && entry.key === "if" && !entry.missing;

// the single saturn node (agent) renders horizontally with bottom-edge ports
export const isAgentEntry = (entry: CatalogEntry): boolean =>
    entry.category === "saturn" && !entry.missing;

// the agent's value inputs, laid left→right along the bottom edge (the flow
// "in" goes on the left edge, outputs on the right edge — see portGeometry)
const agentBottomPorts = (entry: CatalogEntry): PortSpec[] =>
    entry.inputs.filter((p) => p.kind !== "flow");

// per-tool mcp nodes (key "mcp:<uuid>:<toolName>") and skill nodes render as
// grant chips. The legacy generic mcp:<uuid> entry has no toolName → rect
// branch; missing placeholders keep the dashed rect (like isModelEntry)
export const isMcpChipEntry = (entry: CatalogEntry): boolean =>
    entry.category === "mcp" && !entry.missing && typeof entry.toolName === "string";

export const isSkillChipEntry = (entry: CatalogEntry): boolean =>
    entry.category === "skill" && !entry.missing;

export const isChipEntry = (entry: CatalogEntry): boolean =>
    isMcpChipEntry(entry) || isSkillChipEntry(entry);

export const chipSize = (entry: CatalogEntry): number =>
    isMcpChipEntry(entry) ? MCP_CHIP : SKILL_CHIP;

// missingEntry placeholders map to category "logic", so these are only ever
// true for the real model / event / literal catalog entries
export const isLiteralEntry = (entry: CatalogEntry): boolean =>
    entry.category === "data" &&
    (entry.key === "string" || entry.key === "number") &&
    !entry.missing;

// string box grows with content; height counts explicit lines only (the box
// never soft-wraps — long lines scroll inside the max-width cap)
function literalMetrics(value: string): { width: number; height: number } {
    const lines = value.length ? value.split("\n") : [""];
    const widest = lines.reduce((m, l) => Math.max(m, l.length), 1);
    const width = Math.min(LIT_MAX_W, Math.max(LIT_MIN_W, Math.ceil(widest * LIT_CHAR_W) + LIT_PAD_X));
    return { width, height: lines.length * LIT_LINE_H + LIT_PAD_Y };
}

export const nodeWidth = (entry: CatalogEntry, node?: WorkflowNode): number => {
    if (isModelEntry(entry)) return MODEL_D;
    if (isEventEntry(entry)) return EVENT_W;
    if (isIfEntry(entry)) return IF_W;
    if (isAgentEntry(entry))
        return Math.max(AGENT_MIN_W, agentBottomPorts(entry).length * AGENT_PORT_SLOT);
    if (isChipEntry(entry)) return chipSize(entry);
    if (isLiteralEntry(entry))
        return entry.key === "number" ? NUM_W : literalMetrics(node?.config.value ?? "").width;
    return NODE_W;
};

export const configRowHeight = (field: ConfigField): number =>
    field.input === "textarea" ? TEXTAREA_ROW_H : CONFIG_ROW_H;

// port rows pair input i with output i on the same row
const portRows = (entry: CatalogEntry): number =>
    Math.max(entry.inputs.length, entry.outputs.length);

export function nodeHeight(entry: CatalogEntry, node?: WorkflowNode): number {
    if (isModelEntry(entry)) return MODEL_D + MODEL_LABEL_H;
    if (isEventEntry(entry)) return EVENT_H + EVENT_LABEL_H;
    if (isIfEntry(entry)) return IF_H;
    if (isAgentEntry(entry)) return AGENT_H;
    if (isChipEntry(entry)) return chipSize(entry) + CHIP_LABEL_H;
    if (isLiteralEntry(entry))
        return entry.key === "number"
            ? LIT_LINE_H + LIT_PAD_Y
            : literalMetrics(node?.config.value ?? "").height;
    return (
        HEADER_H +
        portRows(entry) * PORT_ROW_H +
        (entry.config ?? []).reduce((h, f) => h + configRowHeight(f), 0) +
        4 // bottom pad
    );
}

// vertical offset from node.y to the node's canonical (primary) port line —
// the axis grid snapping aligns so cross-shape edges between same-level nodes
// stay horizontal. Mirrors the y-offset portGeometry gives each shape's main
// port (model/event/chip/literal center, if "in" input, agent flow "in", or a
// generic rect's first port row), so snapping this offset onto the grid puts
// that exact port on a grid line. Branch order matches nodeHeight/portGeometry.
export function anchorOffsetY(entry: CatalogEntry, node?: WorkflowNode): number {
    if (isModelEntry(entry)) return MODEL_D / 2;
    if (isEventEntry(entry)) return EVENT_H / 2;
    if (isIfEntry(entry)) return IF_H / 2; // the middle "in" input
    if (isAgentEntry(entry)) return AGENT_TOP_H / 2; // flow "in" on the left edge
    if (isChipEntry(entry)) return chipSize(entry) / 2;
    if (isLiteralEntry(entry)) return nodeHeight(entry, node) / 2;
    return HEADER_H + PORT_ROW_H / 2; // generic rect: first port row
}

// centroid of the anchors this node's outputs connect to; null when the node
// feeds nothing. Target anchors are resolved statically (no graph passed on),
// so this never recurses — chip/model outputs only ever feed agent nodes,
// whose ports don't depend on the source position.
function outputTargetCentroid(
    node: WorkflowNode,
    graph: WorkflowGraph,
    byKey: Record<string, CatalogEntry>,
): { x: number; y: number } | null {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const e of graph.edges) {
        if (e.from.nodeId !== node.id) continue;
        const tn = graph.nodes.find((x) => x.id === e.to.nodeId);
        if (!tn) continue;
        const te = byKey[tn.type];
        if (!te) continue;
        const p = portPosition(tn, te, e.to.portId);
        sx += p.x;
        sy += p.y;
        n += 1;
    }
    return n ? { x: sx / n, y: sy / n } : null;
}

// anchor + outward unit normal (the direction the edge leaves the port) for
// one port. The normal drives the bezier's control points so each end exits
// along its own edge — right-edge ports leave horizontally, the agent's
// bottom-edge ports leave downward, rotated chip/model outputs leave along
// their rotation. Circular model nodes and mcp/skill chips rotate their single
// output around the block toward the agent they feed (graph+byKey supplied);
// unconnected (or graph omitted) they fall back to the right-edge midpoint.
export type PortGeometry = { x: number; y: number; nx: number; ny: number };

export function portGeometry(
    node: WorkflowNode,
    entry: CatalogEntry,
    portId: string,
    graph?: WorkflowGraph,
    byKey?: Record<string, CatalogEntry>,
): PortGeometry {
    // model circle: output rides the circle's perimeter toward its target
    // (right-edge midline when unconnected); no inputs, the left branch is
    // defensive
    if (isModelEntry(entry)) {
        const r = MODEL_D / 2;
        const cx = node.x + r;
        const cy = node.y + r;
        if (entry.inputs.some((p) => p.id === portId))
            return { x: node.x, y: cy, nx: -1, ny: 0 };
        const target = graph && byKey ? outputTargetCentroid(node, graph, byKey) : null;
        if (!target) return { x: node.x + MODEL_D, y: cy, nx: 1, ny: 0 };
        const vx = target.x - cx;
        const vy = target.y - cy;
        const len = Math.hypot(vx, vy) || 1;
        return { x: cx + (r * vx) / len, y: cy + (r * vy) / len, nx: vx / len, ny: vy / len };
    }

    // event circle: output rides the circle's perimeter toward its target
    // (right-edge midline when unconnected), same as the model branch; no
    // inputs, the left branch is defensive
    if (isEventEntry(entry)) {
        const r = EVENT_W / 2;
        const cx = node.x + r;
        const cy = node.y + EVENT_H / 2;
        if (entry.inputs.some((p) => p.id === portId))
            return { x: node.x, y: cy, nx: -1, ny: 0 };
        const target = graph && byKey ? outputTargetCentroid(node, graph, byKey) : null;
        if (!target) return { x: node.x + EVENT_W, y: cy, nx: 1, ny: 0 };
        const vx = target.x - cx;
        const vy = target.y - cy;
        const len = Math.hypot(vx, vy) || 1;
        return { x: cx + (r * vx) / len, y: cy + (r * vy) / len, nx: vx / len, ny: vy / len };
    }

    // agent: the flow "in" leaves the left edge, the outputs stack on the
    // right edge, and the value inputs sit one-per-column along the bottom.
    if (isAgentEntry(entry)) {
        const width = nodeWidth(entry);
        // flow input on the left edge, centered on the top (header+config) band
        const input = entry.inputs.find((p) => p.id === portId);
        if (input?.kind === "flow")
            return { x: node.x, y: node.y + AGENT_TOP_H / 2, nx: -1, ny: 0 };
        // outputs on the right edge, evenly stacked across the top band
        const outIdx = entry.outputs.findIndex((p) => p.id === portId);
        if (outIdx !== -1) {
            const y = (AGENT_TOP_H * (outIdx + 1)) / (entry.outputs.length + 1);
            return { x: node.x + width, y: node.y + y, nx: 1, ny: 0 };
        }
        // value inputs along the bottom edge — edges leave downward
        const bottom = agentBottomPorts(entry);
        const col = Math.max(0, bottom.findIndex((p) => p.id === portId));
        return {
            x: node.x + col * AGENT_PORT_SLOT + AGENT_PORT_SLOT / 2,
            y: node.y + AGENT_H,
            nx: 0,
            ny: 1,
        };
    }

    // grant chip: its single value output rides the square's perimeter toward
    // the agent it feeds (right-edge midline when unconnected); no inputs, the
    // left branch is defensive, like the model circle
    if (isChipEntry(entry)) {
        const size = chipSize(entry);
        const half = size / 2;
        const cx = node.x + half;
        const cy = node.y + half;
        if (entry.inputs.some((p) => p.id === portId))
            return { x: node.x, y: cy, nx: -1, ny: 0 };
        const target = graph && byKey ? outputTargetCentroid(node, graph, byKey) : null;
        if (!target) return { x: node.x + size, y: cy, nx: 1, ny: 0 };
        const vx = target.x - cx;
        const vy = target.y - cy;
        // project the ray onto the square boundary (chebyshev scaling)
        const m = Math.max(Math.abs(vx), Math.abs(vy)) || 1;
        const t = half / m;
        const len = Math.hypot(vx, vy) || 1;
        return { x: cx + vx * t, y: cy + vy * t, nx: vx / len, ny: vy / len };
    }

    // literal box: its single value output rides the box perimeter toward the
    // node it feeds (right-edge midline when unconnected), like the model
    // circle / grant chip but projected onto a rectangle (width/height derive
    // from content). No inputs — the left branch is defensive.
    if (isLiteralEntry(entry)) {
        const w = nodeWidth(entry, node);
        const h = nodeHeight(entry, node);
        const cx = node.x + w / 2;
        const cy = node.y + h / 2;
        if (entry.inputs.some((p) => p.id === portId))
            return { x: node.x, y: cy, nx: -1, ny: 0 };
        const target = graph && byKey ? outputTargetCentroid(node, graph, byKey) : null;
        if (!target) return { x: node.x + w, y: cy, nx: 1, ny: 0 };
        const vx = target.x - cx;
        const vy = target.y - cy;
        // project the ray onto the rectangle boundary
        const t = 1 / Math.max(Math.abs(vx) / (w / 2), Math.abs(vy) / (h / 2), Number.EPSILON);
        const len = Math.hypot(vx, vy) || 1;
        return { x: cx + vx * t, y: cy + vy * t, nx: vx / len, ny: vy / len };
    }

    // if node: l/in/r stack on the left edge (input array order top→bottom),
    // true/false on the right edge, each evenly spaced and leaving horizontally
    if (isIfEntry(entry)) {
        const inputRow = entry.inputs.findIndex((p) => p.id === portId);
        if (inputRow !== -1) {
            const y = node.y + (IF_H * (inputRow + 1)) / (entry.inputs.length + 1);
            return { x: node.x, y, nx: -1, ny: 0 };
        }
        const outRow = entry.outputs.findIndex((p) => p.id === portId);
        const y = node.y + (IF_H * (Math.max(outRow, 0) + 1)) / (entry.outputs.length + 1);
        return { x: node.x + IF_W, y, nx: 1, ny: 0 };
    }

    const rowY = (row: number) => node.y + HEADER_H + row * PORT_ROW_H + PORT_ROW_H / 2;

    const inputRow = entry.inputs.findIndex((p) => p.id === portId);
    if (inputRow !== -1) return { x: node.x, y: rowY(inputRow), nx: -1, ny: 0 };

    const outputRow = entry.outputs.findIndex((p) => p.id === portId);
    return { x: node.x + NODE_W, y: rowY(Math.max(outputRow, 0)), nx: 1, ny: 0 };
}

// position-only view of portGeometry — used where the normal is irrelevant
// (canvas rotated-marker offset, output-centroid resolution)
export function portPosition(
    node: WorkflowNode,
    entry: CatalogEntry,
    portId: string,
    graph?: WorkflowGraph,
    byKey?: Record<string, CatalogEntry>,
): { x: number; y: number } {
    const g = portGeometry(node, entry, portId, graph, byKey);
    return { x: g.x, y: g.y };
}
