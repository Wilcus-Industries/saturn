// Server-side registry queries, split from lib/registry.ts so client
// components can import the types/helpers without pulling in pg.
import { type McpOauth, refreshTokens } from "@/lib/mcp";
import { createTtlCache } from "@/lib/cache.server";
import { db } from "@/lib/db";
import type { McpTool, RegistryEntryRow } from "@/lib/registry";

// per-user registry rows (no secrets — getMcpSecrets stays uncached). The TTL
// backstops mutation paths that miss invalidateUserRegistry; settings actions
// and the MCP OAuth callback invalidate explicitly.
const registryCache = createTtlCache<RegistryEntryRow[]>(60_000);

export function invalidateUserRegistry(userId: string) {
    registryCache.delete(userId);
}

export async function getUserRegistry(userId: string): Promise<RegistryEntryRow[]> {
    return registryCache.getOrLoad(userId, async () => {
        // auth_token / oauth are write-only: never select them, only whether set.
        // Sole exception: a regular (non-secret) variable's value IS viewable, so
        // the case guard exposes auth_token only for kind='variable' and not secret
        // — mcp tokens and secret variables always project '' here.
        const { rows } = await db.query(
            `select id, kind, name, emoji, description, server_url, tools,
                    (auth_token <> '') as has_token,
                    (coalesce(oauth->>'accessToken', '') <> '') as connected,
                    secret,
                    case when kind = 'variable' and not secret then auth_token else '' end as value
             from registry_entry where user_id = $1 order by created_at`,
            [userId],
        );
        return rows as RegistryEntryRow[];
    });
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

// secret values for variable entries (kind 'variable', value in auth_token) —
// for server-side sentinel substitution only (lib/integrations.server.ts);
// uncached like getMcpSecrets, and nothing here may be returned to the client
export async function getVariableValues(
    userId: string,
    ids: string[],
): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { rows } = await db.query(
        `select id, auth_token from registry_entry
         where user_id = $1 and kind = 'variable' and id = any($2::uuid[])`,
        [userId, ids],
    );
    return new Map(rows.map((r: { id: string; auth_token: string }) => [r.id, r.auth_token]));
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
