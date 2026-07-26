"use client";

import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";

// The outer wrapper every node shape in node.tsx renders: absolutely positioned
// at the node's world coords, carrying the selection outline and the four
// pointer handlers that drive the drag gesture.
//
// It must stay BORDERLESS. Ports hang off this box, so geometry.ts's anchors are
// node.x/node.y exactly — a real `border` here would shift every marker inward
// by its width (see nodeFrame.tsx, which paints frames as an inset overlay).
//
// `className` carries whatever the branch paints itself (background, padding,
// the dimmed "(deleted)" state); the selection outline is appended here. Kept in
// its own file so node.tsx defines exactly one component — a second component in
// that module trips a React Compiler ref-analysis false-positive on memoized Node.
export default function BlockShell({
    nodeId,
    x,
    y,
    width,
    selected,
    className = "absolute font-mono text-xs",
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    children,
}: {
    nodeId: string;
    x: number;
    y: number;
    width: number;
    selected: boolean;
    className?: string;
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
    children: ReactNode;
}) {
    return (
        <div
            data-node-id={nodeId}
            style={{ left: x, top: y, width }}
            className={`${className} ${
                selected ? "outline outline-1 outline-foreground" : ""
            }`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
        >
            {children}
        </div>
    );
}

// The label strip under a circular/chip node: two 12px lines fill the h-6 strip
// exactly, so the shape's *_LABEL_H stays 24 and geometry is untouched. The full
// text always rides the title tooltip, since the visible text may be clamped (or
// shortened by the caller, like the model circle's author-less slug).
export function NodeLabel({ title, children }: { title: string; children: ReactNode }) {
    return (
        <span
            className={"line-clamp-2 max-w-full break-words text-center text-[10px] leading-3"}
            title={title}
        >
            {children}
        </span>
    );
}
