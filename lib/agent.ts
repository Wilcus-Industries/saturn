// Client-safe agent types and helpers shared by the workflow test-run
// interpreter (browser) and the callAgentModel server action. Server-only
// code (OpenRouter client, prompt assembly) lives in lib/agent.server.ts —
// same layering split as lib/registry.ts / lib/registry.server.ts.

// a granted MCP tool, resolved to its registry entry — the wire-format
// function names OpenRouter sees never leave the server. exclude is only
// meaningful on ALL_TOOLS refs: tool names the server node's per-node
// selection withholds from the server-side expansion.
export type AgentToolRef = { entryId: string; toolName: string; exclude?: string[] };

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

// sentinel toolName of the MCP server grant chip (node type "mcp:<uuid>:*"
// — the only mcp node type the catalog emits). It resolves like any tool
// ref but expands server-side to the server's every enabled + callable tool
// minus the ref's exclude list — no real tool is ever named "*" (registry
// skips one that is), so the sentinel can't collide.
export const ALL_TOOLS = "*";
export const isAllToolsRef = (ref: AgentToolRef): boolean => ref.toolName === ALL_TOOLS;

// per-node tool selection: a server node's config.exclude holds a JSON
// array (as a string — graph config values are strings) of tool names to
// withhold. Caps mirror lib/registry.ts's MAX_MCP_TOOLS / tool-name length
// (importing registry here would cycle: registry imports this module).
export const MAX_EXCLUDED_TOOLS = 40;

export const isToolExclusionList = (x: unknown): x is string[] =>
    Array.isArray(x) &&
    x.length <= MAX_EXCLUDED_TOOLS &&
    x.every((s) => typeof s === "string" && s.length > 0 && s.length <= 60);

// "" / absent → [] (all tools granted); null = malformed (callers warn and
// grant all, matching the runtime's fail-open expansion)
export function parseToolExclusions(raw: string | undefined): string[] | null {
    if (!raw?.trim()) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return isToolExclusionList(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// grants resolve statically from the source chip node's type, never by
// evaluating it as a value. Node types are "mcp:<36-char-uuid>:<toolName>"
// and "skill:<uuid>" — fixed-offset slices, never split: tool names may
// contain ":". "mcp:" is 4 chars, so the uuid spans [4,40) and ":" sits at
// index 40; a valid tool name is the non-empty remainder from 41. The parse
// still accepts retired per-tool types ("mcp:<uuid>:<toolName>") — the
// interpreter's catalog-entry gate drops those grants, not the parser.
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
