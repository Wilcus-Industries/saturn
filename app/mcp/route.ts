// Hosted MCP server: lets an external agent (e.g. Claude Code via
// `claude mcp add --transport http saturn <baseUrl>/mcp`) create, edit,
// validate and test-run the authenticated user's workflows. Stateless
// Streamable HTTP — plain JSON responses, no SSE, no session id. Auth is the
// better-auth mcp plugin's OAuth 2.1 flow; withMcpAuth resolves the bearer
// token and 401s with the resource-metadata pointer when absent.

import { withMcpAuth } from "better-auth/plugins";
import { auth } from "@/lib/auth";
import {
    accepted,
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    methodNotAllowed,
    negotiateVersion,
    PARSE_ERROR,
    parseRpcRequest,
    rpcError,
    rpcResult,
} from "./protocol";
import { dispatchTool, TOOL_DEFS } from "./tools";

// run_workflow executes graphs inline in this handler — the budget is
// RUN_TIMEOUT_MS in lib/runner.server.ts
export const dynamic = "force-dynamic";

const INSTRUCTIONS =
    "Saturn workflow editor. Workflows are cron-scheduled node graphs (flow + value ports) run server-side. " +
    "Typical loop: get_catalog (node types + authoring guide) → create_workflow → save_graph → run_workflow to test, " +
    "then inspect list_runs/get_run. Graphs and schedules are validated against the account's tier limits.";

export const POST = withMcpAuth(auth, async (req, session) => {
    // tokens are user-linked by the oidc provider; a client-credentials-style
    // token without a user has nothing to edit
    const userId = session.userId;
    if (!userId) return rpcError(null, INVALID_REQUEST, "token is not linked to a user");

    let body: unknown;
    try {
        body = await req.json();
    } catch {
        return rpcError(null, PARSE_ERROR, "body is not valid JSON");
    }
    if (Array.isArray(body)) {
        return rpcError(null, INVALID_REQUEST, "batching is not supported");
    }
    const rpc = parseRpcRequest(body);
    if (!rpc) return rpcError(null, INVALID_REQUEST, "not a JSON-RPC 2.0 request");

    // notifications (no id) are acknowledged and never answered
    if (rpc.id === undefined) return accepted();

    switch (rpc.method) {
        case "initialize":
            return rpcResult(rpc.id, {
                protocolVersion: negotiateVersion(rpc.params.protocolVersion),
                capabilities: { tools: {} },
                serverInfo: { name: "saturn", version: "1.0.0" },
                instructions: INSTRUCTIONS,
            });

        case "ping":
            return rpcResult(rpc.id, {});

        case "tools/list":
            // 11 tools — no pagination needed
            return rpcResult(rpc.id, { tools: TOOL_DEFS });

        case "tools/call": {
            const { name, arguments: args } = rpc.params as {
                name?: unknown;
                arguments?: unknown;
            };
            if (typeof name !== "string") {
                return rpcError(rpc.id, INVALID_PARAMS, "missing tool name");
            }
            const toolArgs =
                typeof args === "object" && args !== null && !Array.isArray(args)
                    ? (args as Record<string, unknown>)
                    : {};
            try {
                const result = await dispatchTool(userId, name, toolArgs);
                if (result === null) {
                    return rpcError(rpc.id, INVALID_PARAMS, `unknown tool "${name}"`);
                }
                return rpcResult(rpc.id, result);
            } catch (err) {
                // tool bugs surface as isError results, not protocol errors —
                // but never leak a stack trace
                return rpcResult(rpc.id, {
                    content: [
                        {
                            type: "text",
                            text: err instanceof Error ? err.message : "tool execution failed",
                        },
                    ],
                    isError: true,
                });
            }
        }

        default:
            return rpcError(rpc.id, METHOD_NOT_FOUND, `method "${rpc.method}" not supported`);
    }
});

export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
