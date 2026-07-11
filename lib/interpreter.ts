// Workflow graph interpreter. Walks the in-memory graph and emits console
// lines as it goes; runs both in the browser (the designer's ▶ test run,
// unsaved edits included) and server-side (the cron runner). Side effects
// happen only through the injected RunHooks: MCP nodes execute for real via
// callMcp (tokens never reach the browser); agent nodes drive their LLM
// loops here, one callAgent invocation per turn (the OpenRouter key stays
// server-side too); standalone skill nodes have no runtime yet and are
// skipped.
import {
    type AgentMessage,
    type AgentModelResult,
    type AgentToolRef,
    MAX_AGENT_MESSAGES,
    MAX_AGENT_TURNS,
    MAX_TOOL_CALLS_PER_TURN,
    type McpCallResult,
    parsePlan,
    parseSkillGrants,
    parseToolGrants,
} from "@/lib/agent";
import { paramPortId } from "@/lib/registry";
import type {
    CatalogEntry,
    McpToolParamType,
    WorkflowGraph,
    WorkflowNode,
} from "@/lib/workflow";

export type ConsoleLine = { kind: "print" | "info" | "warn" | "error"; text: string };

export type CallAgentRequest = {
    model: string;
    system: string;
    skillIds: string[];
    tools: AgentToolRef[];
    messages: AgentMessage[];
    jsonPlan?: boolean;
};

export type RunHooks = {
    emit: (line: ConsoleLine) => void;
    callMcp: (entryId: string, toolName: string, input: string) => Promise<McpCallResult>;
    // one LLM turn of an agent loop (the callAgentModel server action)
    callAgent: (req: CallAgentRequest) => Promise<AgentModelResult>;
    // reports every value computed during the run (nodeId + output portId);
    // the designer keeps these as samples for the extract path picker
    onValue?: (nodeId: string, portId: string, text: string) => void;
    // the topbar stop button; checked before each step (an in-flight MCP
    // call can't be interrupted, but its result is discarded)
    signal?: AbortSignal;
};

type RunValue = string | number | boolean;

// total work cap — real flow cycles are caught exactly (per-chain visited
// set), so this only stops pathological-but-legal graphs (huge nested loops)
const MAX_STEPS = 10_000;
// real network calls — keep a test run from hammering an MCP server
const MAX_MCP_CALLS = 20;
// agent-initiated MCP calls budget separately so a busy loop can't starve
// the graph's plain MCP nodes (and vice versa)
const MAX_AGENT_MCP_CALLS = 40;
// long tool results would drown the console
const MAX_RESULT_CHARS = 2000;
// tool output fed back to the model — larger than the console cap, the
// model usually needs more of the result than a human skimming a log
const MAX_MODEL_RESULT_CHARS = 8000;

// thrown after the error line is already emitted; unwinds to runWorkflow
class RunAbort extends Error {}

const fmt = (v: RunValue): string => String(v);

const truncate = (s: string): string =>
    s.length > MAX_RESULT_CHARS ? `${s.slice(0, MAX_RESULT_CHARS)}… (truncated)` : s;

function truthy(v: RunValue): boolean {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
    return v !== "" && v !== "false" && v !== "0";
}

// numeric when both sides coerce cleanly, string otherwise ("" is not numeric
// — Number("") is 0, which would make `"" == 0` true)
const asNumber = (v: RunValue): number =>
    typeof v === "string" && v.trim() === "" ? NaN : Number(v);

function compare(a: RunValue, b: RunValue, op: string): boolean {
    if (op === "contains") return String(a).includes(String(b));
    const na = asNumber(a);
    const nb = asNumber(b);
    const numeric = !Number.isNaN(na) && !Number.isNaN(nb);
    switch (op) {
        case "==": return numeric ? na === nb : String(a) === String(b);
        case "!=": return numeric ? na !== nb : String(a) !== String(b);
        case "<": return numeric ? na < nb : String(a) < String(b);
        case ">": return numeric ? na > nb : String(a) > String(b);
        case "<=": return numeric ? na <= nb : String(a) <= String(b);
        case ">=": return numeric ? na >= nb : String(a) >= String(b);
        default: return false;
    }
}

// loop items: JSON array if it parses, else comma-separated
function toList(items: RunValue): RunValue[] {
    if (typeof items !== "string") return [items];
    const trimmed = items.trim();
    if (trimmed === "") return [];
    if (trimmed.startsWith("[")) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed.map((x) =>
                    typeof x === "string" || typeof x === "number" || typeof x === "boolean"
                        ? x
                        : JSON.stringify(x),
                );
            }
        } catch {
            // fall through to comma-split
        }
    }
    return trimmed.split(",").map((s) => s.trim());
}

// one tool arg from its string source (port value or config literal) to the
// JSON type the tool's schema declares
function coerceParam(
    raw: string,
    type: McpToolParamType,
): { ok: true; value: unknown } | { ok: false } {
    switch (type) {
        case "string":
            return { ok: true, value: raw };
        case "number": {
            const n = raw.trim() === "" ? NaN : Number(raw);
            return Number.isNaN(n) ? { ok: false } : { ok: true, value: n };
        }
        case "boolean":
            return { ok: true, value: truthy(raw) };
        case "array": {
            const trimmed = raw.trim();
            if (trimmed.startsWith("[")) {
                try {
                    const parsed: unknown = JSON.parse(trimmed);
                    if (Array.isArray(parsed)) return { ok: true, value: parsed };
                } catch {
                    // fall through to comma-split
                }
            }
            return {
                ok: true,
                value: trimmed === "" ? [] : trimmed.split(",").map((s) => s.trim()),
            };
        }
        case "object": {
            try {
                const parsed: unknown = JSON.parse(raw);
                if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                    return { ok: true, value: parsed };
                }
            } catch {
                // not JSON
            }
            return { ok: false };
        }
    }
}

export async function runWorkflow(
    graph: WorkflowGraph,
    byKey: Record<string, CatalogEntry>,
    { emit, callMcp, callAgent, onValue, signal }: RunHooks,
): Promise<void> {
    let steps = 0;
    let mcpCalls = 0;
    let agentMcpCalls = 0;
    const loopValues = new Map<string, RunValue>(); // loop nodeId → current item
    const results = new Map<string, string>(); // mcp nodeId → last tool result
    const saturnResults = new Map<string, string>(); // agent/await "nodeId:portId" → output
    const awaitArrivals = new Map<string, number>(); // await nodeId → flow arrivals so far
    let branchFailed = false; // a fan-out branch failed — siblings stop at their next step

    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
    const label = (node: WorkflowNode) => byKey[node.type]?.label ?? node.type;

    const fail = (text: string): never => {
        emit({ kind: "error", text });
        throw new RunAbort();
    };
    const warn = (text: string) => emit({ kind: "warn", text });

    // flow outputs may fan out — every edge's target, in graph edge order
    const followFlowAll = (nodeId: string, portId: string): WorkflowNode[] =>
        graph.edges
            .filter((e) => e.kind === "flow" && e.from.nodeId === nodeId && e.from.portId === portId)
            .map((e) => nodeById.get(e.to.nodeId))
            .filter((n): n is WorkflowNode => !!n);

    const incomingValueEdge = (nodeId: string, portId: string) =>
        graph.edges.find(
            (e) => e.kind === "value" && e.to.nodeId === nodeId && e.to.portId === portId,
        );

    // multi-edge value input (await "values") — all incoming edges, edge order
    const incomingValueEdges = (nodeId: string, portId: string) =>
        graph.edges.filter(
            (e) => e.kind === "value" && e.to.nodeId === nodeId && e.to.portId === portId,
        );

    // per-step eval state: the memo (a diamond of value edges would re-evaluate
    // upstream ports exponentially and repeat every warn) and the value-cycle
    // stack. Local to each flow step so concurrent fan-out branches can't
    // clobber each other — a shared stack would also flag false cycles when
    // two branches read the same output at once.
    type EvalCtx = { memo: Map<string, RunValue>; stack: Set<string> };

    function evalInput(node: WorkflowNode, portId: string, ctx: EvalCtx): RunValue {
        const edge = incomingValueEdge(node.id, portId);
        if (!edge) {
            warn(`${label(node)}: input "${portId}" not connected — using ""`);
            return "";
        }
        return evalOutput(edge.from.nodeId, edge.from.portId, ctx);
    }

    // memoizes within one flow step; also reports each computed value as a
    // picker sample
    function evalOutput(nodeId: string, portId: string, ctx: EvalCtx): RunValue {
        const key = `${nodeId}:${portId}`;
        const memoized = ctx.memo.get(key);
        if (memoized !== undefined) return memoized;
        const value = computeOutput(nodeId, portId, ctx);
        ctx.memo.set(key, value);
        onValue?.(nodeId, portId, fmt(value));
        return value;
    }

    function computeOutput(nodeId: string, portId: string, ctx: EvalCtx): RunValue {
        const node = nodeById.get(nodeId);
        if (!node) return "";
        const key = `${nodeId}:${portId}`;
        if (ctx.stack.has(key)) fail("value cycle detected");
        ctx.stack.add(key);
        try {
            const entry = byKey[node.type];
            switch (node.type) {
                case "literal": {
                    const value = node.config.value ?? "";
                    if (node.config.valueType !== "number") return value;
                    const n = Number(value.trim());
                    if (Number.isNaN(n)) {
                        warn(`literal "${value}" is not a number — using 0`);
                        return 0;
                    }
                    return n;
                }
                case "and":
                    return truthy(evalInput(node, "a", ctx)) && truthy(evalInput(node, "b", ctx));
                case "or":
                    return truthy(evalInput(node, "a", ctx)) || truthy(evalInput(node, "b", ctx));
                case "not":
                    return !truthy(evalInput(node, "in", ctx));
                case "extract": {
                    const path = (node.config.path ?? "").trim();
                    const raw = fmt(evalInput(node, "value", ctx));
                    let cur: unknown;
                    try {
                        cur = JSON.parse(raw);
                    } catch {
                        warn(`extract: value is not JSON — using ""`);
                        return "";
                    }
                    for (const seg of path ? path.split(".") : []) {
                        if (Array.isArray(cur)) {
                            cur = cur[Number(seg)];
                        } else if (typeof cur === "object" && cur !== null) {
                            cur = (cur as Record<string, unknown>)[seg];
                        } else {
                            cur = undefined;
                        }
                        if (cur === undefined) {
                            warn(`extract: path "${path}" not found — using ""`);
                            return "";
                        }
                    }
                    if (
                        typeof cur === "string" ||
                        typeof cur === "number" ||
                        typeof cur === "boolean"
                    ) {
                        return cur;
                    }
                    return JSON.stringify(cur);
                }
                case "loop": {
                    const item = loopValues.get(node.id);
                    if (item === undefined) {
                        warn(`loop "item" read outside an iteration — using ""`);
                        return "";
                    }
                    return item;
                }
                case "agent":
                case "await": {
                    const stored = saturnResults.get(key);
                    if (stored === undefined) {
                        warn(`${label(node)}: "${portId}" read before the node ran — using ""`);
                        return "";
                    }
                    return stored;
                }
                default: {
                    if (entry?.category === "mcp") {
                        const result = results.get(node.id);
                        if (result === undefined) {
                            warn(`${label(node)}: "result" read before the node ran — using ""`);
                            return "";
                        }
                        return result;
                    }
                    if (entry?.category === "skill") return "";
                    warn(`cannot evaluate output "${portId}" of ${label(node)} — using ""`);
                    return "";
                }
            }
        } finally {
            ctx.stack.delete(key);
        }
    }

    // one LLM agent loop: call the model, execute its tool calls via
    // callMcp, feed results back, repeat until it answers without tools or
    // a cap trips. Failures emit + throw RunAbort via fail.
    async function runAgentLoop(opts: {
        prefix: string; // console prefix ("agent")
        system: string;
        model: string;
        toolRefs: AgentToolRef[];
        skillIds: string[];
        userText: string;
        jsonPlan: boolean;
    }): Promise<string> {
        if (!opts.model) fail(`${opts.prefix}: no model set`);
        const messages: AgentMessage[] = [
            { role: "user", content: opts.userText || "(no input)" },
        ];
        let content = "";
        for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
            if (signal?.aborted) fail("run stopped");
            emit({ kind: "info", text: `${opts.prefix}: calling ${opts.model}…` });
            const res = await callAgent({
                model: opts.model,
                system: opts.system,
                skillIds: opts.skillIds,
                tools: opts.toolRefs,
                messages,
                jsonPlan: opts.jsonPlan,
            });
            if ("error" in res) fail(`${opts.prefix}: ${res.error}`);
            content = "content" in res ? res.content : "";
            const allCalls = "toolCalls" in res ? res.toolCalls : [];
            const calls = allCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
            if (allCalls.length > calls.length) {
                warn(
                    `${opts.prefix}: ${allCalls.length - calls.length} tool call(s) over the per-turn cap (${MAX_TOOL_CALLS_PER_TURN}) dropped`,
                );
            }
            if (!calls.length) {
                emit({ kind: "info", text: truncate(`${opts.prefix} → ${content || "(empty)"}`) });
                return content;
            }
            messages.push({ role: "assistant", content, toolCalls: calls });
            for (const call of calls) {
                if (signal?.aborted) fail("run stopped");
                if (++agentMcpCalls > MAX_AGENT_MCP_CALLS) {
                    fail(`agent MCP call limit (${MAX_AGENT_MCP_CALLS}) exceeded for one run`);
                }
                emit({ kind: "info", text: `${opts.prefix}: → ${call.toolName}…` });
                const result = await callMcp(call.entryId, call.toolName, call.arguments);
                let text: string;
                if ("error" in result) {
                    // feed the error back — the model can often recover
                    warn(`${opts.prefix}: ${call.toolName}: ${result.error}`);
                    text = `Error: ${result.error}`;
                } else {
                    text = result.text;
                    emit({
                        kind: "info",
                        text: truncate(`${opts.prefix}: ${call.toolName} → ${text || "(empty)"}`),
                    });
                }
                messages.push({
                    role: "tool",
                    toolCallId: call.id,
                    content:
                        text.length > MAX_MODEL_RESULT_CHARS
                            ? `${text.slice(0, MAX_MODEL_RESULT_CHARS)}… (truncated)`
                            : text,
                });
            }
            // keep headroom for next turn's assistant + tool messages —
            // the action rejects transcripts over MAX_AGENT_MESSAGES
            if (messages.length > MAX_AGENT_MESSAGES - MAX_TOOL_CALLS_PER_TURN - 1) {
                warn(`${opts.prefix}: transcript limit reached`);
                return content;
            }
        }
        warn(`${opts.prefix}: turn limit (${MAX_AGENT_TURNS}) reached`);
        return content;
    }

    // dispatch a flow output: nothing, one chain, or a concurrent fan-out
    async function execFrom(nodeId: string, portId: string, visited: Set<string>): Promise<void> {
        const targets = followFlowAll(nodeId, portId);
        if (targets.length === 0) return;
        if (targets.length === 1) return execChain(targets[0], visited);
        return runFanOut(targets, visited);
    }

    // fan-out width is uncapped on purpose: edges are hand-drawn, the save
    // action caps edge counts, and MAX_STEPS bounds total work
    let fanOutDepth = 0;
    async function runFanOut(targets: WorkflowNode[], visited: Set<string>): Promise<void> {
        fanOutDepth++;
        try {
            // each branch gets a copy of the chain's visited set: a cycle back
            // through the fan-out is still caught, but branches reconverging
            // on a shared downstream node aren't a false cycle
            const settled = await Promise.allSettled(
                targets.map((t) =>
                    execChain(t, new Set(visited)).catch((err: unknown) => {
                        // first failure aborts the run — flag it so sibling
                        // branches stop at their next step check instead of
                        // emitting past the abort (in-flight network calls
                        // still finish, as with the stop button)
                        branchFailed = true;
                        throw err;
                    }),
                ),
            );
            const rejected = settled.find((s) => s.status === "rejected");
            if (rejected) throw rejected.reason;
        } finally {
            // once no concurrent chain is left, a partially-arrived await is
            // provably dead (an upstream `if` diverged past it) — warn and
            // reset so a later loop iteration starts a fresh barrier
            if (--fanOutDepth === 0 && !branchFailed && !signal?.aborted) {
                for (const [id, arrived] of awaitArrivals) {
                    const expected = graph.edges.filter(
                        (e) => e.kind === "flow" && e.to.nodeId === id && e.to.portId === "in",
                    ).length;
                    warn(`await never completed (${arrived}/${expected} branches)`);
                }
                awaitArrivals.clear();
            }
        }
    }

    // walks one flow chain; recurses for loop bodies and fan-outs (a flow
    // output with several edges runs each downstream chain concurrently).
    // Revisiting a node within the same chain can only mean an infinite
    // cycle; reconverging branches carry separate copies of `visited`, so a
    // shared downstream node runs once per arriving branch (last-writer-wins
    // on its stored results — put an await between them to join instead).
    async function execChain(start: WorkflowNode, visited: Set<string>): Promise<void> {
        let node: WorkflowNode | null = start;
        while (node) {
            if (signal?.aborted) fail("run stopped");
            if (branchFailed) throw new RunAbort(); // sibling already printed the error
            if (visited.has(node.id)) fail(`flow cycle detected at "${label(node)}"`);
            visited.add(node.id);
            if (++steps > MAX_STEPS) fail(`step limit (${MAX_STEPS}) exceeded`);
            const ctx: EvalCtx = { memo: new Map(), stack: new Set() };
            const entry = byKey[node.type];
            let next: string | null;
            switch (node.type) {
                case "print": {
                    const msg = node.config.message ?? "";
                    const hasValue = !!incomingValueEdge(node.id, "value");
                    const value = hasValue ? fmt(evalInput(node, "value", ctx)) : "";
                    const text = msg && hasValue ? `${msg} ${value}` : msg || value;
                    emit({ kind: "print", text });
                    next = "out";
                    break;
                }
                case "if": {
                    const op = node.config.operator;
                    if (!op) fail("if: no operator selected");
                    const a = evalInput(node, "a", ctx);
                    const b = incomingValueEdge(node.id, "b")
                        ? evalInput(node, "b", ctx)
                        : (node.config.b_literal ?? "");
                    next = compare(a, b, op!) ? "true" : "false";
                    break;
                }
                case "loop": {
                    for (const item of toList(evalInput(node, "items", ctx))) {
                        loopValues.set(node.id, item);
                        await execFrom(node.id, "body", new Set());
                    }
                    loopValues.delete(node.id);
                    next = "done";
                    break;
                }
                case "await": {
                    // join barrier: every incoming flow edge must arrive; the
                    // last arrival evaluates "values" and continues the chain
                    // (id: the filter closure loses TS's narrowing of `node`)
                    const id = node.id;
                    const expected = graph.edges.filter(
                        (e) => e.kind === "flow" && e.to.nodeId === id && e.to.portId === "in",
                    ).length;
                    const arrived = (awaitArrivals.get(node.id) ?? 0) + 1;
                    if (arrived < expected) {
                        awaitArrivals.set(node.id, arrived);
                        next = null; // this branch ends at the barrier
                        break;
                    }
                    awaitArrivals.delete(node.id); // a loop re-entry gets a fresh barrier
                    const values = incomingValueEdges(node.id, "values").map((e) =>
                        evalOutput(e.from.nodeId, e.from.portId, ctx),
                    );
                    const json = JSON.stringify(values);
                    saturnResults.set(`${node.id}:results`, json);
                    onValue?.(node.id, "results", json);
                    if (expected > 1) {
                        emit({
                            kind: "info",
                            text: `await: ${expected}/${expected} branches — continuing`,
                        });
                    }
                    next = "out";
                    break;
                }
                case "start":
                    next = "out"; // only reachable via a flow cycle
                    break;
                case "agent": {
                    const jsonPlan = node.config.output === "plan";
                    const result = await runAgentLoop({
                        prefix: "agent",
                        system: node.config.system ?? "",
                        model: (node.config.model ?? "").trim(),
                        toolRefs: parseToolGrants(node.config.tools ?? ""),
                        skillIds: parseSkillGrants(node.config.skills ?? ""),
                        userText: fmt(evalInput(node, "prompt", ctx)),
                        jsonPlan,
                    });
                    saturnResults.set(`${node.id}:result`, result);
                    onValue?.(node.id, "result", result);
                    if (jsonPlan) {
                        const tasks = parsePlan(result);
                        if (tasks) {
                            const planJson = JSON.stringify(tasks);
                            saturnResults.set(`${node.id}:plan`, planJson);
                            onValue?.(node.id, "plan", planJson);
                        } else {
                            warn(`agent: output is not a valid plan — "plan" port empty`);
                            saturnResults.set(`${node.id}:plan`, "");
                        }
                    }
                    next = "out";
                    break;
                }
                default:
                    if (entry?.category === "mcp") {
                        // legacy generic node ("mcp:<uuid>") picks its tool from
                        // config; per-tool nodes ("mcp:<uuid>:<tool>") carry it in
                        // the entry. entryId is a fixed-offset slice, never a
                        // split — tool names may contain ":".
                        const legacy = typeof entry.toolName !== "string";
                        const toolName = legacy ? node.config.tool : entry.toolName;
                        if (!toolName) {
                            warn(`${entry.label}: no tool selected — skipped`);
                            next = "out";
                            break;
                        }
                        if (++mcpCalls > MAX_MCP_CALLS) {
                            fail(`MCP call limit (${MAX_MCP_CALLS}) exceeded for one run`);
                        }
                        const entryId = legacy ? node.type.slice(4) : node.type.slice(4, 40);
                        let input: string;
                        if (entry.params) {
                            const args: Record<string, unknown> = {};
                            for (const p of entry.params) {
                                const portId = paramPortId(p.name);
                                let raw: string | null = null;
                                if (incomingValueEdge(node.id, portId)) {
                                    raw = fmt(evalInput(node, portId, ctx));
                                } else if ((node.config[portId] ?? "") !== "") {
                                    raw = node.config[portId];
                                }
                                if (raw === null) {
                                    if (p.required) {
                                        warn(`${entry.label}: required arg "${p.name}" not set — omitted`);
                                    }
                                    continue;
                                }
                                const coerced = coerceParam(raw, p.type);
                                if (!coerced.ok) {
                                    warn(`${entry.label}: arg "${p.name}" is not a valid ${p.type} — omitted`);
                                    continue;
                                }
                                args[p.name] = coerced.value;
                            }
                            input = JSON.stringify(args);
                        } else {
                            // no schema (legacy node or manually added tool) —
                            // raw-JSON escape hatch on the "input" port
                            input = incomingValueEdge(node.id, "input")
                                ? fmt(evalInput(node, "input", ctx))
                                : "";
                        }
                        const display = `${entry.group ?? entry.label} · ${toolName}`;
                        emit({ kind: "info", text: `calling ${display}…` });
                        const res = await callMcp(entryId, toolName, input);
                        if ("error" in res) fail(`${display}: ${res.error}`);
                        const text = "text" in res ? res.text : "";
                        results.set(node.id, text);
                        onValue?.(node.id, "result", text);
                        emit({
                            kind: "info",
                            text: truncate(`${display} → ${text || "(empty)"}`),
                        });
                        next = "out";
                    } else if (entry?.category === "skill") {
                        warn(`"${entry.label}" is not executable — skipped`);
                        next = "out";
                    } else {
                        // missing/deleted entry or a node with no flow semantics
                        warn(`"${label(node)}" skipped`);
                        next = null;
                    }
            }
            if (!next) {
                node = null;
                continue;
            }
            const targets = followFlowAll(node.id, next);
            if (targets.length > 1) {
                // a fan-out replaces the single-next continuation — the join
                // continues via an await node's own out edge instead
                await runFanOut(targets, visited);
                node = null;
            } else {
                node = targets[0] ?? null;
            }
        }
    }

    const start = graph.nodes.find((n) => n.type === "start");
    if (!start) {
        emit({ kind: "error", text: "no start node — add one from the toolbox" });
        return;
    }

    emit({ kind: "info", text: "▶ run started" });
    try {
        await execFrom(start.id, "out", new Set());
    } catch (err) {
        if (!(err instanceof RunAbort)) throw err;
        // a user stop already printed "run stopped" — skip the extra line
        if (!signal?.aborted) emit({ kind: "error", text: "run aborted" });
        return;
    }
    emit({ kind: "info", text: `run finished (${steps} steps)` });
}
