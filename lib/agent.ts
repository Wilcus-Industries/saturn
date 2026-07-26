// The agent caps and grant helpers the DESIGNER needs — validation warnings and
// the tool picker. Executing an agent turn is entirely Rust (src-tauri/src/
// agent.rs, openrouter.rs); these constants mirror the ones enforced there.

// grants are now edges from chip nodes into the agent's tools/skills ports —
// these cap how many an agent may carry (mirrored by src-tauri/src/agent.rs,
// enforced on every agent request in src-tauri/src/runner.rs)
export const MAX_GRANTED_TOOLS = 20;
export const MAX_GRANTED_SKILLS = 10;

// what a Saturn Agent turn runs on when nothing picked a model: the chat's
// initial selection, and what a saturn-agent node with a blank model field
// resolves to. Mirrors src-tauri/src/saturn.rs's DEFAULT_MODEL, which is the
// one the node actually uses — change one, change both.
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4.5";

// sentinel toolName of the MCP server grant chip (node type "mcp:<uuid>:*"
// — the only mcp node type the catalog emits). It resolves like any tool
// ref but expands server-side to the server's every enabled + callable tool
// minus the ref's exclude list — no real tool is ever named "*" (registry
// skips one that is), so the sentinel can't collide.
export const ALL_TOOLS = "*";

// per-node tool selection: a server node's config.exclude holds a JSON
// array (as a string — graph config values are strings) of tool names to
// withhold. Caps mirror lib/registry.ts's MAX_MCP_TOOLS / tool-name length
// (importing registry here would cycle: registry imports this module).
const MAX_EXCLUDED_TOOLS = 40;

const isToolExclusionList = (x: unknown): x is string[] =>
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
