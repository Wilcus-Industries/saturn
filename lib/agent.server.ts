// Server-only OpenRouter chat-completions client for agent workflow nodes.
// Plain fetch against the OpenAI-compatible API; tool definitions are built
// from the registry's stored MCP tool specs, and the wire-format function
// names never leave this module — tool calls are decoded back to
// {entryId, toolName} before returning (lib/agent.ts AgentToolCall).
import type { AgentMessage, AgentToolCall, AgentToolRef } from "@/lib/agent";
import type { McpToolParam } from "@/lib/workflow";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 60_000;
const MAX_COMPLETION_TOKENS = 8192;

export type AgentToolSpec = {
    ref: AgentToolRef;
    description?: string;
    params?: McpToolParam[];
};

type WireToolDef = {
    type: "function";
    function: { name: string; description?: string; parameters: object };
};

type WireToolCall = {
    id?: string;
    function?: { name?: string; arguments?: string };
};

// exported for the Agent-page chat orchestrator (lib/agentChat.server.ts),
// which builds its own tool transcripts against streamChat
export type WireMessage =
    | { role: "system" | "user"; content: string }
    | {
          role: "assistant";
          content: string;
          tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
      }
    | { role: "tool"; tool_call_id: string; content: string };

type Usage = { costUsd: number; promptTokens: number; completionTokens: number };

// narrow unknown to a plain object (not array/null) — used all over the
// defensive response parsing below
const asRecord = (x: unknown): Record<string, unknown> | null =>
    typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

// usage accounting from `usage: {include: true}`; a missing/odd usage object
// just means no ledger record
function parseUsage(rawUsage: Record<string, unknown> | null): Usage | undefined {
    if (typeof rawUsage?.cost !== "number") return undefined;
    return {
        costUsd: rawUsage.cost,
        promptTokens: typeof rawUsage.prompt_tokens === "number" ? rawUsage.prompt_tokens : 0,
        completionTokens: typeof rawUsage.completion_tokens === "number" ? rawUsage.completion_tokens : 0,
    };
}

// user-renderable error from a non-2xx OpenRouter response body
const modelError = (body: unknown, status: number): Error => {
    const err = asRecord(asRecord(body)?.error);
    const message = typeof err?.message === "string" ? err.message : `HTTP ${status}`;
    return new Error(`model call failed: ${message}`);
};

// {type:"object", properties, required} from the stored param spec; manual
// tools (no discovered params) accept any object
function toParameters(params: McpToolParam[] | undefined): object {
    if (!params?.length) return { type: "object" };
    const properties: Record<string, object> = {};
    for (const p of params) {
        properties[p.name] = {
            type: p.type,
            ...(p.description ? { description: p.description } : {}),
        };
    }
    return {
        type: "object",
        properties,
        required: params.filter((p) => p.required).map((p) => p.name),
    };
}

// deterministic wire-safe function names: sanitize the tool name, dedupe
// cross-server collisions with an entry-id prefix. Returns the decode map
// (wire name → ref) and the encode map (ref key → wire name) so assistant
// messages replayed from the client re-encode identically.
export function buildToolDefs(specs: AgentToolSpec[]): {
    defs: WireToolDef[];
    byWireName: Map<string, AgentToolRef>;
    wireNameOf: Map<string, string>; // "<entryId>:<toolName>" → wire name
} {
    const defs: WireToolDef[] = [];
    const byWireName = new Map<string, AgentToolRef>();
    const wireNameOf = new Map<string, string>();
    for (const spec of specs) {
        const base = spec.ref.toolName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
        let name = base;
        if (byWireName.has(name)) {
            name = `${spec.ref.entryId.slice(0, 8)}_${base}`.slice(0, 64);
        }
        if (byWireName.has(name)) continue; // same server+tool sent twice — skip dup
        byWireName.set(name, spec.ref);
        wireNameOf.set(`${spec.ref.entryId}:${spec.ref.toolName}`, name);
        defs.push({
            type: "function",
            function: {
                name,
                ...(spec.description ? { description: spec.description } : {}),
                parameters: toParameters(spec.params),
            },
        });
    }
    return { defs, byWireName, wireNameOf };
}

// one chat-completions turn. Throws Error with a user-renderable message on
// HTTP/decode failures or when the model calls a tool it wasn't given.
export async function chatComplete(
    apiKey: string,
    req: {
        model: string;
        system: string;
        messages: AgentMessage[];
        tools: AgentToolSpec[];
        outputImage?: boolean;
        reasoning?: { enabled: false } | { effort: string };
    },
): Promise<{
    content: string;
    toolCalls: AgentToolCall[];
    images: string[];
    // present when OpenRouter returned usage accounting; costUsd is the
    // amount charged to the key. Server-side only — never crosses to the
    // browser (AgentModelResult in lib/agent.ts stays usage-free).
    usage?: { costUsd: number; promptTokens: number; completionTokens: number };
}> {
    const { defs, byWireName, wireNameOf } = buildToolDefs(req.tools);

    const wire: WireMessage[] = [{ role: "system", content: req.system }];
    for (const m of req.messages) {
        if (m.role === "assistant") {
            wire.push({
                role: "assistant",
                content: m.content,
                ...(m.toolCalls?.length
                    ? {
                          tool_calls: m.toolCalls.map((c) => ({
                              id: c.id,
                              type: "function" as const,
                              function: {
                                  // grants can change between turns; a stale
                                  // replayed name still round-trips
                                  name:
                                      wireNameOf.get(`${c.entryId}:${c.toolName}`) ??
                                      c.toolName.replace(/[^a-zA-Z0-9_-]/g, "_"),
                                  arguments: c.arguments,
                              },
                          })),
                      }
                    : {}),
            });
        } else if (m.role === "tool") {
            wire.push({ role: "tool", tool_call_id: m.toolCallId, content: m.content });
        } else {
            wire.push({ role: "user", content: m.content });
        }
    }

    const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: req.model,
            messages: wire,
            max_tokens: MAX_COMPLETION_TOKENS,
            usage: { include: true }, // per-call cost for the credits ledger
            ...(defs.length ? { tools: defs } : {}),
            ...(req.outputImage ? { modalities: ["image", "text"] } : {}),
            ...(req.reasoning ? { reasoning: req.reasoning } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) throw modelError(body, res.status);

    const choices = asRecord(body)?.choices;
    const message = asRecord(Array.isArray(choices) ? asRecord(choices[0])?.message : null);
    if (!message) throw new Error("model call failed: malformed response");

    const content = typeof message.content === "string" ? message.content : "";
    // image-output models return generated images as data URLs on
    // message.images — keep only well-formed ones
    const images: string[] = [];
    if (Array.isArray(message.images)) {
        for (const raw of message.images as unknown[]) {
            const url = asRecord(asRecord(raw)?.image_url)?.url;
            if (typeof url === "string" && url.startsWith("data:image/")) images.push(url);
        }
    }
    const toolCalls: AgentToolCall[] = [];
    if (Array.isArray(message.tool_calls)) {
        for (const raw of message.tool_calls as WireToolCall[]) {
            const name = raw.function?.name ?? "";
            const ref = byWireName.get(name);
            if (!ref) throw new Error(`model requested unknown tool "${name}"`);
            toolCalls.push({
                id: raw.id || crypto.randomUUID(),
                entryId: ref.entryId,
                toolName: ref.toolName,
                arguments: raw.function?.arguments || "{}",
            });
        }
    }
    const usage = parseUsage(asRecord(asRecord(body)?.usage));
    return { content, toolCalls, images, ...(usage ? { usage } : {}) };
}

// streaming sibling of chatComplete for the Agent-page chat: surfaces
// reasoning tokens (which chatComplete discards) and takes wire-shaped
// messages + tool defs directly — the caller owns the multi-turn loop, tool
// dispatch, metering and key selection. Yields incremental { reasoning } /
// { content } deltas as they arrive and returns the final usage accounting
// (present when OpenRouter reported cost) plus any accumulated tool calls.
// Throws Error("model call failed: …") on a non-2xx response, same shape as
// chatComplete.
export async function* streamChat(
    apiKey: string,
    req: {
        model: string;
        system: string;
        messages: WireMessage[];
        tools?: WireToolDef[];
        reasoning?: { enabled: false } | { effort: string };
        signal?: AbortSignal;
    },
): AsyncGenerator<
    { reasoning: string } | { content: string },
    {
        usage?: { costUsd: number; promptTokens: number; completionTokens: number };
        toolCalls: { id: string; name: string; arguments: string }[];
    }
> {
    const wire: WireMessage[] = [{ role: "system", content: req.system }, ...req.messages];
    const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: req.model,
            messages: wire,
            max_tokens: MAX_COMPLETION_TOKENS,
            stream: true,
            usage: { include: true }, // rides the final SSE chunk for the ledger
            ...(req.tools?.length ? { tools: req.tools } : {}),
            ...(req.reasoning ? { reasoning: req.reasoning } : {}),
        }),
        signal: req.signal,
    });

    if (!res.ok || !res.body) {
        const body: unknown = await res.json().catch(() => null);
        throw modelError(body, res.status);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let usage: Usage | undefined;
    // tool calls arrive as fragments keyed by `index` — the provider splits the
    // arguments JSON across frames, so every field concatenates in arrival order
    const calls = new Map<number, { id: string; name: string; arguments: string }>();

    // SSE frames are newline-delimited; a chunk can split a line, so keep the
    // trailing partial in `buffer` and only parse complete lines.
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line || line.startsWith(":")) continue; // keep-alive comment
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let json: unknown;
            try {
                json = JSON.parse(data);
            } catch {
                continue; // partial/garbled frame — skip
            }
            const obj = asRecord(json);
            const choices = obj?.choices;
            const delta = asRecord(Array.isArray(choices) ? asRecord(choices[0])?.delta : null);
            if (delta) {
                if (typeof delta.reasoning === "string" && delta.reasoning) {
                    yield { reasoning: delta.reasoning };
                }
                if (typeof delta.content === "string" && delta.content) {
                    yield { content: delta.content };
                }
                if (Array.isArray(delta.tool_calls)) {
                    for (const raw of delta.tool_calls as unknown[]) {
                        const c = asRecord(raw);
                        if (!c) continue;
                        const index = typeof c.index === "number" ? c.index : 0;
                        const slot = calls.get(index) ?? { id: "", name: "", arguments: "" };
                        if (!slot.id && typeof c.id === "string") slot.id = c.id;
                        const fn = asRecord(c.function);
                        if (typeof fn?.name === "string") slot.name += fn.name;
                        if (typeof fn?.arguments === "string") slot.arguments += fn.arguments;
                        calls.set(index, slot);
                    }
                }
            }
            const parsed = parseUsage(asRecord(obj?.usage));
            if (parsed) usage = parsed;
        }
    }
    const toolCalls = [...calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, c]) => ({ ...c, id: c.id || crypto.randomUUID() }))
        .filter((c) => c.name);
    return { usage, toolCalls };
}
