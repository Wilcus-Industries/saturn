"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import AsciiSaturn from "@/app/dashboard/asciiSaturn";
import type { AgentPrefs } from "@/app/dashboard/agentPrefs";
import type { OpenrouterModel } from "@/lib/openrouter.server";
import AgentComposer from "./agentComposer";
// the transcript + the in-flight stream live in module state so they survive
// this component being unmounted by the dashboard → designer navigation
import {
    getMessages,
    getStreaming,
    onGraph as subscribeGraph,
    requestHandoff,
    send,
    serverMessages,
    serverStreaming,
    stop,
    subscribe,
    type ToolPart,
} from "./agentChatStore";

export type { ChatMessage, Part, ToolPart } from "./agentChatStore";

// hero exit duration — keep in sync with .agent-exit in globals.css. A timeout
// (not animationend) drives unmount so reduced-motion, where the animation is
// suppressed, still tears the hero down.
const HERO_EXIT_MS = 340;

// tool name's first token → what the row says while it happens. A literal map,
// not a parser: unknown prefixes just show the name with the underscores out.
const VERBS: Record<string, string> = {
    list: "listing",
    get: "reading",
    create: "creating",
    update: "updating",
    delete: "deleting",
    save: "saving",
    run: "running",
    validate: "validating",
    search: "searching",
    forget: "forgetting",
};
function toolLabel(name: string): string {
    const [head, ...rest] = name.split("_");
    const verb = VERBS[head];
    return verb ? `${verb} ${rest.join(" ")}`.trim() : name.replace(/_/g, " ");
}

const STATUS_WORD = { run: "running", ok: "done", err: "failed" } as const;

// tools carrying a workflow id — create_workflow returns one, the rest were
// called with one
const ARG_ID_TOOLS = new Set(["save_graph", "get_workflow", "update_workflow", "run_workflow"]);

function handoffId(p: ToolPart): string | null {
    if (p.status !== "ok") return null;
    const src = p.name === "create_workflow" ? p.result : ARG_ID_TOOLS.has(p.name) ? p.args : null;
    if (!src) return null;
    try {
        const id = (JSON.parse(src) as { id?: unknown }).id;
        return typeof id === "string" ? id : null;
    } catch {
        return null; // model-written JSON — unparseable just means no chip
    }
}

const pretty = (raw: string): string => {
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw; // args arrive mid-stream-truncated in pathological cases
    }
};

// one tool call — chrome sitting between the grey reasoning and the white
// answer, never content. The glyph carries the status (colour alone wouldn't);
// clicking expands the raw arguments + result.
function ToolRow({ part, onOpen }: { part: ToolPart; onOpen?: (id: string) => void }) {
    const [open, setOpen] = useState(false);
    const handoff = onOpen ? handoffId(part) : null;

    return (
        <div className={"flex flex-col items-start gap-1"}>
            <button
                type={"button"}
                aria-expanded={open}
                aria-label={`${toolLabel(part.name)} — ${STATUS_WORD[part.status]}`}
                onClick={() => setOpen((o) => !o)}
                className={
                    "flex cursor-pointer items-center gap-1.5 border border-foreground/15 " +
                    "px-2 py-0.5 font-mono text-xs text-gray-400/80 transition-colors " +
                    "hover:text-foreground"
                }
            >
                {part.status === "run" ? (
                    <span
                        aria-hidden
                        className={"h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-400"}
                    />
                ) : (
                    <span
                        aria-hidden
                        className={part.status === "ok" ? "text-green-400" : "text-red-400"}
                    >
                        {part.status === "ok" ? "✓" : "✗"}
                    </span>
                )}
                <span>{toolLabel(part.name)}</span>
            </button>

            {open && (
                <pre
                    className={
                        "max-h-60 w-full overflow-auto whitespace-pre-wrap break-words border " +
                        "border-foreground/15 p-2 font-mono text-[10px] leading-relaxed " +
                        "text-gray-400/80"
                    }
                >
                    {pretty(part.args)}
                    {part.result ? `\n\n${part.result}` : ""}
                </pre>
            )}

            {onOpen && handoff && (
                <button
                    type={"button"}
                    onClick={() => onOpen(handoff)}
                    className={
                        "cursor-pointer font-mono text-xs text-gray-400/80 underline " +
                        "underline-offset-2 transition-colors hover:text-foreground"
                    }
                >
                    open in designer →
                </button>
            )}
        </div>
    );
}

export default function AgentChat({
    models,
    prefs,
    workflowId,
    onGraph,
    panel,
}: {
    models: OpenrouterModel[];
    prefs?: AgentPrefs;
    workflowId?: string;
    onGraph?: (graph: unknown) => void;
    panel?: boolean;
}) {
    const messages = useSyncExternalStore(subscribe, getMessages, serverMessages);
    const streaming = useSyncExternalStore(subscribe, getStreaming, serverStreaming);
    // the hero (ascii + greeting) is a centered overlay dismissed by the first
    // message; `heroExiting` keeps it mounted for one exit animation past that
    const [heroExiting, setHeroExiting] = useState(false);
    const heroVisible = messages.length === 0 || heroExiting;

    const router = useRouter();
    const scrollRef = useRef<HTMLDivElement>(null);

    // stick to the bottom as deltas stream in
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages]);

    // a graph the agent saved lands on the canvas — but only when it is the
    // workflow this chat is docked to (the frame carries every save's id)
    useEffect(() => {
        if (!onGraph || !workflowId) return;
        return subscribeGraph((payload) => {
            const p = (payload ?? {}) as { id?: unknown; graph?: unknown };
            if (p.id === workflowId) onGraph(p.graph);
        });
    }, [onGraph, workflowId]);

    const handleSend = useCallback(
        (text: string, model: string, reasoning: string) => {
            // first message: dismiss the hero with the exit animation
            if (getMessages().length === 0) {
                setHeroExiting(true);
                setTimeout(() => setHeroExiting(false), HERO_EXIT_MS);
            }
            void send(text, model, reasoning, workflowId);
        },
        [workflowId],
    );

    // hand the conversation to the designer's panel and go there. The stream is
    // module-owned, so a turn still running keeps running across the navigation
    // and finishes in the panel. Never automatic — the chip is a click.
    const openInDesigner = useCallback(
        (id: string) => {
            requestHandoff(id);
            router.push(`/dashboard/workflows/${id}`);
        },
        [router],
    );


    return (
        <div
            className={
                panel
                    ? "flex h-full flex-col px-3"
                    : "flex min-h-[calc(100dvh-7.5rem)] flex-col md:min-h-[calc(100dvh-4rem)]"
            }
        >
            <div className={"relative flex-1 overflow-hidden"}>
                {/* message list — scrolls internally, composer stays pinned */}
                <div ref={scrollRef} className={"absolute inset-0 overflow-y-auto"}>
                    <div className={"mx-auto flex w-full max-w-2xl flex-col gap-6 py-6"}>
                        {messages.map((m, i) =>
                            m.role === "user" ? (
                                <div key={i} className={"flex justify-end"}>
                                    <div
                                        className={
                                            "message-enter max-w-[85%] whitespace-pre-wrap break-words " +
                                            "border border-foreground/15 bg-foreground/[0.04] px-3 py-2 " +
                                            "font-mono text-sm"
                                        }
                                    >
                                        {m.content}
                                    </div>
                                </div>
                            ) : (
                                <div key={i} className={"message-enter flex flex-col gap-1.5"}>
                                    {m.parts.map((p, j) =>
                                        p.kind === "tool" ? (
                                            <ToolRow
                                                key={j}
                                                part={p}
                                                onOpen={panel ? undefined : openInDesigner}
                                            />
                                        ) : (
                                            <p
                                                key={j}
                                                className={
                                                    "whitespace-pre-wrap break-words font-mono " +
                                                    "leading-relaxed " +
                                                    (p.kind === "reasoning"
                                                        ? "text-xs text-gray-400/80"
                                                        : "text-sm text-foreground")
                                                }
                                            >
                                                {p.text}
                                            </p>
                                        ),
                                    )}
                                    {/* thinking… before any token arrives */}
                                    {m.parts.length === 0 && !m.error && streaming && (
                                        <p className={"font-mono text-xs text-gray-400"}>
                                            <span className={"animate-pulse"}>thinking…</span>
                                        </p>
                                    )}
                                    {m.error && (
                                        <p className={"font-mono text-xs text-red-400/80"}>{m.error}</p>
                                    )}
                                </div>
                            ),
                        )}
                    </div>
                </div>

                {/* hero overlay — centered greeting + planet, dismissed on first send */}
                {heroVisible && (
                    <div
                        className={
                            "pointer-events-none absolute inset-0 -mt-4 flex flex-col items-center " +
                            "justify-center gap-8 md:-mt-8 " +
                            (heroExiting ? "agent-exit" : "agent-enter")
                        }
                    >
                        <AsciiSaturn
                            scale={2}
                            sizeClass={"text-[min(9px,2vw)]"}
                            noise={false}
                        />
                        <div className={"flex flex-col items-center gap-2 text-center"}>
                            <h1
                                className={
                                    "font-mono " + (panel ? "text-lg" : "text-2xl md:text-3xl")
                                }
                            >
                                Say hello to Saturn Agent
                            </h1>
                            <p className={"font-mono text-sm text-gray-400"}>
                                Ask about your workflows, runs, and memory — or just say hi.
                            </p>
                        </div>
                    </div>
                )}
            </div>

            <AgentComposer
                models={models}
                prefs={prefs}
                onSend={handleSend}
                streaming={streaming}
                onStop={stop}
            />
        </div>
    );
}
