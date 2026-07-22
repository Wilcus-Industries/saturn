// Persistent agent-memory core (server-only). A memory store is a
// registry_entry of kind 'memory'; its items are memory_item rows with
// pgvector embeddings (db/setup.sql). Agents get three tools at runtime —
// memory_search / memory_save / memory_forget — resolved to AgentToolSpecs
// like MCP tools, but executed here against the local store instead of an
// external server. Embeddings run through OpenRouter's OpenAI-compatible
// endpoint, funded exactly like agent turns: the platform key while built-in
// credits remain (debited to the model_usage ledger), else the user's BYOK
// key. All failures return as values — never throw for an expected failure.
import { MEMORY_TOOL_NAMES, type McpCallResult } from "@/lib/agent";
import type { AgentToolSpec } from "@/lib/agent.server";
import { getCreditUsage, platformKey, recordUsage } from "@/lib/credits.server";
import { db } from "@/lib/db";
import { getOpenrouterKey } from "@/lib/openrouter.server";
import { getUserRegistry } from "@/lib/registry.server";
import { SELF_HOSTED } from "@/lib/selfhost";
import type { McpToolParam } from "@/lib/workflow";

export const MEMORY_EMBED_MODEL = "openai/text-embedding-3-small"; // 1536 dims
export const MAX_MEMORY_ITEMS = 2000; // per store; enforced here, no ANN index needed
export const MAX_MEMORY_CONTENT = 2000; // chars per saved item

const EMBED_DIMS = 1536;
const EMBED_URL = "https://openrouter.ai/api/v1/embeddings";
const EMBED_TIMEOUT_MS = 30_000;
const MAX_QUERY = 1000; // search query length cap

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const [MEMORY_SEARCH, MEMORY_SAVE, MEMORY_FORGET] = MEMORY_TOOL_NAMES;

// the three tools an agent gets from one attached memory store. Each ref
// carries the store id as entryId (mirrors an MCP tool ref); the runner
// dispatches by toolName into executeMemoryTool.
export function memoryToolSpecs(memoryId: string): AgentToolSpec[] {
    return [
        {
            ref: { entryId: memoryId, toolName: MEMORY_SEARCH },
            description:
                "Semantic search over the attached memory store. Returns the most relevant saved items with their ids, content, similarity score, and timestamps.",
            params: [
                { name: "query", type: "string", required: true, description: "what to look for" },
                {
                    name: "limit",
                    type: "number",
                    required: false,
                    description: "max results, 1-20, default 5",
                },
            ] satisfies McpToolParam[],
        },
        {
            ref: { entryId: memoryId, toolName: MEMORY_SAVE },
            description:
                "Store a durable fact, preference, or summary in the memory store (max 2000 chars). For lasting knowledge worth recalling later — not raw transcripts.",
            params: [
                {
                    name: "content",
                    type: "string",
                    required: true,
                    description: "the fact or summary to remember",
                },
            ] satisfies McpToolParam[],
        },
        {
            ref: { entryId: memoryId, toolName: MEMORY_FORGET },
            description:
                "Permanently delete one memory item by its id (ids come from memory_search results).",
            params: [
                {
                    name: "id",
                    type: "string",
                    required: true,
                    description: "id of the memory item to delete",
                },
            ] satisfies McpToolParam[],
        },
    ];
}

// executes one memory tool call for a workflow run. Errors return as values
// (not throws) so consoles and run logs can render them — same contract as
// executeMcpTool.
export async function executeMemoryTool(
    userId: string,
    memoryId: string,
    op: string,
    input: string,
    source: "designer" | "cron" | "manual" | "event",
): Promise<McpCallResult> {
    if (typeof memoryId !== "string" || !UUID.test(memoryId)) return { error: "invalid memory id" };
    if (typeof op !== "string" || !(MEMORY_TOOL_NAMES as readonly string[]).includes(op)) {
        return { error: "unknown memory operation" };
    }

    const registry = await getUserRegistry(userId);
    const row = registry.find((r) => r.id === memoryId && r.kind === "memory");
    if (!row) return { error: "memory store not found" };

    // parse the model-built argument object — same convention as executeMcpTool
    let args: Record<string, unknown> = {};
    if (typeof input === "string" && input.trim()) {
        try {
            const parsed: unknown = JSON.parse(input);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                throw new Error();
            }
            args = parsed as Record<string, unknown>;
        } catch {
            return { error: 'input must be a JSON object, e.g. {"query":"..."}' };
        }
    }

    try {
        if (op === MEMORY_SEARCH) return await memorySearch(userId, memoryId, source, args);
        if (op === MEMORY_SAVE) return await memorySave(userId, memoryId, source, args);
        return await memoryForget(userId, memoryId, args);
    } catch (err) {
        // embed() throws user-renderable messages; DB errors fall back generic
        return { error: err instanceof Error ? err.message : "memory operation failed" };
    }
}

async function memorySearch(
    userId: string,
    memoryId: string,
    source: "designer" | "cron" | "manual" | "event",
    args: Record<string, unknown>,
): Promise<McpCallResult> {
    const query = typeof args.query === "string" ? args.query.trim().slice(0, MAX_QUERY) : "";
    if (!query) return { error: "query must be a non-empty string" };
    const rawLimit = typeof args.limit === "number" ? Math.floor(args.limit) : 5;
    const limit = Math.max(1, Math.min(20, Number.isFinite(rawLimit) ? rawLimit : 5));

    const [embedding] = await embed(userId, source, [query]);
    const vec = JSON.stringify(embedding); // pg has no vector type — bind as text, cast ::vector
    const { rows } = await db.query<{
        id: string;
        content: string;
        created_at: Date;
        score: number;
    }>(
        `select id, content, created_at, 1 - (embedding <=> $3::vector) as score
           from memory_item
          where entry_id = $1 and user_id = $2 and embedding is not null
          order by embedding <=> $3::vector
          limit $4`,
        [memoryId, userId, vec, limit],
    );
    return {
        text: JSON.stringify(
            rows.map((r) => ({
                id: r.id,
                content: r.content,
                score: Math.round(r.score * 1000) / 1000,
                created_at: r.created_at.toISOString(),
            })),
        ),
    };
}

async function memorySave(
    userId: string,
    memoryId: string,
    source: "designer" | "cron" | "manual" | "event",
    args: Record<string, unknown>,
): Promise<McpCallResult> {
    const content = typeof args.content === "string" ? args.content.trim() : "";
    if (!content) return { error: "content must be a non-empty string" };
    // reject over-cap rather than silently truncate — the model should know
    if (content.length > MAX_MEMORY_CONTENT) {
        return { error: `content too long (max ${MAX_MEMORY_CONTENT} chars) — summarize it first` };
    }

    const { rows: countRows } = await db.query<{ n: number }>(
        "select count(*)::int as n from memory_item where entry_id = $1",
        [memoryId],
    );
    if ((countRows[0]?.n ?? 0) >= MAX_MEMORY_ITEMS) {
        return { error: `memory store is full (${MAX_MEMORY_ITEMS} items) — memory_forget items first` };
    }

    const [embedding] = await embed(userId, source, [content]);
    const vec = JSON.stringify(embedding);
    const { rows } = await db.query<{ id: string }>(
        `insert into memory_item (entry_id, user_id, content, embedding)
         values ($1, $2, $3, $4::vector)
         returning id`,
        [memoryId, userId, content, vec],
    );
    return { text: JSON.stringify({ id: rows[0].id, saved: true }) };
}

async function memoryForget(
    userId: string,
    memoryId: string,
    args: Record<string, unknown>,
): Promise<McpCallResult> {
    const id = typeof args.id === "string" ? args.id : "";
    if (!UUID.test(id)) return { error: "invalid memory item id" };
    // scoped by entry + user so an id from another store can't be forgotten here
    const { rowCount } = await db.query(
        "delete from memory_item where id = $1 and entry_id = $2 and user_id = $3",
        [id, memoryId, userId],
    );
    if (!rowCount) return { error: "memory not found" };
    return { text: JSON.stringify({ forgotten: true }) };
}

// ---------------------------------------------------------------- embeddings

// embed texts through OpenRouter — platform key while credits remain (billed
// to the ledger), else the user's BYOK key. Throws Error with a
// user-renderable message on no key / HTTP / decode failure (caught by the
// callers → error value). Key selection mirrors executeAgentTurn.
async function embed(
    userId: string,
    source: "designer" | "cron" | "manual" | "event",
    texts: string[],
): Promise<number[][]> {
    let apiKey: string | null = null;
    let platformBilled = false;
    if (SELF_HOSTED) {
        // single owner, no credits/BYOK: the server-wide platform key funds
        // embeddings and nothing is metered (recordUsage also no-ops).
        apiKey = platformKey();
        if (!apiKey) {
            throw new Error(
                "model calls need an OpenRouter key: set PLATFORM_OPENROUTER_KEY on the server",
            );
        }
    } else {
        const credits = await getCreditUsage(userId);
        if (credits.allowance > 0 && credits.used < credits.allowance && platformKey()) {
            apiKey = platformKey();
            platformBilled = true;
        } else {
            apiKey = await getOpenrouterKey(userId);
        }
        if (!apiKey) {
            throw new Error(
                credits.allowance > 0
                    ? "out of built-in model credits for now — add an OpenRouter key in settings to keep running"
                    : "no model credits on your plan — upgrade for built-in credits or add an OpenRouter key in settings",
            );
        }
    }

    const res = await fetch(EMBED_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: MEMORY_EMBED_MODEL,
            input: texts,
            usage: { include: true }, // per-call cost for the credits ledger
        }),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });

    const body: unknown = await res.json().catch(() => null);
    const record = (x: unknown): Record<string, unknown> | null =>
        typeof x === "object" && x !== null && !Array.isArray(x)
            ? (x as Record<string, unknown>)
            : null;

    if (!res.ok) {
        const err = record(record(body)?.error);
        const message = typeof err?.message === "string" ? err.message : `HTTP ${res.status}`;
        throw new Error(`embedding call failed: ${message}`);
    }

    const data = record(body)?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error("embedding call failed: malformed response");
    }
    const vectors: number[][] = [];
    for (const item of data) {
        const emb = record(item)?.embedding;
        if (
            !Array.isArray(emb) ||
            emb.length !== EMBED_DIMS ||
            !emb.every((n) => typeof n === "number")
        ) {
            throw new Error("embedding call failed: unexpected vector shape");
        }
        vectors.push(emb as number[]);
    }

    // metering: only platform-billed calls with a reported cost touch the
    // ledger; BYOK is never recorded, and a missing cost is silently skipped.
    // recordUsage never throws.
    const usage = record(record(body)?.usage);
    if (platformBilled && typeof usage?.cost === "number") {
        await recordUsage(userId, {
            model: MEMORY_EMBED_MODEL,
            costUsd: usage.cost,
            promptTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
            completionTokens: 0, // embeddings have no completion tokens
            source,
        });
    }

    return vectors;
}

// ------------------------------------------------------------- settings views

export type MemoryItemRow = { id: string; content: string; created_at: Date };

// items in one store for the owner, newest first, optional content substring
// filter. Capped at 500 — the settings list is a browse view, not the store.
export async function listMemoryItems(
    entryId: string,
    userId: string,
    q?: string,
): Promise<MemoryItemRow[]> {
    const filter = typeof q === "string" ? q.trim() : "";
    if (filter) {
        // escape LIKE metacharacters so a stray %/_ can't widen the match
        const pattern = `%${filter.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
        const { rows } = await db.query<MemoryItemRow>(
            `select id, content, created_at
               from memory_item
              where entry_id = $1 and user_id = $2 and content ilike $3
              order by created_at desc
              limit 500`,
            [entryId, userId, pattern],
        );
        return rows;
    }
    const { rows } = await db.query<MemoryItemRow>(
        `select id, content, created_at
           from memory_item
          where entry_id = $1 and user_id = $2
          order by created_at desc
          limit 500`,
        [entryId, userId],
    );
    return rows;
}

// entry_id → item count for all of a user's stores (usage/limit display)
export async function countMemoryItems(userId: string): Promise<Map<string, number>> {
    const { rows } = await db.query<{ entry_id: string; n: number }>(
        "select entry_id, count(*)::int as n from memory_item where user_id = $1 group by entry_id",
        [userId],
    );
    return new Map(rows.map((r) => [r.entry_id, r.n]));
}
