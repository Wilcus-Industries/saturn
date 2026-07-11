// Server-side registry queries, split from lib/registry.ts so client
// components can import the types/helpers without pulling in pg.
import { type McpOauth, refreshTokens } from "@/lib/mcp";
import { db } from "@/lib/db";
import type { McpTool, RegistryEntryRow } from "@/lib/registry";

export async function getUserRegistry(userId: string): Promise<RegistryEntryRow[]> {
    // auth_token / oauth are write-only: never select them, only whether set
    const { rows } = await db.query(
        `select id, kind, name, emoji, description, server_url, tools,
                (auth_token <> '') as has_token,
                (coalesce(oauth->>'accessToken', '') <> '') as connected
         from registry_entry where user_id = $1 order by created_at`,
        [userId],
    );
    return rows as RegistryEntryRow[];
}

export type McpSecretsRow = {
    id: string;
    server_url: string;
    auth_token: string;
    tools: McpTool[];
    oauth: McpOauth;
};

// full credentials for one MCP entry — for server-side MCP calls only;
// nothing from this row may be returned to the client
export async function getMcpSecrets(id: string, userId: string): Promise<McpSecretsRow | null> {
    const { rows } = await db.query(
        `select id, server_url, auth_token, tools, oauth
         from registry_entry where id = $1 and user_id = $2 and kind = 'mcp'`,
        [id, userId],
    );
    return (rows[0] as McpSecretsRow) ?? null;
}

// bearer token for server-side MCP calls: a manual token wins, otherwise the
// stored OAuth access token (refreshed + persisted when expired). Also returns
// the oauth object as stored after any refresh so callers never hold a stale
// rotated refresh token.
export async function freshMcpToken(
    entry: McpSecretsRow,
    userId: string,
): Promise<{ token: string | undefined; oauth: McpOauth }> {
    let oauth = entry.oauth ?? {};
    if (entry.auth_token) return { token: entry.auth_token, oauth };

    if (
        oauth.accessToken &&
        oauth.refreshToken &&
        oauth.tokenUrl &&
        oauth.clientId &&
        oauth.expiresAt &&
        oauth.expiresAt < Date.now()
    ) {
        const refreshed = await refreshTokens({
            tokenUrl: oauth.tokenUrl,
            clientId: oauth.clientId,
            clientSecret: oauth.clientSecret,
            refreshToken: oauth.refreshToken,
            resource: entry.server_url,
        });
        oauth = {
            ...oauth,
            ...refreshed,
            refreshToken: refreshed.refreshToken ?? oauth.refreshToken,
        };
        await db.query(
            "update registry_entry set oauth = $1, updated_at = now() where id = $2 and user_id = $3",
            [JSON.stringify(oauth), entry.id, userId],
        );
    }
    return { token: oauth.accessToken, oauth };
}
