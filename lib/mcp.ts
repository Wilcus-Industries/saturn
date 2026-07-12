// Minimal MCP Streamable-HTTP client (tool discovery) + the OAuth 2.1 flow
// MCP servers use (protected-resource metadata → authorization-server
// metadata → dynamic client registration → PKCE authorization code).
// Server-only: tokens and client secrets never leave this layer.
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { McpToolParam, McpToolParamType } from "@/lib/workflow";

const PROTOCOL_VERSION = "2025-06-18";
const TIMEOUT_MS = 15_000;

// ------------------------------------------------------------------ SSRF guard
// The MCP server_url and every OAuth metadata endpoint the flow then follows
// (authorization_servers, registration/token endpoints from server-returned
// JSON) are attacker-influenceable, so no request from this layer may reach a
// private/loopback/link-local/reserved address — e.g. cloud metadata at
// 169.254.169.254, RFC1918, or localhost. Every fetch site calls
// assertPublicHttpsUrl first; saveMcpServer uses the sync shape check.
const BLOCKED = new BlockList();
// IPv4 special-use / private ranges (RFC 5735 / 6598 / 1918)
for (const [net, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
    BLOCKED.addSubnet(net, prefix, "ipv4");
}
// IPv6 special-use ranges. ::ffff:0:0/96 (IPv4-mapped) must NOT be listed:
// BlockList canonicalizes plain IPv4 as mapped-v6 internally, so that subnet
// would match every IPv4 address and block all IPv4-only hosts. Mapped
// literals are still safe — BlockList checks them against the v4 rules
// (dotted and hex forms alike), so ::ffff:127.0.0.1 stays blocked.
BLOCKED.addAddress("::", "ipv6"); // unspecified
BLOCKED.addAddress("::1", "ipv6"); // loopback
for (const [net, prefix] of [
    ["64:ff9b::", 96], // NAT64
    ["100::", 64], // discard-only
    ["fc00::", 7], // unique-local
    ["fe80::", 10], // link-local
    ["ff00::", 8], // multicast
    ["2001:db8::", 32], // documentation
] as const) {
    BLOCKED.addSubnet(net, prefix, "ipv6");
}

function ipBlocked(ip: string): boolean {
    const fam = isIP(ip);
    if (fam === 0) return true; // unparseable → refuse
    return BLOCKED.check(ip, fam === 4 ? "ipv4" : "ipv6");
}

// bracketed IPv6 hostnames arrive from URL.hostname as "[::1]"
const bareHost = (host: string): string =>
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

// synchronous shape guard: https-only, reject literal private/loopback IPs and
// localhost/.local without touching DNS — safe to call at save time
export function assertHttpsUrlShape(raw: string): URL {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new Error("Invalid server URL");
    }
    if (url.protocol !== "https:") throw new Error("Server URL must be https");
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
        throw new Error("Server URL must be a public host");
    }
    const bare = bareHost(host);
    if (isIP(bare) !== 0 && ipBlocked(bare)) {
        throw new Error("Server URL must be a public host");
    }
    return url;
}

// full egress guard: shape check + DNS resolution; every resolved address must
// be public. Blunts DNS-rebinding by re-checking at call time (a public IP that
// later rebinds to private between this lookup and the fetch is residual).
export async function assertPublicHttpsUrl(raw: string): Promise<void> {
    const url = assertHttpsUrlShape(raw);
    const bare = bareHost(url.hostname.toLowerCase());
    if (isIP(bare) !== 0) return; // literal IP already validated above
    let addrs: { address: string }[];
    try {
        addrs = await lookup(bare, { all: true });
    } catch {
        throw new Error("Could not resolve server host");
    }
    if (addrs.length === 0 || addrs.some((a) => ipBlocked(a.address))) {
        throw new Error("Server host resolves to a non-public address");
    }
}

export type DiscoveredTool = {
    name: string;
    description: string;
    // tri-state: true/false when the server annotates the tool, undefined
    // when it sends no annotations at all (capability unknown — most servers)
    readOnly: boolean | undefined;
    params: McpToolParam[];
};

const MAX_TOOL_PARAMS = 12;
const MAX_PARAM_NAME = 60;
const MAX_PARAM_DESCRIPTION = 200;
const PARAM_TYPES: ReadonlySet<string> = new Set([
    "string", "number", "boolean", "array", "object",
]);

// property schema → param type. Handles the union spellings real servers
// use — type: ["null","array"], anyOf/oneOf variants — by taking the first
// recognized non-null type; integer folds into number; anything else
// (enum-only, $ref, missing) falls back to string.
function paramType(p: Record<string, unknown>): McpToolParamType {
    const candidates: unknown[] = Array.isArray(p.type) ? [...p.type] : [p.type];
    for (const alt of [p.anyOf, p.oneOf]) {
        if (!Array.isArray(alt)) continue;
        for (const variant of alt) {
            if (typeof variant === "object" && variant !== null) {
                candidates.push((variant as Record<string, unknown>).type);
            }
        }
    }
    for (const c of candidates) {
        if (c === "integer") return "number";
        if (typeof c === "string" && c !== "null" && PARAM_TYPES.has(c)) {
            return c as McpToolParamType;
        }
    }
    return "string";
}

// bounded param list from a tool's inputSchema — top-level properties +
// required only; schemas are arbitrary user-server JSON, so stay defensive
function deriveParams(schema: unknown): McpToolParam[] {
    if (typeof schema !== "object" || schema === null) return [];
    const s = schema as Record<string, unknown>;
    const props = s.properties;
    if (typeof props !== "object" || props === null) return [];
    const required = new Set(
        Array.isArray(s.required)
            ? s.required.filter((r): r is string => typeof r === "string")
            : [],
    );
    const params: McpToolParam[] = [];
    for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
        if (!name || name.length > MAX_PARAM_NAME) continue;
        const p = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        params.push({
            name,
            type: paramType(p),
            required: required.has(name),
            ...(typeof p.description === "string" && p.description
                ? { description: p.description.slice(0, MAX_PARAM_DESCRIPTION) }
                : {}),
        });
    }
    // required first (stable within each group), THEN cap — the cap must
    // never drop a required param or the node couldn't be run at all
    params.sort((a, b) => Number(b.required) - Number(a.required));
    return params.slice(0, MAX_TOOL_PARAMS);
}

// oauth jsonb column shape (all fields optional — {} until connected)
export type McpOauth = {
    clientId?: string;
    clientSecret?: string;
    authUrl?: string;
    tokenUrl?: string;
    scope?: string;
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number; // epoch ms
    // pending authorization (set when the user is redirected out)
    state?: string;
    codeVerifier?: string;
};

// thrown when the server answers 401 — caller starts the OAuth flow
export class McpAuthRequired extends Error {
    wwwAuthenticate: string;
    constructor(wwwAuthenticate: string) {
        super("MCP server requires authorization");
        this.wwwAuthenticate = wwwAuthenticate;
    }
}

// ---------------------------------------------------------------- JSON-RPC

type RpcResponse = { id?: number; result?: unknown; error?: { message?: string } };

// Streamable HTTP responses are either plain JSON or an SSE stream whose
// data events carry JSON-RPC messages — accept both, return the matching id
async function parseRpcBody(res: Response, id: number): Promise<RpcResponse | null> {
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (contentType.includes("text/event-stream")) {
        for (const line of text.split("\n")) {
            if (!line.startsWith("data:")) continue;
            try {
                const msg = JSON.parse(line.slice(5).trim()) as RpcResponse;
                if (msg.id === id) return msg;
            } catch {
                // non-JSON keepalive event — skip
            }
        }
        return null;
    }
    try {
        return JSON.parse(text) as RpcResponse;
    } catch {
        return null;
    }
}

async function rpc(
    serverUrl: string,
    method: string,
    params: unknown,
    opts: { token?: string; sessionId?: string; id?: number },
): Promise<{ result: unknown; sessionId?: string }> {
    const id = opts.id ?? 1;
    const isNotification = method.startsWith("notifications/");
    await assertPublicHttpsUrl(serverUrl); // SSRF guard
    const res = await fetch(serverUrl, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": PROTOCOL_VERSION,
            ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
            ...(opts.sessionId ? { "mcp-session-id": opts.sessionId } : {}),
        },
        body: JSON.stringify({
            jsonrpc: "2.0",
            method,
            params,
            ...(isNotification ? {} : { id }),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
    });

    if (res.status === 401) {
        throw new McpAuthRequired(res.headers.get("www-authenticate") ?? "");
    }
    const sessionId = res.headers.get("mcp-session-id") ?? opts.sessionId;
    if (isNotification) return { result: null, sessionId };
    if (!res.ok) throw new Error(`MCP server responded ${res.status}`);

    const msg = await parseRpcBody(res, id);
    if (!msg) throw new Error("MCP server sent an unreadable response");
    if (msg.error) throw new Error(`MCP error: ${msg.error.message ?? "unknown"}`);
    return { result: msg.result, sessionId };
}

// initialize → notifications/initialized → tools/list (paginated)
export async function discoverTools(serverUrl: string, token?: string): Promise<DiscoveredTool[]> {
    const init = await rpc(
        serverUrl,
        "initialize",
        {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "saturn", version: "0.1.0" },
        },
        { token, id: 1 },
    );
    const sessionId = init.sessionId;
    try {
        await rpc(serverUrl, "notifications/initialized", {}, { token, sessionId });
    } catch {
        // some servers reject the notification — tools/list may still work
    }

    const tools: DiscoveredTool[] = [];
    let cursor: string | undefined;
    let id = 2;
    do {
        const { result } = await rpc(
            serverUrl,
            "tools/list",
            cursor ? { cursor } : {},
            { token, sessionId, id: id++ },
        );
        const page = result as {
            tools?: {
                name?: string;
                description?: string;
                inputSchema?: unknown;
                annotations?: { readOnlyHint?: boolean };
            }[];
            nextCursor?: string;
        };
        for (const t of page.tools ?? []) {
            if (typeof t.name !== "string" || !t.name) continue;
            tools.push({
                name: t.name,
                description: t.description ?? "",
                // no annotations object → unknown, NOT write-capable; with
                // annotations present, readOnlyHint defaults to false per spec
                readOnly: t.annotations ? t.annotations.readOnlyHint === true : undefined,
                params: deriveParams(t.inputSchema),
            });
        }
        cursor = page.nextCursor;
    } while (cursor && tools.length < 500);
    return tools;
}

// initialize → notifications/initialized → tools/call; returns the joined
// text content of the result
export async function callTool(
    serverUrl: string,
    toolName: string,
    args: Record<string, unknown>,
    token?: string,
): Promise<string> {
    const init = await rpc(
        serverUrl,
        "initialize",
        {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "saturn", version: "0.1.0" },
        },
        { token, id: 1 },
    );
    const sessionId = init.sessionId;
    try {
        await rpc(serverUrl, "notifications/initialized", {}, { token, sessionId });
    } catch {
        // some servers reject the notification — tools/call may still work
    }

    const { result } = await rpc(
        serverUrl,
        "tools/call",
        { name: toolName, arguments: args },
        { token, sessionId, id: 2 },
    );
    const r = result as {
        content?: { type?: string; text?: string }[];
        isError?: boolean;
    };
    const text = (r.content ?? [])
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("\n");
    if (r.isError) throw new Error(text || "Tool call failed");
    return text;
}

// ------------------------------------------------------------------ OAuth

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
    try {
        await assertPublicHttpsUrl(url); // SSRF guard (blocked → null, no egress)
        const res = await fetch(url, {
            headers: { accept: "application/json" },
            signal: AbortSignal.timeout(TIMEOUT_MS),
            cache: "no-store",
        });
        if (!res.ok) return null;
        return (await res.json()) as Record<string, unknown>;
    } catch {
        return null;
    }
}

export type AuthServerMeta = {
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    scope?: string; // space-joined scopes_supported (PRM wins over AS metadata)
};

const joinScopes = (value: unknown): string | undefined =>
    Array.isArray(value) && value.every((s) => typeof s === "string") && value.length
        ? value.join(" ")
        : undefined;

// RFC 9728 protected-resource metadata lookup. The 401's WWW-Authenticate may
// name the metadata URL directly; otherwise fall back to the well-known paths.
async function resolveViaPrm(
    serverUrl: string,
    wwwAuthenticate: string,
): Promise<{ authServer: string; prmScope?: string } | null> {
    const url = new URL(serverUrl);
    const prmUrls: string[] = [];
    const fromHeader = /resource_metadata="([^"]+)"/.exec(wwwAuthenticate)?.[1];
    if (fromHeader) prmUrls.push(fromHeader);
    prmUrls.push(
        `${url.origin}/.well-known/oauth-protected-resource${url.pathname === "/" ? "" : url.pathname}`,
        `${url.origin}/.well-known/oauth-protected-resource`,
    );

    for (const prmUrl of prmUrls) {
        const prm = await fetchJson(prmUrl);
        const servers = prm?.authorization_servers;
        if (Array.isArray(servers) && typeof servers[0] === "string") {
            return { authServer: servers[0], prmScope: joinScopes(prm?.scopes_supported) };
        }
    }
    return null;
}

// RFC 8414 / OIDC discovery against one authorization-server issuer
async function fetchAsMeta(
    authServer: string,
    prmScope?: string,
): Promise<AuthServerMeta | null> {
    const as = new URL(authServer);
    const asPath = as.pathname === "/" ? "" : as.pathname;
    const candidates = [
        `${as.origin}/.well-known/oauth-authorization-server${asPath}`,
        `${as.origin}/.well-known/oauth-authorization-server`,
        `${as.origin}/.well-known/openid-configuration${asPath}`,
        `${as.origin}${asPath}/.well-known/openid-configuration`,
    ];
    for (const candidate of candidates) {
        const meta = await fetchJson(candidate);
        if (
            typeof meta?.authorization_endpoint === "string" &&
            typeof meta?.token_endpoint === "string"
        ) {
            return {
                authorization_endpoint: meta.authorization_endpoint,
                token_endpoint: meta.token_endpoint,
                registration_endpoint:
                    typeof meta.registration_endpoint === "string"
                        ? meta.registration_endpoint
                        : undefined,
                scope: prmScope ?? joinScopes(meta.scopes_supported),
            };
        }
    }
    return null;
}

// RFC 9728 protected-resource metadata → RFC 8414 authorization-server
// metadata, for servers that answered 401.
export async function getAuthServerMeta(
    serverUrl: string,
    wwwAuthenticate: string,
): Promise<AuthServerMeta> {
    const prm = await resolveViaPrm(serverUrl, wwwAuthenticate);
    // no PRM → assume the MCP origin is its own authorization server
    const meta = await fetchAsMeta(
        prm?.authServer ?? new URL(serverUrl).origin,
        prm?.prmScope,
    );
    if (!meta) throw new Error("MCP server requires auth but exposes no OAuth metadata");
    return meta;
}

// PRM-only probe for servers that answer discovery anonymously but 401 at
// tools/call (e.g. Google's Gmail MCP). No PRM → null (genuinely public
// server); deliberately no origin-as-AS fallback so public servers that
// merely expose OIDC metadata don't false-positive.
export async function probeAuthServerMeta(serverUrl: string): Promise<AuthServerMeta | null> {
    const prm = await resolveViaPrm(serverUrl, "");
    if (!prm) return null;
    const meta = await fetchAsMeta(prm.authServer, prm.prmScope);
    if (!meta) {
        // the server declared itself protected — saving tools that can never
        // be called would look like a successful connect
        throw new Error(
            "MCP server advertises OAuth but its authorization server exposes no metadata",
        );
    }
    return meta;
}

// RFC 7591 dynamic client registration (public client, PKCE only)
export async function registerClient(
    registrationEndpoint: string,
    redirectUri: string,
    scope?: string,
): Promise<{ clientId: string; clientSecret?: string }> {
    await assertPublicHttpsUrl(registrationEndpoint); // SSRF guard
    const res = await fetch(registrationEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
            client_name: "Saturn",
            redirect_uris: [redirectUri],
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            token_endpoint_auth_method: "none",
            ...(scope ? { scope } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error("MCP authorization server refused client registration");
    const body = (await res.json()) as { client_id?: string; client_secret?: string };
    if (!body.client_id) throw new Error("Client registration returned no client_id");
    return { clientId: body.client_id, clientSecret: body.client_secret };
}

export function pkcePair(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

export function buildAuthorizeUrl(args: {
    authUrl: string;
    clientId: string;
    redirectUri: string;
    state: string;
    challenge: string;
    resource: string;
    scope?: string;
}): string {
    const url = new URL(args.authUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", args.clientId);
    url.searchParams.set("redirect_uri", args.redirectUri);
    url.searchParams.set("state", args.state);
    url.searchParams.set("code_challenge", args.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", args.resource);
    if (args.scope) url.searchParams.set("scope", args.scope);
    return url.toString();
}

type TokenSet = { accessToken: string; refreshToken?: string; expiresAt?: number };

async function tokenRequest(
    tokenUrl: string,
    params: Record<string, string>,
    clientSecret?: string,
): Promise<TokenSet> {
    await assertPublicHttpsUrl(tokenUrl); // SSRF guard
    const res = await fetch(tokenUrl, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
            ...(clientSecret
                ? {
                      authorization: `Basic ${Buffer.from(
                          `${params.client_id}:${clientSecret}`,
                      ).toString("base64")}`,
                  }
                : {}),
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Token request failed (${res.status})`);
    const body = (await res.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
    };
    if (!body.access_token) throw new Error("Token response had no access_token");
    return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
    };
}

export function exchangeCode(args: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
}): Promise<TokenSet> {
    return tokenRequest(
        args.tokenUrl,
        {
            grant_type: "authorization_code",
            code: args.code,
            redirect_uri: args.redirectUri,
            client_id: args.clientId,
            code_verifier: args.codeVerifier,
            resource: args.resource,
        },
        args.clientSecret,
    );
}

export function refreshTokens(args: {
    tokenUrl: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
    resource: string;
}): Promise<TokenSet> {
    return tokenRequest(
        args.tokenUrl,
        {
            grant_type: "refresh_token",
            refresh_token: args.refreshToken,
            client_id: args.clientId,
            resource: args.resource,
        },
        args.clientSecret,
    );
}
