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
export const HEADER_H = 24; // h-6 — the icon+label band every headered node shares
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
// label strip may be wider than the circle so names like "was mentioned" or
// "every 30 minutes" fit — render-only: ports/edges anchor on the circle, so
// this never feeds an anchor computation
export const EVENT_LABEL_W = 96;

// agent nodes render horizontally: a header, a row of config dropdowns
// (output + reasoning), then the value inputs (prompt/system/model/tools/
// skills) along the BOTTOM edge — one per column, name centered above its
// marker. The flow input "in" sits on the LEFT edge (vertically centered on
// the body band) and the outputs "out"/"result" stack on the RIGHT edge, each
// leaving along its own normal. Side ports live in the body band only — never
// over the header — mirroring the if node's IF_HEADER_H/IF_BODY_H split.
// node.tsx's agent branch must match these exactly. Width grows with the
// bottom-port count.
export const AGENT_PORT_SLOT = 48; // width of one bottom-edge port column
export const AGENT_HEADER_H = HEADER_H; // 24
export const AGENT_CONFIG_H = 40; // output + reasoning dropdown row
export const AGENT_LABEL_H = 16; // port-name strip above the markers
export const AGENT_PORT_H = 20; // bottom-edge marker row
export const AGENT_H = AGENT_HEADER_H + AGENT_CONFIG_H + AGENT_LABEL_H + AGENT_PORT_H;
export const AGENT_BODY_H = AGENT_CONFIG_H; // 40 — the side-port band, below the header
export const AGENT_LEFT_GUTTER = 14; // config-row left pad clearing the "in" port
export const AGENT_RIGHT_GUTTER = 48; // config-row right pad clearing "result"
export const AGENT_MIN_W = AGENT_LEFT_GUTTER + AGENT_RIGHT_GUTTER + 120;

// mcp/skill grant chips render as a rounded square (60px mcp / 48px skill)
// with a label strip (h-6) below, like the model circle; node.tsx's chip
// branch must match these exactly too
export const MCP_CHIP = 60;
export const SKILL_CHIP = 48;
export const MEMORY_CHIP = 48;
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

// secret variable nodes: a read-only literal-shaped box showing only the
// variable's name behind a key glyph, sized from the name (single line)
export const VAR_ICON_W = 16; // key glyph + gap before the name

// the if node renders as a compact square carrying the agent node's frame: a
// header band on top, then a body whose center holds the operator dropdown,
// with the l/in/r inputs stacked on the body's left edge and the true/false
// flow outputs on its right edge. node.tsx's if branch must match these
// exactly too.
export const IF_W = 92;
export const IF_HEADER_H = HEADER_H; // 24
export const IF_BODY_H = 64; // operator + side-port band
export const IF_H = IF_HEADER_H + IF_BODY_H;

export const isModelEntry = (entry: CatalogEntry): boolean =>
    entry.category === "model" && !entry.missing;

export const isEventEntry = (entry: CatalogEntry): boolean =>
    entry.category === "events" && !entry.missing;

// the if node renders as a compact square (see IF_W/IF_H); only the real if
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

// mcp server nodes (key "mcp:<uuid>:*") and skill nodes render as grant chips
// branch; missing placeholders keep the dashed rect (like isModelEntry)
export const isMcpChipEntry = (entry: CatalogEntry): boolean =>
    entry.category === "mcp" && !entry.missing && typeof entry.toolName === "string";

export const isSkillChipEntry = (entry: CatalogEntry): boolean =>
    entry.category === "skill" && !entry.missing;

export const isMemoryChipEntry = (entry: CatalogEntry): boolean =>
    entry.category === "memory" && !entry.missing;

export const isChipEntry = (entry: CatalogEntry): boolean =>
    isMcpChipEntry(entry) || isSkillChipEntry(entry) || isMemoryChipEntry(entry);

export const chipSize = (entry: CatalogEntry): number =>
    isMcpChipEntry(entry) ? MCP_CHIP : isMemoryChipEntry(entry) ? MEMORY_CHIP : SKILL_CHIP;

// missingEntry placeholders map to category "logic", so these are only ever
// true for the real model / event / literal catalog entries
export const isLiteralEntry = (entry: CatalogEntry): boolean =>
    entry.category === "data" &&
    (entry.key === "string" || entry.key === "number") &&
    !entry.missing;

// secret variable value boxes render like a single-line literal, but sized
// from the entry's label (the variable name) — node.config carries nothing
export const isVariableEntry = (entry: CatalogEntry): boolean =>
    entry.category === "variable" && !entry.missing;

export const variableWidth = (entry: CatalogEntry): number =>
    Math.min(
        LIT_MAX_W,
        Math.max(LIT_MIN_W, Math.ceil(entry.label.length * LIT_CHAR_W) + LIT_PAD_X + VAR_ICON_W),
    );

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
    if (isVariableEntry(entry)) return variableWidth(entry);
    return NODE_W;
};

export const configRowHeight = (field: ConfigField): number =>
    field.input === "textarea" ? TEXTAREA_ROW_H : CONFIG_ROW_H;

// input ports absorbed into a config row: a field's overriddenBy names the
// port, and the marker renders on that row's left edge instead of its own
// port row (integration action nodes). node.tsx must skip these in the
// zipped port rows and render them inline.
export const pairedInputIds = (entry: CatalogEntry): Set<string> =>
    new Set(
        (entry.config ?? [])
            .map((f) => f.overriddenBy)
            .filter((id): id is string => !!id && entry.inputs.some((p) => p.id === id)),
    );

export const unpairedInputs = (entry: CatalogEntry): PortSpec[] => {
    const paired = pairedInputIds(entry);
    return entry.inputs.filter((p) => !paired.has(p.id));
};

// port rows pair (unpaired) input i with output i on the same row
const portRows = (entry: CatalogEntry): number =>
    Math.max(unpairedInputs(entry).length, entry.outputs.length);

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
    if (isVariableEntry(entry)) return LIT_LINE_H + LIT_PAD_Y;
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
    if (isIfEntry(entry)) return IF_HEADER_H + IF_BODY_H / 2; // the middle "in" input
    if (isAgentEntry(entry)) return AGENT_HEADER_H + AGENT_BODY_H / 2; // flow "in" on the left edge
    if (isChipEntry(entry)) return chipSize(entry) / 2;
    if (isLiteralEntry(entry) || isVariableEntry(entry)) return nodeHeight(entry, node) / 2;
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

// centroid of the anchors a single port connects to — for an input port, the
// source outputs feeding it; for an output port, the target inputs it feeds.
// Peer anchors are resolved statically (no graph passed on) so this never
// recurses, like outputTargetCentroid. Used by the event circle, whose
// outputs each pivot toward their own connection.
function portPeerCentroid(
    node: WorkflowNode,
    portId: string,
    isInput: boolean,
    graph: WorkflowGraph,
    byKey: Record<string, CatalogEntry>,
): { x: number; y: number } | null {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const e of graph.edges) {
        const self = isInput ? e.to : e.from;
        const peer = isInput ? e.from : e.to;
        if (self.nodeId !== node.id || self.portId !== portId) continue;
        const pn = graph.nodes.find((x) => x.id === peer.nodeId);
        if (!pn) continue;
        const pe = byKey[pn.type];
        if (!pe) continue;
        const p = portPosition(pn, pe, peer.portId);
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

    // event circle: each output rides the circle perimeter toward the node it
    // feeds — like the integration branch, extended to two outputs. Unconnected,
    // each falls back to its home edge: the flow "out" on the right, the
    // "payload" value out on the bottom. The schedule/start events carry only
    // the flow output, so they resolve to the right-edge midline as before. No
    // inputs — the left branch is defensive.
    if (isEventEntry(entry)) {
        const r = EVENT_W / 2;
        const cx = node.x + r;
        const cy = node.y + EVENT_H / 2;
        if (entry.inputs.some((p) => p.id === portId))
            return { x: node.x, y: cy, nx: -1, ny: 0 };
        const out = entry.outputs.find((p) => p.id === portId);
        const home: PortGeometry =
            out && out.kind !== "flow"
                ? { x: cx, y: node.y + EVENT_H, nx: 0, ny: 1 } // payload value out on the bottom
                : { x: node.x + EVENT_W, y: cy, nx: 1, ny: 0 }; // flow out on the right
        const peer = graph && byKey ? portPeerCentroid(node, portId, false, graph, byKey) : null;
        if (!peer) return home;
        const vx = peer.x - cx;
        const vy = peer.y - cy;
        const len = Math.hypot(vx, vy) || 1;
        return { x: cx + (r * vx) / len, y: cy + (r * vy) / len, nx: vx / len, ny: vy / len };
    }

    // agent: the flow "in" leaves the left edge, the outputs stack on the
    // right edge, and the value inputs sit one-per-column along the bottom.
    if (isAgentEntry(entry)) {
        const width = nodeWidth(entry);
        // flow input on the left edge, centered on the body band
        const input = entry.inputs.find((p) => p.id === portId);
        if (input?.kind === "flow")
            return { x: node.x, y: node.y + AGENT_HEADER_H + AGENT_BODY_H / 2, nx: -1, ny: 0 };
        // outputs on the right edge, evenly stacked across the body band
        const outIdx = entry.outputs.findIndex((p) => p.id === portId);
        if (outIdx !== -1) {
            const y = AGENT_HEADER_H + (AGENT_BODY_H * (outIdx + 1)) / (entry.outputs.length + 1);
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

    // literal box (and the read-only variable box): its single value output
    // rides the box perimeter toward the node it feeds (right-edge midline
    // when unconnected), like the model circle / grant chip but projected
    // onto a rectangle (width/height derive from content / the variable
    // name). No inputs — the left branch is defensive.
    if (isLiteralEntry(entry) || isVariableEntry(entry)) {
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

    // if node: l/in/r stack on the body's left edge (input array order
    // top→bottom), true/false on its right edge, each evenly spaced below the
    // header band and leaving horizontally
    if (isIfEntry(entry)) {
        const bodyY = (row: number, count: number) =>
            node.y + IF_HEADER_H + (IF_BODY_H * (row + 1)) / (count + 1);
        const inputRow = entry.inputs.findIndex((p) => p.id === portId);
        if (inputRow !== -1) {
            return { x: node.x, y: bodyY(inputRow, entry.inputs.length), nx: -1, ny: 0 };
        }
        const outRow = entry.outputs.findIndex((p) => p.id === portId);
        const y = bodyY(Math.max(outRow, 0), entry.outputs.length);
        return { x: node.x + IF_W, y, nx: 1, ny: 0 };
    }

    const rowY = (row: number) => node.y + HEADER_H + row * PORT_ROW_H + PORT_ROW_H / 2;

    // paired inputs anchor at the vertical center of their config row,
    // below every port row
    const fields = entry.config ?? [];
    const pairedField = fields.findIndex((f) => f.overriddenBy === portId);
    if (pairedField !== -1 && entry.inputs.some((p) => p.id === portId)) {
        let y = node.y + HEADER_H + portRows(entry) * PORT_ROW_H;
        for (let i = 0; i < pairedField; i++) y += configRowHeight(fields[i]);
        y += configRowHeight(fields[pairedField]) / 2;
        return { x: node.x, y, nx: -1, ny: 0 };
    }

    const inputRow = unpairedInputs(entry).findIndex((p) => p.id === portId);
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
