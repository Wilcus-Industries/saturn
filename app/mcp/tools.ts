// Tool surface of the hosted workflow-editor MCP server: definitions
// (hand-written JSON Schemas — no schema lib in the stack) and the dispatch
// that executes them for the OAuth token's userId. Everything here reuses the
// same cores as the designer actions and the cron runner; tool-execution
// failures return as isError results, never as JSON-RPC errors.

import { describeCron, isValidCron } from "@/lib/cron";
import { db } from "@/lib/db";
import type { ConsoleLine } from "@/lib/interpreter";
import { buildUserCatalog } from "@/lib/registry";
import { getUserRegistry } from "@/lib/registry.server";
import { executeWorkflowRun, UUID } from "@/lib/runner.server";
import { assertCronFloor, baseUrl, getActivationLevels, limitsFor } from "@/lib/subscription";
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
const MAX_PARAM_DESCRIPTION = 200;

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
        description: "List the user's workflows: id, name, emoji, description, cron schedule (with a human-readable summary), node count and last run time.",
        inputSchema: obj({}),
    },
    {
        name: "get_workflow",
        description: "Fetch one workflow: metadata plus the full node graph JSON.",
        inputSchema: obj({ id: str("Workflow id (uuid)") }, ["id"]),
    },
    {
        name: "create_workflow",
        description:
            'Create a workflow. cron is a 5-field UTC expression where each field is "*" or a plain integer; "*/n" (n 2-30) is allowed in the minute field only — no ranges or lists. Examples: "0 9 * * *" daily 09:00 UTC, "*/5 * * * *" every 5 minutes. The account tier caps how many workflows can exist and how tight the schedule may be. The workflow starts with an empty graph — author it with save_graph.',
        inputSchema: obj(
            {
                name: str("Workflow name"),
                cron: str('5-field cron, e.g. "0 * * * *" for hourly'),
                emoji: str("Single emoji icon (optional, default ⚙️)"),
                description: str("Short description (optional)"),
            },
            ["name", "cron"],
        ),
    },
    {
        name: "update_workflow",
        description: "Update workflow metadata (name, emoji, description, cron). Only provided fields change; the graph is untouched (use save_graph for that).",
        inputSchema: obj(
            {
                id: str("Workflow id (uuid)"),
                name: str("New name"),
                emoji: str("New emoji"),
                description: str("New description"),
                cron: str("New 5-field cron expression"),
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
            "The node catalog available to this user (built-in nodes plus their registered MCP tools and skills) with every node's ports and config fields, and the authoring guide for the graph format. Call this before writing any graph.",
        inputSchema: obj({}),
    },
    {
        name: "validate_graph",
        description: "Dry-run validation of a graph without saving: structural errors (bad ports, kind mismatches, duplicate edges, fan-in on single-edge value inputs) and warnings (unknown node types, missing start node, unresolvable agent grants).",
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
            "Execute a workflow now, server-side, exactly like a scheduled run (real MCP tool calls, real model calls) and return the console log. The run is recorded in the workflow's run history with trigger 'manual'. Requires a start node.",
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
// authoring guide embedded in get_catalog
// ---------------------------------------------------------------------------

const GRAPH_DOCS = `# Authoring Saturn workflow graphs

A graph is {"nodes": [...], "edges": [...]}.
Node: {"id": "<unique string>", "type": "<catalog key>", "x": <number>, "y": <number>, "config": {"<fieldId>": "<string value>"}}.
Edge: {"id": "<unique string>", "from": {"nodeId", "portId"}, "to": {"nodeId", "portId"}, "kind": "flow" | "value"} — from is always an output port, to an input port, and kind must match both ports' kind.

## Ports
- flow ports sequence execution. A flow output may fan out into several edges: the branches run CONCURRENTLY.
- value ports carry data (always strings; JSON for structured data). A value input accepts exactly ONE incoming edge — except ports marked "multi" (only await.values).
- Every runnable graph needs exactly one "start" node; execution follows flow edges from it.

## Config vs ports
Config fields hold literal strings. A field with "overriddenBy" is ignored when its named input port is connected (e.g. if.b_literal loses to the b port). Numbers/booleans are written as strings.

## Built-in nodes
- start: entry point. if: routes flow to true/false comparing a vs b (config.operator; b from port or b_literal). loop: runs body once per item of the JSON array on items, then done; item carries the current element. and/or/not: boolean values. literal: emits config.value (config.valueType: string|number). print: logs config.message or the value port. extract: pulls a field out of a JSON value via config.path, dot-separated with numeric array indices ("data.results.0.price"). await: join barrier for parallel branches — continues when ALL incoming flow edges arrive; results = JSON array of its values edges (multi port), in edge order. model: emits config.model (an OpenRouter model id) on its "model" value output — connect it to an agent's model input.

## MCP tool nodes (keys "mcp:<entryId>:<toolName>")
One node per registered tool. Each parameter is a value input port named "p_<param>" with a same-named config field as literal fallback. Tools without discovered params (and legacy "mcp:<entryId>" nodes) take one raw-JSON-object string on the "input" port. Output "result" carries the tool result text.

## Agent node (type "agent")
LLM loop over built-in model credits (paid plans) with the user's OpenRouter key as fallback. Inputs: flow in, prompt (value), model (value — overrides config.model when connected, usually from a "model" node). Config: system (textarea), model (OpenRouter id like "openai/gpt-4o-mini"), output ("text" | "image" — image works only on models whose OpenRouter output modalities include image; any other value runs as text; image mode ignores tool grants and returns the first generated image), tools, skills. tools/skills are JSON string arrays as strings: tools entries are "<entryId>:<toolName>" (the mcp node key without the "mcp:" prefix), skills entries are skill entry uuids. The agent may call granted tools itself. Output "result" carries the final text, or a data:image/… URL when output=image.
Skill nodes are not executable on their own — skills only run as agent grants.

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

const ok = (data: unknown): ToolResult => ({
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});
const fail = (message: string): ToolResult => ({
    content: [{ type: "text", text: message }],
    isError: true,
});

const asId = (x: unknown): string | null =>
    typeof x === "string" && UUID.test(x) ? x : null;

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
                "invalid graph shape — needs {nodes, edges} with unique string node ids, at most one start node, numeric x/y, string-valued config, and edges anchored to existing nodes",
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
                cron: string;
                node_count: number;
                last_run_at: Date | null;
            }>(
                `select id, name, emoji, description, cron,
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
                    cron: r.cron,
                    schedule: describeCron(r.cron),
                    nodeCount: r.node_count,
                    lastRunAt: r.last_run_at,
                })),
            );
        }

        case "get_workflow": {
            const id = asId(args.id);
            if (!id) return fail("invalid workflow id");
            const { rows } = await db.query(
                `select id, name, emoji, description, cron, graph, last_run_at, created_at, updated_at
                   from workflow where id = $1 and user_id = $2`,
                [id, userId],
            );
            if (!rows[0]) return fail("workflow not found");
            return ok({ ...rows[0], schedule: describeCron(rows[0].cron) });
        }

        case "create_workflow": {
            const wfName = typeof args.name === "string" ? args.name.trim() : "";
            if (!wfName) return fail("name is required");
            const cron = typeof args.cron === "string" ? args.cron.trim() : "";
            if (!isValidCron(cron)) {
                return fail('invalid cron expression — 5 fields, each "*" or an integer, "*/n" in the minute field only');
            }
            const emoji = typeof args.emoji === "string" && args.emoji.trim() ? args.emoji.trim() : "⚙️";
            const description = typeof args.description === "string" ? args.description.trim() : "";

            const level = await tierFor(userId);
            try {
                assertCronFloor(cron, level);
            } catch (err) {
                return fail(err instanceof Error ? err.message : "schedule not allowed");
            }
            const cap = limitsFor(level).workflows;
            const { rows: countRows } = await db.query<{ count: string }>(
                "select count(*) from workflow where user_id = $1",
                [userId],
            );
            if (Number(countRows[0].count) >= cap) {
                return fail(`your plan allows ${cap} workflows — upgrade to add more`);
            }

            const { rows } = await db.query<{ id: string }>(
                `insert into workflow (user_id, name, emoji, description, cron)
                 values ($1, $2, $3, $4, $5) returning id`,
                [userId, wfName, emoji, description, cron],
            );
            return ok({
                id: rows[0].id,
                url: `${baseUrl}/dashboard/workflows/${rows[0].id}`,
                note: "the graph is empty — author it with save_graph (see get_catalog first)",
            });
        }

        case "update_workflow": {
            const id = asId(args.id);
            if (!id) return fail("invalid workflow id");

            const sets: string[] = [];
            const values: unknown[] = [];
            const push = (column: string, value: string) => {
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
            if (args.cron !== undefined) {
                const cron = typeof args.cron === "string" ? args.cron.trim() : "";
                if (!isValidCron(cron)) return fail("invalid cron expression");
                try {
                    assertCronFloor(cron, await tierFor(userId));
                } catch (err) {
                    return fail(err instanceof Error ? err.message : "schedule not allowed");
                }
                push("cron", cron);
            }
            if (sets.length === 0) return fail("nothing to update — pass name, emoji, description or cron");

            values.push(id, userId);
            const { rowCount } = await db.query(
                `update workflow set ${sets.join(", ")}, updated_at = now()
                  where id = $${values.length - 1} and user_id = $${values.length}`,
                values,
            );
            if (!rowCount) return fail("workflow not found");
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
            return ok({ deleted: true });
        }

        case "get_catalog": {
            const byKey = await buildByKey(userId);
            const nodes = Object.values(byKey)
                .filter((e) => !e.legacy && !e.missing)
                .map((e) => ({
                    key: e.key,
                    label: e.label,
                    category: e.category,
                    ...(e.group ? { server: e.group } : {}),
                    inputs: e.inputs.map((p) => ({
                        id: p.id,
                        kind: p.kind,
                        ...(p.multi ? { multi: true } : {}),
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
                    ...(e.params?.length
                        ? {
                              params: e.params.map((p) => ({
                                  name: p.name,
                                  type: p.type,
                                  required: p.required,
                                  ...(p.description
                                      ? { description: p.description.slice(0, MAX_PARAM_DESCRIPTION) }
                                      : {}),
                              })),
                          }
                        : {}),
                }));
            return ok({ docs: GRAPH_DOCS, nodes });
        }

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
            return ok(rows[0]);
        }

        default:
            return null; // unknown tool — the route turns this into -32602
    }
}
