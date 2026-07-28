// User registry: MCP servers and skills added in dashboard settings
// (registry_entry table). Rows convert to workflow CatalogEntry nodes
// keyed "mcp:<uuid>:*" / "skill:<uuid>" so the designer can render them.
// Client-safe — the SQLite query and every mutation live in
// src-tauri/src/registry.rs, reached over IPC (lib/ipc.tsx).
import { ALL_TOOLS } from "@/lib/agent";
import { type CatalogEntry, type McpToolParam, valuePort } from "@/lib/workflow";

type RegistryKind = "mcp" | "skill" | "memory" | "variable" | "saturn";
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
    workspace: string; // saturn builtin row only — '' = the default ~/Saturn
    tools: McpTool[];
    has_token: boolean; // derived — auth_token itself is never selected
    connected: boolean; // derived — oauth tokens themselves are never selected
    secret: boolean; // variable only — true = write-only, false = viewable/editable
    value: string; // plaintext for regular (non-secret) variables only; '' otherwise
};

export const MAX_MCP_TOOLS = 40;

// Saturn Agent's own memory store, seeded by store.rs's SCHEMA and mirrored in
// src-tauri/src/saturn.rs as MEMORY_ID. Rename, wipe and per-item delete all
// stay allowed; only the store itself is undeletable (registry::delete_entry
// refuses, so the UI hides the button rather than being the guard).
export const SATURN_MEMORY_ID = "00000000-0000-4000-8000-000000000001";

const userNodeKey = (kind: RegistryKind, id: string) => `${kind}:${id}`;

// canonical uuid shape check, shared by every id-validating route/action/tool.
// Anchored + case-insensitive, never /g — no lastIndex state, so one shared
// object is safe to .test() from anywhere.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Secret variables (kind 'variable'): the node evaluates to an opaque
// sentinel client-side; only executeIntegration swaps in the real value,
// server-side, scoped to the owning user. The plaintext never enters the
// graph, the interpreter, logs, or onValue samples.
const VARIABLE_PREFIX = "variable:";
export function variableIdFromNodeType(type: string): string | null {
    if (!type.startsWith(VARIABLE_PREFIX)) return null;
    const id = type.slice(VARIABLE_PREFIX.length);
    return UUID_RE.test(id) ? id : null;
}
export const variableSentinel = (id: string) => `{{var:${id}}}`;
// reverse of variableSentinel: a config field holding exactly a variable
// sentinel resolves to its uuid (else null). Lets a value snap directly into
// an app/event config box — no edge, no standalone box.
export function variableIdFromSentinel(value: string): string | null {
    const m = value.match(/^\{\{var:(.+)\}\}$/i);
    return m && UUID_RE.test(m[1]) ? m[1] : null;
}

// favicon lookup wants the brand's apex domain, not the MCP host —
// agent.robinhood.com's favicon is a blank, robinhood.com's is the logo
export function faviconDomain(serverUrl: string): string {
    const host = new URL(serverUrl).hostname;
    // a locally-served MCP server (127.0.0.1, [::1], localhost, a .local name)
    // has no brand to look up — "" means "letter tile, and no request to google"
    if (!host.includes(".") || /^[\d.]+$/.test(host) || host.endsWith(".local")) return "";
    const labels = host.split(".");
    return labels.length <= 2 ? host : labels.slice(-2).join(".");
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
        description: row.description,
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
        description: row.description,
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

// secret variable value box: a read-only literal-shaped node showing only the
// variable's name. Its single value output evaluates to the {{var:<uuid>}}
// sentinel — never the secret itself (see VARIABLE_PREFIX above).
function toVariableEntry(row: RegistryEntryRow): CatalogEntry {
    return {
        key: userNodeKey(row.kind, row.id),
        label: row.name,
        category: "variable",
        secret: row.secret, // splits the value box color: violet secret / sky regular
        inputs: [],
        outputs: [valuePort("value")],
    };
}

// chat grant chip: a single "session" value output wired into an agent's
// "session" port makes that agent's conversation persist across runs. NOT a
// registry kind — chats are `saturn_session` rows with their own table and
// CRUD — so this is a fourth source of catalog entries, merged into byKey
// alongside CATALOG and buildUserCatalog. Mirrors src-tauri/src/saturn.rs's
// session_catalog: change one, change both.
export const sessionEntry = (id: string, name: string): CatalogEntry => ({
    key: `session:${id}`,
    label: name,
    category: "session",
    inputs: [],
    outputs: [valuePort("session")],
    // chips render their emoji (skill/memory carry a user-chosen one); a chat
    // has no icon of its own, so every one of them wears the same speech bubble
    emoji: "💬",
});

// the builtin 'saturn' row is settings-only: its tools belong to Saturn Agent
// itself, not to an agent node's tools port, and it carries no server_url —
// toServerEntry's faviconDomain would throw on it inside the designer's render.
export const buildUserCatalog = (rows: RegistryEntryRow[]): CatalogEntry[] =>
    rows
        .filter((row) => row.kind !== "saturn")
        .map((row) =>
            row.kind === "skill"
                ? toSkillEntry(row)
                : row.kind === "memory"
                  ? toMemoryEntry(row)
                  : row.kind === "variable"
                    ? toVariableEntry(row)
                    : toServerEntry(row),
        );
