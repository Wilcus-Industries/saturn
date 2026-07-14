// Server-side integration senders — the outbound network calls behind the
// interpreter's callIntegration hook. Config comes from graph jsonb and the
// public callIntegration server action, so everything here treats it as
// untrusted. Errors return as values (never throws) so consoles and run
// logs can render them.
import type { McpCallResult } from "@/lib/agent";
import { INTEGRATIONS_BY_ID } from "@/lib/integrations";

const MAX_INTEGRATION_MESSAGE = 4096; // text cap (mirrors MAX_TOOL_INPUT)
const MAX_INTEGRATION_IMAGE = 4_194_304; // image data-URL cap (mirrors runner MAX_IMAGE_DATA_URL)
const DISCORD_CONTENT_LIMIT = 2000; // Discord's hard cap on `content`
const DISCORD_UPLOAD_LIMIT = 8_388_608; // 8 MiB — Discord free webhook attachment cap
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
            body: form,
            signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (!imgRes.ok) {
            const body = (await imgRes.text().catch(() => "")).slice(0, 200);
            return { error: `discord webhook failed (${imgRes.status})${body ? `: ${body}` : ""}` };
        }
        return { text: "sent" };
    }
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
