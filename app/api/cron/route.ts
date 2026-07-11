import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { runDueWorkflows } from "@/lib/runner.server";

export const maxDuration = 300; // runs execute inline in this invocation
export const dynamic = "force-dynamic";

function authorized(header: string | null): boolean {
    const secret = process.env.CRON_SECRET;
    if (!secret || !header) return false;
    const expected = Buffer.from(`Bearer ${secret}`);
    const got = Buffer.from(header);
    return got.length === expected.length && timingSafeEqual(got, expected);
}

export async function GET(request: Request) {
    if (!process.env.CRON_SECRET)
        return new NextResponse("CRON_SECRET not configured", { status: 500 }); // never operate open
    if (!authorized(request.headers.get("authorization")))
        return new NextResponse("Unauthorized", { status: 401 });
    return NextResponse.json(await runDueWorkflows());
}
