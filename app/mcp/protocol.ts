// JSON-RPC plumbing for the hosted MCP server (app/mcp/route.ts) — the
// stateless-server counterpart of the hand-rolled client in lib/mcp.ts.
// Plain-JSON Streamable HTTP: single-object POST bodies (the 2025-06-18
// revision removed batching), no SSE stream, no session id.

import { NextResponse } from "next/server";

// newest first — initialize echoes the client's version when supported and
// proposes the newest otherwise (the spec's negotiation rule)
export const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_VERSION = SUPPORTED_VERSIONS[0];

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type RpcId = string | number | null;

export type RpcRequest = {
    id: RpcId | undefined; // undefined = notification, never answered
    method: string;
    params: Record<string, unknown>;
};

const isRecord = (x: unknown): x is Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x);

// null on anything that isn't a single well-formed JSON-RPC request object
export function parseRpcRequest(body: unknown): RpcRequest | null {
    if (!isRecord(body) || body.jsonrpc !== "2.0") return null;
    if (typeof body.method !== "string" || !body.method) return null;
    const id = body.id;
    if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
        return null;
    }
    if (body.params !== undefined && !isRecord(body.params)) return null;
    return { id, method: body.method, params: body.params ?? {} };
}

export function rpcResult(id: RpcId, result: unknown): NextResponse {
    return NextResponse.json({ jsonrpc: "2.0", id, result });
}

export function rpcError(id: RpcId, code: number, message: string): NextResponse {
    return NextResponse.json({ jsonrpc: "2.0", id, error: { code, message } });
}

// notifications get acknowledged with an empty 202 per the transport spec
export const accepted = () => new NextResponse(null, { status: 202 });

export const methodNotAllowed = () =>
    new NextResponse("Method Not Allowed", { status: 405, headers: { allow: "POST" } });

export function negotiateVersion(requested: unknown): string {
    return typeof requested === "string" &&
        (SUPPORTED_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_VERSION;
}
