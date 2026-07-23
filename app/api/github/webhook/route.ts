// Central GitHub App webhook endpoint — thin HTTP shell. All translation,
// subscription matching, privacy filtering and dispatch live in
// lib/githubApp.server.ts. This handler only gates and authenticates:
//
//   env unset → 404 · oversized body → 413 · bad/missing HMAC signature → 401
//   (verified over the raw bytes BEFORE any JSON.parse) · missing event → 400 ·
//   ping → 200 · otherwise delegate.
//
// Zero outbound fetches: nothing payload-derived shapes a request. Never logs
// the secret or full payloads.
import { createHmac, timingSafeEqual } from "node:crypto";

import { githubWebhookConfigured, handleGithubDelivery } from "@/lib/githubApp.server";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB — GitHub caps payloads at ~25 MB, we need far less

const methodNotAllowed = () =>
    new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

export async function POST(req: Request): Promise<Response> {
    // 1. feature gate — unset secret means the app isn't registered; 404 so the
    // endpoint is indistinguishable from not existing (poller-only mode)
    if (!githubWebhookConfigured()) return new Response("Not Found", { status: 404 });
    const secret = process.env.GITHUB_WEBHOOK_SECRET as string;

    // 2. reject by declared size before reading the stream
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
        return new Response("Payload Too Large", { status: 413 });

    // 3. read raw body, re-check actual byte length (content-length can lie/absent)
    const rawBody = await req.text();
    if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES)
        return new Response("Payload Too Large", { status: 413 });

    // 4. verify signature over the raw bytes — BEFORE any JSON.parse
    if (!verifySignature(rawBody, secret, req.headers.get("x-hub-signature-256")))
        return new Response("Unauthorized", { status: 401 });

    // 5. event header + ping
    const event = req.headers.get("x-github-event");
    if (!event) return new Response("missing x-github-event", { status: 400 });
    if (event === "ping") return new Response("pong", { status: 200 });

    // 6. delegate authenticated delivery
    return handleGithubDelivery(event, req.headers.get("x-github-delivery") ?? "", rawBody);
}

// x-hub-signature-256: `sha256=<hex>` HMAC-SHA256 of the raw body under the
// shared secret. Length-checked timing-safe compare; any missing/malformed/
// mismatched signature fails closed.
function verifySignature(rawBody: string, secret: string, header: string | null): boolean {
    if (!header) return false;
    const prefix = "sha256=";
    if (!header.startsWith(prefix)) return false;
    const provided = header.slice(prefix.length);
    if (!/^[0-9a-f]+$/i.test(provided)) return false;
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
