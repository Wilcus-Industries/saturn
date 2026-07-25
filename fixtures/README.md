# Interpreter golden fixtures

Executable specification of `lib/interpreter.ts`. Each case in `cases/` is a
workflow graph; each file in `expected/` is the exact console transcript and the
exact per-port value stream that graph produces. The Rust interpreter is correct
when it reproduces these files byte for byte.

```
node fixtures/run.mjs            verify everything, exit 1 on any mismatch
node fixtures/run.mjs --update   regenerate expected/ from the TS interpreter
node fixtures/run.mjs if-        verify only cases whose filename contains "if-"
```

No install step, no dependencies, no database. `run.mjs` registers a resolve
hook for tsconfig's `@/*` alias and lets Node strip the types; the
`interpreter → workflow → integrations → agent/cron/registry` subgraph is pure,
so it loads standalone.

## These files outlive the TypeScript

Phase F deletes the TypeScript interpreter. From that moment `expected/` **is**
the specification — there is nothing left to regenerate it from. Do not run
`--update` to make a failing case pass. A diff means one of two things:

- the Rust port is wrong (the usual case), or
- the semantics were deliberately changed, in which case the expected file is
  edited in the same commit as the change, by hand, with the reason in the
  message.

## What is captured

`emit` (the console) and `onValue` (every value computed on every output port,
in evaluation order). `onValue` is the stricter of the two: it pins evaluation
order, the memoization that keeps a diamond from evaluating a node twice, and
the exact `String()` rendering of every intermediate — none of which the printed
output alone would catch.

Arrays longer than 500 entries keep their first 480 and last 19 with an
`"… N elided …"` marker in between; the count still has to match.

## Determinism

Every hook answer is a pure function of its arguments. Nothing reads the clock,
the network, a random source, or the environment. The stubs are in `run.mjs`:

| hook | canned answer |
|---|---|
| `callMcp` | `mcp:<entryId>/<tool>(<digest of input>)`; tool `big` returns 30 000 chars, tool `boom` returns an error |
| `callMemory` | `mem:<storeId>/<op>(<digest>)` |
| `callIntegration` | `sent:<provider> cfg=<digest> msg=<digest>`; node config `stub: "big"` returns a long string, `stub: "error"` returns an error |
| `callAgent` | `agent[<per-message role:length>](<digest of the whole request>)`; a prompt starting `TOOL `/`MEM `/`MANY `/`IMG ` steers it into the tool loop, the memory route, the per-turn cap, or an image reply; model `stub-error` fails |

`digest` is `<utf16 length>#<FNV-1a hex>` over **UTF-16 code units** — matching
the units `.length` and `.slice()` count inside the interpreter. In Rust that is
`s.encode_utf16()`. A port that measures bytes or `char`s fails here rather than
silently at the 2000-char truncation boundary.

## Adding a case

Write `cases/<name>.json`:

```jsonc
{
  "graph": { "nodes": [...], "edges": [...] },   // a WorkflowGraph, required
  "entries": [ /* CatalogEntry */ ],             // registry-backed node types
  "entryNodeIds": ["..."],                       // else every event node fires
  "eventPayloads": { "<nodeId>": "<json>" }      // event node payload seeding
}
```

`entries` is merged over `CATALOG_BY_KEY`, so mcp / skill / memory / variable
node types (which normally come from the user's registry and a database) are
declared inline. Then run `--update` once and **read the generated file** — the
point is that a human agreed the output is right, not that a run produced it.

Prefer a linear flow chain. A flow fan-out makes emit order an ordering question
rather than a semantics question; `await-join` and `await-abandoned` cover that
deliberately and nothing else should.

## Coupling worth knowing

Console text embeds node **labels** from `catalog.json` (`"print"`,
`"send webhook"`, `"agent"`). Renaming a catalog label changes these files.
That is intended: the label is part of the observable behaviour.

Only the first 17 catalog entries are authored in `catalog.json`. The
`integration:*` / `event:*` tail is **derived** from the provider descriptors in
`lib/integrations.ts` — `"send webhook"` above is one of them, and touching a
descriptor there is what silently rots the JSON. Regenerate with
`node scripts/gen-catalog.mjs`; `npm run lint` runs its `--check` mode first and
fails on drift.
