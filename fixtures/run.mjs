#!/usr/bin/env node
// Golden fixture oracle for lib/interpreter.ts.
//
// Runs every case in cases/ through the real TypeScript interpreter with
// deterministic stub hooks and compares the captured console + per-port values
// against expected/. The Rust port is checked against these files, so they
// must stay byte-identical run to run, machine to machine, forever — every
// stub answer is a pure function of its arguments and nothing reads the clock,
// the network, a random source or an environment variable.
//
//   node fixtures/run.mjs            verify (exit 1 on any mismatch)
//   node fixtures/run.mjs --update   regenerate expected/
//   node fixtures/run.mjs if-        verify only cases matching a substring
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

// lib/*.ts uses tsconfig's "@/*" alias. Node strips types natively but resolves
// nothing, so map the alias before the first import() of anything under lib/.
// catalog.json needs the type attribute the TS source omits (a bundler concern
// there, a hard requirement here).
const root = new URL("../", import.meta.url);
registerHooks({
    resolve(spec, ctx, next) {
        if (!spec.startsWith("@/")) return next(spec, ctx);
        const json = spec.endsWith(".json");
        const url = new URL(json ? spec.slice(2) : `${spec.slice(2)}.ts`, root).href;
        return json
            ? { url, format: "json", importAttributes: { type: "json" }, shortCircuit: true }
            : { url, format: "module-typescript", shortCircuit: true };
    },
});
const { runWorkflow } = await import("@/lib/interpreter");
const { CATALOG_BY_KEY } = await import("@/lib/workflow");

// FNV-1a over UTF-16 code units, prefixed with the same .length the
// interpreter's truncation uses — so a Rust port that measures in bytes or
// chars instead of UTF-16 units fails here rather than silently at 2000 chars.
// Rust: s.encode_utf16().
const digest = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
    }
    return `${s.length}#${h.toString(16).padStart(8, "0")}`;
};
// key-sorted so a Rust HashMap can reproduce it
const canon = (o) => JSON.stringify(o, Object.keys(o).sort());

// Every effectful hook answers from its arguments alone. Cases steer them
// through values they already control: an mcp tool named "big"/"boom", an
// integration config key "stub", an agent prompt prefixed "TOOL "/"MANY ".
function stubHooks(log) {
    return {
        emit: (line) => log.console.push(line),
        onValue: (nodeId, portId, text) => log.values.push([nodeId, portId, text]),
        callMcp: async (entryId, toolName, input) =>
            toolName === "boom"
                ? { error: `stub mcp refused ${entryId}` }
                : toolName === "big"
                  ? { text: "x".repeat(30_000) }
                  : { text: `mcp:${entryId}/${toolName}(${digest(input)})` },
        callMemory: async (memoryId, op, input) => ({
            text: `mem:${memoryId}/${op}(${digest(input)})`,
        }),
        callIntegration: async (providerId, config, message) =>
            config.stub === "error"
                ? { error: `stub ${providerId} refused` }
                : config.stub === "big"
                  // 3 UTF-16 units per group, so MAX_RESULT_CHARS (2000) cuts
                  // mid-surrogate-pair — the expected file pins the lone
                  // surrogate a char-or-byte-indexed port would never produce
                  ? { text: "y🚀".repeat(700) }
                  : {
                        text: `sent:${providerId} cfg=${digest(canon(config))} msg=${digest(message)}`,
                    },
        callAgent: async (req) => {
            if (req.model === "stub-error") return { error: "stub model failure" };
            const first = req.messages[0].content;
            const fresh = req.messages[req.messages.length - 1].role === "user";
            const call = (i) => ({
                id: `call-${i}`,
                entryId: req.tools[0]?.entryId ?? req.memoryId ?? "none",
                toolName: first.slice(first.indexOf(" ") + 1),
                arguments: `{"i":${i}}`,
            });
            if (fresh && first.startsWith("TOOL ")) return { content: "", toolCalls: [call(0)] };
            if (fresh && first.startsWith("MANY ")) {
                return { content: "", toolCalls: [0, 1, 2, 3, 4, 5, 6].map(call) };
            }
            // an output=image agent whose model returns no image falls back to
            // text, so both paths need steering
            if (req.outputImage && first.startsWith("IMG ")) {
                return { content: "", toolCalls: [], image: `data:image/png;base64,${"Q".repeat(4001)}` };
            }
            if (fresh && first.startsWith("MEM ")) {
                return {
                    content: "",
                    toolCalls: [{ ...call(0), entryId: req.memoryId ?? "none" }],
                };
            }
            // the transcript shape is the thing a port most easily gets wrong,
            // so report both readable per-message lengths and a full-fidelity
            // hash of the entire request
            const shape = req.messages.map((m) => `${m.role}:${m.content.length}`).join(",");
            return { content: `agent[${shape}](${digest(canon(req))})`, toolCalls: [] };
        },
    };
}

// A 10k-step case would otherwise commit a 400 KB expected file. The count is
// preserved, so a port that runs the wrong number of steps still fails.
const CAP = 500;
const elide = (arr) =>
    arr.length <= CAP ? arr : [...arr.slice(0, 480), `… ${arr.length - CAP} elided …`, ...arr.slice(-19)];

async function runCase(spec) {
    const byKey = { ...CATALOG_BY_KEY };
    for (const e of spec.entries ?? []) byKey[e.key] = e;
    const log = { console: [], values: [] };
    try {
        await runWorkflow(spec.graph, byKey, stubHooks(log), {
            entryNodeIds: spec.entryNodeIds,
            eventPayloads: spec.eventPayloads,
        });
    } catch (err) {
        // runWorkflow swallows RunAbort itself; anything reaching here is a
        // real escape and part of the spec
        log.threw = String(err?.message ?? err);
    }
    log.console = elide(log.console);
    log.values = elide(log.values);
    return log;
}

const dir = new URL("./", import.meta.url).pathname;
const update = process.argv.includes("--update");
const filter = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "";
mkdirSync(`${dir}expected`, { recursive: true });

let failed = 0;
let ran = 0;
for (const file of readdirSync(`${dir}cases`).sort()) {
    if (!file.endsWith(".json") || !file.includes(filter)) continue;
    const name = file.slice(0, -5);
    ran++;
    const actual = `${JSON.stringify(await runCase(JSON.parse(readFileSync(`${dir}cases/${file}`, "utf8"))), null, 2)}\n`;
    const path = `${dir}expected/${name}.json`;
    if (update) {
        writeFileSync(path, actual);
        continue;
    }
    let want;
    try {
        want = readFileSync(path, "utf8");
    } catch {
        console.log(`MISSING ${name} — run with --update`);
        failed++;
        continue;
    }
    if (want === actual) continue;
    failed++;
    console.log(`\nFAIL ${name}`);
    const a = want.split("\n");
    const b = actual.split("\n");
    let shown = 0;
    for (let i = 0; i < Math.max(a.length, b.length) && shown < 20; i++) {
        if (a[i] === b[i]) continue;
        shown++;
        if (a[i] !== undefined) console.log(`  ${i + 1} - ${a[i]}`);
        if (b[i] !== undefined) console.log(`  ${i + 1} + ${b[i]}`);
    }
}
console.log(update ? `updated ${ran} fixtures` : `${ran - failed}/${ran} fixtures passed`);
process.exit(failed ? 1 : 0);
