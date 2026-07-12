import type { CatalogEntry, ConfigField, WorkflowNode } from "@/lib/workflow";

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
export const MODEL_D = 72;
export const MODEL_LABEL_H = 24;

// event nodes render as a curved-left block (h-12 w-14) with a label strip
// (h-6) below; node.tsx's event branch must match these exactly too
export const EVENT_W = 56; // w-14
export const EVENT_H = 48; // h-12
export const EVENT_LABEL_H = 24; // h-6 name strip below (like MODEL_LABEL_H)

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

export const isModelEntry = (entry: CatalogEntry): boolean =>
    entry.category === "model" && !entry.missing;

export const isEventEntry = (entry: CatalogEntry): boolean =>
    entry.category === "events" && !entry.missing;

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

// inputs sit on the left edge (x = node.x), outputs on the right
// (x = node.x + NODE_W); y is the vertical center of the port's row
export function portPosition(
    node: WorkflowNode,
    entry: CatalogEntry,
    portId: string,
): { x: number; y: number } {
    // model circle: ports anchor on the horizontal midline (output on the
    // right edge; no inputs exist, the left branch is defensive)
    if (isModelEntry(entry)) {
        const y = node.y + MODEL_D / 2;
        return entry.inputs.some((p) => p.id === portId)
            ? { x: node.x, y }
            : { x: node.x + MODEL_D, y };
    }

    // event block: output anchors on the right-edge midline (start has one
    // output, no inputs — the left branch is defensive)
    if (isEventEntry(entry)) {
        const y = node.y + EVENT_H / 2;
        return entry.inputs.some((p) => p.id === portId)
            ? { x: node.x, y }
            : { x: node.x + EVENT_W, y };
    }

    // grant chip: only a single value output, on the right-edge midline (no
    // inputs — the left branch is defensive, like the model circle)
    if (isChipEntry(entry)) {
        const size = chipSize(entry);
        const y = node.y + size / 2;
        return entry.inputs.some((p) => p.id === portId)
            ? { x: node.x, y }
            : { x: node.x + size, y };
    }

    // literal box: only a value output, on the right edge at the box midline
    // (width/height derive from its content)
    if (isLiteralEntry(entry)) {
        const y = node.y + nodeHeight(entry, node) / 2;
        return entry.inputs.some((p) => p.id === portId)
            ? { x: node.x, y }
            : { x: node.x + nodeWidth(entry, node), y };
    }

    const rowY = (row: number) => node.y + HEADER_H + row * PORT_ROW_H + PORT_ROW_H / 2;

    const inputRow = entry.inputs.findIndex((p) => p.id === portId);
    if (inputRow !== -1) return { x: node.x, y: rowY(inputRow) };

    const outputRow = entry.outputs.findIndex((p) => p.id === portId);
    return { x: node.x + NODE_W, y: rowY(Math.max(outputRow, 0)) };
}
