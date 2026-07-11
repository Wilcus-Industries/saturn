// Client-safe agent types and helpers shared by the workflow test-run
// interpreter (browser) and the callAgentModel server action. Server-only
// code (OpenRouter client, prompt assembly) lives in lib/agent.server.ts —
// same layering split as lib/registry.ts / lib/registry.server.ts.

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

// result of one LLM turn (callAgentModel action / executeAgentTurn core);
// image is a data:image/… URL, set only for output=image agent turns
export type AgentModelResult =
    | { content: string; toolCalls: AgentToolCall[]; image?: string }
    | { error: string };

export const MAX_AGENT_TURNS = 8; // LLM calls per agent loop
export const MAX_AGENT_MESSAGES = 60; // transcript length cap per model call
export const MAX_TOOL_CALLS_PER_TURN = 5;

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
