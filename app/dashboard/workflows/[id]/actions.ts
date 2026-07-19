"use server";

import {
    type AgentMessage,
    type AgentModelResult,
    type AgentToolRef,
    isToolExclusionList,
    MAX_AGENT_MESSAGES,
    type McpCallResult,
} from "@/lib/agent";
import { db } from "@/lib/db";
import { subscriptionsChanged } from "@/lib/events.server";
import { executeIntegration } from "@/lib/integrations.server";
import type { CallAgentRequest } from "@/lib/interpreter";
import { executeAgentTurn, executeMcpTool, UUID } from "@/lib/runner.server";
import { requireUser } from "@/lib/subscription";
import { isWorkflowGraph, MAX_EDGES, MAX_GRAPH_JSON, MAX_NODES } from "@/lib/workflow";

// actions are public POST endpoints — re-check the session here

const MAX_AGENT_PAYLOAD = 131_072; // serialized transcript cap

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
