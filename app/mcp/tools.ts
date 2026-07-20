// Tool surface of the hosted workflow-editor MCP server: definitions
// (hand-written JSON Schemas — no schema lib in the stack) and the dispatch
// that executes them for the OAuth token's userId. Everything here reuses the
// same cores as the designer actions and the cron runner; tool-execution
// failures return as isError results, never as JSON-RPC errors.

import { MAX_GRANTED_SKILLS, MAX_GRANTED_TOOLS } from "@/lib/agent";
import { db } from "@/lib/db";
import { subscriptionsChanged } from "@/lib/events.server";
import { EXTENSION_EVENTS, eventNodeKey } from "@/lib/integrations";
import type { ConsoleLine } from "@/lib/interpreter";
import { buildUserCatalog } from "@/lib/registry";
import { getUserRegistry } from "@/lib/registry.server";
import { executeWorkflowRun, UUID } from "@/lib/runner.server";
import { baseUrl, getActivationLevels, limitsFor } from "@/lib/subscription";
import {
    CATALOG_BY_KEY,
    type CatalogEntry,
    isWorkflowGraph,
    MAX_EDGES,
    MAX_GRAPH_JSON,
    MAX_NODES,
    validateGraphStrict,
    type WorkflowGraph,
} from "@/lib/workflow";

const MAX_RUN_TIMEOUT_S = 240;
const MAX_LIST_RUNS = 50;

// ---------------------------------------------------------------------------
// definitions
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;
export type ToolDef = { name: string; description: string; inputSchema: JsonSchema };

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
});
const str = (description: string): JsonSchema => ({ type: "string", description });

const GRAPH_SCHEMA: JsonSchema = {
    type: "object",
    description:
        "Complete workflow graph: { nodes: [{id, type, x, y, config}], edges: [{id, from: {nodeId, portId}, to: {nodeId, portId}, kind}] }. See get_catalog for node types, ports and authoring rules.",
};

export const TOOL_DEFS: ToolDef[] = [
    {
        name: "list_workflows",
        description: "List the user's workflows: id, name, emoji, description, active flag, node count and last run time. The schedule lives inside the graph (a 'schedule' event node) — fetch it with get_workflow.",
        inputSchema: obj({}),
    },
    {
        name: "get_workflow",
        description:
            "Fetch one workflow: metadata plus the full node graph JSON. Each node carries a read-only `label` — the node type resolved to its human name (e.g. which MCP server an mcp:<uuid>:* grant is); trust it over guessing from the type string. Labels are informational and ignored on save.",
        inputSchema: obj({ id: str("Workflow id (uuid)") }, ["id"]),
    },
    {
        name: "create_workflow",
        description:
            "Create a workflow. It starts with an empty graph — author it with save_graph. To run on a schedule, add a 'schedule' event node (its config.cron is a 5-field UTC expression) and wire its flow output onward; the account tier caps how many workflows can exist and how tight the schedule may be.",
        inputSchema: obj(
            {
                name: str("Workflow name"),
                emoji: str("Single emoji icon (optional, default ⚙️)"),
                description: str("Short description (optional)"),
            },
            ["name"],
        ),
    },
    {
        name: "update_workflow",
        description: "Update workflow metadata (name, emoji, description, active). The schedule lives in the graph's 'schedule' node — change it with save_graph. active gates whether any events fire.",
        inputSchema: obj(
            {
                id: str("Workflow id (uuid)"),
                name: str("New name"),
                emoji: str("New emoji"),
                description: str("New description"),
                active: {
                    type: "boolean",
                    description: "true = events fire (scheduled runs enabled), false = paused (manual runs still work)",
                },
            },
            ["id"],
        ),
    },
    {
        name: "delete_workflow",
        description: "Permanently delete a workflow. Irreversible — the graph and the entire run history are removed.",
        inputSchema: obj({ id: str("Workflow id (uuid)") }, ["id"]),
    },
    {
        name: "get_catalog",
        description:
            "The node catalog available to this user (their registered MCP servers, skills and memory stores first, then built-in nodes) with every node's ports and config fields. Tool descriptions are trimmed for brevity — the full text reaches the agent at runtime. Call this before writing any graph; get_docs has the graph-format authoring guide.",
        inputSchema: obj({}),
    },
    {
        name: "get_docs",
        description:
            "The authoring guide for the workflow graph format: node/edge shapes, port kinds, wiring rules, event nodes and scheduling. Read it before writing your first graph; get_catalog has the concrete node types.",
        inputSchema: obj({}),
    },
    {
        name: "validate_graph",
        description: "Dry-run validation of a graph without saving: structural errors (bad ports, kind mismatches, duplicate edges, fan-in on single-edge value inputs) and warnings (unknown node types, no event node, blank/invalid schedule cron, unresolvable agent grants).",
        inputSchema: obj({ graph: GRAPH_SCHEMA }, ["graph"]),
    },
    {
        name: "save_graph",
        description: "Replace a workflow's entire graph. Rejects on structural errors; returns warnings that don't block saving. Validate with validate_graph first if unsure.",
        inputSchema: obj({ id: str("Workflow id (uuid)"), graph: GRAPH_SCHEMA }, ["id", "graph"]),
    },
    {
        name: "run_workflow",
        description:
            "Execute a workflow now, server-side, exactly like a scheduled run (real MCP tool calls, real model calls) and return the console log. Fires every event node in the graph. The run is recorded in the workflow's run history with trigger 'manual'. Requires an event node.",
        inputSchema: obj(
            {
                id: str("Workflow id (uuid)"),
                timeoutSeconds: {
                    type: "number",
                    description: `Abort the run after this many seconds (default and max ${MAX_RUN_TIMEOUT_S})`,
                },
            },
            ["id"],
        ),
    },
    {
        name: "list_runs",
        description: "Run history of a workflow, newest first: trigger, status, error and timing (without the full console logs — use get_run for those).",
        inputSchema: obj(
            {
                workflowId: str("Workflow id (uuid)"),
                limit: { type: "number", description: `Max rows (default ${MAX_LIST_RUNS})` },
            },
            ["workflowId"],
        ),
    },
    {
        name: "get_run",
        description: "One run of a workflow including its full console log.",
        inputSchema: obj(
            { workflowId: str("Workflow id (uuid)"), runId: str("Run id (uuid)") },
            ["workflowId", "runId"],
        ),
    },
];

// ---------------------------------------------------------------------------
// authoring guide served by get_docs
// ---------------------------------------------------------------------------

// one bullet per platform event descriptor — config, filters and the payload
// JSON shape are read straight from the descriptor so this never drifts
const EVENT_NODE_DOCS = EXTENSION_EVENTS.map((e) => {
    const filters = e.config.map((f) => f.id).filter((id) => !e.requiredConfig.includes(id));
    return `- ${eventNodeKey(e.id)} (${e.app} "${e.label}"): config ${
        e.config.map((f) => f.id).join(", ")
    } — required ${e.requiredConfig.join(", ") || "none"}${
        filters.length ? `, optional filters ${filters.join(", ")}` : ""
    }. Its "payload" value output is a JSON string shaped ${e.payloadDoc} — wire it into an extract node to pull a field (e.g. path "content").`;
}).join("\n");

const GRAPH_DOCS = `# Authoring Saturn workflow graphs

A graph is {"nodes": [...], "edges": [...]}.
Node: {"id": "<unique string>", "type": "<catalog key>", "x": <number>, "y": <number>, "config": {"<fieldId>": "<string value>"}}.
Edge: {"id": "<unique string>", "from": {"nodeId", "portId"}, "to": {"nodeId", "portId"}, "kind": "flow" | "value"} — from is always an output port, to an input port, and kind must match both ports' kind.

## Ports
- flow ports sequence execution. A flow output may fan out into several edges: the branches run CONCURRENTLY.
- value ports carry data (always strings; JSON for structured data). A value input accepts exactly ONE incoming edge — except ports marked "multi" (only await.values).
- A graph triggers from an event node (category "events"). The main one is "schedule" — its config.cron (5-field UTC expression: each field "*" or a plain integer, "*/n" with n 2-30 in the minute field only, e.g. "0 9 * * *" daily 09:00, "*/5 * * * *" every 5 min) sets when it fires; the platform "event:<id>" nodes (see below) fire in real time instead. A graph holds AT MOST ONE event node — it is the single entry point and execution follows flow edges from it (saving a graph with two or more is rejected). No event node ⇒ the workflow never triggers (a manual run_workflow still fires the event node).

## Config vs ports
Config fields hold literal strings. A field with "overriddenBy" is ignored when its named input port is connected. Numbers/booleans are written as strings.

## Built-in nodes
- schedule: scheduled entry point (config.cron, see above). if: routes flow to true/false comparing the left ("l") vs right ("r") operand value ports (config.operator). loop: runs body once per item of the JSON array on items, then done; item carries the current element. and/or/not: boolean values. string: emits config.value verbatim on its "out" value output. number: emits config.value coerced to a number ("out"). print: logs its "message" input — the connected port overrides the config.message literal (overriddenBy). concat: joins the "a" and "b" value inputs into one string on "out". extract: pulls a field out of a JSON value via config.path, dot-separated with numeric array indices ("data.results.0.price"). await: join barrier for parallel branches — continues when ALL incoming flow edges arrive; results = JSON array of its values edges (multi port), in edge order. model: emits config.model (an OpenRouter model id) on its "model" value output — connect it to an agent's model input.

## MCP server nodes (keys "mcp:<entryId>:*"), skill nodes (keys "skill:<uuid>") and memory nodes (keys "memory:<uuid>")
Grant chips — one MCP server node per registered server, one skill node per skill, one memory node per registered memory store. They have NO flow ports and are NOT executable on their own: a server node has a single value output "tool", a skill node a single value output "skill", a memory node a single value output "memory". That output connects nowhere except an agent's matching grant port ("tool" → agent "tools", "skill" → agent "skills", "memory" → agent "memory"); wiring it there grants the agent that server's tools / that skill / that memory store. Chips are never run or evaluated as values — the grant resolves statically from the node type. MCP tools therefore run only through agents.
A server node grants every enabled tool that passes the read/write gate (off or write-mismatched tools are silently skipped; the grantable list is each catalog entry's "tools" field). Optional config.exclude — a JSON array of tool names AS A STRING (e.g. "[\\"delete_file\\"]") — withholds specific tools from the grant: unknown names are ignored, and tools discovered later are granted automatically unless excluded. Old per-tool keys ("mcp:<entryId>:<toolName>") no longer exist — they render as inert "(deleted)" placeholders and grant nothing.
A memory node connects ONLY to an agent's "memory" port, and that port takes a SINGLE edge — one memory store per agent (wiring a second memory node replaces the first). At runtime the attached store gives the agent three built-in tools it calls itself — memory_search (semantic recall), memory_save (store a durable fact) and memory_forget (delete an item by id) — and injects the store's name into the system prompt. These three occupy tool slots, so an agent with a memory store attached can be granted at most 17 MCP tools (the tool cap is ${MAX_GRANTED_TOOLS}).

## Variable nodes (keys "variable:<uuid>")
Read-only secret value boxes, one per variable the user added in the designer toolbox. No inputs; a single value output "value" that connects to any ordinary value input. The output evaluates to an opaque placeholder {{var:<uuid>}} — NEVER the secret itself. Saturn substitutes the real value server-side ONLY inside integration nodes (config fields and message) at send time; everywhere else (print, agent prompts, MCP tool args, logs) the placeholder passes through literally. Use them to feed botToken/webhookUrl-style config ports without putting secrets in the graph.

## Agent node (type "agent")
LLM loop over built-in model credits (paid plans) with the user's OpenRouter key as fallback. Inputs: flow in; prompt (value); system (value, usually from a "string" node — config.system is a legacy fallback honored only when the port is unconnected); model (value, usually from a "model" node — config.model is a legacy fallback likewise); tools (value, multi — accepts ONLY MCP server node outputs); skills (value, multi — accepts ONLY skill node outputs); memory (value, SINGLE edge — accepts ONLY a memory node output; a second edge replaces the first, so an agent has at most ONE memory store, and the memory_search/memory_save/memory_forget tools it adds count against the tool cap, leaving room for at most 17 MCP tools). Config: output ("text" | "image" — image works only on models whose OpenRouter output modalities include image; any other value runs as text; image mode ignores tool grants and returns the first generated image) and reasoning ("off" | "low" | "medium" | "high" — maps to OpenRouter's reasoning parameter: "off" disables it, a level sets the effort, blank or any other value leaves the model default; only meaningful on models that support reasoning, and ignored entirely when output=image). Grants come from the connected chips: at most ${MAX_GRANTED_TOOLS} tools (after server-node expansion) and ${MAX_GRANTED_SKILLS} skills, resolved from each chip's node type; the agent may call granted tools itself during its loop. Output "result" carries the final text, or a data:image/… URL when output=image.

## Integration nodes (keys "integration:<provider>")
Outbound action nodes. Inputs: flow in, plus one value port PER CONFIG FIELD (same id) that overrides the field's literal when connected — so tokens, channel/chat ids, and messages can all be wired from upstream nodes (e.g. an extract node pulling chatId out of an event payload). Output: flow out; read-style actions additionally have a value output carrying their result, readable downstream only after the node's flow step ran. Messages truncate to the platform's cap (Discord 2000 chars, Telegram 4096); a message that is a data:image/… URL is uploaded as a file attachment/photo instead of text.
- integration:discord-webhook: config.webhookUrl must be a real https://discord.com/api/webhooks/… URL (validated server-side at run time).
- integration:discord-send-message: posts via the Discord bot API. config.botToken is a bot token (the same one an event:discord-mentioned node uses), config.channelId the numeric id of the channel to post in; the bot needs Send Messages permission there.
- integration:discord-read-messages: reads the channel's recent history via the Discord bot API (the bot needs Read Message History there). config.count = how many (1-100, default 20). Value output "messages" = a JSON array string, oldest first: [{id, author, bot, content, timestamp, attachments: [url]}] — wire it into an extract node or an agent's prompt. Telegram has no counterpart (its Bot API has no history endpoint).
- integration:discord-typing: triggers the bot's typing indicator in config.channelId (same botToken/channelId config, no message). config.status "on" fires it (Discord auto-expires it after ~10s or when the bot sends a message); "off" is a no-op — Discord has no cancel call.
- integration:telegram-send-message: posts via the Telegram bot API (sendMessage, or sendPhoto for an image data URL). config.botToken is a bot token from @BotFather (the same one an event:telegram-message node uses), config.chatId a numeric chat id (negative for groups) or @channelusername.
- integration:telegram-typing: triggers the bot's typing indicator in config.chatId (same botToken/chatId config, no message). config.status "on" fires it (Telegram auto-expires it after ~5s or when the bot sends a message); "off" is a no-op — Telegram has no cancel call.

## Event nodes (keys "event:<id>")
Inbound platform triggers that fire a run in real time (no cron). Category "events" like "schedule", so the one-event-per-graph rule applies: an event graph uses this node as its single entry point and has no "schedule" node. Each has a flow output "out" and a value output "payload" carrying the event as a JSON string. Delivery is gated by the workflow's active flag; every delivered event runs (no cooldown).
${EVENT_NODE_DOCS}
event:discord-mentioned fires when the user's Discord bot is @-mentioned in a server it belongs to; messages authored by any bot are ignored (loop guard). Leave guildId/channelId blank to fire on every mention, or set them to restrict to one server/channel.
event:telegram-message fires on any message the user's Telegram bot receives — direct messages always; group messages only when the bot's privacy mode is disabled via @BotFather (or the bot is a group admin). Leave chatId blank to fire on every chat, or set it (numeric id or @channelusername) to restrict to one chat.

## Layout
Positions are free-form; the designer snaps to a 24px grid. Readable default: columns left-to-right, x += 264 per step, y += 168 per parallel branch.

## Limits
Max ${MAX_NODES} nodes, ${MAX_EDGES} edges, ${MAX_GRAPH_JSON} bytes of graph JSON. Unknown node types are saved but render as inert "(deleted)" placeholders and do nothing at runtime.`;

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export type ToolResult = {
    content: { type: "text"; text: string }[];
    isError?: boolean;
};

// compact: graph/log-bearing results — pretty-printing inflates them 2-3×
// against the interpreter's per-result cap when an agent node is the caller
const ok = (data: unknown, compact = false): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(data, null, compact ? undefined : 2) }],
});
const fail = (message: string): ToolResult => ({
    content: [{ type: "text", text: message }],
    isError: true,
});

const asId = (x: unknown): string | null =>
    typeof x === "string" && UUID.test(x) ? x : null;

// catalog tool descriptions are for picking, not prompting — the full text
// reaches the model at runtime via buildToolDefs, so first line capped
const MAX_CATALOG_DESC = 150;
function trimDescription(d: string): string {
    const firstLine = d.split("\n", 1)[0].trim();
    return firstLine.length > MAX_CATALOG_DESC
        ? `${firstLine.slice(0, MAX_CATALOG_DESC)}…`
        : firstLine;
}

// static catalog + the owner's registry nodes — same byKey the designer and
// the runner use, minus missingEntry (unknown types must stay *unknown* here
// so validation can warn about them)
async function buildByKey(userId: string): Promise<Record<string, CatalogEntry>> {
    const byKey: Record<string, CatalogEntry> = { ...CATALOG_BY_KEY };
    for (const entry of buildUserCatalog(await getUserRegistry(userId))) {
        byKey[entry.key] = entry;
    }
    return byKey;
}

// isWorkflowGraph + size caps + strict structural validation, shared by
// validate_graph and save_graph
function checkGraph(
    graph: unknown,
    byKey: Record<string, CatalogEntry>,
): { graph: WorkflowGraph; errors: string[]; warnings: string[] } | { reject: string } {
    if (!isWorkflowGraph(graph)) {
        return {
            reject:
                "invalid graph shape — needs {nodes, edges} with unique string node ids, numeric x/y, string-valued config, and edges anchored to existing nodes",
        };
    }
    if (graph.nodes.length > MAX_NODES) return { reject: `too many nodes (max ${MAX_NODES})` };
    if (graph.edges.length > MAX_EDGES) return { reject: `too many edges (max ${MAX_EDGES})` };
    if (JSON.stringify(graph).length > MAX_GRAPH_JSON) {
        return { reject: `graph JSON too large (max ${MAX_GRAPH_JSON} bytes)` };
    }
    return { graph, ...validateGraphStrict(graph, byKey) };
}

async function tierFor(userId: string) {
    return (await getActivationLevels([userId])).get(userId) ?? null;
}

export async function dispatchTool(
    userId: string,
    name: string,
    args: Record<string, unknown>,
): Promise<ToolResult | null> {
    switch (name) {
        case "list_workflows": {
            const { rows } = await db.query<{
                id: string;
                name: string;
                emoji: string;
                description: string;
                active: boolean;
                node_count: number;
                last_run_at: Date | null;
            }>(
                `select id, name, emoji, description, active,
                        jsonb_array_length(graph->'nodes') as node_count, last_run_at
                   from workflow where user_id = $1 order by created_at desc`,
                [userId],
            );
            return ok(
                rows.map((r) => ({
                    id: r.id,
                    name: r.name,
                    emoji: r.emoji,
                    description: r.description,
                    active: r.active,
                    nodeCount: r.node_count,
                    lastRunAt: r.last_run_at,
                })),
            );
        }

        case "get_workflow": {
            const id = asId(args.id);
            if (!id) return fail("invalid workflow id");
            const { rows } = await db.query<{ graph: WorkflowGraph }>(
                `select id, name, emoji, description, active, graph, last_run_at, created_at, updated_at
                   from workflow where id = $1 and user_id = $2`,
                [id, userId],
            );
            if (!rows[0]) return fail("workflow not found");
            // annotate each node with its resolved catalog label — node types
            // like mcp:<uuid>:* are opaque to the caller, and agents guess
            // (wrongly) which server a uuid is without this. Labels are
            // re-resolved on every read, so one echoed back into save_graph
            // is harmless (extra node keys pass the shape guard).
            const byKey = await buildByKey(userId);
            const wf = rows[0];
            const nodes = Array.isArray(wf.graph?.nodes)
                ? wf.graph.nodes.map((n) => ({
                      ...n,
                      label: byKey[n.type]?.label ?? "(unknown — deleted or invalid type)",
                  }))
                : [];
            return ok({ ...wf, graph: { ...wf.graph, nodes } }, true);
        }

        case "create_workflow": {
            const wfName = typeof args.name === "string" ? args.name.trim() : "";
            if (!wfName) return fail("name is required");
            const emoji = typeof args.emoji === "string" && args.emoji.trim() ? args.emoji.trim() : "⚙️";
            const description = typeof args.description === "string" ? args.description.trim() : "";

            const level = await tierFor(userId);
            const cap = limitsFor(level).workflows;
            const { rows: countRows } = await db.query<{ count: string }>(
                "select count(*) from workflow where user_id = $1",
                [userId],
            );
            if (Number(countRows[0].count) >= cap) {
                return fail(`your plan allows ${cap} workflows — upgrade to add more`);
            }

            const { rows } = await db.query<{ id: string }>(
                `insert into workflow (user_id, name, emoji, description)
                 values ($1, $2, $3, $4) returning id`,
                [userId, wfName, emoji, description],
            );
            return ok({
                id: rows[0].id,
                url: `${baseUrl}/dashboard/workflows/${rows[0].id}`,
                note: "the graph is empty — author it with save_graph (add a 'schedule' event node to run on a schedule; see get_catalog first)",
            });
        }

        case "update_workflow": {
            const id = asId(args.id);
            if (!id) return fail("invalid workflow id");

            const sets: string[] = [];
            const values: unknown[] = [];
            const push = (column: string, value: unknown) => {
                values.push(value);
                sets.push(`${column} = $${values.length}`);
            };
            if (args.name !== undefined) {
                const v = typeof args.name === "string" ? args.name.trim() : "";
                if (!v) return fail("name cannot be empty");
                push("name", v);
            }
            if (args.emoji !== undefined && typeof args.emoji === "string" && args.emoji.trim()) {
                push("emoji", args.emoji.trim());
            }
            if (args.description !== undefined && typeof args.description === "string") {
                push("description", args.description.trim());
            }
            if (args.active !== undefined) {
                if (typeof args.active !== "boolean") return fail("active must be a boolean");
                push("active", args.active);
            }
            if (sets.length === 0) return fail("nothing to update — pass name, emoji, description or active");

            values.push(id, userId);
            const { rowCount } = await db.query(
                `update workflow set ${sets.join(", ")}, updated_at = now()
                  where id = $${values.length - 1} and user_id = $${values.length}`,
                values,
            );
            if (!rowCount) return fail("workflow not found");
            subscriptionsChanged(); // active gates event delivery
            return ok({ updated: true });
        }

        case "delete_workflow": {
            const id = asId(args.id);
            if (!id) return fail("invalid workflow id");
            const { rowCount } = await db.query(
                "delete from workflow where id = $1 and user_id = $2",
                [id, userId],
            );
            if (!rowCount) return fail("workflow not found");
            subscriptionsChanged(); // the workflow's event nodes are gone
            return ok({ deleted: true });
        }

        case "get_catalog": {
            const byKey = await buildByKey(userId);
            // registry entries (mcp/skill/memory) sorted first: agent-node
            // callers see a truncated result (interpreter's per-result cap),
            // and the user's own servers must never be what gets cut
            const isUserEntry = (e: CatalogEntry) => !(e.key in CATALOG_BY_KEY);
            const entries = Object.values(byKey)
                .filter((e) => !e.legacy && !e.missing)
                .sort((a, b) => Number(isUserEntry(b)) - Number(isUserEntry(a)));
            const nodes = entries.map((e) => ({
                key: e.key,
                label: e.label,
                category: e.category,
                // group names an integration's or event's app
                ...(e.group ? { app: e.group } : {}),
                // mcp server node: the tools its grant can expand to — trimmed
                // descriptions (full text reaches the model via buildToolDefs)
                ...(e.tools
                    ? { tools: e.tools.map((t) => ({ name: t.name, ...(t.description ? { description: trimDescription(t.description) } : {}) })) }
                    : {}),
                inputs: e.inputs.map((p) => ({
                    id: p.id,
                    kind: p.kind,
                    ...(p.multi ? { multi: true } : {}),
                    ...(p.accepts ? { accepts: p.accepts } : {}),
                })),
                outputs: e.outputs.map((p) => ({ id: p.id, kind: p.kind })),
                ...(e.config?.length
                    ? {
                          config: e.config.map((f) => ({
                              id: f.id,
                              input: f.input,
                              ...(f.options ? { options: f.options } : {}),
                              ...(f.picker ? { picker: f.picker } : {}),
                              ...(f.overriddenBy ? { overriddenBy: f.overriddenBy } : {}),
                          })),
                      }
                    : {}),
            }));
            return ok({ note: "graph-format authoring guide: call get_docs", nodes }, true);
        }

        case "get_docs":
            return { content: [{ type: "text", text: GRAPH_DOCS }] };

        case "validate_graph": {
            const checked = checkGraph(args.graph, await buildByKey(userId));
            if ("reject" in checked) return fail(checked.reject);
            return ok({
                valid: checked.errors.length === 0,
                errors: checked.errors,
                warnings: checked.warnings,
            });
        }

        case "save_graph": {
            const id = asId(args.id);
            if (!id) return fail("invalid workflow id");
            const checked = checkGraph(args.graph, await buildByKey(userId));
            if ("reject" in checked) return fail(checked.reject);
            if (checked.errors.length > 0) {
                return fail(`graph has structural errors:\n${checked.errors.join("\n")}`);
            }
            const { rowCount } = await db.query(
                "update workflow set graph = $1, updated_at = now() where id = $2 and user_id = $3",
                [JSON.stringify(checked.graph), id, userId],
            );
            if (!rowCount) return fail("workflow not found");
            subscriptionsChanged(); // graph edits change event nodes/tokens
            return ok({ saved: true, warnings: checked.warnings });
        }

        case "run_workflow": {
            const id = asId(args.id);
            if (!id) return fail("invalid workflow id");
            const timeoutSeconds =
                typeof args.timeoutSeconds === "number" && args.timeoutSeconds > 0
                    ? Math.min(args.timeoutSeconds, MAX_RUN_TIMEOUT_S)
                    : MAX_RUN_TIMEOUT_S;

            const { rows } = await db.query<{ id: string; user_id: string; graph: WorkflowGraph }>(
                "select id, user_id, graph from workflow where id = $1 and user_id = $2",
                [id, userId],
            );
            if (!rows[0]) return fail("workflow not found");

            const result = await executeWorkflowRun(rows[0], {
                trigger: "manual",
                timeoutMs: timeoutSeconds * 1000,
            });
            return ok(result);
        }

        case "list_runs": {
            const workflowId = asId(args.workflowId);
            if (!workflowId) return fail("invalid workflow id");
            const limit =
                typeof args.limit === "number" && args.limit > 0
                    ? Math.min(Math.floor(args.limit), MAX_LIST_RUNS)
                    : MAX_LIST_RUNS;
            // ownership via the workflow join — workflow_run has no user_id
            const { rows } = await db.query(
                `select r.id, r.trigger, r.status, r.error, r.started_at, r.finished_at,
                        jsonb_array_length(r.log) as log_lines
                   from workflow_run r
                   join workflow w on w.id = r.workflow_id
                  where r.workflow_id = $1 and w.user_id = $2
                  order by r.started_at desc limit $3`,
                [workflowId, userId, limit],
            );
            return ok(rows);
        }

        case "get_run": {
            const workflowId = asId(args.workflowId);
            const runId = asId(args.runId);
            if (!workflowId || !runId) return fail("invalid id");
            const { rows } = await db.query<{ log: ConsoleLine[] }>(
                `select r.id, r.trigger, r.status, r.error, r.log, r.started_at, r.finished_at
                   from workflow_run r
                   join workflow w on w.id = r.workflow_id
                  where r.id = $1 and r.workflow_id = $2 and w.user_id = $3`,
                [runId, workflowId, userId],
            );
            if (!rows[0]) return fail("run not found");
            return ok(rows[0], true);
        }

        default:
            return null; // unknown tool — the route turns this into -32602
    }
}
