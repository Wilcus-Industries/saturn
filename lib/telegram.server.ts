// In-process Telegram Bot API long-poller, started from
// lib/background.server.ts on production server boot:
//
//   - reads the normalized inbound-event subscriptions straight from the DB
//     (lib/events.server.ts getEventSubscriptions, filtered to
//     provider === "telegram") every 60s, plus immediately (2s debounce) when
//     a workflow mutation pokes subscriptionsChanged(),
//   - holds ONE getUpdates loop per distinct bot token — Telegram allows only
//     a single getUpdates consumer per token, and multiple workflows can
//     share a bot; subscriptions are diffed by token value (a fixed/rotated
//     token arrives as a new map key and a fresh poller),
//   - on each delivered message: skips backlog older than 5 min (a first-ever
//     poller start must not replay up to 24h of old chatter; deploy restarts
//     lose nothing), applies each subscription's optional chatId filter, and
//     dispatches one ingestEvent call per match — every message runs (no
//     cooldown), so there is no queueing here. Bots never receive their own
//     (or other bots') messages via getUpdates, so no loop guard is needed.
//
// 401/404 responses (bad token) permanently kill that token's poller until
// its value changes. 409 Conflict (a webhook is set, or another getUpdates
// consumer is running) is external and healable — retry slowly with a hint,
// never auto-delete the webhook.
import {
    type EventSubscription,
    getEventSubscriptions,
    ingestEvent,
    MAX_EVENT_PAYLOAD,
    onSubscriptionsChanged,
} from "@/lib/events.server";

const POLL_INTERVAL_MS = 60_000;
const REFRESH_DEBOUNCE_MS = 2_000;
const LONG_POLL_S = 25; // getUpdates server-side hold
const FETCH_TIMEOUT_MS = 35_000; // client-side safety net: LONG_POLL_S + 10s
const MAX_BACKOFF_MS = 60_000;
const SKIP_OLDER_THAN_S = 300; // ignore backlog messages older than 5 min

type TelegramChat = { id: number; type?: string; username?: string };
type TelegramUser = { id: number; username?: string; first_name?: string };
type TelegramMessage = {
    message_id: number;
    date: number; // unix seconds
    chat: TelegramChat;
    from?: TelegramUser;
    text?: string;
    caption?: string;
};
type TelegramUpdate = { update_id: number; message?: TelegramMessage };

/** Never log a full bot token — identify pollers by their tail. */
const fp = (token: string) => `…${token.slice(-4)}`;

const pollers = new Map<string, TelegramPoller>();
let pollTimer: NodeJS.Timeout | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;
let stopped = false;

class TelegramPoller {
    token: string;
    subs: EventSubscription[];
    offset: number | null = null;
    abort: AbortController | null = null;
    sleepTimer: NodeJS.Timeout | null = null;
    wakeSleep: (() => void) | null = null;
    backoffMs = 1_000;
    dead = false; // 401/404 — never poll this token value again
    destroyed = false;

    constructor(token: string, subs: EventSubscription[]) {
        this.token = token;
        this.subs = subs;
        void this.loop();
    }

    async loop() {
        while (!this.destroyed && !this.dead) {
            let res: Response;
            let bodyText: string;
            try {
                this.abort = new AbortController();
                // manual timeout so destroy() can also abort the same fetch
                const timeout = setTimeout(() => this.abort?.abort(), FETCH_TIMEOUT_MS);
                try {
                    res = await fetch(`https://api.telegram.org/bot${this.token}/getUpdates`, {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        body: JSON.stringify({
                            timeout: LONG_POLL_S,
                            allowed_updates: ["message"],
                            ...(this.offset !== null ? { offset: this.offset } : {}),
                        }),
                        signal: this.abort.signal,
                    });
                    bodyText = await res.text();
                } finally {
                    clearTimeout(timeout);
                    this.abort = null;
                }
            } catch {
                // destroy() abort or network failure — backoff (the while
                // condition handles the destroyed case)
                await this.backoff();
                continue;
            }

            if (res.status === 401 || res.status === 404) {
                this.dead = true;
                console.error(
                    `[telegram ${fp(this.token)}] giving up: authentication failed — check the bot token (from @BotFather)`,
                );
                return;
            }
            if (res.status === 409) {
                console.error(
                    `[telegram ${fp(this.token)}] conflict (409): another getUpdates consumer or a webhook is active for this bot — delete the webhook or stop the other poller`,
                );
                await this.sleep(MAX_BACKOFF_MS);
                continue;
            }
            let parsed: { ok?: boolean; result?: TelegramUpdate[]; parameters?: { retry_after?: number } };
            try {
                parsed = JSON.parse(bodyText);
            } catch {
                parsed = {};
            }
            if (res.status === 429) {
                const retryAfter = parsed.parameters?.retry_after;
                if (typeof retryAfter === "number" && retryAfter > 0) {
                    await this.sleep(Math.min(retryAfter * 1000, MAX_BACKOFF_MS));
                } else {
                    await this.backoff();
                }
                continue;
            }
            if (!res.ok || parsed.ok !== true || !Array.isArray(parsed.result)) {
                console.error(
                    `[telegram ${fp(this.token)}] getUpdates failed (${res.status}): ${bodyText.slice(0, 200)}`,
                );
                await this.backoff();
                continue;
            }

            this.backoffMs = 1_000;
            for (const update of parsed.result) {
                // offset is the ack — advance unconditionally, even for
                // skipped/filtered updates
                this.offset = update.update_id + 1;
                this.handleUpdate(update);
            }
        }
    }

    handleUpdate(update: TelegramUpdate) {
        const m = update.message;
        if (!m) return;
        // backlog guard — never replay old chatter after downtime
        if (Date.now() / 1000 - m.date > SKIP_OLDER_THAN_S) return;
        for (const sub of this.subs) {
            // chatId filter: numeric id or @channelusername
            if (
                sub.config.chatId &&
                sub.config.chatId !== String(m.chat.id) &&
                sub.config.chatId !== (m.chat.username ? `@${m.chat.username}` : "")
            ) {
                continue;
            }
            // fire-and-forget: the run executes inline (up to RUN_TIMEOUT_MS)
            // — never block the poll loop on it
            this.dispatch(sub, m).catch((err) => {
                console.error(
                    `[telegram ${fp(this.token)}] event dispatch failed for workflow ${sub.workflowId}: ${err.message}`,
                );
            });
        }
    }

    async dispatch(sub: EventSubscription, m: TelegramMessage) {
        // shape must mirror the telegram-message samplePayload in
        // lib/integrations.ts — it seeds designer test runs and the path picker
        const event = {
            text: m.text ?? m.caption ?? "",
            chatId: String(m.chat.id),
            chatType: m.chat.type ?? "",
            userId: m.from ? String(m.from.id) : "",
            username: m.from?.username ?? "",
            firstName: m.from?.first_name ?? "",
            messageId: String(m.message_id),
            date: new Date(m.date * 1000).toISOString(),
        };
        let payload = JSON.stringify(event);
        if (payload.length > MAX_EVENT_PAYLOAD) {
            // can't happen with Telegram's 4096-char message cap, but never
            // trip the ingest shape check
            event.text = event.text.slice(0, 8_000);
            payload = JSON.stringify(event);
        }
        const result = await ingestEvent({
            workflowId: sub.workflowId,
            nodeId: sub.nodeId,
            payload,
        });
        console.log(
            `[telegram ${fp(this.token)}] delivered to workflow ${sub.workflowId}: ${JSON.stringify(result).slice(0, 200)}`,
        );
    }

    // abortable sleep — destroy() resolves it early so the loop exits promptly
    sleep(ms: number) {
        return new Promise<void>((resolve) => {
            this.wakeSleep = resolve;
            this.sleepTimer = setTimeout(() => {
                this.sleepTimer = null;
                this.wakeSleep = null;
                resolve();
            }, ms);
        });
    }

    backoff() {
        const ms = this.backoffMs;
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
        return this.sleep(ms);
    }

    destroy() {
        this.destroyed = true;
        this.abort?.abort();
        if (this.sleepTimer) {
            clearTimeout(this.sleepTimer);
            this.sleepTimer = null;
        }
        this.wakeSleep?.();
        this.wakeSleep = null;
    }
}

async function poll() {
    let subs: EventSubscription[];
    try {
        subs = (await getEventSubscriptions()).filter((s) => s.provider === "telegram");
    } catch (err) {
        // transient DB unavailability must not tear down live pollers — keep
        // the current set
        console.error(`[telegram] subscription query failed: ${(err as Error).message}`);
        return;
    }

    const byToken = new Map<string, EventSubscription[]>();
    for (const sub of subs) {
        const list = byToken.get(sub.botToken);
        if (list) list.push(sub);
        else byToken.set(sub.botToken, [sub]);
    }

    for (const [token, poller] of pollers) {
        const wanted = byToken.get(token);
        if (wanted) {
            poller.subs = wanted; // loop survives filter/workflow edits
        } else {
            console.log(`[telegram ${fp(token)}] no subscriptions left, stopping poller`);
            poller.destroy();
            pollers.delete(token);
        }
    }
    for (const [token, list] of byToken) {
        if (!pollers.has(token)) {
            console.log(
                `[telegram ${fp(token)}] starting poller (${list.length} subscription${list.length === 1 ? "" : "s"})`,
            );
            pollers.set(token, new TelegramPoller(token, list));
        }
    }
}

export function startTelegram() {
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
    console.log(`[telegram] started (poll every ${POLL_INTERVAL_MS / 1000}s)`);
    void loop();
}

export function stopTelegram() {
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
    for (const poller of pollers.values()) poller.destroy();
    pollers.clear();
}
