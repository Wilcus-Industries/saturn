import { NextResponse } from "next/server";
import { ingestEvent } from "@/lib/events.server";
import { serviceAuthorized } from "@/lib/serviceAuth";

export const dynamic = "force-dynamic"; // the run executes inline; budget is RUN_TIMEOUT_MS

// Transitional real-time event ingress for the external saturn-events
// deliverer — event delivery now runs in-process (lib/gateway.server.ts calls
// ingestEvent directly). Kept one release as the rollback path. Bearer-authed
// with CRON_SECRET; all validation/claim/execution lives in
// lib/events.server.ts ingestEvent.
export async function POST(request: Request) {
    if (!process.env.CRON_SECRET)
        return new NextResponse("CRON_SECRET not configured", { status: 500 }); // never operate open
    if (!serviceAuthorized(request.headers.get("authorization")))
        return new NextResponse("Unauthorized", { status: 401 });

    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    if (typeof body !== "object" || body === null)
        return NextResponse.json({ error: "invalid body" }, { status: 400 });
    const { workflowId, nodeId, payload } = body as Record<string, unknown>;

    const result = await ingestEvent({ workflowId, nodeId, payload });
    if ("error" in result) return NextResponse.json(result, { status: 400 });
    return NextResponse.json(result);
}
