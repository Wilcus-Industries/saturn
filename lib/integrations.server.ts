// Server-side integration senders — the outbound network calls behind the
// interpreter's callIntegration hook. Config comes from graph jsonb and the
// public callIntegration server action, so everything here treats it as
// untrusted. Errors return as values (never throws) so consoles and run
// logs can render them.
import type { McpCallResult } from "@/lib/agent";
import { INTEGRATIONS_BY_ID } from "@/lib/integrations";

const MAX_INTEGRATION_MESSAGE = 4096; // mirrors MAX_TOOL_INPUT
const DISCORD_CONTENT_LIMIT = 2000; // Discord's hard cap on `content`
const SEND_TIMEOUT_MS = 15_000;

// userId is unused by webhook senders but threaded through so bot-token
// providers can resolve per-user secrets later
type SendFn = (
    userId: string,
    config: Record<string, string>,
    message: string,
) => Promise<McpCallResult>;

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
    if (!message.trim()) return { error: "message is empty" };
    const content =
        message.length > DISCORD_CONTENT_LIMIT
            ? `${message.slice(0, DISCORD_CONTENT_LIMIT - 1)}…`
            : message;
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 200);
        return { error: `discord webhook failed (${res.status})${body ? `: ${body}` : ""}` };
    }
    return { text: "sent" };
}

const SENDERS: Record<string, SendFn> = {
    "discord-webhook": sendDiscordWebhook,
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
    if (message.length > MAX_INTEGRATION_MESSAGE) {
        return { error: `message too long (max ${MAX_INTEGRATION_MESSAGE} chars)` };
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
