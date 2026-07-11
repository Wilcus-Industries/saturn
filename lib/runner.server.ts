// Server-side workflow execution cores, split from the designer's server
// actions (app/dashboard/workflows/[id]/actions.ts) so scheduled runs can
// execute the same logic for a userId without a browser session. Semantic
// checks live here — graph/agent-derived input is untrusted even
// server-side; shape validation of browser-built transcripts stays in the
// actions.
import type { AgentModelResult, McpCallResult } from "@/lib/agent";
import { type AgentToolSpec, chatComplete } from "@/lib/agent.server";
import { cronMatches } from "@/lib/cron";
import { db } from "@/lib/db";
import {
    type CallAgentRequest,
    type ConsoleLine,
    describeImage,
    runWorkflow,
} from "@/lib/interpreter";
import { callTool, McpAuthRequired } from "@/lib/mcp";
import { getOpenrouterKey } from "@/lib/openrouter.server";
import { buildUserCatalog, canCallTool } from "@/lib/registry";
import { freshMcpToken, getMcpSecrets, getUserRegistry } from "@/lib/registry.server";
import { getActivationLevels, limitsFor } from "@/lib/subscription";
import { CATALOG_BY_KEY, type CatalogEntry, missingEntry, type WorkflowGraph } from "@/lib/workflow";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TOOL_INPUT = 4096;
const MODEL_ID = /^[\w.:/-]{1,128}$/;
const MAX_SYSTEM_PROMPT = 8192;
const MAX_GRANTED_TOOLS = 20;
const MAX_GRANTED_SKILLS = 10;
const MAX_MODEL_CONTENT = 20_000; // model output returned per turn
const MAX_IMAGE_DATA_URL = 4_194_304; // generated-image data URL (~3 MB decoded)

// executes one MCP tool call for a workflow run. Returns errors as values
// (not throws) so consoles and run logs can render them.
export async function executeMcpTool(
    userId: string,
    entryId: string,
    toolName: string,
    input: string,
): Promise<McpCallResult> {
    if (typeof entryId !== "string" || !UUID.test(entryId)) return { error: "invalid entry id" };
    if (typeof toolName !== "string" || !toolName) return { error: "no tool selected" };
    if (typeof input !== "string" || input.length > MAX_TOOL_INPUT) {
        return { error: "input too long" };
    }

    const entry = await getMcpSecrets(entryId, userId);
    if (!entry) return { error: "MCP server not found" };
    const tool = entry.tools.find((t) => t.name === toolName);
    if (!tool?.enabled) return { error: `tool "${toolName}" is not enabled` };
    if (!canCallTool(tool)) {
        return {
            error: `the server declares "${toolName}" write-capable but it's granted read-only — allow read+write in settings`,
        };
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
            return { error: 'input must be a JSON object, e.g. {"symbol":"NVDA"}' };
        }
    }

    try {
        const { token } = await freshMcpToken(entry, userId);
        const text = await callTool(entry.server_url, toolName, args, token);
        return { text };
    } catch (err) {
        if (err instanceof McpAuthRequired) {
            return { error: "authorization required — connect the server in settings" };
        }
        return { error: err instanceof Error ? err.message : "tool call failed" };
    }
}

// one LLM turn of an agent node's loop: resolve grants against the user's
// registry, inject skill instructions by id (never caller-supplied text),
// call OpenRouter with the user's key. Errors return as values.
export async function executeAgentTurn(
    userId: string,
    req: CallAgentRequest,
): Promise<AgentModelResult> {
    if (typeof req.model !== "string" || !MODEL_ID.test(req.model)) {
        return { error: "invalid model id" };
    }
    if (typeof req.system !== "string" || req.system.length > MAX_SYSTEM_PROMPT) {
        return { error: "system prompt too long" };
    }
    if (!Array.isArray(req.skillIds) || req.skillIds.length > MAX_GRANTED_SKILLS) {
        return { error: "too many skills" };
    }
    if (!req.skillIds.every((id) => typeof id === "string" && UUID.test(id))) {
        return { error: "invalid skill id" };
    }
    if (!Array.isArray(req.tools) || req.tools.length > MAX_GRANTED_TOOLS) {
        return { error: "too many tools" };
    }

    // resolve grants against the user's registry — reject outright on any
    // mismatch instead of silently dropping (a granted-but-unavailable tool
    // is a misconfiguration the user must see, not something the model
    // should hallucinate around). executeMcpTool re-checks at execution time.
    const registry = await getUserRegistry(userId);
    const specs: AgentToolSpec[] = [];
    for (const ref of req.tools) {
        const row = registry.find((r) => r.id === ref.entryId && r.kind === "mcp");
        const tool = row?.tools.find((t) => t.name === ref.toolName);
        if (!tool?.enabled) return { error: `tool "${ref.toolName}" is not enabled` };
        if (!canCallTool(tool)) {
            return {
                error: `the server declares "${ref.toolName}" write-capable but it's granted read-only — allow read+write in settings`,
            };
        }
        specs.push({ ref, description: tool.description, params: tool.params });
    }

    let system = req.system;
    for (const id of req.skillIds) {
        const row = registry.find((r) => r.id === id && r.kind === "skill");
        if (!row) return { error: "skill not found" };
        system += `\n\n## Skill: ${row.name}\n${row.description}`;
    }
    const apiKey = await getOpenrouterKey(userId);
    if (!apiKey) return { error: "no OpenRouter key — add one in settings" };

    try {
        const { content, toolCalls, images } = await chatComplete(apiKey, {
            model: req.model,
            system,
            messages: req.messages,
            tools: specs,
            outputImage: req.outputImage === true,
        });
        // the image rides its own field so the content slice never touches
        // the data URL; oversized images are dropped (interpreter falls back
        // to text with a warning)
        const image =
            req.outputImage === true
                ? images.find((u) => u.length <= MAX_IMAGE_DATA_URL)
                : undefined;
        return {
            content: content.slice(0, MAX_MODEL_CONTENT),
            toolCalls,
            ...(image ? { image } : {}),
        };
    } catch (err) {
        return { error: err instanceof Error ? err.message : "model call failed" };
    }
}

// ---------------------------------------------------------------------------
// Scheduled execution tick (driven by GET /api/cron, pinged per-minute by an
// external scheduler). Matching is against the current UTC minute only — a
// missed ping skips that occurrence, no catch-up.
// ---------------------------------------------------------------------------

const MAX_RUNS_PER_TICK = 25;
const RUN_TIMEOUT_MS = 240_000;
const MAX_LOG_LINES = 300;
const MAX_LOG_LINE_CHARS = 2_000;
const RUNS_KEPT_PER_WORKFLOW = 50;
const CLAIM_GUARD_FLOOR_S = 50;

type ClaimedWorkflow = { id: string; user_id: string; name: string; graph: WorkflowGraph };

export async function runDueWorkflows(): Promise<{ due: number; ran: number }> {
    // janitor: a killed invocation (platform timeout, crash) strands rows in
    // 'running'; anything well past the RUN_TIMEOUT_MS budget is dead
    await db.query(
        `update workflow_run
            set status = 'error',
                error = 'run never finished (function terminated)',
                finished_at = now()
          where status = 'running' and started_at < now() - interval '10 minutes'`,
    );

    // light candidate select — no graph payload yet; the jsonb containment
    // check drops graphs that could never run (no start node)
    const { rows: candidates } = await db.query<{ id: string; user_id: string; cron: string }>(
        `select id, user_id, cron from workflow
          where graph->'nodes' @> '[{"type":"start"}]'`,
    );

    const now = new Date();
    const matched = candidates.filter((c) => cronMatches(c.cron, now));
    if (matched.length === 0) return { due: 0, ran: 0 };
    const toClaim = matched.slice(0, MAX_RUNS_PER_TICK);

    // batch tier resolution — one query for all candidate owners
    const levels = await getActivationLevels([...new Set(toClaim.map((c) => c.user_id))]);

    const claimed: ClaimedWorkflow[] = [];
    for (const c of toClaim) {
        const floor = limitsFor(levels.get(c.user_id) ?? null).cronFloorMinutes;
        // the guard doubles as the run-time tier-floor clamp: a downgraded
        // user's '* * * * *' degrades to their floor instead of erroring.
        // -30s absorbs pinger jitter; the 50s floor makes duplicate
        // same-minute pings no-ops.
        const guardSeconds = Math.max(CLAIM_GUARD_FLOOR_S, floor * 60 - 30);
        // atomic claim via single-statement conditional UPDATE — session
        // advisory locks are unsafe on pgbouncer transaction pooling (Neon),
        // and the external scheduler can overlap or retry ticks
        const { rows } = await db.query<ClaimedWorkflow>(
            `update workflow set last_run_at = now()
              where id = $1
                and (last_run_at is null or last_run_at <= now() - make_interval(secs => $2))
              returning id, user_id, name, graph`,
            [c.id, guardSeconds],
        );
        if (rows[0]) claimed.push(rows[0]);
    }

    // runOne never rejects, but allSettled keeps one pathological failure
    // from ever sinking its siblings
    await Promise.allSettled(claimed.map((wf) => runOne(wf)));
    return { due: matched.length, ran: claimed.length };
}

// executes one claimed workflow and persists its workflow_run row. Catches
// everything — nothing may reject out of the tick.
async function runOne(wf: ClaimedWorkflow): Promise<void> {
    await executeWorkflowRun(wf, { trigger: "cron" });
}

export type WorkflowRunResult = {
    runId: string | null; // null when even the run row couldn't be recorded
    status: "success" | "error";
    error: string;
    log: ConsoleLine[];
};

// shared execution core: records a workflow_run, executes the graph with the
// owner's registry catalog and the server hooks, persists status/log, prunes
// history. Never rejects — the cron tick (trigger 'cron') and the MCP
// server's run_workflow tool (trigger 'manual') both consume errors as values.
export async function executeWorkflowRun(
    wf: { id: string; user_id: string; graph: WorkflowGraph },
    opts: { trigger: "cron" | "manual"; timeoutMs?: number },
): Promise<WorkflowRunResult> {
    const timeoutMs = Math.min(opts.timeoutMs ?? RUN_TIMEOUT_MS, RUN_TIMEOUT_MS);
    let runId: string;
    try {
        const { rows } = await db.query<{ id: string }>(
            `insert into workflow_run (workflow_id, trigger) values ($1, $2) returning id`,
            [wf.id, opts.trigger],
        );
        runId = rows[0].id;
    } catch {
        // couldn't even record the run — skip; a cron claim already spent this slot
        return { runId: null, status: "error", error: "could not record the run", log: [] };
    }

    try {
        // byKey exactly like the designer: static catalog + user registry +
        // '(deleted)' placeholders so stale node types stay inert, not fatal
        const byKey: Record<string, CatalogEntry> = { ...CATALOG_BY_KEY };
        for (const entry of buildUserCatalog(await getUserRegistry(wf.user_id))) {
            byKey[entry.key] = entry;
        }
        for (const n of wf.graph.nodes) {
            if (!byKey[n.type]) byKey[n.type] = missingEntry(n.type);
        }

        // capped log capture — lines past the cap are counted, not stored;
        // lastError is tracked incrementally so truncation can't lose it
        const log: ConsoleLine[] = [];
        let dropped = 0;
        let sawError = false;
        let lastError = "";
        const emit = (rawLine: ConsoleLine) => {
            // never persist image data URLs — the char cap would corrupt the
            // base64 and bloat workflow_run.log; store a placeholder instead
            const line: ConsoleLine =
                rawLine.kind === "image"
                    ? { kind: "info", text: describeImage(rawLine.text) }
                    : rawLine;
            const text = line.text.slice(0, MAX_LOG_LINE_CHARS);
            if (line.kind === "error") {
                sawError = true;
                lastError = text;
            }
            if (log.length >= MAX_LOG_LINES) {
                dropped++;
                return;
            }
            log.push({ kind: line.kind, text });
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let thrown: string | null = null;
        try {
            await runWorkflow(wf.graph, byKey, {
                emit,
                callMcp: (entryId, toolName, input) =>
                    executeMcpTool(wf.user_id, entryId, toolName, input),
                callAgent: (req) => executeAgentTurn(wf.user_id, req),
                signal: controller.signal,
            });
        } catch (err) {
            thrown = err instanceof Error ? err.message : "run failed";
        } finally {
            clearTimeout(timer);
        }

        if (dropped > 0) log.push({ kind: "info", text: `(${dropped} lines truncated)` });

        // the interpreter *returns* after emitting "no start node"/"run
        // aborted" error lines, so sawError (not just throw/abort) decides
        const failed = thrown !== null || controller.signal.aborted || sawError;
        const status = failed ? "error" : "success";
        const error = failed ? (thrown ?? (lastError || "run failed")) : "";
        await db.query(
            `update workflow_run
                set status = $2, error = $3, log = $4, finished_at = now()
              where id = $1`,
            [runId, status, error, JSON.stringify(log)],
        );

        // prune per-completion — cheap, and spares a global retention job
        await db.query(
            `delete from workflow_run
              where workflow_id = $1 and id not in (
                    select id from workflow_run
                     where workflow_id = $1
                     order by started_at desc
                     limit $2)`,
            [wf.id, RUNS_KEPT_PER_WORKFLOW],
        );
        return { runId, status, error, log };
    } catch {
        // persistence itself failed — the janitor sweeps the orphaned
        // 'running' row next tick
        return { runId, status: "error", error: "run persistence failed", log: [] };
    }
}
