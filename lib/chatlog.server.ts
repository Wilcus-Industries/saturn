// Persistent per-user chat logs (server-only) — the "log append" / "log read"
// designer nodes. One implicit log store per user, partitioned by a free-form
// log_key the graph wires in (a Discord channel id, a Telegram chat id, any
// string). Rows live in chat_message (db/setup.sql); each (user, key) log is a
// ring buffer pruned to its newest MAX_CHAT_MESSAGES_PER_KEY rows on append.
// No metering — no LLM or embedding calls. All failures return as values —
// never throw for an expected failure (same contract as executeMemoryTool).
import type { McpCallResult } from "@/lib/agent";
import { db } from "@/lib/db";

export const MAX_CHAT_MESSAGES_PER_KEY = 200; // ring buffer per (user, key)
export const MAX_CHAT_CONTENT = 4096; // chars stored per message
export const MAX_CHAT_KEY = 256;
export const MAX_CHATLOG_INPUT = 65_536; // op input JSON cap (whole event payloads fit)

const DEFAULT_READ_LIMIT = 20;
const TRANSCRIPT_MSG_CHARS = 1000; // per-message cap in the read transcript

// executes one chat-log operation ("append" | "read") for a workflow run.
// input is a JSON object string built by the interpreter, not by a model:
// {"key","message","role"} for append, {"key","limit"} for read. read's
// success text IS the formatted transcript (oldest-first, one line per
// message) so it wires straight into an agent prompt.
export async function executeChatLog(
    userId: string,
    op: string,
    input: string,
): Promise<McpCallResult> {
    if (op !== "append" && op !== "read") return { error: "unknown chat log operation" };
    if (typeof input !== "string" || input.length > MAX_CHATLOG_INPUT) {
        return { error: "input too long" };
    }

    let args: Record<string, unknown> = {};
    if (input.trim()) {
        try {
            const parsed: unknown = JSON.parse(input);
            if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
                throw new Error();
            }
            args = parsed as Record<string, unknown>;
        } catch {
            return { error: 'input must be a JSON object, e.g. {"key":"..."}' };
        }
    }

    const key = String(args.key ?? "").trim();
    if (!key) return { error: "key must be a non-empty string" };
    // never truncate identifiers — that could silently merge two distinct logs
    if (key.length > MAX_CHAT_KEY) return { error: `key too long (max ${MAX_CHAT_KEY} chars)` };

    try {
        if (op === "append") return await chatAppend(userId, key, args);
        return await chatRead(userId, key, args);
    } catch {
        return { error: "chat log operation failed" };
    }
}

async function chatAppend(
    userId: string,
    key: string,
    args: Record<string, unknown>,
): Promise<McpCallResult> {
    const content = String(args.message ?? "")
        .trim()
        .slice(0, MAX_CHAT_CONTENT);
    // image-only / empty messages must not kill a bot's reply flow
    if (!content) return { text: '{"appended":false,"skipped":"empty message"}' };
    const role = args.role === "bot" ? "bot" : "user";

    await db.query(
        "insert into chat_message (user_id, log_key, role, content) values ($1, $2, $3, $4)",
        [userId, key, role, content],
    );
    // ring buffer: prune on every append (cheap via the (user_id, log_key,
    // id desc) index; racy under concurrent appends but self-correcting on
    // the next one — same accepted looseness as the workflow_run prune)
    await db.query(
        `delete from chat_message
          where user_id = $1 and log_key = $2 and id not in (
                select id from chat_message
                 where user_id = $1 and log_key = $2
                 order by id desc
                 limit $3)`,
        [userId, key, MAX_CHAT_MESSAGES_PER_KEY],
    );
    return { text: '{"appended":true}' };
}

async function chatRead(
    userId: string,
    key: string,
    args: Record<string, unknown>,
): Promise<McpCallResult> {
    // blank/absent limit must fall to the default — Number("") is 0, which
    // would otherwise clamp to 1 (same trap as the interpreter's asNumber)
    const str = String(args.limit ?? "").trim();
    const raw = typeof args.limit === "number" ? args.limit : str === "" ? NaN : Number(str);
    const limit = Number.isFinite(raw)
        ? Math.max(1, Math.min(MAX_CHAT_MESSAGES_PER_KEY, Math.floor(raw)))
        : DEFAULT_READ_LIMIT;

    const { rows } = await db.query<{ role: string; content: string; created_at: Date }>(
        `select role, content, created_at from chat_message
          where user_id = $1 and log_key = $2
          order by id desc limit $3`,
        [userId, key, limit],
    );
    const lines = rows
        .reverse() // oldest first — reads naturally in a prompt
        .map((r) => `[${stamp(r.created_at)}] ${r.role}: ${clip(r.content)}`);
    return { text: lines.join("\n") };
}

// [M/D HH:MM] in UTC — consistent with crons being UTC
function stamp(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

const clip = (s: string): string =>
    s.length > TRANSCRIPT_MSG_CHARS ? `${s.slice(0, TRANSCRIPT_MSG_CHARS)}…` : s;
