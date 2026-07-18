import { NextResponse } from "next/server";
import { runDueWorkflows } from "@/lib/runner.server";
import { serviceAuthorized } from "@/lib/serviceAuth";

export const maxDuration = 300; // runs execute inline in this invocation
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
    if (!process.env.CRON_SECRET)
        return new NextResponse("CRON_SECRET not configured", { status: 500 }); // never operate open
    if (!serviceAuthorized(request.headers.get("authorization")))
        return new NextResponse("Unauthorized", { status: 401 });
    return NextResponse.json(await runDueWorkflows());
}
