#!/usr/bin/env node
// catalog.json is a snapshot of a derivation, and that is the drift hole this
// guards. Its integration:* / event:* tail is generated from the provider
// descriptors in lib/integrations.ts — pre-Phase-B lib/workflow.ts spread
// exactly these two .map()s into CATALOG at runtime, so drift was impossible;
// freezing the expansion into JSON made it possible and silent. Add an action,
// rename a config field, add an event, and both the designer and the Rust
// interpreter read a catalog that no longer matches the descriptors.
//
//   node scripts/gen-catalog.mjs          rewrite catalog.json
//   node scripts/gen-catalog.mjs --check  exit 1 if stale (npm run catalog:check)
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";

// lib/*.ts uses tsconfig's "@/*" alias. Node strips types natively but resolves
// nothing, so map the alias before the first import() of anything under lib/.
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
const {
    EVENT_PREFIX,
    EXTENSION_EVENTS,
    INTEGRATION_PREFIX,
    INTEGRATIONS,
    eventNodeKey,
    integrationKey,
} = await import("@/lib/integrations");
const { valuePort: v } = await import("@/lib/workflow");
const flow = (id) => ({ id, label: id, kind: "flow" });

const path = new URL("catalog.json", root);
const onDisk = readFileSync(path, "utf8");
const isDerived = (key) => key.startsWith(INTEGRATION_PREFIX) || key.startsWith(EVENT_PREFIX);

// AUTHORED — the static node types. Phase B deleted their literals from
// lib/workflow.ts, so catalog.json is their only source: read back verbatim,
// nothing here can re-derive them. Re-serializing still normalizes their
// formatting, so --check catches a hand-edit that broke the shape.
const authored = JSON.parse(onDisk).filter((e) => !isDerived(e.key));

// DERIVED — verbatim the two maps CATALOG used to spread (git show
// acf6fc6:lib/workflow.ts). Their per-entry semantics are documented at
// lib/workflow.ts's CATALOG comment, not repeated here.
const derived = [
    ...INTEGRATIONS.map((p) => ({
        key: integrationKey(p.id), category: "integration", label: p.label,
        group: p.app, section: p.section, logoDomain: p.logoDomain,
        inputs: [flow("in"), ...p.config.map((f) => v(f.id, f.label))],
        outputs: p.output ? [flow("out"), v(p.output.id, p.output.label)] : [flow("out")],
        config: p.config.map((f) => ({ ...f, overriddenBy: f.id })),
    })),
    ...EXTENSION_EVENTS.map((e) => ({
        key: eventNodeKey(e.id), category: "events", label: e.label,
        group: e.app, logoDomain: e.logoDomain, emoji: e.emoji,
        inputs: e.config.map((f) => v(f.id, f.label)),
        outputs: [flow("out"), v("payload")],
        config: e.config.map((f) => ({ ...f, overriddenBy: f.id })),
    })),
];

const want = `${JSON.stringify([...authored, ...derived], null, 2)}\n`;
if (!process.argv.includes("--check")) {
    writeFileSync(path, want);
    console.log(`catalog.json: ${authored.length} authored + ${derived.length} derived entries`);
    process.exit(0);
}
if (want === onDisk) {
    console.log(`catalog.json up to date (${authored.length} authored + ${derived.length} derived)`);
    process.exit(0);
}
console.log("catalog.json is STALE — regenerate with: node scripts/gen-catalog.mjs");
console.log("  - on disk   + regenerated from lib/integrations.ts\n");
const a = onDisk.split("\n");
const b = want.split("\n");
let shown = 0;
for (let i = 0; i < Math.max(a.length, b.length) && shown < 20; i++) {
    if (a[i] === b[i]) continue;
    shown++;
    if (a[i] !== undefined) console.log(`  ${i + 1} - ${a[i]}`);
    if (b[i] !== undefined) console.log(`  ${i + 1} + ${b[i]}`);
}
process.exit(1);
