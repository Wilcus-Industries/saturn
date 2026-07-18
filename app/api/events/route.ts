import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { EXTENSION_EVENTS_BY_KEY } from "@/lib/integrations";
import { executeWorkflowRun, UUID } from "@/lib/runner.server";
import { serviceAuthorized } from "@/lib/serviceAuth";
import type { WorkflowGraph } from "@/lib/workflow";

export const maxDuration = 300; // the run executes inline in this invocation
export const dynamic = "force-dynamic";

const MAX_NODE_ID = 128;
const MAX_EVENT_PAYLOAD = 16_384; // JSON payload string cap

// Real-time inbound-event ingress: saturn_admin's Discord Gateway client POSTs
// a matched mention here and the addressed event node's workflow runs
// immediately (trigger 'event'). Bearer-authed with CRON_SECRET like the cron
// tick — the Pi is the only caller. A per-workflow 30s cooldown, claimed on
// workflow.last_run_at (the same conditional-UPDATE idiom as the cron runner),
// drops mention bursts. The one-event-per-workflow rule means a mention
// workflow has no schedule node, so event and cron claims never fight over that
// column.
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
    if (typeof workflowId !== "string" || !UUID.test(workflowId))
        return NextResponse.json({ error: "invalid workflowId" }, { status: 400 });
    if (typeof nodeId !== "string" || !nodeId || nodeId.length > MAX_NODE_ID)
        return NextResponse.json({ error: "invalid nodeId" }, { status: 400 });
    if (typeof payload !== "string" || payload.length > MAX_EVENT_PAYLOAD)
        return NextResponse.json({ error: "invalid payload" }, { status: 400 });

    // authed service caller — no need to hide existence/state behind 404s
    const { rows } = await db.query<{
        id: string;
        user_id: string;
        graph: WorkflowGraph;
        active: boolean;
    }>("select id, user_id, graph, active from workflow where id = $1", [workflowId]);
    const wf = rows[0];
    if (!wf) return NextResponse.json({ ran: false, reason: "not found" });
    if (!wf.active) return NextResponse.json({ ran: false, reason: "inactive" });

    const node = wf.graph.nodes.find((n) => n.id === nodeId);
    if (!node || !EXTENSION_EVENTS_BY_KEY[node.type])
        return NextResponse.json({ ran: false, reason: "no such event node" });

    // per-workflow cooldown: atomic claim on last_run_at that re-checks active.
    // No row ⇒ still cooling down (or just deactivated) — drop the mention.
    const { rows: claimed } = await db.query<{ id: string }>(
        `update workflow set last_run_at = now()
          where id = $1
            and active
            and (last_run_at is null or last_run_at <= now() - interval '30 seconds')
          returning id`,
        [workflowId],
    );
    if (!claimed[0]) return NextResponse.json({ ran: false, reason: "cooldown" });

    const result = await executeWorkflowRun(
        { id: wf.id, user_id: wf.user_id, graph: wf.graph },
        { trigger: "event", entryNodeIds: [nodeId], eventPayloads: { [nodeId]: payload } },
    );
    return NextResponse.json({ ran: true, runId: result.runId, status: result.status });
}
