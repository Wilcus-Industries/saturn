// User registry: MCP servers and skills added in dashboard settings
// (registry_entry table). Rows convert to workflow CatalogEntry nodes
// keyed "mcp:<uuid>:*" / "skill:<uuid>" so the designer can render them.
// Client-safe (no pg import) — the DB query lives in lib/registry.server.ts.
import { ALL_TOOLS } from "@/lib/agent";
import { type CatalogEntry, type McpToolParam, valuePort } from "@/lib/workflow";

export type RegistryKind = "mcp" | "skill" | "memory";
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

// skill grant chip: a single "skill" value output wired into an agent's
// "skills" port grants the skill (resolved statically from the node type).
function toSkillEntry(row: RegistryEntryRow): CatalogEntry {
    return {
        key: userNodeKey(row.kind, row.id),
        label: row.name,
        category: "skill",
        inputs: [],
        outputs: [valuePort("skill")],
        emoji: row.emoji,
    };
}

// memory store grant chip: a single "memory" value output wired into an
// agent's "memory" port grants the store (resolved statically from the node
// type). Single-edge on the agent side — one memory store per agent.
function toMemoryEntry(row: RegistryEntryRow): CatalogEntry {
    return {
        key: userNodeKey(row.kind, row.id),
        label: row.name,
        category: "memory",
        inputs: [],
        outputs: [valuePort("memory")],
        emoji: row.emoji,
    };
}

// MCP server grant chip (key "mcp:<uuid>:*"): one non-executable chip per
// server. Wired into an agent's "tools" port it grants every enabled +
// callable tool — the sentinel toolName expands server-side in
// executeAgentTurn, minus the node's config.exclude selection (a JSON array
// string edited via the designer's tool picker; tools discovered later are
// auto-included unless excluded). tools lists exactly the expansion set so
// the picker and get_catalog never show a tool the runtime would skip.
// Always emitted, even with zero enabled tools — disabling everything in
// settings must not flip saved server nodes to "(deleted)".
function toServerEntry(row: RegistryEntryRow): CatalogEntry {
    return {
        key: `mcp:${row.id}:${ALL_TOOLS}`,
        category: "mcp",
        label: row.name,
        logoDomain: faviconDomain(row.server_url),
        toolName: ALL_TOOLS,
        inputs: [],
        outputs: [valuePort("tool")],
        config: [{ id: "exclude", label: "exclude", input: "text" }],
        // guard the sentinel: a real tool literally named "*" never grants
        tools: row.tools
            .filter((t) => t.enabled && canCallTool(t) && t.name !== ALL_TOOLS)
            .map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}) })),
    };
}

export const buildUserCatalog = (rows: RegistryEntryRow[]): CatalogEntry[] =>
    rows.map((row) =>
        row.kind === "skill"
            ? toSkillEntry(row)
            : row.kind === "memory"
              ? toMemoryEntry(row)
              : toServerEntry(row),
    );
