// User registry: MCP servers and skills added in dashboard settings
// (registry_entry table). Rows convert to workflow CatalogEntry nodes
// keyed "mcp:<uuid>" / "skill:<uuid>" so the designer can render them.
// Client-safe (no pg import) — the DB query lives in lib/registry.server.ts.
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

// legacy generic mcp node / skill node — two port rows, at most one config
// row. The mcp shape survives only so graphs saved before per-tool nodes
// keep resolving; buildUserCatalog flags it legacy (hidden from the toolbox).
export function toCatalogEntry(row: RegistryEntryRow): CatalogEntry {
    const base = {
        key: userNodeKey(row.kind, row.id),
        label: row.name,
        inputs: [flowIn, valuePort("input")],
        outputs: [flowOut, valuePort("result")],
    };
    if (row.kind === "mcp") {
        return {
            ...base,
            category: "mcp",
            config: [{
                id: "tool",
                label: "tool",
                input: "select",
                options: row.tools.filter((t) => t.enabled).map((t) => t.name),
            }],
            logoDomain: faviconDomain(row.server_url),
        };
    }
    return { ...base, category: "skill", emoji: row.emoji };
}

// "p_" prefix keeps param port/config ids clear of reserved ids
// (in/out/result, the legacy tool select) — schema keys can be anything
export const paramPortId = (name: string) => `p_${name}`;

// one designer node per enabled tool. Discovered tools carry params: each
// becomes a value input port plus a config text field used as a literal
// fallback when the port isn't connected (the if.b/b_literal pattern).
// Manually added tools have no params → a raw-JSON "input" port instead.
function toToolEntry(row: RegistryEntryRow, tool: McpTool): CatalogEntry | null {
    const key = `mcp:${row.id}:${tool.name}`;
    if (key.length > MAX_NODE_TYPE_LENGTH) return null; // overlong discovered name — skip
    const base = {
        key,
        category: "mcp" as const,
        label: tool.name,
        group: row.name,
        logoDomain: faviconDomain(row.server_url),
        toolName: tool.name,
        outputs: [flowOut, valuePort("result")],
    };
    if (!tool.params) return { ...base, inputs: [flowIn, valuePort("input")] };
    return {
        ...base,
        params: tool.params,
        inputs: [
            flowIn,
            ...tool.params.map((p) =>
                valuePort(paramPortId(p.name), p.required ? `${p.name}*` : p.name),
            ),
        ],
        config: tool.params.map((p) => ({
            id: paramPortId(p.name),
            label: p.name,
            overriddenBy: paramPortId(p.name),
            ...(p.type === "boolean"
                ? { input: "select" as const, options: ["true", "false"] }
                : { input: p.type === "number" ? ("number" as const) : ("text" as const) }),
        })),
    };
}

export const buildUserCatalog = (rows: RegistryEntryRow[]): CatalogEntry[] =>
    rows.flatMap((row) => {
        if (row.kind === "skill") return [toCatalogEntry(row)];
        const toolEntries = row.tools
            .filter((t) => t.enabled)
            .flatMap((t) => toToolEntry(row, t) ?? []);
        return [...toolEntries, { ...toCatalogEntry(row), legacy: true }];
    });
