"use client";

// The Saturn Agent conversations live OUTSIDE React, in module state. Rust owns
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
//   4. It caches each visited session's transcript, its draft and whether it is
//      streaming, so nothing on screen decides whether a turn keeps rendering.
//
// KEYED BY SESSION, and that is the point. One `messages`/`streaming` pair for N
// sessions meant switching chats mid-turn dropped every remaining frame on the
// floor: the deltas stopped matching the visible id, the partial reply is in no
// database (Rust appends the assistant row once, after the turn), and switching
// back left `patchLast` staring at a `user` row it refuses to touch. A slot per
// session is what makes "the turn keeps running" true on screen and not just in
// Rust.
//
// The transcript itself is persistent — it lives in `saturn_message` and Rust
// appends to it. These are caches of one window each, not the record.

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
// `summary` is a compaction marker, not a turn: the rows it stands for are still
// above it in the transcript, and only the model's window skips them.
export type ChatMessage =
    | { role: "user"; content: string }
    | { role: "summary"; content: string }
    | { role: "assistant"; parts: Part[]; error?: string };

type Assistant = Extract<ChatMessage, { role: "assistant" }>;

/// One session's window. `messages` is replaced, never mutated in place — that is
/// what keeps `useSyncExternalStore` bailing out of renders for a chat that isn't
/// the one streaming.
type Slot = { messages: ChatMessage[]; streaming: boolean; draft: string };

// ponytail: one slot per session VISITED this process, never evicted — a stale
// slot for a deleted session is a few KB that nothing renders. Bound it if a
// session list ever gets big enough for that to matter.
const slots = new Map<string, Slot>();
// sessions whose turn landed while the user was reading a different chat — the
// switcher's green glyph, cleared the moment that chat is opened.
//
// ponytail: process-lifetime and never evicted, same looseness as `slots` — a
// deleted session's stale id is a string nothing renders. One gap by design:
// the store's `sessionId` stays set while the designer panel has the chat, so a
// turn finishing there reads as visited rather than going green.
const finished = new Set<string>();
let sessionId = "";
// workflow id the chat asked the designer to open, read once on arrival
let handoff: string | null = null;

function slot(id: string): Slot {
    let s = slots.get(id);
    if (!s) {
        s = { messages: [], streaming: false, draft: "" };
        slots.set(id, s);
    }
    return s;
}

const listeners = new Set<() => void>();
const graphListeners = new Set<(graph: unknown) => void>();
const emit = () => {
    for (const l of listeners) l();
};

export function subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
}

// useSyncExternalStore server snapshots — the store is client-only, so the
// prerendered HTML always shows the empty conversation (a fresh load has one anyway)
const EMPTY: ChatMessage[] = [];
export const serverMessages = (): ChatMessage[] => EMPTY;
export const serverStreaming = (): boolean => false;

export const getMessages = (): ChatMessage[] => slots.get(sessionId)?.messages ?? EMPTY;
export const getStreaming = (): boolean => slots.get(sessionId)?.streaming ?? false;
export const getSessionId = (): string => sessionId;

/// Every session with a turn in flight, space-joined — what the page's tab strip
/// puts a spinner on. A primitive, not an array, because `emit()` is global and
/// fires on every delta frame: a fresh array each call would fail
/// useSyncExternalStore's snapshot-identity check, and a cache to fix that is
/// more code than a join. Slot-only knowledge: a session never opened in this
/// window has no slot, so an `agent` node streaming into one reads as idle.
export const getRunning = (): string =>
    [...slots]
        .filter(([, s]) => s.streaming)
        .map(([id]) => id)
        .join(" ");

/// Every session holding a reply the user has not looked at yet, space-joined —
/// the switcher's third state. Primitive for the same reason `getRunning` is.
export const getFinished = (): string => [...finished].join(" ");

/// The unsent composer text, per session. Not part of the subscribed snapshot:
/// the textarea owns the value while it is mounted and this is only the copy that
/// outlives the mount, so writing it must not re-render the transcript.
export const getDraft = (): string => slots.get(sessionId)?.draft ?? "";
export const setDraft = (text: string) => {
    if (sessionId) slot(sessionId).draft = text;
};

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

// mutate the trailing assistant message of ONE session (the streaming target) —
// `id`, never "whichever chat is open", so a backgrounded turn keeps landing.
// `parts` is copied here so callers may splice it, never the array in prior state.
function patchLast(id: string, fn: (m: Assistant) => void) {
    const s = slots.get(id);
    if (!s) return;
    const last = s.messages[s.messages.length - 1];
    if (last?.role !== "assistant") return;
    const copy = { ...last, parts: last.parts.slice() };
    fn(copy);
    s.messages = [...s.messages.slice(0, -1), copy];
    emit();
}

// one `saturn-delta` frame → transcript edit. Same frame vocabulary the hosted
// NDJSON stream used, so this is unchanged. Every payload parse is guarded: a
// malformed frame is dropped, never thrown, so the stream survives it.
function apply(sid: string, t: string, d: string) {
    // Nested turns only (a `saturn-agent` node): nothing in this window called
    // `send()`, so the optimistic user+assistant echo never happened and every
    // later frame would have no assistant row to land in. This frame IS that
    // echo — and the only thing that lights the working indicator for a turn
    // the user started from Discord rather than the composer.
    if (t === "u") {
        const s = slots.get(sid);
        if (!s) return;
        s.messages = [...s.messages, { role: "user", content: d }, { role: "assistant", parts: [] }];
        s.streaming = true;
        emit();
        return;
    }
    if (t === "r" || t === "c") {
        const kind = t === "r" ? "reasoning" : "text";
        patchLast(sid, (m) => {
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
        patchLast(sid, (m) => void (m.error = d));
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
        patchLast(sid, (m) =>
            m.parts.push({
                kind: "tool",
                id,
                name: typeof p.name === "string" ? p.name : "tool",
                args: typeof p.args === "string" ? p.args : "",
                status: "run",
            }),
        );
    } else if (t === "te") {
        patchLast(sid, (m) => {
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
// by the dashboard ⇄ designer navigation, and while the user is reading a
// different chat entirely. Frames are routed to their OWN session's slot; the
// having-a-slot test is what stops a `saturn-agent` node run materializing a
// chat the user never opened.
//
// The window guard is for the static export's prerender pass, which evaluates
// this module in Node — Tauri's `listen` reaches for `window` at import.
if (typeof window !== "undefined") {
    void onEvent<{ sessionId?: string; t?: string; d?: string }>("saturn-delta", (f) => {
        const id = f.sessionId;
        if (typeof id !== "string" || !slots.has(id)) return;
        if (typeof f.t === "string" && typeof f.d === "string") apply(id, f.t, f.d);
    });
    void onEvent<{ sessionId?: string }>("saturn-done", (f) => {
        const id = f.sessionId;
        if (typeof id !== "string") return;
        const s = slots.get(id);
        if (!s) return;
        s.streaming = false;
        // the chat being read when the reply lands is already visited, so it
        // never goes green — only a backgrounded one does
        if (id !== sessionId) finished.add(id);
        emit();
        // the record is authoritative once the turn is over, and it is where a
        // compaction summary appears — the turn loop wrote it, nothing streamed
        // it. NOT after a failure: `error` is set from the `e` frame and never
        // persisted, so refetching would silently wipe the red line off a turn
        // the user needs to see failed
        const last = s.messages[s.messages.length - 1];
        if (last?.role === "assistant" && last.error) return;
        void reload(id);
    });
}

/// Pull the stored transcript over the cached one, without blanking first.
/// Called on arrival and again after every turn: compaction happens server-side
/// between turns and appends a summary row nothing streams, so without this the
/// divider would not show up until the next session switch.
async function reload(id: string): Promise<void> {
    const stored = await call<{ role: string; content: string; parts: Part[] }[]>(
        "saturn_get_messages",
        { sessionId: id },
    );
    const s = slots.get(id);
    // a load landing mid-way into the NEXT turn must not wipe the reply already
    // streaming into it. Landing for a session the user has since switched away
    // from is fine now — that slot is still the one that session renders from.
    if (!s || s.streaming) return;
    s.messages = stored.map((m) =>
        m.role === "user" || m.role === "summary"
            ? { role: m.role, content: m.content }
            : { role: "assistant", parts: m.parts },
    );
    emit();
}

/// Switch the visible chat. Nothing is cleared: the slot the old session was
/// streaming into stays exactly where it is, still taking frames, and is on
/// screen again untouched the moment this is called with its id back.
export async function setSession(id: string): Promise<void> {
    sessionId = id;
    localStorage.setItem("saturnSession", id);
    slot(id);
    finished.delete(id); // opening it IS the visit that clears the green glyph
    emit();
    // `reload` no-ops on a slot mid-stream; every other slot may be stale (an
    // `agent` node writes into these rows too), so it is worth the one fetch
    await reload(id);
}

export async function send(
    text: string,
    model: string,
    reasoning: string,
    workflowId?: string,
): Promise<void> {
    // read once: the user may switch chats before the invoke resolves, and every
    // write below belongs to the session the message was typed in
    const id = sessionId;
    if (!id) return;
    const s = slot(id);
    if (s.streaming) return;

    // the user turn and the empty assistant the deltas will fill. Rust appends
    // both to `saturn_message` itself — this is the optimistic echo, not the record.
    s.messages = [...s.messages, { role: "user", content: text }, { role: "assistant", parts: [] }];
    s.streaming = true;
    emit();

    try {
        await call("saturn_send", { sessionId: id, model, reasoning, text, workflowId });
    } catch (err) {
        // the spawn itself failed, so no `saturn-done` is coming — clear here
        patchLast(id, (m) => void (m.error = err instanceof Error ? err.message : String(err)));
        s.streaming = false;
        emit();
    }
}

// cooperative — Rust unwinds the turn between socket reads and tool calls, then
// emits `saturn-done`, which is what actually clears `streaming`. Per session:
// two chats can stream at once, so a global stop would kill the wrong turn.
export const stop = () => callVoid("saturn_stop", { sessionId });
