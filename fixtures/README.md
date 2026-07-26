# Interpreter golden fixtures

Executable specification of the workflow interpreter. `interpreter.ts` here is
the TypeScript **oracle** — no app code imports it; it exists only to generate
`expected/`, which is why it lives in this directory rather than in `lib/`. It
declares its own `ConsoleLine` (the app's copy lives in `lib/ipc.tsx`) and
otherwise imports only `lib/{agent,integrations,registry,workflow}.ts`.

Each case in `cases/` is a
workflow graph; each file in `expected/` is the exact console transcript and the
exact per-port value stream that graph produces. The Rust interpreter is correct
when it reproduces these files byte for byte.

```
node fixtures/run.mjs            verify everything, exit 1 on any mismatch
node fixtures/run.mjs --update   regenerate expected/ from the TS interpreter
node fixtures/run.mjs if-        verify only cases whose filename contains "if-"
```

No install step, no dependencies, no database. `run.mjs` registers a resolve
hook for tsconfig's `@/*` alias and lets Node strip the types (the oracle is
imported as `@/fixtures/interpreter` so it goes through that hook too); the
`interpreter → workflow → integrations → agent/cron/registry` subgraph is pure,
so it loads standalone.

## These files outlive the TypeScript

Phase F deletes `interpreter.ts`. From that moment `expected/` **is**
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
rather than a semantics question; only the `await-*` and `fanout-*` cases do it
deliberately. Keep it that way — but note the limit is narrower than it looks:
a *single* suspending branch is perfectly reproducible and
`fanout-suspending-sibling` pins it, because a failed branch must stop a
suspended sibling before its next step (that sibling could be a Discord send —
this is a side-effect divergence, not a transcript one). What no sequential
interpreter can reproduce is **several** entry nodes whose fan-outs suspend and
interleave on V8's microtask queue. Don't write that case.

## Traps these files exist to catch

A port that looks right and fails here:

- **UTF-16 code-unit ordering** (`if-string-order`). `<`/`>` compare code
  units, so an astral character sorts *below* every BMP character from U+E000
  up — the reverse of Rust's byte-wise `str` ordering. The same units drive
  `.length` and the 2000-char truncation (`http-request-stub` pins a lone
  surrogate at that cut, the one divergence a port cannot reproduce).
- **`String(number)`** (`number-boundaries`). Exponential above 1e21 and below
  1e-6, `-0` prints `0`, `Infinity` spelled out. And `Number(string)` accepts
  `0x`/`0b`/`0o` literals, which is how `extract` reaches `[10,20,30]` element
  `0x2` (`extract-index-coercion`).
- **Per-step evaluation state** (`fanout-shared-node`, `await-abandoned-in-loop`).
  The memo, the value-cycle stack and the await barrier are scoped to one flow
  step / one fan-out, not to the run — a shared one changes the value stream
  and can complete a barrier that should have been abandoned.
- **`branchFailed` is set a microtask late** (`fanout-abort-siblings`,
  `fanout-suspending-sibling`). A sibling that never suspends runs to completion
  *after* another branch has already aborted, because `.map` started every
  branch synchronously before the `.catch` microtask ran. Setting the flag
  eagerly changes the transcript. But a sibling that *does* suspend stops at its
  next step — get that half wrong and a failed branch still fires a Discord
  send.
- **Shortest-digits ties round to EVEN** (`number-ties-and-trim`). Where two
  decimal candidates round-trip equally well, ECMA-262 picks the even one;
  Rust's shortest formatter rounds half away from zero. Verified against V8 over
  849,857 doubles — 11 disagreed, all exact ties. "Always round down" is equally
  wrong, so both directions are pinned.
- **`.trim()` is `StrWhiteSpace`, not Unicode `White_Space`**
  (`number-ties-and-trim`). JS trims U+FEFF and does not trim U+0085; Rust does
  the opposite. Either flips a string between a number and `NaN`, which decides
  an `if` — and a BOM survives a copy-paste out of a file. Verified against V8
  over 200,053 strings.

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
