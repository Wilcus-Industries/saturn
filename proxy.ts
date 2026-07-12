import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Force an explicit consent screen on the hosted-MCP OAuth authorize endpoint.
//
// better-auth's mcp plugin (authorize.mjs) issues an authorization code with NO
// consent screen unless the request itself carries `prompt=consent`. Combined
// with anonymous dynamic client registration and a Lax session cookie, a
// logged-in victim lured to a crafted authorize URL would silently mint an
// access token bound to their account for an attacker-registered client —
// cross-account takeover. Rewriting every authorize request to include
// `prompt=consent` routes it through our /oauth/consent screen, which cannot
// proceed without an explicit click. The post-login resume path is covered too:
// the plugin stashes this (already-rewritten) query in a signed cookie and
// replays it after Google sign-in, so `prompt=consent` still applies.
export function proxy(request: NextRequest) {
    if (request.nextUrl.searchParams.get("prompt") === "consent") {
        return NextResponse.next();
    }
    const url = request.nextUrl.clone();
    url.searchParams.set("prompt", "consent");
    return NextResponse.redirect(url);
}

export const config = {
    matcher: "/api/auth/mcp/authorize",
};
