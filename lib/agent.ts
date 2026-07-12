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

// grants are now edges from chip nodes into the agent's tools/skills ports —
// these cap how many an agent may carry (mirrored by the server's request
// validation in lib/runner.server.ts)
export const MAX_GRANTED_TOOLS = 20;
export const MAX_GRANTED_SKILLS = 10;

// grants resolve statically from the source chip node's type, never by
// evaluating it as a value. Node types are "mcp:<36-char-uuid>:<toolName>"
// and "skill:<uuid>" — fixed-offset slices, never split: tool names may
// contain ":". "mcp:" is 4 chars, so the uuid spans [4,40) and ":" sits at
// index 40; a valid tool name is the non-empty remainder from 41.
export function toolRefFromNodeType(type: string): AgentToolRef | null {
    if (!type.startsWith("mcp:") || type[40] !== ":" || type.length <= 41) return null;
    return { entryId: type.slice(4, 40), toolName: type.slice(41) };
}

// "skill:" is 6 chars; a valid skill node type is exactly the prefix + a
// 36-char uuid remainder
export function skillIdFromNodeType(type: string): string | null {
    if (!type.startsWith("skill:") || type.length !== 42) return null;
    return type.slice(6);
}
