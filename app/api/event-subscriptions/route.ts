import { NextResponse } from "next/server";
import { getEventSubscriptions } from "@/lib/events.server";
import { serviceAuthorized } from "@/lib/serviceAuth";

export const dynamic = "force-dynamic";

// Transitional subscription feed for the external saturn-events deliverer
// (deliverer/deliverer.mjs) — event delivery now runs in-process
// (lib/gateway.server.ts reads lib/events.server.ts directly). Kept one
// release as the rollback path: re-enabling the saturn-events unit restores
// external delivery with no rebuild. Bearer-authed with CRON_SECRET.
export async function GET(request: Request) {
    if (!process.env.CRON_SECRET)
        return new NextResponse("CRON_SECRET not configured", { status: 500 }); // never operate open
    if (!serviceAuthorized(request.headers.get("authorization")))
        return new NextResponse("Unauthorized", { status: 401 });
    return NextResponse.json(await getEventSubscriptions());
}
