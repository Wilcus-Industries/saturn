import { oAuthProtectedResourceMetadata } from "better-auth/plugins";
import { auth } from "@/lib/auth";

// RFC 9728 protected-resource metadata for the /mcp server (root form).
export const GET = oAuthProtectedResourceMetadata(auth);
