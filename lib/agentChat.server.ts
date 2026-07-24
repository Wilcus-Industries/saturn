// Server-only orchestrator for the Agent-page chat (app/dashboard/(shell)).
// A tool-free, non-persistent back-and-forth: validate the browser-built
// transcript, pick the funding key (platform credits then BYOK — shared with
// executeAgentTurn), stream OpenRouter, and meter platform-billed turns to the
// model_usage ledger. Yields NDJSON-ready deltas the route pumps to the client.
import { MAX_AGENT_MESSAGES, MODEL_ID, toReasoningParam } from "@/lib/agent";
import { streamChat } from "@/lib/agent.server";
import { recordUsage, selectModelApiKey } from "@/lib/credits.server";

const MAX_CHAT_MESSAGE = 24_000; // per-message char cap (mirrors output slice)

// brief placeholder persona — refined once the Agent gains tools/orchestration
const SATURN_SYSTEM =
    "You are Saturn Agent, a helpful assistant inside Saturn, a workflow-automation " +
    "tool where users build event-driven agent workflows on a node canvas. Be concise, " +
    "friendly, and practical. Use plain text (no markdown headers).";

export type ChatMessage = { role: "user" | "assistant"; content: string };
// NDJSON frame: r = reasoning (grey), c = content (white), e = error
type ChatDelta = { t: "r" | "c" | "e"; d: string };

type ChatRequest = {
    model: string;
    reasoning?: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
};

// shape-guard a browser-built transcript (untrusted server-side)
function validate(req: ChatRequest): string | null {
    if (typeof req.model !== "string" || !MODEL_ID.test(req.model)) return "invalid model id";
    if (!Array.isArray(req.messages) || req.messages.length === 0) return "no messages";
    if (req.messages.length > MAX_AGENT_MESSAGES) return "conversation too long";
    for (const m of req.messages) {
        if (!m || (m.role !== "user" && m.role !== "assistant")) return "invalid message role";
        if (typeof m.content !== "string" || m.content.length > MAX_CHAT_MESSAGE) {
            return "invalid message content";
        }
    }
    return null;
}

export async function* runAgentChat(
    userId: string,
    req: ChatRequest,
): AsyncGenerator<ChatDelta, void> {
    const bad = validate(req);
    if (bad) {
        yield { t: "e", d: bad };
        return;
    }

    const key = await selectModelApiKey(userId);
    if ("error" in key) {
        yield { t: "e", d: key.error };
        return;
    }

    const reasoning = toReasoningParam(req.reasoning);

    try {
        const it = streamChat(key.apiKey, {
            model: req.model,
            system: SATURN_SYSTEM,
            messages: req.messages,
            reasoning,
            signal: req.signal,
        });
        // manual iteration so the generator's return value (usage) survives
        while (true) {
            const step = await it.next();
            if (step.done) {
                if (key.platformBilled && step.value.usage) {
                    await recordUsage(userId, {
                        model: req.model,
                        ...step.value.usage,
                        source: "manual",
                    });
                }
                break;
            }
            const delta = step.value;
            yield "reasoning" in delta ? { t: "r", d: delta.reasoning } : { t: "c", d: delta.content };
        }
    } catch (err) {
        // an aborted stream is expected (client stopped) — stay quiet
        if (err instanceof Error && err.name === "AbortError") return;
        yield { t: "e", d: err instanceof Error ? err.message : "model call failed" };
    }
}
