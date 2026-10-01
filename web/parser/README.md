# Span-first request parser (experimental)

Turns a Turkish/English event request, plus the previous plan, into plan
operations (`contract.ts`). It is standalone and not yet wired into `lib/`.

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

This is the selected prototype to continue improving. It remains separate
from the serving application. The 197/200 cached replay is a development
result after tuning against exposed cases, not launch qualification.

Known defects include optional `workshop olabilir` becoming mandatory,
clock alternatives or exclusions being dropped or inverted, `09:00`
becoming `21:00`, ignored equal-amount budget-basis corrections, and edits
that discard unrelated conditions. Repair these families, then evaluate
independent wording before integrating the parser.

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
