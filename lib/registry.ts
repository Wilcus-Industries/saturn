// User registry: MCP servers and skills added in dashboard settings
// (registry_entry table). Rows convert to workflow CatalogEntry nodes
// keyed "mcp:<uuid>" / "skill:<uuid>" so the designer can render them.
// Client-safe (no pg import) — the DB query lives in lib/registry.server.ts.
import { ALL_TOOLS } from "@/lib/agent";
import {
    type CatalogEntry,
    flowIn,
    flowOut,
    MAX_NODE_TYPE_LENGTH,
    type McpToolParam,
    valuePort,
} from "@/lib/workflow";

export type RegistryKind = "mcp" | "skill";
export type McpTool = {
    name: string;
    access: "read" | "write";
    enabled: boolean;
    readOnly?: boolean; // discovered readOnlyHint; absent (manual tool) = write-capable
    description?: string; // discovered — display-only in settings
    params?: McpToolParam[]; // discovered arg spec; absent for manually added tools
};

// call gate: blocks only a provable capability/grant mismatch — the server
// explicitly declares the tool write-capable (readOnly === false) while the
// user granted read-only. Unknown capability (manual tools, servers that
// send no annotations — most of them) trusts the user's grant: blocking
// there adds no safety, it just forces a pointless flip to read+write.
export const canCallTool = (tool: McpTool): boolean =>
    tool.readOnly !== false || tool.access === "write";

export type RegistryEntryRow = {
    id: string;
    kind: RegistryKind;
    name: string;
    emoji: string;
    description: string;
    server_url: string;
    tools: McpTool[];
    has_token: boolean; // derived — auth_token itself is never selected
    connected: boolean; // derived — oauth tokens themselves are never selected
};

export const MAX_ENTRIES_PER_KIND = 50;
export const MAX_MCP_TOOLS = 40;

export const userNodeKey = (kind: RegistryKind, id: string) => `${kind}:${id}`;

// favicon lookup wants the brand's apex domain, not the MCP host —
// agent.robinhood.com's favicon is a blank, robinhood.com's is the logo
export function faviconDomain(serverUrl: string): string {
    const host = new URL(serverUrl).hostname;
    const labels = host.split(".");
    return labels.length <= 2 ? host : labels.slice(-2).join(".");
}

// discovered tools replace the stored allowlist. access is the user's grant:
// a tool the user already configured keeps its enabled/access choices, except
// read-only tools are capped at "read" (a write grant there is meaningless).
// newly-seen read-only tools start on, write-capable ones start off.
// freshly discovered readOnly/description/params always overwrite what's stored.
export function mergeTools(
    existing: McpTool[],
    discovered: {
        name: string;
        readOnly: boolean | undefined;
        description?: string;
        params?: McpToolParam[];
    }[],
): McpTool[] {
    const byName = new Map(existing.map((t) => [t.name, t]));
    return discovered.slice(0, MAX_MCP_TOOLS).map(({ name, readOnly, description, params }) => {
        // readOnly: undefined deliberately lands in the object so it
        // overwrites a stale stored value (JSON serialization drops the key)
        const fresh = {
            readOnly,
            ...(description ? { description } : {}),
            ...(params ? { params } : {}),
        };
        const kept = byName.get(name);
        if (kept) return { ...kept, ...fresh, ...(readOnly ? { access: "read" as const } : {}) };
        // new tools: declared read-only start enabled; declared write-capable
        // start off at write; unknown start off at read (least privilege)
        if (readOnly === true) return { name, access: "read", enabled: true, ...fresh };
        if (readOnly === false) return { name, access: "write", enabled: false, ...fresh };
        return { name, access: "read", enabled: false, ...fresh };
    });
}

// legacy generic mcp node / skill grant chip. The mcp shape survives only so
// graphs saved before per-tool nodes keep resolving; buildUserCatalog flags
// it legacy (hidden from the toolbox). The skill node is a non-executable
// grant chip: a single "skill" value output wired into an agent's "skills"
// port grants the skill (resolved statically from the node type).
export function toCatalogEntry(row: RegistryEntryRow): CatalogEntry {
    const key = userNodeKey(row.kind, row.id);
    if (row.kind === "mcp") {
        return {
            key,
            label: row.name,
            category: "mcp",
            inputs: [flowIn, valuePort("input")],
            outputs: [flowOut, valuePort("result")],
            config: [{
                id: "tool",
                label: "tool",
                input: "select",
                options: row.tools.filter((t) => t.enabled).map((t) => t.name),
            }],
            logoDomain: faviconDomain(row.server_url),
        };
    }
    return {
        key,
        label: row.name,
        category: "skill",
        inputs: [],
        outputs: [valuePort("skill")],
        emoji: row.emoji,
    };
}

// one non-executable grant chip per enabled tool: a single "tool" value
// output wired into an agent's "tools" port grants it. Grants resolve
// statically from the node type ("mcp:<uuid>:<toolName>"), never by evaluating
// the chip — so the tool's params live only on the registry rows (server-side
// buildToolDefs), not on the node.
function toToolEntry(row: RegistryEntryRow, tool: McpTool): CatalogEntry | null {
    const key = `mcp:${row.id}:${tool.name}`;
    if (key.length > MAX_NODE_TYPE_LENGTH) return null; // overlong discovered name — skip
    return {
        key,
        category: "mcp",
        label: tool.name,
        group: row.name,
        logoDomain: faviconDomain(row.server_url),
        toolName: tool.name,
        inputs: [],
        outputs: [valuePort("tool")],
    };
}

// the "general MCP server" grant chip (key "mcp:<uuid>:*"): a single chip
// that grants an agent every enabled + callable tool of the server, instead
// of one chip per tool. Renders/connects exactly like a per-tool chip
// (category "mcp" + a toolName), but its sentinel toolName expands
// server-side in executeAgentTurn.
function toServerAllToolsEntry(row: RegistryEntryRow): CatalogEntry {
    return {
        key: `mcp:${row.id}:${ALL_TOOLS}`,
        category: "mcp",
        label: "All tools",
        group: row.name,
        logoDomain: faviconDomain(row.server_url),
        toolName: ALL_TOOLS,
        inputs: [],
        outputs: [valuePort("tool")],
    };
}

export const buildUserCatalog = (rows: RegistryEntryRow[]): CatalogEntry[] =>
    rows.flatMap((row) => {
        if (row.kind === "skill") return [toCatalogEntry(row)];
        // guard the sentinel: a real tool literally named "*" would collide
        // with the general-server chip's key, so it never becomes a chip
        const enabled = row.tools.filter((t) => t.enabled && t.name !== ALL_TOOLS);
        const toolEntries = enabled.flatMap((t) => toToolEntry(row, t) ?? []);
        // the general node is redundant for a single-tool server, so only
        // offer it once there are 2+ enabled tools; sorts first in the group
        const allTools = enabled.length >= 2 ? [toServerAllToolsEntry(row)] : [];
        return [...allTools, ...toolEntries, { ...toCatalogEntry(row), legacy: true }];
    });
