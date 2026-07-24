"use client";

// The Saturn Agent conversation lives OUTSIDE React, in module state. The
// dashboard chat and the designer's docked panel are two different pages, so
// moving between them unmounts and remounts the chat — with the transcript and
// the fetch owned by the component, "open in designer" aborted the very turn it
// was handing over and shipped a frozen snapshot of it. Here the stream keeps
// running across the navigation and whichever chat is mounted renders it.
// Still non-persistent: module state dies with the tab, nothing is stored.

// one rendered turn. An assistant turn is an ordered part list, not two fixed
// strings: the server's tool loop interleaves reasoning → text → tool → more
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
let controller: AbortController | null = null;
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

// useSyncExternalStore server snapshots — the store is client-only, so SSR
// always renders the empty conversation (a fresh load has one anyway)
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

// one NDJSON frame → transcript edit. Every payload parse is guarded: a
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

export async function send(
    text: string,
    model: string,
    reasoning: string,
    workflowId?: string,
): Promise<void> {
    if (streaming) return;

    // transcript to POST — prior turns as plain {role, content}: only the text
    // parts travel, reasoning and tool calls are display-only (tool calls are
    // per-request ephemeral by design)
    const outgoing: { role: string; content: string }[] = [];
    for (const m of messages) {
        if (m.role === "user") {
            outgoing.push({ role: "user", content: m.content });
            continue;
        }
        const said = m.parts.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("");
        if (said) outgoing.push({ role: "assistant", content: said });
    }
    outgoing.push({ role: "user", content: text });

    messages = [...messages, { role: "user", content: text }, { role: "assistant", parts: [] }];
    streaming = true;
    emit();

    const ac = new AbortController();
    controller = ac;
    try {
        const res = await fetch("/api/agent/chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, reasoning, messages: outgoing, workflowId }),
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
                try {
                    const frame: { t?: unknown; d?: unknown } = JSON.parse(line);
                    if (typeof frame.t === "string" && typeof frame.d === "string") {
                        apply(frame.t, frame.d);
                    }
                } catch {
                    // a bad frame (or a consumer that threw on one) must never
                    // take the rest of the stream down with it
                }
            }
        }
    } catch (err) {
        // user-initiated stop is not an error
        if (!(err instanceof DOMException && err.name === "AbortError")) {
            patchLast((m) => void (m.error = "connection lost"));
        }
    } finally {
        streaming = false;
        controller = null;
        emit();
    }
}

export const stop = () => controller?.abort();
