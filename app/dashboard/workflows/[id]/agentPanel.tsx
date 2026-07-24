"use client";

import { useRef, useState } from "react";
import AgentChat from "@/app/dashboard/(shell)/agentChat";
// type-only imports — compile-erased, safe in a client component
import type { AgentPrefs } from "@/app/dashboard/agentPrefs";
import type { OpenrouterModel } from "@/lib/openrouter.server";

// resize bounds: never narrower than the composer needs, never wider than most
// of the viewport (the canvas has to stay usable)
const MIN_WIDTH = 300;
const MAX_WIDTH_FRACTION = 0.6;

// the Saturn Agent chat docked beside the canvas. Width lives here (local
// state, deliberately never persisted — same call as the console panel's
// height) and the left edge drags it, mirroring console.tsx's pointer-capture
// gesture rotated 90°.
export default function AgentPanel({
    workflowId,
    models,
    prefs,
    onGraph,
    onClose,
}: {
    workflowId: string;
    models: OpenrouterModel[];
    prefs?: AgentPrefs;
    // a save_graph that targeted this workflow — the raw payload, unvalidated
    onGraph: (graph: unknown) => void;
    onClose: () => void;
}) {
    const [width, setWidth] = useState(400);
    const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

    return (
        <aside
            style={{ width }}
            className={"relative flex shrink-0 flex-col border-l border-foreground/15 bg-background"}
        >
            <div
                onPointerDown={(e) => {
                    resizeRef.current = { startX: e.clientX, startWidth: width };
                    e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                    const drag = resizeRef.current;
                    if (!drag) return;
                    const max = Math.round(window.innerWidth * MAX_WIDTH_FRACTION);
                    const next = drag.startWidth + drag.startX - e.clientX;
                    setWidth(Math.min(max, Math.max(MIN_WIDTH, next)));
                }}
                onPointerUp={() => (resizeRef.current = null)}
                onPointerCancel={() => (resizeRef.current = null)}
                aria-hidden
                className={
                    "absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none transition-colors hover:bg-foreground/20 active:bg-foreground/20"
                }
            />
            <div
                className={
                    "flex items-center gap-4 border-b border-foreground/15 px-3 py-1.5 font-mono text-xs"
                }
            >
                <h2 className={"text-[10px] uppercase tracking-wider text-gray-400"}>agent</h2>
                <button
                    type={"button"}
                    onClick={onClose}
                    aria-label={"close agent"}
                    className={"ml-auto text-gray-400 transition-colors hover:text-foreground"}
                >
                    ×
                </button>
            </div>
            <div className={"min-h-0 flex-1 overflow-hidden"}>
                <AgentChat
                    panel
                    workflowId={workflowId}
                    models={models}
                    prefs={prefs}
                    onGraph={onGraph}
                />
            </div>
        </aside>
    );
}
