"use client";

// The Saturn Agent conversation lives OUTSIDE React, in module state. Rust owns
// the stream now — `saturn_send` spawns a thread that keeps writing whether or
// not a component is mounted — so this is no longer here to keep a fetch alive.
// It survives for four reasons:
//
//   1. It is the only sink a module-scope Tauri listener can write to. The
//      `saturn-delta` listeners are registered once for the life of the process
//      and never unlistened; they need somewhere to put frames that outlives
//      every mount.
//   2. It holds the handoff one-shot (`requestHandoff`/`takeHandoff`) across the
//      dashboard → designer navigation.
//   3. It fans the `g` frame out to whichever designer canvas is open.
//   4. It caches the transcript, so moving between the dashboard chat and the
//      docked panel doesn't refetch `saturn_get_messages` mid-stream.
//
// The transcript itself is persistent — it lives in `saturn_message` and Rust
// appends to it. This is a cache of one session's window, not the record.

import { call, callVoid, onEvent } from "@/lib/ipc";

// one rendered turn. An assistant turn is an ordered part list, not two fixed
// strings: the tool loop interleaves reasoning → text → tool → more
// reasoning across turns, and the parts preserve that order. `error` marks a
// failed turn (transport or model error) rendered as a faint red line.
export type ToolPart = {
    kind: "tool";
    id: string;
    name: string;
    args: string; // raw arguments JSON string as the model wrote it
    status: "run" | "ok" | "err";
    result?: string;
};
export type Part = { kind: "reasoning" | "text"; text: string } | ToolPart;
export type ChatMessage =
    | { role: "user"; content: string }
    | { role: "assistant"; parts: Part[]; error?: string };

type Assistant = Extract<ChatMessage, { role: "assistant" }>;

let messages: ChatMessage[] = [];
let streaming = false;
let sessionId = "";
// workflow id the chat asked the designer to open, read once on arrival
let handoff: string | null = null;

const listeners = new Set<() => void>();
const graphListeners = new Set<(graph: unknown) => void>();
const emit = () => {
    for (const l of listeners) l();
};

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}
export const getMessages = (): ChatMessage[] => messages;
export const getStreaming = (): boolean => streaming;
export const getSessionId = (): string => sessionId;

// useSyncExternalStore server snapshots — the store is client-only, so the
// prerendered HTML always shows the empty conversation (a fresh load has one anyway)
const EMPTY: ChatMessage[] = [];
export const serverMessages = (): ChatMessage[] => EMPTY;
export const serverStreaming = (): boolean => false;

// the designer panel adopts graphs the agent saves into the workflow it has open
export function onGraph(fn: (graph: unknown) => void): () => void {
    graphListeners.add(fn);
    return () => void graphListeners.delete(fn);
}

export const requestHandoff = (id: string) => void (handoff = id);
export function takeHandoff(id: string): boolean {
    if (handoff !== id) return false;
    handoff = null;
    return true;
}

// mutate the trailing assistant message (the streaming target). `parts` is
// copied here so callers may splice it, never the array in prior state.
function patchLast(fn: (m: Assistant) => void) {
    const last = messages[messages.length - 1];
    if (last?.role !== "assistant") return;
    const copy = { ...last, parts: last.parts.slice() };
    fn(copy);
    messages = [...messages.slice(0, -1), copy];
    emit();
}

// one `saturn-delta` frame → transcript edit. Same frame vocabulary the hosted
// NDJSON stream used, so this is unchanged. Every payload parse is guarded: a
// malformed frame is dropped, never thrown, so the stream survives it.
function apply(t: string, d: string) {
    if (t === "r" || t === "c") {
        const kind = t === "r" ? "reasoning" : "text";
        patchLast((m) => {
            const i = m.parts.length - 1;
            const last = m.parts[i];
            // grow the trailing part only when it is the same kind — a tool row
            // in between starts a fresh block, which is what keeps the turn's
            // interleave readable
            if (last && last.kind === kind) m.parts[i] = { kind, text: last.text + d };
            else m.parts.push({ kind, text: d });
        });
        return;
    }
    if (t === "e") {
        patchLast((m) => void (m.error = d));
        return;
    }
    let payload: unknown;
    try {
        payload = JSON.parse(d);
    } catch {
        return;
    }
    if (t === "g") {
        for (const l of graphListeners) l(payload);
        return;
    }
    const p = (payload ?? {}) as {
        id?: unknown;
        name?: unknown;
        args?: unknown;
        ok?: unknown;
        result?: unknown;
    };
    const id = p.id;
    if (typeof id !== "string") return;
    if (t === "ts") {
        patchLast((m) =>
            m.parts.push({
                kind: "tool",
                id,
                name: typeof p.name === "string" ? p.name : "tool",
                args: typeof p.args === "string" ? p.args : "",
                status: "run",
            }),
        );
    } else if (t === "te") {
        patchLast((m) => {
            const i = m.parts.findIndex((x) => x.kind === "tool" && x.id === id);
            if (i === -1) return;
            m.parts[i] = {
                ...(m.parts[i] as ToolPart),
                status: p.ok ? "ok" : "err",
                result: typeof p.result === "string" ? p.result : "",
            };
        });
    }
}

// Registered once, for the life of the process, and deliberately never
// unlistened: a turn started here must keep landing while the chat is unmounted
// by the dashboard ⇄ designer navigation. The sessionId filter is what stops a
// `saturn-agent` node run writing into whichever chat happens to be open.
//
// The window guard is for the static export's prerender pass, which evaluates
// this module in Node — Tauri's `listen` reaches for `window` at import.
if (typeof window !== "undefined") {
    void onEvent<{ sessionId?: string; t?: string; d?: string }>("saturn-delta", (f) => {
        if (f.sessionId !== sessionId) return;
        if (typeof f.t === "string" && typeof f.d === "string") apply(f.t, f.d);
    });
    void onEvent<{ sessionId?: string }>("saturn-done", (f) => {
        if (f.sessionId !== sessionId) return;
        streaming = false;
        emit();
    });
}

/// Switch the visible chat. Replaces the cached transcript with the stored one —
/// a session change mid-stream is possible, and the deltas for the old session
/// simply stop matching the filter.
export async function setSession(id: string): Promise<void> {
    sessionId = id;
    localStorage.setItem("saturnSession", id);
    messages = [];
    streaming = false;
    emit();
    const stored = await call<{ role: string; content: string; parts: Part[] }[]>(
        "saturn_get_messages",
        { sessionId: id },
    );
    // a slow load for a session the user already switched away from must not
    // overwrite the one now on screen
    if (sessionId !== id) return;
    messages = stored.map((m) =>
        m.role === "user"
            ? { role: "user", content: m.content }
            : { role: "assistant", parts: m.parts },
    );
    emit();
}

export async function send(
    text: string,
    model: string,
    reasoning: string,
    workflowId?: string,
): Promise<void> {
    if (streaming || !sessionId) return;

    // the user turn and the empty assistant the deltas will fill. Rust appends
    // both to `saturn_message` itself — this is the optimistic echo, not the record.
    messages = [...messages, { role: "user", content: text }, { role: "assistant", parts: [] }];
    streaming = true;
    emit();

    try {
        await call("saturn_send", { sessionId, model, reasoning, text, workflowId });
    } catch (err) {
        // the spawn itself failed, so no `saturn-done` is coming — clear here
        patchLast((m) => void (m.error = err instanceof Error ? err.message : String(err)));
        streaming = false;
        emit();
    }
}

// cooperative — Rust unwinds the turn between socket reads and tool calls, then
// emits `saturn-done`, which is what actually clears `streaming`
export const stop = () => callVoid("saturn_stop");
