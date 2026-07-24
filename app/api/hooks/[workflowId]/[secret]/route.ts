// Inbound per-workflow webhook ingress — thin HTTP shell. A two-segment path
// (workflowId + secret) whose secret never hits an index: the row is fetched by
// PK, then the secret is compared in-process with a length-checked timing-safe
// equal. Every verification failure collapses to a byte-identical 404 (row
// missing, secret unprovisioned, secret mismatch, workflow inactive, no
// event:webhook node) so the endpoint is no oracle — the workflow id alone is
// not a capability. On success we respond 202 immediately and hand the built
// payload to ingestEvent fire-and-forget (same pipeline as every other event
// trigger). Never logs the secret, URL, or payload. No env gate — works under
// SELF_HOSTED unchanged.
import { timingSafeEqual } from "node:crypto";

import { createTtlCache } from "@/lib/cache.server";
import { db } from "@/lib/db";
import { ingestEvent, MAX_EVENT_PAYLOAD } from "@/lib/events.server";
import { UUID } from "@/lib/runner.server";
import type { WorkflowGraph } from "@/lib/workflow";

export const dynamic = "force-dynamic";

const SECRET_RE = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB — matches the GitHub webhook route
const MAX_QUERY_KEYS = 50;
const MAX_QUERY_KEY = 256;
const MAX_QUERY_VALUE = 2048;
const RATE_LIMIT = 60; // requests per fixed 60s window, per workflow

// A4 — fixed-window rate limiter. createTtlCache stamps expiresAt at set() time,
// so a mutable counter object mutated in place gives a true 60s fixed window
// (not a sliding one). Keyed by workflowId. Known residual: a wrong-secret flood
// counts against the workflow's own window (accepted v1).
const hookHits = createTtlCache<{ count: number }>(60_000, 5_000);

// fixed-length dummy for the row-miss / null-secret path so a missing workflow
// or unprovisioned secret does the same constant-time crypto work as a real
// compare — no timing oracle on whether the secret is even correct.
const DUMMY_SECRET = Buffer.alloc(32);

const notFound = () => new Response("Not Found", { status: 404 });
const methodNotAllowed = () =>
    new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });

export const GET = methodNotAllowed;
export const PUT = methodNotAllowed;
export const PATCH = methodNotAllowed;
export const DELETE = methodNotAllowed;

export async function POST(
    req: Request,
    ctx: { params: Promise<{ workflowId: string; secret: string }> },
): Promise<Response> {
    // 1. shape gates — junk ids never reach the db (or the rate-limit map)
    const { workflowId, secret } = await ctx.params;
    if (!UUID.test(workflowId) || !SECRET_RE.test(secret)) return notFound();

    // 2. rate limit before auth/db — cheap rejection, over limit → 429
    let entry = hookHits.get(workflowId);
    if (!entry) {
        entry = { count: 0 };
        hookHits.set(workflowId, entry);
    }
    if (++entry.count > RATE_LIMIT)
        return new Response("Too Many Requests", { status: 429 });

    // 3. body caps — reject by declared size, then re-check actual bytes
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES)
        return new Response("Payload Too Large", { status: 413 });
    const rawBody = await req.text();
    if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES)
        return new Response("Payload Too Large", { status: 413 });

    // 4. single PK lookup
    const { rows } = await db.query<{
        id: string;
        active: boolean;
        graph: WorkflowGraph;
        webhook_secret: string | null;
    }>("select id, active, graph, webhook_secret from workflow where id = $1", [workflowId]);
    const wf = rows[0];

    // 5. verify — every failure returns the identical 404. Row-miss / null-secret
    // still run a dummy compare to flatten timing.
    if (!wf || wf.webhook_secret === null) {
        timingSafeEqual(DUMMY_SECRET, DUMMY_SECRET);
        return notFound();
    }
    if (!secretEquals(secret, wf.webhook_secret)) return notFound();
    if (!wf.active) return notFound();

    // graph is untrusted jsonb — guard defensively before reading it
    const nodes = Array.isArray(wf.graph?.nodes) ? wf.graph.nodes : [];
    const webhookNode = nodes.find(
        (n) => n && typeof n === "object" && n.type === "event:webhook",
    );
    const nodeId = webhookNode?.id;
    if (typeof nodeId !== "string" || !nodeId) return notFound();

    // 6. build the event envelope (payload shape per plan A1), capped to fit
    const payload = buildPayload(req, rawBody);

    // 7. respond immediately, then run fire-and-forget. ingestEvent validates,
    // atomically re-checks active + stamps last_run_at, and executes with
    // trigger "event". Synchronous-response mode (return the workflow's output to
    // the caller) is future work — today the webhook is always 202 fire-and-forget.
    void ingestEvent({ workflowId, nodeId, payload }).catch(() => {});
    return Response.json({ ok: true }, { status: 202 });
}

// length check first (timingSafeEqual throws on unequal-length buffers), then a
// constant-time compare over the utf8 bytes.
function secretEquals(provided: string, stored: string): boolean {
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(stored, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

// Build the { method, contentType, query, body, receivedAt } envelope. body is
// the parsed value when the raw body is JSON object/array (so extract can walk
// one dot path), else the raw string. If the envelope overflows
// MAX_EVENT_PAYLOAD, rebuild with a truncated raw-string body + truncated:"true"
// and shrink it until it fits.
function buildPayload(req: Request, rawBody: string): string {
    const contentType = (req.headers.get("content-type") ?? "")
        .split(";")[0]
        .trim()
        .toLowerCase();

    const query: Record<string, string> = {};
    let keyCount = 0;
    for (const [k, v] of new URL(req.url).searchParams) {
        if (k.length > MAX_QUERY_KEY) continue;
        // last-wins: overwriting an existing key never grows the distinct-key count
        if (!Object.prototype.hasOwnProperty.call(query, k)) {
            if (keyCount >= MAX_QUERY_KEYS) continue;
            keyCount++;
        }
        query[k] = v.slice(0, MAX_QUERY_VALUE);
    }

    const receivedAt = new Date().toISOString();
    const base = { method: "POST", contentType, query, receivedAt };

    const full = JSON.stringify({ ...base, body: parseBody(rawBody) });
    if (full.length <= MAX_EVENT_PAYLOAD) return full;

    // overflow: fall back to a truncated raw-string body. Binary-search the
    // largest prefix whose stringified envelope fits (JSON escaping makes the
    // overhead non-uniform, so measure rather than guess).
    const withBody = (s: string) => JSON.stringify({ ...base, body: s, truncated: "true" });
    let lo = 0;
    let hi = rawBody.length;
    let best = withBody("");
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const candidate = withBody(rawBody.slice(0, mid));
        if (candidate.length <= MAX_EVENT_PAYLOAD) {
            best = candidate;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return best;
}

// JSON object/array → parsed value (embedded so body.<path> works in one
// extract); anything else (primitive, invalid JSON, empty) → the raw string.
function parseBody(rawBody: string): unknown {
    const trimmed = rawBody.trim();
    if (!trimmed) return rawBody;
    try {
        const value: unknown = JSON.parse(trimmed);
        if (value !== null && typeof value === "object") return value;
    } catch {
        // not JSON — fall through to the raw string
    }
    return rawBody;
}
