// Server-side workflow execution cores, split from the designer's server
// actions (app/dashboard/workflows/[id]/actions.ts) so scheduled runs can
// execute the same logic for a userId without a browser session. Semantic
// checks live here — graph/agent-derived input is untrusted even
// server-side; shape validation of browser-built transcripts stays in the
// actions.
import {
    type AgentModelResult,
    isAllToolsRef,
    isToolExclusionList,
    MAX_GRANTED_SKILLS,
    MAX_GRANTED_TOOLS,
    type McpCallResult,
} from "@/lib/agent";
import { type AgentToolSpec, chatComplete } from "@/lib/agent.server";
import { cronMatches } from "@/lib/cron";
import { db } from "@/lib/db";
import {
    type CallAgentRequest,
    type ConsoleLine,
    describeImage,
    runWorkflow,
} from "@/lib/interpreter";
import { getCreditUsage, platformKey, recordUsage } from "@/lib/credits.server";
import { executeIntegration } from "@/lib/integrations.server";
import { executeMemoryTool, memoryToolSpecs } from "@/lib/memory.server";
import { callTool, McpAuthRequired } from "@/lib/mcp";
import { getOpenrouterKey } from "@/lib/openrouter.server";
import { buildUserCatalog, canCallTool } from "@/lib/registry";
import { freshMcpToken, getMcpSecrets, getUserRegistry } from "@/lib/registry.server";
import { executeSandboxTool, sandboxToolSpecs } from "@/lib/sandbox.server";
import { getActivationLevels, limitsFor } from "@/lib/subscription";
import { CATALOG_BY_KEY, type CatalogEntry, missingEntry, type WorkflowGraph } from "@/lib/workflow";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_TOOL_INPUT = 65_536;
const MODEL_ID = /^[\w.:/-]{1,128}$/;
const MAX_SYSTEM_PROMPT = 8192;
const MAX_MODEL_CONTENT = 20_000; // model output returned per turn
const MAX_IMAGE_DATA_URL = 4_194_304; // generated-image data URL (~3 MB decoded)
const REASONING_MODES = new Set(["off", "low", "medium", "high"]);

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
// call OpenRouter — on the platform key while built-in credits remain
// (debited to the model_usage ledger), else the user's own key. Errors
// return as values.
export async function executeAgentTurn(
    userId: string,
    req: CallAgentRequest,
    source: "designer" | "cron" | "manual" | "event",
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
    if (req.memoryId !== undefined && (typeof req.memoryId !== "string" || !UUID.test(req.memoryId))) {
        return { error: "invalid memory store" };
    }
    if (req.sandboxId !== undefined && (typeof req.sandboxId !== "string" || !UUID.test(req.sandboxId))) {
        return { error: "invalid sandbox" };
    }
    if (!Array.isArray(req.tools) || req.tools.length > MAX_GRANTED_TOOLS) {
        return { error: "too many tools" };
    }

    // resolve grants against the user's registry — reject outright on any
    // mismatch instead of silently dropping (a granted-but-unavailable tool
    // is a misconfiguration the user must see, not something the model
    // should hallucinate around). executeMcpTool re-checks at execution time.
    // A server chip (isAllToolsRef) is the exception: it expands to the
    // server's every enabled + callable tool minus the node's exclude
    // selection, silently skipping off, write-mismatched, or excluded ones —
    // "all the tools that are usable", never an error. Stale excluded names
    // simply never match.
    const registry = await getUserRegistry(userId);
    const specs: AgentToolSpec[] = [];
    const seen = new Set<string>(); // "<entryId>:<toolName>" — dedupe across chips
    for (const ref of req.tools) {
        const row = registry.find((r) => r.id === ref.entryId && r.kind === "mcp");
        if (isAllToolsRef(ref)) {
            if (!row) return { error: "MCP server not found" };
            const excluded = new Set(isToolExclusionList(ref.exclude) ? ref.exclude : []);
            for (const tool of row.tools) {
                if (!tool.enabled || !canCallTool(tool) || excluded.has(tool.name)) continue;
                const key = `${ref.entryId}:${tool.name}`;
                if (seen.has(key)) continue;
                seen.add(key);
                specs.push({
                    ref: { entryId: ref.entryId, toolName: tool.name },
                    description: tool.description,
                    params: tool.params,
                });
            }
            continue;
        }
        const tool = row?.tools.find((t) => t.name === ref.toolName);
        if (!tool?.enabled) return { error: `tool "${ref.toolName}" is not enabled` };
        if (!canCallTool(tool)) {
            return {
                error: `the server declares "${ref.toolName}" write-capable but it's granted read-only — allow read+write in settings`,
            };
        }
        const key = `${ref.entryId}:${ref.toolName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        specs.push({ ref, description: tool.description, params: tool.params });
    }
    // a general-server chip is one edge but expands past the grant cap
    if (specs.length > MAX_GRANTED_TOOLS) specs.length = MAX_GRANTED_TOOLS;

    let system = req.system;
    for (const id of req.skillIds) {
        const row = registry.find((r) => r.id === id && r.kind === "skill");
        if (!row) return { error: "skill not found" };
        system += `\n\n## Skill: ${row.name}\n${row.description}`;
    }
    // memory store and sandbox: reject a missing store/sandbox outright (never
    // silently drop — a granted-but-gone resource is a misconfiguration the
    // user must see). Their tools are unshifted AFTER the MAX_GRANTED_TOOLS
    // slice above, so they always survive the cap and sit at the head of the
    // array — head position reserves the clean wire names (buildToolDefs
    // renames the later collider, not the first). With memory attached an agent
    // gets at most 17 MCP tools; with a sandbox, 17; with both, 14.
    if (req.memoryId !== undefined) {
        const row = registry.find((r) => r.id === req.memoryId && r.kind === "memory");
        if (!row) return { error: "memory store not found" };
        system += `\n\n## Memory: ${row.name}\n${row.description}\nSearch before answering questions that may involve prior context; save durable facts (not transcripts); forget stale items by id.`;
        specs.unshift(...memoryToolSpecs(req.memoryId));
    }
    if (req.sandboxId !== undefined) {
        const row = registry.find((r) => r.id === req.sandboxId && r.kind === "sandbox");
        if (!row) return { error: "sandbox not found" };
        system += `\n\n## Sandbox: ${row.name}${row.description ? `\n${row.description}` : ""}\nA persistent Linux sandbox (Debian: bash, Node 22, python3, pip, git, curl). Files under /work persist across runs ($HOME is /work); everything else resets. The rootfs is read-only: never try to install runtimes or system packages (no apt, no nvm — they fail or get OOM-killed); small installs go into /work via \`pip install --user\` or \`npm install\` in a /work project dir. Commands run via sandbox_exec time out per plan tier. The sandbox is a container with its own resource limits: free/nproc/df report the HOST, not the sandbox — for the sandbox's real limits read /sys/fs/cgroup/memory.max (bytes), /sys/fs/cgroup/cpu.max (quota period), and /sys/fs/cgroup/pids.max.`;
        specs.unshift(...sandboxToolSpecs(req.sandboxId));
    }
    // key selection: platform key while credits remain, else BYOK fallback.
    // The check-then-call-then-record sequence can overshoot the allowance by
    // ~one in-flight turn (bounded by max_tokens) — see lib/credits.server.ts.
    const credits = await getCreditUsage(userId);
    let apiKey: string | null = null;
    let platformBilled = false;
    if (credits.allowance > 0 && credits.used < credits.allowance && platformKey()) {
        apiKey = platformKey();
        platformBilled = true;
    } else {
        apiKey = await getOpenrouterKey(userId);
    }
    if (!apiKey) {
        return {
            error:
                credits.allowance > 0
                    ? "out of built-in model credits for now — add an OpenRouter key in settings to keep running"
                    : "no model credits on your plan — upgrade for built-in credits or add an OpenRouter key in settings",
        };
    }

    // allowlist the reasoning mode; drop it for image output (single-turn,
    // reasoning not applicable) and map to OpenRouter's reasoning param
    let reasoningMode =
        typeof req.reasoning === "string" && REASONING_MODES.has(req.reasoning)
            ? req.reasoning
            : undefined;
    if (req.outputImage === true) reasoningMode = undefined;
    const reasoning =
        reasoningMode === "off"
            ? ({ enabled: false } as const)
            : reasoningMode
              ? { effort: reasoningMode }
              : undefined;

    try {
        const { content, toolCalls, images, usage } = await chatComplete(apiKey, {
            model: req.model,
            system,
            messages: req.messages,
            tools: specs,
            outputImage: req.outputImage === true,
            reasoning,
        });
        if (platformBilled && usage) {
            await recordUsage(userId, { model: req.model, ...usage, source });
        }
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
// Scheduled execution tick — driven per-minute by the in-process scheduler
// (lib/scheduler.server.ts), which passes the UTC minute being processed so
// missed minutes can be caught up.
// ---------------------------------------------------------------------------

const MAX_RUNS_PER_TICK = 25; // Pi capacity knob — concurrent runs share the app process
const RUN_TIMEOUT_MS = 600_000; // policy, not a platform budget (the 300s serverless cap is gone)
// stranded 'running' rows are declared dead once safely past the run budget
const JANITOR_AFTER_S = RUN_TIMEOUT_MS / 1000 + 300;
const MAX_LOG_LINES = 300;
const MAX_LOG_LINE_CHARS = 2_000;
const RUNS_KEPT_PER_WORKFLOW = 50;
const CLAIM_GUARD_FLOOR_S = 50;

type ClaimedWorkflow = { id: string; user_id: string; name: string; graph: WorkflowGraph };

export async function runDueWorkflows(
    at: Date = new Date(),
): Promise<{ due: number; ran: number }> {
    // janitor: a killed process (deploy restart, crash) strands rows in
    // 'running'; anything well past the RUN_TIMEOUT_MS budget is dead
    await db.query(
        `update workflow_run
            set status = 'error',
                error = 'run never finished (process terminated)',
                finished_at = now()
          where status = 'running' and started_at < now() - make_interval(secs => $1)`,
        [JANITOR_AFTER_S],
    );

    // candidate select — the jsonb containment check drops graphs that could
    // never run on a schedule (no schedule node). Cron now lives in each
    // schedule node's config, so we load the graph to read it.
    const { rows: candidates } = await db.query<{ id: string; user_id: string; graph: WorkflowGraph }>(
        `select id, user_id, graph from workflow
          where active
            and graph->'nodes' @> '[{"type":"schedule"}]'`,
    );

    const matched = candidates.filter((c) => matchingScheduleNodeIds(c.graph, at).length > 0);
    if (matched.length === 0) return { due: 0, ran: 0 };
    const toClaim = matched.slice(0, MAX_RUNS_PER_TICK);

    // batch tier resolution — one query for all candidate owners
    const levels = await getActivationLevels([...new Set(toClaim.map((c) => c.user_id))]);

    const claimed: ClaimedWorkflow[] = [];
    for (const c of toClaim) {
        const floor = limitsFor(levels.get(c.user_id) ?? null).cronFloorMinutes;
        // the guard doubles as the run-time tier-floor clamp: a downgraded
        // user's '* * * * *' degrades to their floor instead of erroring.
        // -30s absorbs tick jitter; the 50s floor makes duplicate
        // same-minute ticks (catch-up bursts, a stray second process) no-ops.
        const guardSeconds = Math.max(CLAIM_GUARD_FLOOR_S, floor * 60 - 30);
        // atomic claim via single-statement conditional UPDATE — session
        // advisory locks are unsafe on pgbouncer transaction pooling (Neon),
        // and tick sources can overlap (see the guard comment above)
        const { rows } = await db.query<ClaimedWorkflow>(
            `update workflow set last_run_at = now()
              where id = $1
                and active
                and (last_run_at is null or last_run_at <= now() - make_interval(secs => $2))
              returning id, user_id, name, graph`,
            [c.id, guardSeconds],
        );
        if (rows[0]) claimed.push(rows[0]);
    }

    // runOne never rejects, but allSettled keeps one pathological failure
    // from ever sinking its siblings. Fire only the schedule nodes matching
    // this minute (recomputed from the claimed graph).
    await Promise.allSettled(
        claimed.map((wf) => runOne(wf, matchingScheduleNodeIds(wf.graph, at))),
    );
    return { due: matched.length, ran: claimed.length };
}

// schedule nodes whose config.cron fires at `at` — the entry points a cron
// tick should trigger (a workflow may hold several with different crons)
function matchingScheduleNodeIds(graph: WorkflowGraph, at: Date): string[] {
    return graph.nodes
        .filter((n) => n.type === "schedule" && cronMatches((n.config.cron ?? "").trim(), at))
        .map((n) => n.id);
}

// executes one claimed workflow and persists its workflow_run row. Catches
// everything — nothing may reject out of the tick.
async function runOne(wf: ClaimedWorkflow, entryNodeIds: string[]): Promise<void> {
    await executeWorkflowRun(wf, { trigger: "cron", entryNodeIds });
}

export type WorkflowRunResult = {
    runId: string | null; // null when even the run row couldn't be recorded
    status: "success" | "error";
    error: string;
    log: ConsoleLine[];
};

// shared execution core: records a workflow_run, executes the graph with the
// owner's registry catalog and the server hooks, persists status/log, prunes
// history. Never rejects — the cron tick (trigger 'cron'), the MCP server's
// run_workflow tool (trigger 'manual'), and the event ingress (trigger
// 'event') all consume errors as values.
export async function executeWorkflowRun(
    wf: { id: string; user_id: string; graph: WorkflowGraph },
    opts: {
        trigger: "cron" | "manual" | "event";
        timeoutMs?: number;
        entryNodeIds?: string[];
        eventPayloads?: Record<string, string>;
    },
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
        // '(deleted)' placeholders so stale node types stay inert, not fatal.
        // Prototype chain instead of spreading the (invariant) static catalog
        // per run — per-run writes stay own-properties.
        const byKey: Record<string, CatalogEntry> = Object.create(CATALOG_BY_KEY);
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
                callMemory: (memoryId, op, input) =>
                    executeMemoryTool(wf.user_id, memoryId, op, input, opts.trigger),
                callSandbox: (sandboxId, op, input) =>
                    executeSandboxTool(wf.user_id, sandboxId, op, input),
                callIntegration: (providerId, config, message) =>
                    executeIntegration(wf.user_id, providerId, config, message),
                callAgent: (req) => executeAgentTurn(wf.user_id, req, opts.trigger),
                signal: controller.signal,
            }, { entryNodeIds: opts.entryNodeIds, eventPayloads: opts.eventPayloads });
        } catch (err) {
            thrown = err instanceof Error ? err.message : "run failed";
        } finally {
            clearTimeout(timer);
        }

        if (dropped > 0) log.push({ kind: "info", text: `(${dropped} lines truncated)` });

        // the interpreter *returns* after emitting "no event node"/"run
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
