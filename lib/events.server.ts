// Inbound-event cores (subscription feed + validate/claim/execute), consumed
// by the in-process ingress transports: the Discord gateway
// (lib/gateway.server.ts) and the Telegram long-poller (lib/telegram.server.ts).
import { db } from "@/lib/db";
import { EXTENSION_EVENTS_BY_KEY } from "@/lib/integrations";
import { hasUnresolvedVariable, substituteVariables } from "@/lib/integrations.server";
import { variableIdFromNodeType, variableSentinel } from "@/lib/registry";
import { executeWorkflowRun, UUID } from "@/lib/runner.server";
import type { WorkflowGraph, WorkflowNode } from "@/lib/workflow";

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
    userId: string; // workflow owner; used by the webhook path's private-repo owner filter
    provider: string; // owning platform id: "discord" | "telegram" | "github"
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

// value-node types whose output resolves without running the graph
const STATIC_VALUE_TYPES = new Set(["string", "number", "literal"]);

// an event node's effective config: the stored literal per descriptor field,
// replaced by a statically-resolved value edge into the field's same-id port
// (variable node → its {{var:<uuid>}} sentinel, string/number/literal node →
// its config.value; any other source is dynamic and resolves to "" — event
// config is read before any run, mirroring resolveAgentModelSlug's
// conservatism). A connected edge always wins over the literal, even blank —
// same precedence as the interpreter's integration merge and the designer's
// dimmed-field UX.
function effectiveEventConfig(
    graph: WorkflowGraph,
    node: WorkflowNode,
    fieldIds: string[],
): Record<string, string> {
    const config: Record<string, string> = {};
    for (const fieldId of fieldIds) {
        let value = (node.config[fieldId] ?? "").trim();
        const edge = graph.edges.find(
            (e) => e.kind === "value" && e.to.nodeId === node.id && e.to.portId === fieldId,
        );
        if (edge) {
            const src = graph.nodes.find((n) => n.id === edge.from.nodeId);
            const varId = src ? variableIdFromNodeType(src.type) : null;
            if (varId !== null) value = variableSentinel(varId);
            else if (src && STATIC_VALUE_TYPES.has(src.type))
                value = (src.config.value ?? "").trim();
            else value = ""; // dynamic upstream — unresolvable pre-run
        }
        config[fieldId] = value;
    }
    return config;
}

// every active workflow's inbound-event nodes, normalized. No tier gating —
// `active` is the gate. Config values may be wired from variable/string nodes;
// variable sentinels resolve here, scoped to the workflow owner, so transports
// only ever see plaintext tokens.
export async function getEventSubscriptions(): Promise<EventSubscription[]> {
    // one jsonb-containment clause per known event type — active workflows
    // containing any of them. Webhook events have no transport (delivery is
    // HTTP-driven via app/api/hooks), so they're excluded here: their workflows
    // stay off the MAX_SUBSCRIPTIONS budget and out of every ingress poller.
    const eventTypes = Object.keys(EXTENSION_EVENTS_BY_KEY).filter(
        (t) => EXTENSION_EVENTS_BY_KEY[t].platform !== "webhook",
    );
    // no transport-backed events at all — nothing to subscribe (empty containment
    // would produce invalid SQL)
    if (!eventTypes.length) return [];
    const containment = eventTypes.map((_, i) => `graph->'nodes' @> $${i + 1}`).join(" or ");
    const { rows } = await db.query<{ id: string; user_id: string; graph: WorkflowGraph }>(
        `select id, user_id, graph from workflow
          where active and (${containment})
          limit ${MAX_SUBSCRIPTIONS}`,
        eventTypes.map((t) => JSON.stringify([{ type: t }])),
    );

    const subscriptions: EventSubscription[] = [];
    for (const wf of rows) {
        for (const node of wf.graph.nodes) {
            const event = EXTENSION_EVENTS_BY_KEY[node.type];
            if (!event || event.platform === "webhook") continue; // no transport for webhook events
            const merged = effectiveEventConfig(
                wf.graph,
                node,
                event.config.map((f) => f.id),
            );
            // resolve variable sentinels per workflow owner (no-query early
            // return when none); foreign/deleted uuids stay literal
            const { config: resolved } = await substituteVariables(wf.user_id, merged, "");
            // skip nodes whose required config is blank or still a sentinel
            // (deleted variable) — no transport can connect without a token
            if (
                event.requiredConfig.some(
                    (f) => !(resolved[f] ?? "").trim() || hasUnresolvedVariable(resolved[f]),
                )
            )
                continue;
            // descriptor-driven: botToken is the grouping key, every other
            // non-blank config field is a transport-interpreted filter. An
            // unresolved sentinel in an optional filter stays literal — it
            // matches nothing (restrictive), never broadens delivery.
            const config: Record<string, string> = {};
            for (const field of event.config) {
                const value = (resolved[field.id] ?? "").trim();
                if (value && field.id !== "botToken") config[field.id] = value;
            }
            subscriptions.push({
                workflowId: wf.id,
                nodeId: node.id,
                userId: wf.user_id,
                provider: event.platform,
                event: event.id,
                botToken: (resolved.botToken ?? "").trim(),
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
