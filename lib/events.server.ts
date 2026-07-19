// Inbound-event cores (subscription feed + validate/claim/execute), consumed
// by the in-process ingress transports: the Discord gateway
// (lib/gateway.server.ts) and the Telegram long-poller (lib/telegram.server.ts).
import { db } from "@/lib/db";
import { EXTENSION_EVENTS_BY_KEY } from "@/lib/integrations";
import { executeWorkflowRun, UUID } from "@/lib/runner.server";
import type { WorkflowGraph } from "@/lib/workflow";

const MAX_SUBSCRIPTIONS = 500;
const MAX_NODE_ID = 128;
export const MAX_EVENT_PAYLOAD = 16_384; // JSON payload string cap

// one normalized inbound-event subscription: everything a transport needs to
// hold a connection and route a delivery. Transports filter on `provider` and
// group connections by `botToken`; the remaining per-event config (optional
// filters like guildId/channelId/chatId) rides in `config`.
export type EventSubscription = {
    workflowId: string;
    nodeId: string;
    provider: string; // owning platform id: "discord" | "telegram"
    event: string; // ExtensionEvent id, e.g. "discord-mentioned"
    botToken: string; // connection-grouping key
    config: Record<string, string>; // non-blank trimmed config minus botToken
};

export type IngestResult = {
    ran: boolean;
    reason?: string;
    runId?: string | null;
    status?: string;
};

// every active workflow's inbound-event nodes, normalized. No tier gating —
// `active` is the gate.
export async function getEventSubscriptions(): Promise<EventSubscription[]> {
    // one jsonb-containment clause per known event type — active workflows
    // containing any of them
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
            // skip nodes missing required config — no transport can connect
            // without a bot token
            if (event.requiredConfig.some((f) => !(node.config[f] ?? "").trim())) continue;
            // descriptor-driven: botToken is the grouping key, every other
            // non-blank config field is a transport-interpreted filter
            const config: Record<string, string> = {};
            for (const field of event.config) {
                const value = (node.config[field.id] ?? "").trim();
                if (value && field.id !== "botToken") config[field.id] = value;
            }
            subscriptions.push({
                workflowId: wf.id,
                nodeId: node.id,
                provider: event.platform,
                event: event.id,
                botToken: (node.config.botToken ?? "").trim(),
                config,
            });
        }
    }
    return subscriptions;
}

// Run one delivered event: validate shape (the gateway builds payloads too —
// defense in depth), load the workflow, require a known event node, stamp
// last_run_at while atomically re-checking `active`, then execute. Every
// mention runs (no cooldown). The one-event-per-workflow rule means a mention
// workflow has no schedule node, so event and cron claims never fight over
// last_run_at.
export async function ingestEvent(input: {
    workflowId: unknown;
    nodeId: unknown;
    payload: unknown;
}): Promise<IngestResult | { error: string }> {
    const { workflowId, nodeId, payload } = input;
    if (typeof workflowId !== "string" || !UUID.test(workflowId))
        return { error: "invalid workflowId" };
    if (typeof nodeId !== "string" || !nodeId || nodeId.length > MAX_NODE_ID)
        return { error: "invalid nodeId" };
    if (typeof payload !== "string" || payload.length > MAX_EVENT_PAYLOAD)
        return { error: "invalid payload" };

    const { rows } = await db.query<{
        id: string;
        user_id: string;
        graph: WorkflowGraph;
        active: boolean;
    }>("select id, user_id, graph, active from workflow where id = $1", [workflowId]);
    const wf = rows[0];
    if (!wf) return { ran: false, reason: "not found" };
    if (!wf.active) return { ran: false, reason: "inactive" };

    const node = wf.graph.nodes.find((n) => n.id === nodeId);
    if (!node || !EXTENSION_EVENTS_BY_KEY[node.type])
        return { ran: false, reason: "no such event node" };

    // stamp last_run_at and atomically re-check active. No row ⇒ the workflow
    // was deactivated between the select above and now — drop the event.
    const { rows: claimed } = await db.query<{ id: string }>(
        `update workflow set last_run_at = now()
          where id = $1 and active
          returning id`,
        [workflowId],
    );
    if (!claimed[0]) return { ran: false, reason: "inactive" };

    const result = await executeWorkflowRun(
        { id: wf.id, user_id: wf.user_id, graph: wf.graph },
        { trigger: "event", entryNodeIds: [nodeId], eventPayloads: { [nodeId]: payload } },
    );
    return { ran: true, runId: result.runId, status: result.status };
}

// push-invalidation seam: workflow mutations poke the ingress transports to
// re-poll subscriptions without waiting out their 60s intervals. Plain
// callbacks keep `ws` (and the whole gateway module) out of server-action
// bundles.
const subscriptionsListeners = new Set<() => void>();

// register a listener; returns its unsubscriber
export function onSubscriptionsChanged(fn: () => void): () => void {
    subscriptionsListeners.add(fn);
    return () => subscriptionsListeners.delete(fn);
}

// fire-and-forget; no-op when no transport is running
export function subscriptionsChanged() {
    for (const fn of subscriptionsListeners) fn();
}
