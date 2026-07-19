import { NextResponse } from "next/server";
import { runDueWorkflows } from "@/lib/runner.server";
import { serviceAuthorized } from "@/lib/serviceAuth";

// Manual/backcompat tick trigger: production scheduling is the in-process
// scheduler (instrumentation.ts → lib/scheduler.server.ts); this route stays
// as a debug hook and rollback path (re-enable the Pi's systemd timer without
// a rebuild). Runs execute inline; the budget is RUN_TIMEOUT_MS in
// lib/runner.server.ts.
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    if (!process.env.CRON_SECRET)
        return new NextResponse("CRON_SECRET not configured", { status: 500 }); // never operate open
    if (!serviceAuthorized(request.headers.get("authorization")))
        return new NextResponse("Unauthorized", { status: 401 });
    return NextResponse.json(await runDueWorkflows());
}
