// @ts-check
// saturn-events — the Discord event deliverer (successor to the retired
// saturn_admin Rust service). Runs as its own systemd unit on the Pi, next to
// the Next.js app:
//
//   - polls GET /api/event-subscriptions (bearer CRON_SECRET) every 60s for
//     the normalized inbound-event subscriptions of every active workflow,
//   - holds ONE Discord Gateway websocket per distinct bot token (multiple
//     workflows can share a bot; subscriptions are diffed by token value —
//     a fixed/rotated token arrives as a new map key and a fresh connection),
//   - on MESSAGE_CREATE: skips bot authors (loop guard), matches plain
//     @-mentions of the connected bot, applies each subscription's optional
//     guild/channel filters, and POSTs one /api/events call per match. The
//     server's 30s per-workflow cooldown drops mention bursts — no queueing
//     here.
//
// Fatal Gateway closes (4004 bad token, 4010-4013) permanently kill that
// token's connection until its value changes. 4014 (disallowed intents)
// retries once without the privileged MESSAGE_CONTENT intent — Discord still
// delivers full content on messages that mention the bot, so mention
// workflows keep working for bots that never enabled the intent.
//
// Run: CRON_SECRET=... [SATURN_BASE_URL=http://127.0.0.1:3000] node deliverer/deliverer.mjs
// Logs are single-line to stdout/stderr; journald adds timestamps.

import WebSocket from "ws";

const BASE_URL = process.env.SATURN_BASE_URL ?? "http://127.0.0.1:3000";
const CRON_SECRET = process.env.CRON_SECRET;
const POLL_INTERVAL_MS = 60_000;
const GATEWAY_URL = "wss://gateway.discord.gg";
const GATEWAY_QUERY = "/?v=10&encoding=json";
const INTENT_GUILD_MESSAGES = 1 << 9;
const INTENT_MESSAGE_CONTENT = 1 << 15; // privileged — see 4014 fallback
const MAX_EVENT_PAYLOAD = 16_384; // mirror of the /api/events ingress cap
const MAX_RECONNECT_DELAY_MS = 60_000;
// close codes where reconnecting can never help (bad token, sharding
// required, invalid version/intents) — give up on the token until it changes
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013]);

/**
 * @typedef {{ workflowId: string, nodeId: string, provider: string,
 *   event: string, botToken: string, guildId: string | null,
 *   channelId: string | null }} Sub
 */

/** Never log a full bot token — identify connections by their tail. */
const fp = (/** @type {string} */ token) => `…${token.slice(-4)}`;

/** @type {Map<string, BotConnection>} */
const connections = new Map();

class BotConnection {
    /** @param {string} token @param {Sub[]} subs */
    constructor(token, subs) {
        this.token = token;
        this.subs = subs;
        /** @type {WebSocket | null} */
        this.ws = null;
        /** @type {number | null} */
        this.seq = null;
        /** @type {string | null} */
        this.sessionId = null;
        /** @type {string | null} */
        this.resumeGatewayUrl = null;
        /** @type {string | null} */
        this.botUserId = null;
        /** @type {NodeJS.Timeout | null} */
        this.heartbeatTimer = null;
        /** @type {NodeJS.Timeout | null} */
        this.reconnectTimer = null;
        this.awaitingAck = false;
        this.reconnectDelay = 1_000;
        this.intents = INTENT_GUILD_MESSAGES | INTENT_MESSAGE_CONTENT;
        this.dead = false; // fatal close — never reconnect this token value
        this.destroyed = false;
        this.connect();
    }

    connect() {
        if (this.dead || this.destroyed) return;
        const base = this.resumeGatewayUrl ?? GATEWAY_URL;
        const ws = new WebSocket(base + GATEWAY_QUERY);
        this.ws = ws;
        ws.on("message", (data) => {
            let pkt;
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
            console.error(`[${fp(this.token)}] websocket error: ${err.message}`);
            ws.terminate(); // close handler drives the reconnect
        });
    }

    /** @param {{ op: number, d: any, s: number | null, t: string | null }} pkt */
    onPayload(pkt) {
        if (pkt.s !== null && pkt.s !== undefined) this.seq = pkt.s;
        switch (pkt.op) {
            case 10: {
                // HELLO — start heartbeating (first beat jittered per docs),
                // then resume if we have session state, else identify
                this.stopHeartbeat();
                const interval = pkt.d.heartbeat_interval;
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

    /** @param {string | null} t @param {any} d */
    onDispatch(t, d) {
        if (t === "READY") {
            this.sessionId = d.session_id;
            this.resumeGatewayUrl = d.resume_gateway_url ?? null;
            this.botUserId = d.user.id;
            this.reconnectDelay = 1_000;
            const mode = this.intents & INTENT_MESSAGE_CONTENT ? "" : " (no message-content intent)";
            console.log(
                `[${fp(this.token)}] connected as ${d.user.username} (${this.subs.length} subscription${this.subs.length === 1 ? "" : "s"})${mode}`,
            );
        } else if (t === "RESUMED") {
            this.reconnectDelay = 1_000;
            console.log(`[${fp(this.token)}] session resumed`);
        } else if (t === "MESSAGE_CREATE") {
            this.onMessage(d);
        }
    }

    beat() {
        if (this.awaitingAck) {
            // zombie connection — last heartbeat never ACKed; close handler
            // reconnects and resumes
            console.error(`[${fp(this.token)}] heartbeat not acked, reconnecting`);
            this.awaitingAck = false;
            this.ws?.terminate();
            return;
        }
        this.awaitingAck = true;
        this.send({ op: 1, d: this.seq });
    }

    /** @param {number} code */
    onClose(code) {
        this.stopHeartbeat();
        this.awaitingAck = false;
        this.ws = null;
        if (this.destroyed) return;
        if (code === 4014 && this.intents & INTENT_MESSAGE_CONTENT) {
            // privileged intent not enabled for this bot — mention messages
            // carry content regardless, so retry without it (fresh session)
            console.error(
                `[${fp(this.token)}] disallowed intents (4014) — retrying without message-content intent`,
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
            console.error(`[${fp(this.token)}] giving up: ${hint}`);
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

    /** @param {any} d MESSAGE_CREATE dispatch data */
    onMessage(d) {
        if (d.author?.bot) return; // loop guard: never react to bots (incl. self)
        if (!this.botUserId) return;
        // plain user @-mention of the bot (a reply with the ping toggle on also
        // lands in mentions; role/@everyone mentions deliberately don't count)
        if (!d.mentions?.some((/** @type {any} */ u) => u.id === this.botUserId)) return;
        for (const sub of this.subs) {
            if (sub.guildId && sub.guildId !== d.guild_id) continue;
            if (sub.channelId && sub.channelId !== d.channel_id) continue;
            // fire-and-forget: the ingress runs the workflow inline (up to ~4
            // min) — never block the ws message path on it
            this.postEvent(sub, d).catch((err) => {
                console.error(
                    `[${fp(this.token)}] event post failed for workflow ${sub.workflowId}: ${err.message}`,
                );
            });
        }
    }

    /** @param {Sub} sub @param {any} d */
    async postEvent(sub, d) {
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
            // ingress 400
            event.content = event.content.slice(0, 8_000);
            payload = JSON.stringify(event);
        }
        const res = await fetch(`${BASE_URL}/api/events`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${CRON_SECRET}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ workflowId: sub.workflowId, nodeId: sub.nodeId, payload }),
            signal: AbortSignal.timeout(300_000),
        });
        const body = await res.text();
        console.log(
            `[${fp(this.token)}] delivered to workflow ${sub.workflowId}: ${res.status} ${body.slice(0, 200)}`,
        );
    }

    /** @param {Record<string, unknown>} pkt */
    send(pkt) {
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
    /** @type {Sub[]} */
    let subs;
    try {
        const res = await fetch(`${BASE_URL}/api/event-subscriptions`, {
            headers: { authorization: `Bearer ${CRON_SECRET}` },
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        subs = await res.json();
    } catch (err) {
        // transient app unavailability (e.g. mid-deploy) must not tear down
        // live Gateway sessions — keep the current connection set
        console.error(`subscription poll failed: ${/** @type {Error} */ (err).message}`);
        return;
    }

    /** @type {Map<string, Sub[]>} */
    const byToken = new Map();
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
            console.log(`[${fp(token)}] no subscriptions left, disconnecting`);
            conn.destroy();
            connections.delete(token);
        }
    }
    for (const [token, list] of byToken) {
        if (!connections.has(token)) {
            console.log(`[${fp(token)}] opening gateway connection (${list.length} subscription${list.length === 1 ? "" : "s"})`);
            connections.set(token, new BotConnection(token, list));
        }
    }
}

function main() {
    if (!CRON_SECRET) {
        console.error("CRON_SECRET is not set — refusing to start");
        process.exit(1);
    }
    console.log(`saturn-events starting (app at ${BASE_URL}, poll every ${POLL_INTERVAL_MS / 1000}s)`);

    let stopped = false;
    /** @type {NodeJS.Timeout | null} */
    let pollTimer = null;
    const loop = async () => {
        await poll();
        if (!stopped) pollTimer = setTimeout(loop, POLL_INTERVAL_MS);
    };
    void loop();

    const shutdown = (/** @type {string} */ signal) => {
        console.log(`${signal} received, shutting down`);
        stopped = true;
        if (pollTimer) clearTimeout(pollTimer);
        for (const conn of connections.values()) conn.destroy();
        connections.clear();
        process.exit(0);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}

main();
