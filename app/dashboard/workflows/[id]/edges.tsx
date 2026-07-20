"use client";

import { type Dispatch, memo, type SetStateAction, useState } from "react";
import {
    type CatalogEntry,
    entryStyles,
    type PortKind,
    type WorkflowGraph,
} from "@/lib/workflow";
import { portGeometry, type PortGeometry } from "./geometry";

// single SVG in world coordinates, mounted under the nodes. Endpoints come
// from geometry.ts only — never from DOM measurement.

export type PendingEdge = {
    from: { nodeId: string; portId: string };
    kind: PortKind;
    toWorldPoint: { x: number; y: number };
};

type PortRef = { nodeId: string; portId: string };
// `color` is resolved here rather than kept as a category: an integration node
// draws in its section's color, not its own category's (entryStyles)
type End = PortGeometry & { color: string };

// cubic bezier between two ports plus its DOM-free midpoint. Each control point
// pushes off its port's outward normal so the curve leaves along that edge
// (right-edge ports exit horizontally, the agent's bottom-edge ports exit
// downward, rotated chip outputs exit along their rotation). A zero normal
// (drag cursor) exits straight. `mx`/`my` are the point at t=0.5 —
// (P0 + 3·P1 + 3·P2 + P3) / 8 from the same control points, so the midpoint ×
// button anchors without measuring the rendered path.
function curve(a: PortGeometry, b: PortGeometry): { d: string; mx: number; my: number } {
    const dist = Math.max(40, Math.hypot(b.x - a.x, b.y - a.y) / 2);
    const c1x = a.x + a.nx * dist;
    const c1y = a.y + a.ny * dist;
    const c2x = b.x + b.nx * dist;
    const c2y = b.y + b.ny * dist;
    return {
        d: `M ${a.x} ${a.y} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${b.x} ${b.y}`,
        mx: (a.x + 3 * c1x + 3 * c2x + b.x) / 8,
        my: (a.y + 3 * c1y + 3 * c2y + b.y) / 8,
    };
}

// memoized so a drag only re-renders edges whose props actually changed. Every
// prop is a comparable primitive or a stable callback (setHovered is a state
// setter; onSelect/onDelete are useCallbacks in the designer) so the memo holds.
const EdgePath = memo(function EdgePath({
    id,
    d,
    mx,
    my,
    flow,
    color,
    selected,
    hovered,
    setHovered,
    onSelect,
    onDelete,
}: {
    id: string;
    d: string;
    mx: number; // bezier midpoint, world coords — where the × button sits
    my: number;
    flow: boolean;
    color: string; // value-edge stroke, from the source node's category
    selected: boolean;
    hovered: boolean;
    setHovered: Dispatch<SetStateAction<string | null>>;
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    // a selected edge wears the hovered stroke weight persistently, and its
    // delete button stays shown regardless of pointer position
    const emphasized = hovered || selected;
    return (
        <g>
            <path
                d={d}
                fill={"none"}
                stroke={flow ? "var(--foreground)" : color}
                strokeWidth={flow ? (emphasized ? 3.5 : 2) : emphasized ? 3 : 1.5}
                strokeDasharray={flow ? undefined : "6 4"}
            />
            {/* invisible fat twin: hover + click-to-select hit area. Clicking no
                longer deletes — deletion is the midpoint × or Delete/Backspace. */}
            <path
                d={d}
                fill={"none"}
                stroke={"transparent"}
                strokeWidth={12}
                style={{ pointerEvents: "stroke" }}
                className={"cursor-pointer"}
                onPointerDown={(e) => {
                    // keep the canvas from starting a pan/marquee — its pointer
                    // capture would retarget the gesture away from us — then select
                    if (e.button !== 0) return;
                    e.stopPropagation();
                    onSelect(id);
                }}
                onPointerEnter={() => setHovered(id)}
                onPointerLeave={() => setHovered((h) => (h === id ? null : h))}
            />
            {emphasized && (
                // midpoint × delete button — plain SVG for crispness. 18px hit
                // circle (≥16px target). Its own enter/leave keep the edge hovered
                // while the pointer is over the button (which sits on top of the
                // fat twin), so it doesn't vanish out from under the cursor.
                <g
                    className={"cursor-pointer"}
                    style={{ pointerEvents: "all" }}
                    onPointerDown={(e) => {
                        // don't let the canvas start a pan/marquee behind us
                        if (e.button === 0) e.stopPropagation();
                    }}
                    onClick={(e) => {
                        e.stopPropagation();
                        setHovered(null);
                        onDelete(id);
                    }}
                    onPointerEnter={() => setHovered(id)}
                    onPointerLeave={() => setHovered((h) => (h === id ? null : h))}
                >
                    <circle
                        cx={mx}
                        cy={my}
                        r={9}
                        fill={"var(--background)"}
                        stroke={"var(--foreground)"}
                        strokeWidth={1}
                    />
                    <path
                        d={`M ${mx - 3} ${my - 3} L ${mx + 3} ${my + 3} M ${mx + 3} ${my - 3} L ${mx - 3} ${my + 3}`}
                        stroke={"var(--foreground)"}
                        strokeWidth={1.5}
                    />
                </g>
            )}
        </g>
    );
});

// resolve a port ref to its world anchor; null when the node or the port
// vanished (edges are pruned on deleteNodes, but stay defensive — a missing
// registry entry's placeholder has no ports, so its edges just don't render)
function resolveEnd(
    graph: WorkflowGraph,
    byKey: Record<string, CatalogEntry>,
    ref: PortRef,
    dir: "in" | "out",
): End | null {
    const node = graph.nodes.find((n) => n.id === ref.nodeId);
    if (!node) return null;
    const entry = byKey[node.type];
    if (!entry) return null;
    const ports = dir === "in" ? entry.inputs : entry.outputs;
    if (!ports.some((p) => p.id === ref.portId)) return null;
    // graph+byKey let chip/model outputs rotate toward the agent they feed
    return { ...portGeometry(node, entry, ref.portId, graph, byKey), color: entryStyles(entry).edge };
}

export default function Edges({
    graph,
    byKey,
    pending,
    selectedEdgeId,
    onSelect,
    onDelete,
}: {
    graph: WorkflowGraph;
    byKey: Record<string, CatalogEntry>;
    pending: PendingEdge | null;
    // the edge selected in the designer (mutually exclusive with node selection)
    selectedEdgeId: string | null;
    // stable designer callbacks: select sets selectedEdgeId + clears nodes;
    // delete dispatches the one-undo-step deleteEdge action
    onSelect: (id: string) => void;
    onDelete: (id: string) => void;
}) {
    const [hovered, setHovered] = useState<string | null>(null);

    // a pending drag may start from an input port — try both sides, then bow
    // the curve away from whichever side the anchor sits on
    const outAnchor = pending ? resolveEnd(graph, byKey, pending.from, "out") : null;
    const inAnchor = pending && !outAnchor ? resolveEnd(graph, byKey, pending.from, "in") : null;
    const tp = pending?.toWorldPoint;
    // the dragged end follows the cursor with no edge to exit along (zero normal)
    const cursor = tp ? { x: tp.x, y: tp.y, nx: 0, ny: 0 } : null;
    let pendingD: string | null = null;
    if (cursor && outAnchor) pendingD = curve(outAnchor, cursor).d;
    else if (cursor && inAnchor) pendingD = curve(cursor, inAnchor).d;

    return (
        <svg
            width={1}
            height={1}
            className={"absolute left-0 top-0 overflow-visible"}
            style={{ pointerEvents: "none" }}
        >
            {graph.edges.map((edge) => {
                const from = resolveEnd(graph, byKey, edge.from, "out");
                const to = resolveEnd(graph, byKey, edge.to, "in");
                if (!from || !to) return null;
                const { d, mx, my } = curve(from, to);
                return (
                    <EdgePath
                        key={edge.id}
                        id={edge.id}
                        d={d}
                        mx={mx}
                        my={my}
                        flow={edge.kind === "flow"}
                        color={from.color}
                        selected={selectedEdgeId === edge.id}
                        hovered={hovered === edge.id}
                        setHovered={setHovered}
                        onSelect={onSelect}
                        onDelete={onDelete}
                    />
                );
            })}

            {pendingD && (
                <path
                    d={pendingD}
                    fill={"none"}
                    stroke={"var(--foreground)"}
                    strokeWidth={1.5}
                    strokeDasharray={"6 4"}
                    opacity={0.5}
                />
            )}
        </svg>
    );
}
