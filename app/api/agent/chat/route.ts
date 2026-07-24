// Session-authed streaming chat for the Agent page. Pumps runAgentChat's
// NDJSON deltas ({"t":"r|c|e","d":…}\n) to the browser as they arrive. Not the
// MCP/bearer surface — this is the logged-in dashboard user's own session.
import { type ChatMessage, runAgentChat } from "@/lib/agentChat.server";
import { getSessionCached } from "@/lib/subscription";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
    // browser session, not MCP bearer — return a clean 401 (requireUser would
    // redirect, which a fetch() caller can't follow sensibly)
    const session = await getSessionCached();
    if (!session?.user) return Response.json({ error: "unauthorized" }, { status: 401 });

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "bad request" }, { status: 400 });
    }
    const b = (body ?? {}) as { model?: unknown; reasoning?: unknown; messages?: unknown };
    // shallow read — runAgentChat re-validates model/messages deeply
    const model = typeof b.model === "string" ? b.model : "";
    const reasoning = typeof b.reasoning === "string" ? b.reasoning : undefined;
    const messages = Array.isArray(b.messages) ? (b.messages as ChatMessage[]) : [];

    const userId = session.user.id;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                for await (const delta of runAgentChat(userId, {
                    model,
                    reasoning,
                    messages,
                    signal: request.signal, // client disconnect aborts the upstream call
                })) {
                    controller.enqueue(encoder.encode(`${JSON.stringify(delta)}\n`));
                }
            } catch {
                try {
                    controller.enqueue(encoder.encode(`${JSON.stringify({ t: "e", d: "stream failed" })}\n`));
                } catch {}
            } finally {
                try {
                    controller.close();
                } catch {}
            }
        },
    });

    return new Response(stream, {
        headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no", // don't let a proxy buffer the stream
        },
    });
}

export function GET(): Response {
    return new Response("method not allowed", { status: 405 });
}
