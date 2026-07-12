"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import {
    type AuthServerMeta,
    buildAuthorizeUrl,
    discoverTools,
    getAuthServerMeta,
    McpAuthRequired,
    type McpOauth,
    pkcePair,
    probeAuthServerMeta,
    registerClient,
} from "@/lib/mcp";
import {
    MAX_ENTRIES_PER_KIND,
    MAX_MCP_TOOLS,
    type McpTool,
    mergeTools,
    type RegistryKind,
} from "@/lib/registry";
import { freshMcpToken, getMcpSecrets } from "@/lib/registry.server";
import { baseUrl, getActivation, limitsFor, requireUser } from "@/lib/subscription";

// actions are public POST endpoints — every one re-checks the session itself

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_NAME = 60;
const MAX_DESCRIPTION = 2000;
const MAX_TOKEN = 4096;

// expected failures come back as a value the modal renders inline; a thrown
// error would only reach Next's generic error page (message redacted in prod)
type ActionResult = { error: string } | undefined;

function toError(err: unknown): { error: string } {
    return { error: err instanceof Error ? err.message : "Something went wrong" };
}

function requiredName(formData: FormData): string {
    const name = String(formData.get("name") ?? "").trim();
    if (!name || name.length > MAX_NAME) throw new Error("Name is required (max 60 chars)");
    return name;
}

// optional id field: present + valid uuid → update, absent → insert
function optionalId(formData: FormData): string | null {
    const id = String(formData.get("id") ?? "").trim();
    if (!id) return null;
    if (!UUID.test(id)) throw new Error("Invalid id");
    return id;
}

// cap defaults to the kind-wide maximum; mcp passes the caller's plan limit
async function assertUnderCap(userId: string, kind: RegistryKind, cap = MAX_ENTRIES_PER_KIND) {
    const { rows } = await db.query<{ count: string }>(
        "select count(*) from registry_entry where user_id = $1 and kind = $2",
        [userId, kind],
    );
    if (Number(rows[0].count) >= cap) {
        throw new Error(
            cap < MAX_ENTRIES_PER_KIND
                ? `Your plan allows ${cap} MCP server${cap === 1 ? "" : "s"} — upgrade to add more`
                : `Limit of ${cap} ${kind} entries reached`,
        );
    }
}

function parseTools(raw: string): McpTool[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error("Invalid tools");
    }
    if (!Array.isArray(parsed) || parsed.length > MAX_MCP_TOOLS) throw new Error("Invalid tools");

    const seen = new Set<string>();
    return parsed.map((t): McpTool => {
        if (typeof t !== "object" || t === null) throw new Error("Invalid tools");
        const { name, access, enabled } = t as Record<string, unknown>;
        if (typeof name !== "string" || !name.trim() || name.trim().length > MAX_NAME) {
            throw new Error("Tool names must be 1-60 chars");
        }
        if (access !== "read" && access !== "write") throw new Error("Invalid tool access");
        if (typeof enabled !== "boolean") throw new Error("Invalid tools");
        const trimmed = name.trim();
        if (seen.has(trimmed)) throw new Error(`Duplicate tool name: ${trimmed}`);
        seen.add(trimmed);
        return { name: trimmed, access, enabled };
    });
}

export async function saveMcpServer(formData: FormData): Promise<ActionResult> {
    const { requestHeaders, session } = await requireUser();

    try {
        const id = optionalId(formData);
        const name = requiredName(formData);

        const serverUrl = String(formData.get("serverUrl") ?? "").trim();
        let url: URL;
        try {
            url = new URL(serverUrl);
        } catch {
            throw new Error("Invalid server URL");
        }
        if (url.protocol !== "https:") throw new Error("Server URL must be https");

        const authToken = String(formData.get("authToken") ?? "").trim();
        if (authToken.length > MAX_TOKEN) throw new Error("Token too long");
        const clearToken = formData.get("clearToken") === "on";

        let tools = parseTools(String(formData.get("tools") ?? "[]"));

        if (id) {
            // parseTools strips everything but {name, access, enabled} — the
            // client never submits discovered readOnly/description/params.
            // Re-attach the stored ones by tool name so a settings save
            // doesn't wipe them.
            const { rows } = await db.query<{ tools: McpTool[] }>(
                "select tools from registry_entry where id = $1 and user_id = $2 and kind = 'mcp'",
                [id, session.user.id],
            );
            const stored = new Map((rows[0]?.tools ?? []).map((t) => [t.name, t]));
            tools = tools.map((t) => {
                const prev = stored.get(t.name);
                return prev
                    ? {
                          ...t,
                          ...(prev.readOnly !== undefined ? { readOnly: prev.readOnly } : {}),
                          ...(prev.description ? { description: prev.description } : {}),
                          ...(prev.params ? { params: prev.params } : {}),
                      }
                    : t;
            });

            // blank token keeps the stored one; clearToken erases; filled overwrites
            const params: unknown[] = [name, serverUrl, JSON.stringify(tools)];
            let tokenSql = "auth_token";
            if (clearToken) {
                tokenSql = "''";
            } else if (authToken) {
                params.push(authToken);
                tokenSql = `$${params.length}`;
            }
            params.push(id, session.user.id);
            const { rowCount } = await db.query(
                `update registry_entry
                 set name = $1, server_url = $2, tools = $3, auth_token = ${tokenSql},
                     updated_at = now()
                 where id = $${params.length - 1} and user_id = $${params.length} and kind = 'mcp'`,
                params,
            );
            if (!rowCount) throw new Error("Not found");
        } else {
            const cap = Math.min(
                limitsFor(await getActivation(requestHeaders)).mcpServers,
                MAX_ENTRIES_PER_KIND,
            );
            await assertUnderCap(session.user.id, "mcp", cap);
            await db.query(
                `insert into registry_entry (user_id, kind, name, server_url, auth_token, tools)
                 values ($1, 'mcp', $2, $3, $4, $5)`,
                [session.user.id, name, serverUrl, authToken, JSON.stringify(tools)],
            );
        }
    } catch (err) {
        return toError(err);
    }

    revalidatePath("/dashboard/settings");
}

export async function saveSkill(formData: FormData): Promise<ActionResult> {
    const { session } = await requireUser();

    try {
        const id = optionalId(formData);
        const name = requiredName(formData);
        const emoji = String(formData.get("emoji") ?? "").trim() || "⚙️";
        const description = String(formData.get("description") ?? "").trim();
        if (description.length > MAX_DESCRIPTION) throw new Error("Instructions too long");

        if (id) {
            const { rowCount } = await db.query(
                `update registry_entry
                 set name = $1, emoji = $2, description = $3, updated_at = now()
                 where id = $4 and user_id = $5 and kind = 'skill'`,
                [name, emoji, description, id, session.user.id],
            );
            if (!rowCount) throw new Error("Not found");
        } else {
            await assertUnderCap(session.user.id, "skill");
            await db.query(
                `insert into registry_entry (user_id, kind, name, emoji, description)
                 values ($1, 'skill', $2, $3, $4)`,
                [session.user.id, name, emoji, description],
            );
        }
    } catch (err) {
        return toError(err);
    }

    revalidatePath("/dashboard/settings");
}

const OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";

// begin OAuth: dynamically register the client if needed, stash the PKCE
// verifier + state, return the URL to send the user out to
async function startMcpOauth(
    serverUrl: string,
    entryId: string,
    oauth: McpOauth,
    meta: AuthServerMeta,
    userId: string,
): Promise<string> {
    let { clientId, clientSecret } = oauth;
    if (!clientId || oauth.scope !== meta.scope) {
        // re-register when the scope changed — a client registered without
        // the server's scopes may be refused at the authorization endpoint
        if (!meta.registration_endpoint) {
            throw new Error(
                "This server requires OAuth but doesn't support dynamic client registration — edit the server and set an auth token instead",
            );
        }
        ({ clientId, clientSecret } = await registerClient(
            meta.registration_endpoint,
            `${baseUrl}${OAUTH_CALLBACK_PATH}`,
            meta.scope,
        ));
    }
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomUUID();
    const pending: McpOauth = {
        ...oauth,
        clientId,
        clientSecret,
        authUrl: meta.authorization_endpoint,
        tokenUrl: meta.token_endpoint,
        scope: meta.scope,
        state,
        codeVerifier: verifier,
    };
    await db.query(
        "update registry_entry set oauth = $1, updated_at = now() where id = $2 and user_id = $3",
        [JSON.stringify(pending), entryId, userId],
    );
    return buildAuthorizeUrl({
        authUrl: meta.authorization_endpoint,
        clientId,
        redirectUri: `${baseUrl}${OAUTH_CALLBACK_PATH}`,
        state,
        challenge,
        resource: serverUrl,
        scope: meta.scope,
    });
}

// connect to the MCP server and pull its tool list; a 401 kicks off the
// OAuth flow instead (redirects the browser to the authorization server)
export async function discoverMcpTools(formData: FormData) {
    const { session } = await requireUser();

    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) throw new Error("Invalid id");
    const entry = await getMcpSecrets(id, session.user.id);
    if (!entry) throw new Error("Not found");

    // manual bearer token wins; otherwise a stored oauth token (refreshed
    // when expired) — or no token at all for public servers
    const { token, oauth } = await freshMcpToken(entry, session.user.id);

    let authorizeUrl: string | null = null;
    let connectError: string | null = null;
    try {
        try {
            const discovered = await discoverTools(entry.server_url, token);
            await db.query(
                "update registry_entry set tools = $1, updated_at = now() where id = $2 and user_id = $3",
                [JSON.stringify(mergeTools(entry.tools, discovered)), id, session.user.id],
            );
            // some servers (Google's Gmail MCP) answer discovery anonymously and
            // only 401 at tools/call — with no token, a published protected-
            // resource metadata means OAuth is still required. No PRM → public.
            if (!token) {
                const meta = await probeAuthServerMeta(entry.server_url);
                if (meta) {
                    authorizeUrl = await startMcpOauth(
                        entry.server_url,
                        id,
                        oauth,
                        meta,
                        session.user.id,
                    );
                }
            }
        } catch (err) {
            if (!(err instanceof McpAuthRequired)) throw err;

            const meta = await getAuthServerMeta(entry.server_url, err.wwwAuthenticate);
            authorizeUrl = await startMcpOauth(entry.server_url, id, oauth, meta, session.user.id);
        }
    } catch (err) {
        // connect failures (unreachable server, no AS metadata, no dynamic
        // client registration, refused registration) surface inline on the
        // entry's card instead of crashing to the error page
        connectError = err instanceof Error ? err.message : "Connection failed";
    }
    // redirect throws internally — must run outside the try/catch
    if (connectError) {
        redirect(
            `/dashboard/settings?entry=${id}&mcp_error=${encodeURIComponent(connectError)}`,
        );
    }
    if (authorizeUrl) redirect(authorizeUrl);

    revalidatePath("/dashboard/settings");
}

// TEMPORARY: stores the user's OpenRouter key until the built-in token
// system lands. Write-only: blank keeps the stored key, checkbox clears.
export async function saveOpenrouterKey(formData: FormData) {
    const { session } = await requireUser();

    const key = String(formData.get("openrouterKey") ?? "").trim();
    if (key.length > MAX_TOKEN) throw new Error("Key too long");
    const clearKey = formData.get("clearKey") === "on";

    if (clearKey) {
        await db.query(
            `update user_secret set openrouter_key = '', updated_at = now()
             where user_id = $1`,
            [session.user.id],
        );
    } else if (key) {
        await db.query(
            `insert into user_secret (user_id, openrouter_key)
             values ($1, $2)
             on conflict (user_id)
             do update set openrouter_key = excluded.openrouter_key, updated_at = now()`,
            [session.user.id, key],
        );
    }

    revalidatePath("/dashboard/settings");
}

export async function deleteRegistryEntry(formData: FormData) {
    const { session } = await requireUser();

    const id = String(formData.get("id") ?? "");
    if (!UUID.test(id)) throw new Error("Invalid id");

    const { rowCount } = await db.query(
        "delete from registry_entry where id = $1 and user_id = $2",
        [id, session.user.id],
    );
    if (!rowCount) throw new Error("Not found");

    revalidatePath("/dashboard/settings");
}
