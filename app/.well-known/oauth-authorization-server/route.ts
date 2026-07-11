import { oAuthDiscoveryMetadata } from "better-auth/plugins";
import { auth } from "@/lib/auth";

// RFC 8414 authorization-server metadata; MCP clients resolve this at the
// origin root because the protected-resource metadata lists the bare origin
// as the authorization server.
export const GET = oAuthDiscoveryMetadata(auth);
