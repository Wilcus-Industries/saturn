// Server-only orchestrator for the Agent-page chat (app/dashboard/(shell)).
// A non-persistent back-and-forth with a tool loop over Saturn's own MCP
// toolset: validate the browser-built transcript, pick the funding key
// (platform credits then BYOK — shared with executeAgentTurn), stream
// OpenRouter, run any requested tools through dispatchTool, and meter
// platform-billed turns to the model_usage ledger. Yields NDJSON-ready deltas
// the route pumps to the client.
import { TOOL_DEFS, dispatchTool, normalizeGraph } from "@/app/mcp/tools";
import {
    MAX_AGENT_MESSAGES,
    MAX_AGENT_TURNS,
    MAX_TOOL_CALLS_PER_TURN,
    MODEL_ID,
    toReasoningParam,
} from "@/lib/agent";
import { type WireMessage, streamChat } from "@/lib/agent.server";
import { recordUsage, selectModelApiKey } from "@/lib/credits.server";
import { UUID } from "@/lib/formActions.server";

const MAX_CHAT_MESSAGE = 24_000; // per-message char cap (mirrors output slice)
const MAX_TOOL_RESULT = 20_000; // fed back to the model
// ponytail: fixed slices, no token accounting — a long tool result eats context
// silently. Budget properly (or summarize) only if turns start truncating.
const MAX_TOOL_ARGS_FRAME = 2_000; // shown in the client's tool row
const MAX_TOOL_RESULT_FRAME = 4_000;

// the hosted MCP server's tools, verbatim — names are already wire-clean
// (snake_case ASCII), so no buildToolDefs-style mangling is needed. Built once:
// TOOL_DEFS is a static module constant, so whatever app/mcp/tools.ts grows is
// picked up automatically.
const CHAT_TOOLS = TOOL_DEFS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
}));

const SATURN_SYSTEM =
    "You are Saturn Agent, working inside Saturn — a workflow-automation tool where users " +
    "build event-driven agent workflows as node graphs on a canvas.\n" +
    "You have real tools over this user's own account: workflows (list/read/create/update/" +
    "delete, save + validate graphs, run them, read run history), memory stores and their " +
    "items, linux sandboxes, skills, variables, and a read view of their registry (MCP " +
    "servers, skills, variables, memory stores, sandboxes).\n" +
    "Hard rule: before you author or edit ANY workflow graph, call get_docs and get_catalog " +
    "first. Never guess the graph format or a node type — the catalog is the only source of " +
    "valid node keys, ports and config fields, and it differs per user.\n" +
    "Prefer validate_graph before save_graph, and fix reported errors rather than saving a " +
    "broken graph. Warnings are usually worth mentioning to the user.\n" +
    "Secret values (variable secrets, MCP auth tokens) are write-only: you can set them, " +
    "never read them. Never echo, guess or invent one.\n" +
    "Tools act on real data — deletes and runs have real side effects. When a request is " +
    "destructive or ambiguous, ask first.\n" +
    "Be concise and practical. The chat renders your text verbatim, so write plain text only " +
    "— no markdown at all (no **bold**, no # headings, no backticks); they show up as literal " +
    "characters.";

export type ChatMessage = { role: "user" | "assistant"; content: string };
// NDJSON frames: r = reasoning (grey), c = content (white), e = error,
// ts = tool start {id,name,args}, te = tool end {id,ok,result},
// g = {id, graph} the agent just saved — the client renders it only if its own
// designer has that workflow open
type ChatDelta = { t: "r" | "c" | "e" | "ts" | "te" | "g"; d: string };

type ChatRequest = {
    model: string;
    reasoning?: string;
    messages: ChatMessage[];
    workflowId?: string; // client hint: the workflow open in the designer
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
    // a hint, not content — a bogus one just means no live canvas updates
    if (req.workflowId !== undefined && !UUID.test(req.workflowId)) req.workflowId = undefined;
    return null;
}

// tool arguments arrive as a model-written JSON string; anything that isn't a
// plain object is a model error, reported back as a failed tool result
function parseArgs(raw: string): Record<string, unknown> | null {
    if (!raw.trim()) return {};
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
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
    const system = req.workflowId
        ? `${SATURN_SYSTEM}\nThe user has workflow ${req.workflowId} open in the designer right ` +
          `now — a save_graph on that id appears on their canvas immediately.`
        : SATURN_SYSTEM;
    const wire: WireMessage[] = req.messages.map((m) =>
        m.role === "assistant"
            ? { role: "assistant" as const, content: m.content }
            : { role: "user" as const, content: m.content },
    );

    try {
        for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
            const it = streamChat(key.apiKey, {
                model: req.model,
                system,
                messages: wire,
                tools: CHAT_TOOLS,
                reasoning,
                signal: req.signal,
            });
            let turnText = "";
            let toolCalls: { id: string; name: string; arguments: string }[] = [];
            // manual iteration so the generator's return value (usage + tool
            // calls) survives
            while (true) {
                const step = await it.next();
                if (step.done) {
                    // each turn is its own metered OpenRouter call
                    if (key.platformBilled && step.value.usage) {
                        await recordUsage(userId, {
                            model: req.model,
                            ...step.value.usage,
                            source: "manual",
                        });
                    }
                    toolCalls = step.value.toolCalls;
                    break;
                }
                const delta = step.value;
                if ("reasoning" in delta) {
                    yield { t: "r", d: delta.reasoning };
                } else {
                    turnText += delta.content;
                    yield { t: "c", d: delta.content };
                }
            }
            if (!toolCalls.length) return;

            wire.push({
                role: "assistant",
                content: turnText,
                tool_calls: toolCalls.map((c) => ({
                    id: c.id,
                    type: "function" as const,
                    function: { name: c.name, arguments: c.arguments },
                })),
            });

            // every call id must get a role:"tool" reply — a missing one makes
            // the next turn 400, so over-budget calls are answered, not skipped
            for (const [i, call] of toolCalls.entries()) {
                yield {
                    t: "ts",
                    d: JSON.stringify({
                        id: call.id,
                        name: call.name,
                        args: call.arguments.slice(0, MAX_TOOL_ARGS_FRAME),
                    }),
                };
                let okResult = false;
                let text: string;
                let args: Record<string, unknown> | null = null;
                if (i >= MAX_TOOL_CALLS_PER_TURN) {
                    text = "tool-call budget exceeded this turn";
                } else if (!(args = parseArgs(call.arguments))) {
                    text = "invalid tool arguments — expected a JSON object";
                } else {
                    try {
                        const res = await dispatchTool(userId, call.name, args);
                        if (!res) {
                            text = `unknown tool "${call.name}"`;
                        } else {
                            text = res.content.map((c) => c.text).join("\n");
                            okResult = !res.isError;
                        }
                    } catch (err) {
                        text = err instanceof Error ? err.message : "tool call failed";
                    }
                }
                wire.push({
                    role: "tool",
                    tool_call_id: call.id,
                    content: text.slice(0, MAX_TOOL_RESULT),
                });
                yield {
                    t: "te",
                    d: JSON.stringify({
                        id: call.id,
                        ok: okResult,
                        result: text.slice(0, MAX_TOOL_RESULT_FRAME),
                    }),
                };
                // hand a saved graph to a designer showing that workflow so the
                // canvas updates live. The STORED graph, not the model's JSON:
                // save_graph fills in / lays out the coordinates the model
                // almost always omits, and a coordinate-less graph fails the
                // canvas-side shape guard. Sent for every workflow — the id
                // rides along and the client keeps only its own, so a chat that
                // started on the dashboard still lands its next save after
                // "open in designer" moved it beside the canvas.
                if (okResult && call.name === "save_graph" && typeof args?.id === "string") {
                    const stored = await normalizeGraph(userId, args.graph);
                    if (stored) {
                        yield { t: "g", d: JSON.stringify({ id: args.id, graph: stored }) };
                    }
                }
            }
        }
        yield { t: "c", d: "\n[stopped: turn limit reached]" };
    } catch (err) {
        // an aborted stream is expected (client stopped) — stay quiet
        if (err instanceof Error && err.name === "AbortError") return;
        yield { t: "e", d: err instanceof Error ? err.message : "model call failed" };
    }
}
