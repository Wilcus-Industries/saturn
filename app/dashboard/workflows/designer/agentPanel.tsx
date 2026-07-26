"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import AgentChat from "@/app/dashboard/(shell)/agentChat";
import SessionPicker, { type SessionRow } from "@/app/dashboard/(shell)/agent/sessionPicker";
import { getSessionId, setSession, subscribe } from "@/app/dashboard/(shell)/agentChatStore";
import { call, useAsync } from "@/lib/ipc";
// type-only import — compile-erased, so the designer ⇄ panel import cycle
// exists only for the type checker, never at runtime
import type { OpenrouterModel } from "./designer";

// resize bounds: never narrower than the composer needs, never wider than most
// of the viewport (the canvas has to stay usable)
const MIN_WIDTH = 300;
const MAX_WIDTH_FRACTION = 0.6;

// module-level so it is stable for useAsync — nothing here depends on props
const loadSessions = () => call<SessionRow[]>("saturn_list_sessions");
// the store is client-only, so the prerendered HTML has no session
const noSession = () => "";

// the Saturn Agent chat docked beside the canvas. Width lives here (local
// state, deliberately never persisted — same call as the console panel's
// height) and the left edge drags it, mirroring console.tsx's pointer-capture
// gesture rotated 90°.
export default function AgentPanel({
    workflowId,
    models,
    onGraph,
    onClose,
}: {
    workflowId: string;
    // null = no OpenRouter key stored; the chat says so above its composer
    models: OpenrouterModel[] | null;
    // a save_graph that targeted this workflow — the raw payload, unvalidated
    onGraph: (graph: unknown) => void;
    onClose: () => void;
}) {
    const [width, setWidth] = useState(400);
    const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

    // the same ensure-a-session effect as (shell)/agent/page.tsx, because either
    // surface can be the first one a session is needed on (a hard reload lands
    // straight here with an empty module store). The `some(...)` guard is what
    // makes the handoff work: arriving mid-stream the session is already set, so
    // nothing calls setSession and the streaming transcript is left alone.
    const { data: sessions, reload } = useAsync(loadSessions);
    const sessionId = useSyncExternalStore(subscribe, getSessionId, noSession);
    useEffect(() => {
        if (!sessions) return;
        if (sessions.length === 0) {
            void call("saturn_create_session", { name: null }).then(reload);
            return;
        }
        if (sessions.some((s) => s.id === sessionId)) return;
        const saved = localStorage.getItem("saturnSession");
        void setSession(sessions.find((s) => s.id === saved)?.id ?? sessions[0].id);
    }, [sessions, sessionId, reload]);
    const ready = sessions && sessionId;

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
                {/* the wrapper carries ml-auto so the × stays pinned right while
                    the session list is still loading */}
                <div className={"ml-auto"}>
                    {ready && (
                        <SessionPicker
                            compact
                            sessions={sessions}
                            current={sessionId}
                            onPick={(id) => void setSession(id)}
                            onChanged={reload}
                        />
                    )}
                </div>
                <button
                    type={"button"}
                    onClick={onClose}
                    aria-label={"close agent"}
                    className={"text-gray-400 transition-colors hover:text-foreground"}
                >
                    ×
                </button>
            </div>
            <div className={"min-h-0 flex-1 overflow-hidden"}>
                {ready && (
                    <AgentChat panel workflowId={workflowId} models={models} onGraph={onGraph} />
                )}
            </div>
        </aside>
    );
}
