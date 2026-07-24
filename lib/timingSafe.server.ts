// Constant-time string compare, shared by every secret-checking route shell
// (hosted MCP static bearer, GitHub webhook HMAC, inbound workflow webhook).
// Server-only, and deliberately importing nothing but node:crypto — each caller
// is its own route bundle, so this module must stay free of transitive weight.
import { timingSafeEqual } from "node:crypto";

// Length is compared first because timingSafeEqual THROWS on unequal-length
// buffers. Length therefore leaks (it always does over the wire); the bytes
// don't.
export function timingSafeEquals(provided: string, expected: string): boolean {
    const a = Buffer.from(provided, "utf8");
    const b = Buffer.from(expected, "utf8");
    return a.length === b.length && timingSafeEqual(a, b);
}
