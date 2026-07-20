"use server";

import {
    type AgentMessage,
    type AgentModelResult,
    type AgentToolRef,
    isToolExclusionList,
    MAX_AGENT_MESSAGES,
    MEMORY_TOOL_NAMES,
    type McpCallResult,
} from "@/lib/agent";
import { db } from "@/lib/db";
import { subscriptionsChanged } from "@/lib/events.server";
import { executeIntegration } from "@/lib/integrations.server";
import type { CallAgentRequest } from "@/lib/interpreter";
import { executeMemoryTool } from "@/lib/memory.server";
import { MAX_ENTRIES_PER_KIND } from "@/lib/registry";
import { invalidateUserRegistry } from "@/lib/registry.server";
import { executeAgentTurn, executeMcpTool, UUID } from "@/lib/runner.server";
import { requireUser } from "@/lib/subscription";
import { isWorkflowGraph, MAX_EDGES, MAX_GRAPH_JSON, MAX_NODES } from "@/lib/workflow";

// actions are public POST endpoints — re-check the session here

const MAX_AGENT_PAYLOAD = 393_216; // serialized transcript cap
const MAX_MEMORY_INPUT = 4096; // memory tool argument JSON cap

export async function saveWorkflow(id: string, graph: unknown) {
    const { session } = await requireUser();
    if (!UUID.test(id)) throw new Error("Invalid workflow id");
    if (!isWorkflowGraph(graph)) throw new Error("Invalid graph");
    if (graph.nodes.length > MAX_NODES || graph.edges.length > MAX_EDGES) {
        throw new Error("Graph too large");
    }
    const json = JSON.stringify(graph);
    if (json.length > MAX_GRAPH_JSON) throw new Error("Graph too large");

    const { rowCount } = await db.query(
        "update workflow set graph = $1, updated_at = now() where id = $2 and user_id = $3",
        [json, id, session.user.id],
    );
    if (!rowCount) throw new Error("Not found");
    // graph edits add/remove event nodes and change bot tokens — poke the
    // gateway (debounced there, so autosave bursts collapse)
    subscriptionsChanged();
}

// --- secret variables (toolbox-managed registry_entry rows, kind 'variable';
// value lives in the write-only auth_token column and never reaches the
// client — variable nodes evaluate to a {{var:<uuid>}} sentinel that only
// executeIntegration substitutes server-side) ---

const MAX_VARIABLE_NAME = 60;
const MAX_VARIABLE_VALUE = 4096;

// expected failures come back as a value the modal renders inline; a thrown
// error would only reach Next's generic error page (message redacted in prod)
type ActionResult = { error: string } | undefined;

export async function saveVariable(formData: FormData): Promise<ActionResult> {
    const { session } = await requireUser();

    try {
        const id = String(formData.get("id") ?? "").trim();
        if (id && !UUID.test(id)) throw new Error("Invalid id");
        const name = String(formData.get("name") ?? "").trim();
        if (!name || name.length > MAX_VARIABLE_NAME) {
            throw new Error(`Name is required (max ${MAX_VARIABLE_NAME} chars)`);
        }
        const value = String(formData.get("value") ?? "").trim();
        if (value.length > MAX_VARIABLE_VALUE) throw new Error("Value too long");
        const clearValue = formData.get("clearValue") === "on";

        if (id) {
            // blank value keeps the stored one; clearValue erases; filled overwrites
            const params: unknown[] = [name];
            let valueSql = "auth_token";
            if (clearValue) {
                valueSql = "''";
            } else if (value) {
                params.push(value);
                valueSql = `$${params.length}`;
            }
            params.push(id, session.user.id);
            const { rowCount } = await db.query(
                `update registry_entry
                 set name = $1, auth_token = ${valueSql}, updated_at = now()
                 where id = $${params.length - 1} and user_id = $${params.length} and kind = 'variable'`,
                params,
            );
            if (!rowCount) throw new Error("Not found");
        } else {
            if (!value) throw new Error("Value is required");
            const { rows } = await db.query<{ count: string }>(
                "select count(*) from registry_entry where user_id = $1 and kind = 'variable'",
                [session.user.id],
            );
            if (Number(rows[0].count) >= MAX_ENTRIES_PER_KIND) {
                throw new Error(`Limit of ${MAX_ENTRIES_PER_KIND} variables reached`);
            }
            await db.query(
                `insert into registry_entry (user_id, kind, name, auth_token)
                 values ($1, 'variable', $2, $3)`,
                [session.user.id, name, value],
            );
        }
    } catch (err) {
        return { error: err instanceof Error ? err.message : "Something went wrong" };
    }

    invalidateUserRegistry(session.user.id);
}

export async function deleteVariable(formData: FormData): Promise<ActionResult> {
    const { session } = await requireUser();
    const id = String(formData.get("id") ?? "").trim();
    if (!UUID.test(id)) return { error: "Invalid id" };
    // idempotent — deleting an already-deleted variable is fine
    await db.query(
        "delete from registry_entry where id = $1 and user_id = $2 and kind = 'variable'",
        [id, session.user.id],
    );
    invalidateUserRegistry(session.user.id);
}

// executes one MCP tool for a designer test run. Returns errors as values
// (not throws) so the client console can render them. Validation and the
// call live in executeMcpTool (lib/runner.server.ts), shared with the
// scheduled runner.
export async function callMcpTool(
    entryId: string,
    toolName: string,
    input: string,
): Promise<McpCallResult> {
    const { session } = await requireUser();
    return executeMcpTool(session.user.id, entryId, toolName, input);
}

// executes one memory-store operation for a designer test run. Errors return
// as values (not throws) so the client console can render them. Validation and
// the operation live in executeMemoryTool (lib/memory.server.ts), shared with
// the scheduled runner.
export async function callMemoryTool(
    memoryId: string,
    op: string,
    input: string,
): Promise<McpCallResult> {
    const { session } = await requireUser();
    if (typeof memoryId !== "string" || !UUID.test(memoryId)) return { error: "invalid memory id" };
    if (typeof op !== "string" || !(MEMORY_TOOL_NAMES as readonly string[]).includes(op)) {
        return { error: "unknown memory operation" };
    }
    if (typeof input !== "string" || input.length > MAX_MEMORY_INPUT) {
        return { error: "input too long" };
    }
    return executeMemoryTool(session.user.id, memoryId, op, input, "designer");
}

// executes one integration send for a designer test run. Errors return as
// values; validation lives in executeIntegration (lib/integrations.server.ts),
// shared with the scheduled runner.
export async function callIntegration(
    providerId: string,
    config: Record<string, string>,
    message: string,
): Promise<McpCallResult> {
    const { session } = await requireUser();
    return executeIntegration(session.user.id, providerId, config, message);
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x);

// the transcript arrives from the browser — shape-check every message before
// replaying it to the model
function isAgentMessage(x: unknown): x is AgentMessage {
    if (!isRecord(x) || typeof x.content !== "string") return false;
    if (x.role === "user") return true;
    if (x.role === "tool") return typeof x.toolCallId === "string";
    if (x.role !== "assistant") return false;
    if (x.toolCalls === undefined) return true;
    return (
        Array.isArray(x.toolCalls) &&
        x.toolCalls.every(
            (c) =>
                isRecord(c) &&
                typeof c.id === "string" &&
                typeof c.entryId === "string" &&
                typeof c.toolName === "string" &&
                typeof c.arguments === "string",
        )
    );
}

const isToolRef = (x: unknown): x is AgentToolRef =>
    isRecord(x) &&
    typeof x.entryId === "string" &&
    UUID.test(x.entryId) &&
    typeof x.toolName === "string" &&
    x.toolName.length > 0 &&
    x.toolName.length <= 60 &&
    (x.exclude === undefined || isToolExclusionList(x.exclude));

// one LLM turn of an agent node's loop. The interpreter (browser) drives
// the loop and executes tool calls via callMcpTool; this action shape-checks
// the browser-built transcript, then delegates to executeAgentTurn
// (lib/runner.server.ts, shared with the scheduled runner), which resolves
// grants/skills against the registry and talks to OpenRouter so the key
// never leaves the server. Errors return as values for the designer console.
export async function callAgentModel(req: CallAgentRequest): Promise<AgentModelResult> {
    // outside any try: requireUser signals its redirect by throwing
    const { session } = await requireUser();

    if (!isRecord(req)) return { error: "invalid request" };
    if (!Array.isArray(req.tools) || !req.tools.every(isToolRef)) {
        return { error: "invalid tool grant" };
    }
    if (req.memoryId !== undefined && (typeof req.memoryId !== "string" || !UUID.test(req.memoryId))) {
        return { error: "invalid memory store" };
    }
    if (
        !Array.isArray(req.messages) ||
        req.messages.length === 0 ||
        req.messages.length > MAX_AGENT_MESSAGES ||
        !req.messages.every(isAgentMessage)
    ) {
        return { error: "invalid transcript" };
    }
    if (JSON.stringify(req.messages).length > MAX_AGENT_PAYLOAD) {
        return { error: "transcript too large" };
    }

    return executeAgentTurn(session.user.id, req, "designer");
}
