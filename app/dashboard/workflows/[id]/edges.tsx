"use client";

import { type Dispatch, memo, type SetStateAction, useState } from "react";
import {
    CATEGORY_STYLES,
    type CatalogEntry,
    type NodeCategory,
    type PortKind,
    type WorkflowGraph,
} from "@/lib/workflow";
import { portPosition } from "./geometry";
import type { GraphAction } from "./graphReducer";

// single SVG in world coordinates, mounted under the nodes. Endpoints come
// from geometry.ts only — never from DOM measurement.

export type PendingEdge = {
    from: { nodeId: string; portId: string };
    kind: PortKind;
    toWorldPoint: { x: number; y: number };
};

type PortRef = { nodeId: string; portId: string };
type End = { x: number; y: number; category: NodeCategory };

// horizontal cubic bezier between two port anchors
function bezier(x1: number, y1: number, x2: number, y2: number): string {
    const dx = Math.max(40, Math.abs(x2 - x1) / 2);
    return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

// memoized so a drag only re-renders edges whose `d` actually moved
// (setHovered/dispatch are stable state setters)
const EdgePath = memo(function EdgePath({
    id,
    d,
    flow,
    color,
    hovered,
    setHovered,
    dispatch,
}: {
    id: string;
    d: string;
    flow: boolean;
    color: string; // value-edge stroke, from the source node's category
    hovered: boolean;
    setHovered: Dispatch<SetStateAction<string | null>>;
    dispatch: Dispatch<GraphAction>;
}) {
    return (
        <g>
            <path
                d={d}
                fill={"none"}
                stroke={flow ? "var(--foreground)" : color}
                strokeWidth={flow ? (hovered ? 3.5 : 2) : hovered ? 3 : 1.5}
                strokeDasharray={flow ? undefined : "6 4"}
            />
            {/* invisible fat twin: hover + click-to-delete hit area */}
            <path
                d={d}
                fill={"none"}
                stroke={"transparent"}
                strokeWidth={12}
                style={{ pointerEvents: "stroke" }}
                className={"cursor-pointer"}
                onPointerDown={(e) => {
                    // keep the canvas from starting a pan — its pointer
                    // capture would retarget the click away from us
                    if (e.button === 0) e.stopPropagation();
                }}
                onClick={() => {
                    setHovered(null);
                    dispatch({ type: "deleteEdge", id });
                }}
                onPointerEnter={() => setHovered(id)}
                onPointerLeave={() => setHovered((h) => (h === id ? null : h))}
            />
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
    return { ...portPosition(node, entry, ref.portId), category: entry.category };
}

export default function Edges({
    graph,
    byKey,
    pending,
    dispatch,
}: {
    graph: WorkflowGraph;
    byKey: Record<string, CatalogEntry>;
    pending: PendingEdge | null;
    dispatch: Dispatch<GraphAction>;
}) {
    const [hovered, setHovered] = useState<string | null>(null);

    // a pending drag may start from an input port — try both sides, then bow
    // the curve away from whichever side the anchor sits on
    const outAnchor = pending ? resolveEnd(graph, byKey, pending.from, "out") : null;
    const inAnchor = pending && !outAnchor ? resolveEnd(graph, byKey, pending.from, "in") : null;
    const tp = pending?.toWorldPoint;
    let pendingD: string | null = null;
    if (tp && outAnchor) pendingD = bezier(outAnchor.x, outAnchor.y, tp.x, tp.y);
    else if (tp && inAnchor) pendingD = bezier(tp.x, tp.y, inAnchor.x, inAnchor.y);

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
                return (
                    <EdgePath
                        key={edge.id}
                        id={edge.id}
                        d={bezier(from.x, from.y, to.x, to.y)}
                        flow={edge.kind === "flow"}
                        color={CATEGORY_STYLES[from.category].edge}
                        hovered={hovered === edge.id}
                        setHovered={setHovered}
                        dispatch={dispatch}
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
