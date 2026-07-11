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

export const configRowHeight = (field: ConfigField): number =>
    field.input === "textarea" ? TEXTAREA_ROW_H : CONFIG_ROW_H;

// port rows pair input i with output i on the same row
const portRows = (entry: CatalogEntry): number =>
    Math.max(entry.inputs.length, entry.outputs.length);

export function nodeHeight(entry: CatalogEntry): number {
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
    const rowY = (row: number) => node.y + HEADER_H + row * PORT_ROW_H + PORT_ROW_H / 2;

    const inputRow = entry.inputs.findIndex((p) => p.id === portId);
    if (inputRow !== -1) return { x: node.x, y: rowY(inputRow) };

    const outputRow = entry.outputs.findIndex((p) => p.id === portId);
    return { x: node.x + NODE_W, y: rowY(Math.max(outputRow, 0)) };
}
