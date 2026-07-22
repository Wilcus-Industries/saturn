import { oAuthDiscoveryMetadata } from "better-auth/plugins";
import { auth } from "@/lib/auth";
import { SELF_HOSTED } from "@/lib/selfhost";

// RFC 8414 authorization-server metadata; MCP clients resolve this at the
// origin root because the protected-resource metadata lists the bare origin
// as the authorization server. Under SELF_HOSTED there is no OAuth flow (the
// /mcp server uses a static bearer token) — 404 so clients don't attempt it.
export const GET = SELF_HOSTED
    ? async () => new Response(null, { status: 404 })
    : oAuthDiscoveryMetadata(auth);
