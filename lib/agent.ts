// Client-safe agent types and helpers shared by the workflow test-run
// interpreter (browser) and the callAgentModel server action. Server-only
// code (OpenRouter client, prompt assembly) lives in lib/agent.server.ts —
// same layering split as lib/registry.ts / lib/registry.server.ts.

// one task of a manager agent's structured plan (the agent node's
// output=plan port)
export type PlanTask = {
    id: string;
    title: string;
    instructions: string;
    complexity: "low" | "medium" | "high";
    input?: string;
};

// a granted MCP tool, resolved to its registry entry — the wire-format
// function names OpenRouter sees never leave the server
export type AgentToolRef = { entryId: string; toolName: string };

// a model-requested tool call, already decoded back to registry terms;
// arguments is the raw JSON-object string (callMcpTool's input contract)
export type AgentToolCall = {
    id: string;
    entryId: string;
    toolName: string;
    arguments: string;
};

export type AgentMessage =
    | { role: "user"; content: string }
    | { role: "assistant"; content: string; toolCalls?: AgentToolCall[] }
    | { role: "tool"; toolCallId: string; content: string };

// result of one real MCP tool call (callMcpTool action / executeMcpTool
// core) — errors return as values so consoles and run logs can render them
export type McpCallResult = { text: string } | { error: string };

// result of one LLM turn (callAgentModel action / executeAgentTurn core)
export type AgentModelResult =
    | { content: string; toolCalls: AgentToolCall[] }
    | { error: string };

export const MAX_AGENT_TURNS = 8; // LLM calls per agent loop
export const MAX_AGENT_MESSAGES = 60; // transcript length cap per model call
export const MAX_TOOL_CALLS_PER_TURN = 5;

export const PLAN_SCHEMA_PROMPT =
    'Respond with only JSON matching {"tasks":[{"id":string,"title":string,' +
    '"instructions":string,"complexity":"low"|"medium"|"high"}]}. ' +
    "Set each task's complexity to how hard it is, so it runs on a fittingly capable model.";

const isRecord = (x: unknown): x is Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x);

const COMPLEXITIES = ["low", "medium", "high"] as const;

// normalize one raw task; null when it lacks the required shape
function parseTask(x: unknown, index: number): PlanTask | null {
    if (!isRecord(x) || typeof x.instructions !== "string" || !x.instructions) return null;
    const complexity = COMPLEXITIES.includes(x.complexity as PlanTask["complexity"])
        ? (x.complexity as PlanTask["complexity"])
        : "medium";
    return {
        id: typeof x.id === "string" && x.id ? x.id : `task-${index + 1}`,
        title: typeof x.title === "string" ? x.title : "",
        instructions: x.instructions,
        complexity,
        ...(typeof x.input === "string" && x.input ? { input: x.input } : {}),
    };
}

// parse a plan out of model output — a bare array or {tasks:[...]}
// (json_object response_format forces an object wrapper). Invalid tasks are
// dropped; null when nothing usable remains.
export function parsePlan(text: string): PlanTask[] | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    const list = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.tasks : null;
    if (!Array.isArray(list)) return null;
    const tasks = list
        .map((task, i) => parseTask(task, i))
        .filter((t): t is PlanTask => t !== null);
    return tasks.length > 0 ? tasks : null;
}

// grant-picker config values are JSON string arrays; "" or junk → []
export function parseGrantIds(raw: string): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((x): x is string => typeof x === "string");
    } catch {
        return [];
    }
}

// tool grant ids are "<entryId>:<toolName>" — fixed-offset uuid slice, not a
// split, because tool names may contain ":"
export function parseToolGrants(raw: string): AgentToolRef[] {
    return parseGrantIds(raw)
        .filter((id) => id.length > 37 && id[36] === ":")
        .map((id) => ({ entryId: id.slice(0, 36), toolName: id.slice(37) }));
}

export function parseSkillGrants(raw: string): string[] {
    return parseGrantIds(raw);
}
