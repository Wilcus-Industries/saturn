"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import AsciiSaturn from "@/app/(saturn)/asciiSaturn";
import type { OpenrouterModel } from "@/lib/openrouter.server";
import AgentComposer from "./agentComposer";

// one rendered turn. Assistant messages carry reasoning (grey) separately from
// content (white); either may be empty while streaming. `error` marks a failed
// turn (transport or model error) rendered as a faint red line.
type ChatMessage =
    | { role: "user"; content: string }
    | { role: "assistant"; reasoning: string; content: string; error?: string };

// hero exit duration — keep in sync with .agent-exit in globals.css. A timeout
// (not animationend) drives unmount so reduced-motion, where the animation is
// suppressed, still tears the hero down.
const HERO_EXIT_MS = 340;

export default function AgentChat({ models }: { models: OpenrouterModel[] }) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [streaming, setStreaming] = useState(false);
    // hero (ascii + greeting) is a centered overlay that plays agent-exit on the
    // first send, then unmounts — kept separate from `messages.length` so the
    // exit animation has a frame to run before the node leaves the tree
    const [heroVisible, setHeroVisible] = useState(true);
    const [heroExiting, setHeroExiting] = useState(false);
    const [toast, setToast] = useState<string | null>(null);

    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const notify = useCallback((text: string) => {
        if (toastTimer.current) clearTimeout(toastTimer.current);
        setToast(text);
        toastTimer.current = setTimeout(() => setToast(null), 3000);
    }, []);

    // stick to the bottom as deltas stream in
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages]);

    useEffect(
        () => () => {
            abortRef.current?.abort();
            if (toastTimer.current) clearTimeout(toastTimer.current);
        },
        [],
    );

    // mutate the trailing assistant message (the streaming target)
    const patchLast = useCallback((fn: (m: Extract<ChatMessage, { role: "assistant" }>) => void) => {
        setMessages((prev) => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last?.role === "assistant") {
                const copy = { ...last };
                fn(copy);
                next[next.length - 1] = copy;
            }
            return next;
        });
    }, []);

    const send = useCallback(
        async (text: string, model: string, reasoning: string) => {
            if (streaming) return;

            // transcript to POST — prior turns as plain {role, content} (reasoning
            // is display-only, never fed back), plus the new user message
            const outgoing = messages
                .filter((m) => m.role === "user" || m.content)
                .map((m) => ({ role: m.role, content: m.content }));
            outgoing.push({ role: "user", content: text });

            // first message: dismiss the hero with the exit animation
            if (messages.length === 0) {
                setHeroExiting(true);
                setTimeout(() => setHeroVisible(false), HERO_EXIT_MS);
            }

            setMessages((prev) => [
                ...prev,
                { role: "user", content: text },
                { role: "assistant", reasoning: "", content: "" },
            ]);
            setStreaming(true);

            const ac = new AbortController();
            abortRef.current = ac;
            try {
                const res = await fetch("/api/agent/chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ model, reasoning, messages: outgoing }),
                    signal: ac.signal,
                });
                if (!res.ok || !res.body) {
                    patchLast((m) => {
                        m.error = res.status === 401 ? "session expired — reload" : "request failed";
                    });
                    return;
                }
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buf = "";
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += decoder.decode(value, { stream: true });
                    let nl: number;
                    while ((nl = buf.indexOf("\n")) !== -1) {
                        const line = buf.slice(0, nl).trim();
                        buf = buf.slice(nl + 1);
                        if (!line) continue;
                        let d: { t: string; d: string };
                        try {
                            d = JSON.parse(line);
                        } catch {
                            continue;
                        }
                        if (d.t === "r") patchLast((m) => void (m.reasoning += d.d));
                        else if (d.t === "c") patchLast((m) => void (m.content += d.d));
                        else if (d.t === "e") patchLast((m) => void (m.error = d.d));
                    }
                }
            } catch (err) {
                // user-initiated stop is not an error
                if (!(err instanceof DOMException && err.name === "AbortError")) {
                    notify("connection lost");
                    patchLast((m) => {
                        if (!m.content && !m.reasoning) m.error = "connection lost";
                    });
                }
            } finally {
                setStreaming(false);
                abortRef.current = null;
            }
        },
        [messages, streaming, patchLast, notify],
    );

    const stop = useCallback(() => abortRef.current?.abort(), []);

    return (
        <div className={"flex min-h-[calc(100dvh-7.5rem)] flex-col md:min-h-[calc(100dvh-4rem)]"}>
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
                                    {m.reasoning && (
                                        <p
                                            className={
                                                "whitespace-pre-wrap break-words font-mono text-xs " +
                                                "leading-relaxed text-gray-400/80"
                                            }
                                        >
                                            {m.reasoning}
                                        </p>
                                    )}
                                    {m.content && (
                                        <p
                                            className={
                                                "whitespace-pre-wrap break-words font-mono text-sm " +
                                                "leading-relaxed text-foreground"
                                            }
                                        >
                                            {m.content}
                                        </p>
                                    )}
                                    {/* thinking… before any token arrives */}
                                    {!m.reasoning && !m.content && !m.error && streaming && (
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
                        <AsciiSaturn scale={2} sizeClass={"text-[min(9px,2vw)]"} noise={false} />
                        <div className={"flex flex-col items-center gap-2 text-center"}>
                            <h1 className={"font-mono text-2xl md:text-3xl"}>Say hello to Saturn Agent</h1>
                            <p className={"font-mono text-sm text-gray-400"}>
                                Ask about your workflows, runs, and memory — or just say hi.
                            </p>
                        </div>
                    </div>
                )}
            </div>

            <AgentComposer models={models} onSend={send} streaming={streaming} onStop={stop} />

            {toast && (
                <div
                    role={"status"}
                    className={
                        "pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 " +
                        "border border-foreground/20 bg-background px-3 py-1.5 font-mono text-xs " +
                        "text-foreground shadow-lg"
                    }
                >
                    {toast}
                </div>
            )}
        </div>
    );
}
