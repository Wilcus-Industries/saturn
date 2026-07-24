// Runnable check for the MCP session reuse in lib/mcp.ts (this repo has no test
// runner). Stubs fetch, so it makes no network calls; the server URL is an IP
// literal so the SSRF guard resolves without DNS.
//
//   node --experimental-strip-types scripts/check-mcp-session.ts   # from repo root
import assert from "node:assert/strict";
import { register } from "node:module";

// map "@/x" → "<cwd>/x.ts" so lib/mcp.ts's own imports resolve (node has no
// tsconfig-paths support). Inline loader module, so this check stays one file.
register(
    `data:text/javascript,${encodeURIComponent(`
        import { pathToFileURL } from "node:url";
        export function resolve(spec, ctx, next) {
            return spec.startsWith("@/")
                ? next(pathToFileURL(\`\${process.cwd()}/\${spec.slice(2)}.ts\`).href, ctx)
                : next(spec, ctx);
        }
    `)}`,
    import.meta.url,
);

const { callTool } = await import("@/lib/mcp");

const URL_A = "https://93.184.216.34/mcp";
type Call = { method: string; session: string | undefined; auth: string | undefined };
let calls: Call[] = [];
let gen = 1; // bump to expire every outstanding session id
globalThis.fetch = (async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(init.body as string) as { method: string };
    const auth = headers.authorization;
    const session = headers["mcp-session-id"];
    calls.push({ method: body.method, session, auth });

    // one session id per bearer token, so a session leaked across credentials
    // shows up; the generation suffix is how the test expires a session
    const issued = `sess-${auth?.replace("Bearer ", "") ?? "anon"}-${gen}`;
    if (session && session !== issued) return new Response("gone", { status: 404 });
    const json = (result: unknown) =>
        new Response(JSON.stringify({ jsonrpc: "2.0", id: body.method === "initialize" ? 1 : 2, result }), {
            headers: { "content-type": "application/json", "mcp-session-id": issued },
        });
    if (body.method === "tools/call") return json({ content: [{ type: "text", text: "ok" }] });
    return json({});
}) as typeof fetch;

const methods = () => calls.map((c) => c.method);
const reset = () => (calls = []);

// 1. cold call handshakes
assert.equal(await callTool(URL_A, "t", {}, "A"), "ok");
assert.deepEqual(methods(), ["initialize", "notifications/initialized", "tools/call"]);

// 2. warm call reuses the session — one round trip, right session id
reset();
assert.equal(await callTool(URL_A, "t", {}, "A"), "ok");
assert.deepEqual(methods(), ["tools/call"]);
assert.equal(calls[0].session, "sess-A-1");

// 3. a different token NEVER reuses another credential's session
reset();
await callTool(URL_A, "t", {}, "B");
assert.deepEqual(methods(), ["initialize", "notifications/initialized", "tools/call"]);
assert.equal(calls[2].session, "sess-B-1");
reset();
await callTool(URL_A, "t", {}, "A");
assert.deepEqual(calls.map((c) => [c.session, c.auth]), [["sess-A-1", "Bearer A"]]);

// 4. a rejected (stale) session re-handshakes instead of failing the tool call
reset();
gen = 2; // the cached sess-A-1 is now gone as far as the server is concerned
assert.equal(await callTool(URL_A, "t", {}, "A"), "ok");
assert.deepEqual(methods(), ["tools/call", "initialize", "notifications/initialized", "tools/call"]);
assert.equal(calls[3].session, "sess-A-2");

console.log("mcp session cache: ok");
