import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import { discoverTools, exchangeCode, type McpOauth } from "@/lib/mcp";
import { type McpTool, mergeTools } from "@/lib/registry";
import { baseUrl } from "@/lib/subscription";

// OAuth redirect target for MCP server authorization (started from the
// settings "discover" action). Validates the signed-in user + state nonce,
// exchanges the code, stores tokens server-side, then re-runs discovery.
export async function GET(request: Request) {
    const settingsUrl = `${baseUrl}/dashboard/settings`;

    const session = await auth.api.getSession({ headers: await headers() });
    if (!session?.user) return NextResponse.redirect(`${baseUrl}/onboard`);

    const params = new URL(request.url).searchParams;
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) return NextResponse.redirect(settingsUrl);

    // state is a per-attempt nonce stored on exactly one of the user's rows
    const { rows } = await db.query(
        `select id, server_url, tools, oauth from registry_entry
         where user_id = $1 and kind = 'mcp' and oauth->>'state' = $2`,
        [session.user.id, state],
    );
    const entry = rows[0] as
        | { id: string; server_url: string; tools: McpTool[]; oauth: McpOauth }
        | undefined;
    if (!entry?.oauth.tokenUrl || !entry.oauth.clientId || !entry.oauth.codeVerifier) {
        return NextResponse.redirect(settingsUrl);
    }

    const tokens = await exchangeCode({
        tokenUrl: entry.oauth.tokenUrl,
        clientId: entry.oauth.clientId,
        clientSecret: entry.oauth.clientSecret,
        code,
        redirectUri: `${baseUrl}/api/mcp/oauth/callback`,
        codeVerifier: entry.oauth.codeVerifier,
        resource: entry.server_url,
    });

    const oauth: McpOauth = {
        ...entry.oauth,
        ...tokens,
        state: undefined,
        codeVerifier: undefined,
    };
    await db.query(
        "update registry_entry set oauth = $1, updated_at = now() where id = $2 and user_id = $3",
        [JSON.stringify(oauth), entry.id, session.user.id],
    );

    // finish what the user started: pull the tool list with the new token
    try {
        const discovered = await discoverTools(entry.server_url, tokens.accessToken);
        await db.query(
            "update registry_entry set tools = $1, updated_at = now() where id = $2 and user_id = $3",
            [JSON.stringify(mergeTools(entry.tools, discovered)), entry.id, session.user.id],
        );
    } catch {
        // token stored — the user can hit discover again from settings
    }

    return NextResponse.redirect(settingsUrl);
}
