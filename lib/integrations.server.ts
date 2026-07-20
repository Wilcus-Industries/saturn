// Server-side integration senders — the outbound network calls behind the
// interpreter's callIntegration hook. Config comes from graph jsonb and the
// public callIntegration server action, so everything here treats it as
// untrusted. Errors return as values (never throws) so consoles and run
// logs can render them.
import type { McpCallResult } from "@/lib/agent";
import { INTEGRATIONS_BY_ID } from "@/lib/integrations";

const MAX_INTEGRATION_MESSAGE = 4096; // text cap (matches Telegram's message limit)
const MAX_INTEGRATION_IMAGE = 4_194_304; // image data-URL cap (mirrors runner MAX_IMAGE_DATA_URL)
const DISCORD_CONTENT_LIMIT = 2000; // Discord's hard cap on `content`
const DISCORD_UPLOAD_LIMIT = 8_388_608; // 8 MiB — Discord free webhook attachment cap
const TELEGRAM_TEXT_LIMIT = 4096; // Telegram's sendMessage cap (== MAX_INTEGRATION_MESSAGE)
const TELEGRAM_UPLOAD_LIMIT = 10_485_760; // 10 MiB — Telegram photo upload cap
const SEND_TIMEOUT_MS = 15_000;

// SSRF guard analog of the Discord snowflake check: the token rides in the
// URL *path* (api.telegram.org/bot<token>/<method>), so a strict charset
// regex (no "/", "?", "#", "%") keeps untrusted config from shaping the
// fetch target. chat_id only ever travels in the JSON body / form field, but
// gets the same strictness: a numeric id (negative for groups, -100… for
// supergroups/channels) or a public @channelusername.
const TELEGRAM_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{25,64}$/;
const TELEGRAM_CHAT_ID = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;

// userId is unused by webhook senders but threaded through so bot-token
// providers can resolve per-user secrets later
type SendFn = (
    userId: string,
    config: Record<string, string>,
    message: string,
) => Promise<McpCallResult>;

// Shared Discord message POST — webhook execute URLs and the bot channel-messages
// API accept the identical content / files[0] shape. `label` prefixes error values.
async function postDiscordMessage(
    url: URL,
    headers: Record<string, string>,
    message: string,
    label: string,
): Promise<McpCallResult> {
    if (!message.trim()) return { error: "message is empty" };
    // Image data URL -> upload as a file attachment (multipart), not text content
    if (message.startsWith("data:image/")) {
        const marker = ";base64,";
        const markerIdx = message.indexOf(marker);
        if (markerIdx === -1) return { error: "unsupported image encoding (expected base64)" };

        const mime = message.slice(5, markerIdx); // "image/png" | "image/svg+xml"
        const b64 = message.slice(markerIdx + marker.length);
        const bytes = Buffer.from(b64, "base64"); // never throws
        if (bytes.length === 0) return { error: "image data is empty" };
        if (bytes.length > DISCORD_UPLOAD_LIMIT) {
            return { error: `image too large (max ${DISCORD_UPLOAD_LIMIT} bytes)` };
        }

        const subtype = mime.split("/")[1] ?? "png";
        const ext = (subtype.split("+")[0] || "png").toLowerCase(); // svg+xml -> svg
        const form = new FormData();
        form.append("files[0]", new Blob([bytes], { type: mime }), `image.${ext}`);

        const imgRes = await fetch(url, {
            // no content-type header — fetch sets the multipart boundary
            method: "POST",
            headers,
            body: form,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (!imgRes.ok) {
            const body = (await imgRes.text().catch(() => "")).slice(0, 200);
            return { error: `${label} failed (${imgRes.status})${body ? `: ${body}` : ""}` };
        }
        return { text: "sent" };
    }
    const content =
        message.length > DISCORD_CONTENT_LIMIT
            ? `${message.slice(0, DISCORD_CONTENT_LIMIT - 1)}…`
            : message;
    const res = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        return { error: `${label} failed (${res.status})${body ? `: ${body}` : ""}` };
    }
    return { text: "sent" };
}

async function sendDiscordWebhook(
    _userId: string,
    config: Record<string, string>,
    message: string,
): Promise<McpCallResult> {
    // SSRF guard: the URL is untrusted, so only exact Discord webhook hosts
    // and the fixed webhook path may be fetched — never substring checks
    let url: URL;
    try {
        url = new URL((config.webhookUrl ?? "").trim());
    } catch {
        return { error: "invalid webhook url" };
    }
    if (
        url.protocol !== "https:" ||
        !["discord.com", "discordapp.com"].includes(url.hostname) ||
        !url.pathname.startsWith("/api/webhooks/")
    ) {
        return { error: "webhook url must look like https://discord.com/api/webhooks/…" };
    }
    return postDiscordMessage(url, {}, message, "discord webhook");
}

// shared bot-API config parse. The snowflake check doubles as the SSRF guard:
// bot-API URLs are a fixed base plus this digits-only id, so untrusted config
// never shapes the fetch target
function botChannelConfig(
    config: Record<string, string>,
): { botToken: string; channelId: string } | { error: string } {
    const botToken = (config.botToken ?? "").trim();
    const channelId = (config.channelId ?? "").trim();
    if (!botToken) return { error: "bot token is empty" };
    if (!/^\d{17,20}$/.test(channelId)) return { error: "channel id must be a numeric id" };
    return { botToken, channelId };
}

async function sendDiscordMessage(
    _userId: string,
    config: Record<string, string>,
    message: string,
): Promise<McpCallResult> {
    const bot = botChannelConfig(config);
    if ("error" in bot) return bot;
    const url = new URL(`https://discord.com/api/v10/channels/${bot.channelId}/messages`);
    return postDiscordMessage(url, { authorization: `Bot ${bot.botToken}` }, message, "discord send");
}

// GET the channel's recent history; the snowflake check in botChannelConfig is
// the SSRF guard (fixed URL base + digits-only id). Returns a compact
// chronological JSON array for the node's "messages" value output — Discord's
// raw newest-first objects are huge and extract/agent-hostile.
async function readDiscordMessages(
    _userId: string,
    config: Record<string, string>,
): Promise<McpCallResult> {
    const bot = botChannelConfig(config);
    if ("error" in bot) return bot;
    const n = Math.trunc(Number((config.count ?? "").trim()));
    const count = Number.isFinite(n) && n > 0 ? Math.min(100, n) : 20;
    const url = new URL(`https://discord.com/api/v10/channels/${bot.channelId}/messages`);
    url.searchParams.set("limit", String(count));
    const res = await fetch(url, {
        headers: { authorization: `Bot ${bot.botToken}` },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        return { error: `discord read failed (${res.status})${body ? `: ${body}` : ""}` };
    }
    const raw: unknown = await res.json().catch(() => null);
    if (!Array.isArray(raw)) return { error: "discord read failed: unexpected response" };
    const messages = raw.reverse().map((m) => {
        const msg = (m ?? {}) as Record<string, unknown>;
        const author = (msg.author ?? {}) as Record<string, unknown>;
        const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
        return {
            id: typeof msg.id === "string" ? msg.id : "",
            author: typeof author.username === "string" ? author.username : "",
            bot: author.bot === true,
            content: typeof msg.content === "string" ? msg.content : "",
            timestamp: typeof msg.timestamp === "string" ? msg.timestamp : "",
            attachments: attachments
                .map((a) => {
                    const att = (a ?? {}) as Record<string, unknown>;
                    return typeof att.url === "string" ? att.url : "";
                })
                .filter(Boolean),
        };
    });
    return { text: JSON.stringify(messages) };
}

async function sendDiscordTyping(
    _userId: string,
    config: Record<string, string>,
): Promise<McpCallResult> {
    const bot = botChannelConfig(config);
    if ("error" in bot) return bot;
    // Discord has no cancel-typing call — the indicator expires ~10s after the
    // last trigger (or when the bot sends a message), so "off" is a no-op
    if ((config.status ?? "on").trim() === "off") {
        return { text: "typing off (indicator expires on its own)" };
    }
    const res = await fetch(`https://discord.com/api/v10/channels/${bot.channelId}/typing`, {
        method: "POST",
        headers: { authorization: `Bot ${bot.botToken}` },
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        return { error: `discord typing failed (${res.status})${body ? `: ${body}` : ""}` };
    }
    return { text: "typing" };
}

// shared Telegram config parse; the regexes above double as the SSRF guard
function telegramConfig(
    config: Record<string, string>,
): { botToken: string; chatId: string } | { error: string } {
    const botToken = (config.botToken ?? "").trim();
    const chatId = (config.chatId ?? "").trim();
    if (!TELEGRAM_TOKEN.test(botToken)) return { error: "bot token must look like 123456:ABC…" };
    if (!TELEGRAM_CHAT_ID.test(chatId)) {
        return { error: "chat id must be a numeric id or @channelusername" };
    }
    return { botToken, chatId };
}

const telegramUrl = (botToken: string, method: string) =>
    new URL(`https://api.telegram.org/bot${botToken}/${method}`);

async function sendTelegramMessage(
    _userId: string,
    config: Record<string, string>,
    message: string,
): Promise<McpCallResult> {
    const bot = telegramConfig(config);
    if ("error" in bot) return bot;
    if (!message.trim()) return { error: "message is empty" };
    // Image data URL -> upload via sendPhoto (multipart), not text
    if (message.startsWith("data:image/")) {
        const marker = ";base64,";
        const markerIdx = message.indexOf(marker);
        if (markerIdx === -1) return { error: "unsupported image encoding (expected base64)" };

        const mime = message.slice(5, markerIdx); // "image/png" | "image/svg+xml"
        const b64 = message.slice(markerIdx + marker.length);
        const bytes = Buffer.from(b64, "base64"); // never throws
        if (bytes.length === 0) return { error: "image data is empty" };
        if (bytes.length > TELEGRAM_UPLOAD_LIMIT) {
            return { error: `image too large (max ${TELEGRAM_UPLOAD_LIMIT} bytes)` };
        }

        const subtype = mime.split("/")[1] ?? "png";
        const ext = (subtype.split("+")[0] || "png").toLowerCase(); // svg+xml -> svg
        const form = new FormData();
        form.append("chat_id", bot.chatId);
        form.append("photo", new Blob([bytes], { type: mime }), `image.${ext}`);

        const imgRes = await fetch(telegramUrl(bot.botToken, "sendPhoto"), {
            // no content-type header — fetch sets the multipart boundary
            method: "POST",
            body: form,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (!imgRes.ok) {
            const body = (await imgRes.text().catch(() => "")).slice(0, 200);
            return { error: `telegram send failed (${imgRes.status})${body ? `: ${body}` : ""}` };
        }
        return { text: "sent" };
    }
    const text =
        message.length > TELEGRAM_TEXT_LIMIT
            ? `${message.slice(0, TELEGRAM_TEXT_LIMIT - 1)}…`
            : message;
    const res = await fetch(telegramUrl(bot.botToken, "sendMessage"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: bot.chatId, text }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        return { error: `telegram send failed (${res.status})${body ? `: ${body}` : ""}` };
    }
    return { text: "sent" };
}

async function sendTelegramTyping(
    _userId: string,
    config: Record<string, string>,
): Promise<McpCallResult> {
    const bot = telegramConfig(config);
    if ("error" in bot) return bot;
    // Telegram has no cancel call — the indicator expires ~5s after
    // sendChatAction (or when the bot sends a message), so "off" is a no-op
    if ((config.status ?? "on").trim() === "off") {
        return { text: "typing off (indicator expires on its own)" };
    }
    const res = await fetch(telegramUrl(bot.botToken, "sendChatAction"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: bot.chatId, action: "typing" }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        return { error: `telegram typing failed (${res.status})${body ? `: ${body}` : ""}` };
    }
    return { text: "typing" };
}

const SENDERS: Record<string, SendFn> = {
    "discord-webhook": sendDiscordWebhook,
    "discord-send-message": sendDiscordMessage,
    "discord-read-messages": readDiscordMessages,
    "discord-typing": sendDiscordTyping,
    "telegram-send-message": sendTelegramMessage,
    "telegram-typing": sendTelegramTyping,
};

// executes one integration send for a workflow run (test, cron, or manual)
export async function executeIntegration(
    userId: string,
    providerId: string,
    config: Record<string, string>,
    message: string,
): Promise<McpCallResult> {
    const send = typeof providerId === "string" ? SENDERS[providerId] : undefined;
    if (!send || !INTEGRATIONS_BY_ID[providerId]) return { error: "unknown integration" };
    if (typeof message !== "string") return { error: "invalid message" };
    const isImage = message.startsWith("data:image/");
    const cap = isImage ? MAX_INTEGRATION_IMAGE : MAX_INTEGRATION_MESSAGE;
    if (message.length > cap) {
        return isImage
            ? { error: `image too large (max ${MAX_INTEGRATION_IMAGE} chars)` }
            : { error: `message too long (max ${MAX_INTEGRATION_MESSAGE} chars)` };
    }
    if (
        typeof config !== "object" ||
        config === null ||
        Array.isArray(config) ||
        Object.values(config).some((v) => typeof v !== "string")
    ) {
        return { error: "invalid config" };
    }
    try {
        return await send(userId, config, message);
    } catch (err) {
        return { error: err instanceof Error ? err.message : "integration send failed" };
    }
}
