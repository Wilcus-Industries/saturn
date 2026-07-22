import { oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { auth } from "@/lib/auth";
import { SELF_HOSTED } from "@/lib/selfhost";

// RFC 9728 protected-resource metadata for the /mcp server (root form). Under
// SELF_HOSTED the /mcp server uses a static bearer token, not OAuth — 404.
export const GET = SELF_HOSTED
    ? async () => new Response(null, { status: 404 })
    : oAuthProtectedResourceMetadata(auth);
