// Single-user self-hosted mode. SELF_HOSTED=1 turns Saturn into a one-owner
// instance: no sign-in, no plans/limits/credits, model calls funded only by
// PLATFORM_OPENROUTER_KEY, hosted MCP server behind a static bearer token.
//
// SELF_HOSTED is server-only (not NEXT_PUBLIC): importing it from a client
// component would silently inline `undefined` at build time. Server code
// threads it down as props where the client needs it.
export const SELF_HOSTED = process.env.SELF_HOSTED === "1";
export const SELF_HOSTED_USER_ID = "self-hosted-owner";
