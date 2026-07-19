import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { EXTENSION_EVENTS_BY_KEY } from "@/lib/integrations";
import { serviceAuthorized } from "@/lib/serviceAuth";
import type { WorkflowGraph } from "@/lib/workflow";

export const dynamic = "force-dynamic";

const MAX_SUBSCRIPTIONS = 500;

// one normalized inbound-event subscription the saturn-events deliverer
// (deliverer/deliverer.mjs) consumes. botToken egress to the deliverer is by
// design — it holds the Gateway websocket the Next.js request lifecycle
// can't; guild/channel are optional filters.
type EventSubscription = {
    workflowId: string;
    nodeId: string;
    provider: string;
    event: string;
    botToken: string;
    guildId: string | null;
    channelId: string | null;
};

// Subscription feed for the saturn-events deliverer: every active workflow's
// inbound-event nodes, normalized. Bearer-authed with CRON_SECRET like the
// cron tick (the deliverer on the Pi is the only caller). It polls this, diffs
// by bot token, and maintains one Gateway connection per distinct token. No
// tier gating — `active` is the gate.
export async function GET(request: Request) {
    if (!process.env.CRON_SECRET)
        return new NextResponse("CRON_SECRET not configured", { status: 500 }); // never operate open
    if (!serviceAuthorized(request.headers.get("authorization")))
        return new NextResponse("Unauthorized", { status: 401 });

    // one jsonb-containment clause per known event type (only
    // event:discord-mentioned today) — active workflows containing any of them
    const eventTypes = Object.keys(EXTENSION_EVENTS_BY_KEY);
    const containment = eventTypes.map((_, i) => `graph->'nodes' @> $${i + 1}`).join(" or ");
    const { rows } = await db.query<{ id: string; graph: WorkflowGraph }>(
        `select id, graph from workflow
          where active and (${containment})
          limit ${MAX_SUBSCRIPTIONS}`,
        eventTypes.map((t) => JSON.stringify([{ type: t }])),
    );

    const subscriptions: EventSubscription[] = [];
    for (const wf of rows) {
        for (const node of wf.graph.nodes) {
            const event = EXTENSION_EVENTS_BY_KEY[node.type];
            if (!event) continue;
            // skip nodes missing required config — the Pi can't connect without
            // a bot token
            if (event.requiredConfig.some((f) => !(node.config[f] ?? "").trim())) continue;
            // discord-mentioned is the only event type today; its config holds
            // the bot token and optional guild/channel filters
            subscriptions.push({
                workflowId: wf.id,
                nodeId: node.id,
                provider: "discord",
                event: "mentioned",
                botToken: (node.config.botToken ?? "").trim(),
                guildId: (node.config.guildId ?? "").trim() || null,
                channelId: (node.config.channelId ?? "").trim() || null,
            });
        }
    }
    return NextResponse.json(subscriptions);
}
