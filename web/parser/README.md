# Request parser

The v1 request path is stateless. `recommendRequest` reads only the current
`message`. It ignores earlier plans, history, filters, clarification text and
shown event IDs. The API and the golden runner use this same entry point.

`span-v2` is the default protocol when Jev is configured. The name now refers
to the field-reader protocol. It is not an opt-in to the older span-first
implementation. `lib/span-interpreter.ts` calls `buildFieldRequest` and
`composeFields` from `fields.ts`.

The current flow is:

1. `fields.ts` asks one set of Jev questions about every supported field in the
   complete current message.
2. Code resolves dates, clocks, amounts, ages, places, categories, negations
   and condition groups.
3. A stated field that code cannot resolve returns a clarification. Search does
   not silently drop it.
4. The resulting plan goes to source-evidence checks and full-catalog
   retrieval. See the [v1 architecture](../../docs/architecture.md).

Without Jev configuration, `lib/interpreter-config.ts` selects the rules
fallback. An explicit `INPUT_INTERPRETER` value can select a legacy interpreter,
but the v1 product path uses the field reader.

## Older span-first parser

`parse.ts` and `gliner.ts` are legacy entry points. The span-first request
builder and composer remain in `parse-core.ts`, and `extract.ts` supports that
older path. The field reader still shares `contract.ts`, `lexicon.ts` and
`state.ts`. `state.ts` uses `semantics.ts`. The field reader also imports
response and result types from `parse-core.ts`. These shared files are live
dependencies and are not unused parser code. The product plan keeps removal of
the older span-first path as a later task. The archived [span parser retrieval
record](../../docs/archive/span-parser-retrieval.md) preserves its original
integration claims.

The commands below replay historical parser benchmarks. They do not evaluate
the current field reader.

```sh
# From web/, replay existing responses without inference:
node --experimental-strip-types parser/bench/run.mjs all --offline

# These historical manual review scripts can make paid calls on cache misses:
node --experimental-strip-types parser/bench/run-fixture58.mjs
node --experimental-strip-types parser/bench/run-gliner-cases.mjs
```

Responses are cached by request hash in `.runtime/jev-cache/`; `--offline`
replays without calls. `.runtime/jev-ledger.jsonl` records every paid call.
The client's local USD 3 cap is not authorization or a task-wide budget.
Reconcile existing ledgers before any new live evaluation. The optional GLiNER
backend and proposal cache also need versioned provenance before performance
claims.

## Historical benchmark evidence

The older parser developed on `bench/heldout-200.json` and its split in
`bench/split.mjs`. It was evaluated once on `test` at commit `d10d6c7`:

| Split | Clear | Ambiguous | Unsupported | Total |
| --- | --- | --- | --- | --- |
| dev (tuned) | 62/62 | 19/20 | 20/20 | 101/102 |
| test (frozen, first run) | 46/58 | 14/20 | 17/20 | **77/98** |

Later fixes used the test failures. The later 197/200 replay was therefore a
development score, not a held-out estimate or launch qualification. The
October 2 repair added offline regressions for clocks, calendar dates,
alternatives, exclusions, hedge scope, budgets, edits, inverse experiences and
incomplete provider answers. Those checks established behavior with supplied
judgments. They did not measure the current field reader or independent model
accuracy.
