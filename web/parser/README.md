# Span-first request parser (experimental)

Turns a Turkish/English event request, plus the previous plan, into plan
operations (`contract.ts`). The application integration is opt-in through
`INPUT_INTERPRETER=span-v2`; see [retrieval integration](../../docs/span-parser-retrieval.md).

1. `extract.ts` proposes literal mentions with recall-oriented vocabulary and
   computes every value in code (dates, clocks, amounts, counts, places).
2. `parse.ts` sends **one** Jev request with narrow questions about those
   mentions only: polarity, strength, price comparison/basis, clock bounds,
   coordination, modifier scope, edits of existing conditions, vague
   references, sorting, reset and unsupported clauses.
3. Code composes operations; `state.ts` applies them.

Choice answers generally use their argmax; separate plausibility and hedge
rules affect ambiguity and optionality. These composition rules remain
experimental and have known failures. A valid answer is not a guarantee
that the resulting plan preserves the whole request.

## Integration status

This is the selected prototype to continue improving. Production transport
uses the pure `parse-core.ts` module through `lib/span-interpreter.ts`;
the standalone `parse.ts` benchmark client is not imported by the application.
The 197/200 cached replay is a development result after tuning against exposed
cases, not launch qualification.

The October 2 repair adds offline regressions for explicit clocks and invalid
calendar dates; clock alternatives and exclusions; hedge scope and permissive
workshops; budget-basis corrections; compound edits; inverse experiences; and
incomplete provider answers. These establish deterministic extraction and
composition behavior with supplied judgments. The revised questions still need
independent model evaluation before enabling the opt-in runtime; the historical
197/200 score below does not measure this changed revision.

## Benchmarks

```sh
# From web/, replay existing responses without inference:
node --experimental-strip-types parser/bench/run.mjs all --offline

# These manual review scripts can make paid calls on cache misses:
node --experimental-strip-types parser/bench/run-fixture58.mjs
node --experimental-strip-types parser/bench/run-gliner-cases.mjs
```

Responses are cached by request hash in `.runtime/jev-cache/`; `--offline`
replays without calls. `.runtime/jev-ledger.jsonl` records every paid call.
The client's local USD 3 cap is not authorization or a task-wide budget;
reconcile existing ledgers before any new live evaluation. The optional
GLiNER backend and proposal cache also need versioned provenance before
performance claims.

`bench/heldout-200.json` is split by family (`bench/split.mjs`). The parser
was developed on `dev` and evaluated once on `test` at commit `d10d6c7`:

| Split | Clear | Ambiguous | Unsupported | Total |
| --- | --- | --- | --- | --- |
| dev (tuned) | 62/62 | 19/20 | 20/20 | 101/102 |
| test (frozen, first run) | 46/58 | 14/20 | 17/20 | **77/98** |

Later fixes used the test failures, so subsequent 200-case scores (197/200)
are development scores, not held-out estimates. The two Codex corpora above
use a different schema and policy and were reviewed manually.
