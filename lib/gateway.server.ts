// In-process Discord Gateway listener, started from
// lib/background.server.ts on production server boot:
//
//   - reads the normalized inbound-event subscriptions straight from the DB
//     (lib/events.server.ts getEventSubscriptions) every 60s, plus immediately
//     (2s debounce) when a workflow mutation pokes subscriptionsChanged(),
//   - holds ONE Discord Gateway websocket per distinct bot token (multiple
//     workflows can share a bot; subscriptions are diffed by token value —
//     a fixed/rotated token arrives as a new map key and a fresh connection),
//   - on MESSAGE_CREATE: skips bot authors (loop guard), matches plain
//     @-mentions of the connected bot, applies each subscription's optional
//     guild/channel filters, and dispatches one ingestEvent call per match —
//     every mention runs (no cooldown), so there is no queueing here.
//
// Fatal Gateway closes (4004 bad token, 4010-4013) permanently kill that
// token's connection until its value changes. 4014 (disallowed intents)
// retries once without the privileged MESSAGE_CONTENT intent — Discord still
// delivers full content on messages that mention the bot, so mention
// workflows keep working for bots that never enabled the intent.
import WebSocket from "ws";
import {
    type EventSubscription,
    getEventSubscriptions,
    ingestEvent,
    MAX_EVENT_PAYLOAD,
    onSubscriptionsChanged,
} from "@/lib/events.server";

const POLL_INTERVAL_MS = 60_000;
const REFRESH_DEBOUNCE_MS = 2_000;
const GATEWAY_URL = "wss://gateway.discord.gg";
const GATEWAY_QUERY = "/?v=10&encoding=json";
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15; // privileged — see 4014 fallback
const MAX_RECONNECT_DELAY_MS = 60_000;
// close codes where reconnecting can never help (bad token, sharding
// required, invalid version/intents) — give up on the token until it changes
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013]);

type GatewayPacket = { op: number; d: unknown; s: number | null; t: string | null };

type DiscordUser = { id: string; username: string; bot?: boolean };
type ReadyData = {
    session_id: string;
    resume_gateway_url?: string | null;
    user: DiscordUser;
};
type MessageData = {
    id: string;
    content?: string;
    channel_id: string;
    guild_id?: string;
    timestamp: string;
    author: DiscordUser;
    mentions?: DiscordUser[];
};

/** Never log a full bot token — identify connections by their tail. */
const fp = (token: string) => `…${token.slice(-4)}`;

const connections = new Map<string, BotConnection>();
let pollTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;
let stopped = false;

class BotConnection {
    token: string;
    subs: EventSubscription[];
    ws: WebSocket | null = null;
    seq: number | null = null;
    sessionId: string | null = null;
    resumeGatewayUrl: string | null = null;
    botUserId: string | null = null;
    heartbeatTimer: NodeJS.Timeout | null = null;
    reconnectTimer: NodeJS.Timeout | null = null;
    awaitingAck = false;
    reconnectDelay = 1_000;
    intents = INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT;
    dead = false; // fatal close — never reconnect this token value
    destroyed = false;

    constructor(token: string, subs: EventSubscription[]) {
        this.token = token;
        this.subs = subs;
        this.connect();
    }

    connect() {
        if (this.dead || this.destroyed) return;
        const base = this.resumeGatewayUrl ?? GATEWAY_URL;
        const ws = new WebSocket(base + GATEWAY_QUERY);
        this.ws = ws;
        ws.on("message", (data) => {
            let pkt: GatewayPacket;
            try {
                pkt = JSON.parse(data.toString());
            } catch {
                return;
            }
            this.onPayload(pkt);
        });
        ws.on("close", (code) => {
            if (ws === this.ws) this.onClose(code);
        });
        ws.on("error", (err) => {
            console.error(`[gateway ${fp(this.token)}] websocket error: ${err.message}`);
            ws.terminate(); // close handler drives the reconnect
        });
    }

    onPayload(pkt: GatewayPacket) {
        if (pkt.s !== null && pkt.s !== undefined) this.seq = pkt.s;
        switch (pkt.op) {
            case 10: {
                // HELLO — start heartbeating (first beat jittered per docs),
                // then resume if we have session state, else identify
                this.stopHeartbeat();
                const interval = (pkt.d as { heartbeat_interval: number }).heartbeat_interval;
                this.heartbeatTimer = setTimeout(() => {
                    this.beat();
                    this.heartbeatTimer = setInterval(() => this.beat(), interval);
                }, interval * Math.random());
                if (this.sessionId && this.seq !== null) {
                    this.send({
                        op: 6,
                        d: { token: this.token, session_id: this.sessionId, seq: this.seq },
                    });
                } else {
                    this.send({
                        op: 2,
                        d: {
                            token: this.token,
                            intents: this.intents,
                            properties: { os: "linux", browser: "saturn", device: "saturn" },
                        },
                    });
                }
                break;
            }
            case 11: // HEARTBEAT ACK
                this.awaitingAck = false;
                break;
            case 1: // server requests an immediate heartbeat
                this.send({ op: 1, d: this.seq });
                break;
            case 7: // RECONNECT — close and resume
                this.ws?.terminate();
                break;
            case 9: // INVALID_SESSION — d=true means resumable; else start over
                if (pkt.d !== true) {
                    this.sessionId = null;
                    this.seq = null;
                    this.resumeGatewayUrl = null;
                }
                this.ws?.terminate();
                break;
            case 0:
                this.onDispatch(pkt.t, pkt.d);
                break;
        }
    }

    onDispatch(t: string | null, d: unknown) {
        if (t === "READY") {
            const ready = d as ReadyData;
            this.sessionId = ready.session_id;
            this.resumeGatewayUrl = ready.resume_gateway_url ?? null;
            this.botUserId = ready.user.id;
            this.reconnectDelay = 1_000;
            const mode = this.intents & INTENT_MESSAGE_CONTENT ? "" : " (no message-content intent)";
            console.log(
                `[gateway ${fp(this.token)}] connected as ${ready.user.username} (${this.subs.length} subscription${this.subs.length === 1 ? "" : "s"})${mode}`,
            );
        } else if (t === "RESUMED") {
            this.reconnectDelay = 1_000;
            console.log(`[gateway ${fp(this.token)}] session resumed`);
        } else if (t === "MESSAGE_CREATE") {
            this.onMessage(d as MessageData);
        }
    }

    beat() {
        if (this.awaitingAck) {
            // zombie connection — last heartbeat never ACKed; close handler
            // reconnects and resumes
            console.error(`[gateway ${fp(this.token)}] heartbeat not acked, reconnecting`);
            this.awaitingAck = false;
            this.ws?.terminate();
            return;
        }
        this.awaitingAck = true;
        this.send({ op: 1, d: this.seq });
    }

    onClose(code: number) {
        this.stopHeartbeat();
        this.awaitingAck = false;
        this.ws = null;
        if (this.destroyed) return;
        if (code === 4014 && this.intents & INTENT_MESSAGE_CONTENT) {
            // privileged intent not enabled for this bot — mention messages
            // carry content regardless, so retry without it (fresh session)
            console.error(
                `[gateway ${fp(this.token)}] disallowed intents (4014) — retrying without message-content intent`,
            );
            this.intents = INTENT_GUILD_MESSAGES;
            this.sessionId = null;
            this.seq = null;
            this.resumeGatewayUrl = null;
            this.scheduleReconnect();
            return;
        }
        if (FATAL_CLOSE_CODES.has(code) || code === 4014) {
            this.dead = true;
            const hint =
                code === 4004
                    ? "authentication failed — check the bot token"
                    : code === 4014
                      ? "disallowed intents — enable it for this bot at discord.com/developers"
                      : `fatal close code ${code}`;
            console.error(`[gateway ${fp(this.token)}] giving up: ${hint}`);
            return;
        }
        this.scheduleReconnect();
    }

    scheduleReconnect() {
        if (this.dead || this.destroyed || this.reconnectTimer) return;
        const delay = this.reconnectDelay;
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    onMessage(d: MessageData) {
        if (d.author?.bot) return; // loop guard: never react to bots (incl. self)
        if (!this.botUserId) return;
        // plain user @-mention of the bot (a reply with the ping toggle on also
        // lands in mentions; role/@everyone mentions deliberately don't count)
        if (!d.mentions?.some((u) => u.id === this.botUserId)) return;
        for (const sub of this.subs) {
            if (sub.config.guildId && sub.config.guildId !== d.guild_id) continue;
            if (sub.config.channelId && sub.config.channelId !== d.channel_id) continue;
            // fire-and-forget: the run executes inline (up to RUN_TIMEOUT_MS)
            // — never block the ws message path on it
            this.dispatch(sub, d).catch((err) => {
                console.error(
                    `[gateway ${fp(this.token)}] event dispatch failed for workflow ${sub.workflowId}: ${err.message}`,
                );
            });
        }
    }

    async dispatch(sub: EventSubscription, d: MessageData) {
        // shape must mirror the discord-mentioned samplePayload in
        // lib/integrations.ts — it seeds designer test runs and the path picker
        const event = {
            content: d.content ?? "",
            authorId: d.author.id,
            authorUsername: d.author.username,
            channelId: d.channel_id,
            guildId: d.guild_id ?? "",
            messageId: d.id,
            timestamp: d.timestamp,
        };
        let payload = JSON.stringify(event);
        if (payload.length > MAX_EVENT_PAYLOAD) {
            // can't happen with Discord's message caps, but never trip the
            // ingest shape check
            event.content = event.content.slice(0, 8_000);
            payload = JSON.stringify(event);
        }
        const result = await ingestEvent({
            workflowId: sub.workflowId,
            nodeId: sub.nodeId,
            payload,
        });
        console.log(
            `[gateway ${fp(this.token)}] delivered to workflow ${sub.workflowId}: ${JSON.stringify(result).slice(0, 200)}`,
        );
    }

    send(pkt: Record<string, unknown>) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(pkt));
    }

    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearTimeout(this.heartbeatTimer); // clears setInterval handles too
            this.heartbeatTimer = null;
        }
    }

    destroy() {
        this.destroyed = true;
        this.stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        // 1000 tells Discord to invalidate the session cleanly
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.close(1000);
        else this.ws?.terminate();
        this.ws = null;
    }
}

async function poll() {
    let subs: EventSubscription[];
    try {
        subs = (await getEventSubscriptions()).filter((s) => s.provider === "discord");
    } catch (err) {
        // transient DB unavailability must not tear down live Gateway
        // sessions — keep the current connection set
        console.error(`[gateway] subscription query failed: ${(err as Error).message}`);
        return;
    }

    const byToken = new Map<string, EventSubscription[]>();
    for (const sub of subs) {
        const list = byToken.get(sub.botToken);
        if (list) list.push(sub);
        else byToken.set(sub.botToken, [sub]);
    }

    for (const [token, conn] of connections) {
        const wanted = byToken.get(token);
        if (wanted) {
            conn.subs = wanted; // session survives filter/workflow edits
        } else {
            console.log(`[gateway ${fp(token)}] no subscriptions left, disconnecting`);
            conn.destroy();
            connections.delete(token);
        }
    }
    for (const [token, list] of byToken) {
        if (!connections.has(token)) {
            console.log(
                `[gateway ${fp(token)}] opening gateway connection (${list.length} subscription${list.length === 1 ? "" : "s"})`,
            );
            connections.set(token, new BotConnection(token, list));
        }
    }
}

export function startGateway() {
    stopped = false;
    // push invalidation from workflow mutations — debounced so designer
    // autosave bursts collapse to one re-poll
    unsubscribe = onSubscriptionsChanged(() => {
        if (stopped || refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            void poll();
        }, REFRESH_DEBOUNCE_MS);
    });
    // the interval poll stays as the reconciliation backstop
    const loop = async () => {
        await poll();
        if (!stopped) {
            pollTimer = setTimeout(loop, POLL_INTERVAL_MS);
            pollTimer.unref();
        }
    };
    console.log(`[gateway] started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
    void loop();
}

export function stopGateway() {
    stopped = true;
    unsubscribe?.();
    unsubscribe = null;
    if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
    }
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
    for (const conn of connections.values()) conn.destroy();
    connections.clear();
}
