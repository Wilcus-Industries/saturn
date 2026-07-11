import { oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { auth } from "@/lib/auth";

// RFC 9728 path-suffixed form (/.well-known/oauth-protected-resource/mcp) —
// what spec-following clients try first for the resource at /mcp.
export const GET = oAuthProtectedResourceMetadata(auth);
