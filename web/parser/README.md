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

Every judgment takes its argmax. Ambiguity comes only from designated
plausibility judgments (unstated budget basis, "next Saturday", vague
references, modifier scope), so one uncertain answer never blocks a clear
request. Missing values never delete existing constraints.

## Benchmarks

```sh
node bench/run.mjs <dev|test|all> [--offline] [--only=id,id] [--verbose]
node bench/run-fixture58.mjs      # Codex 58-case fixture, manual review
node bench/run-gliner-cases.mjs   # Codex GLiNER conversations, manual review
```

Responses are cached by request hash in `.runtime/jev-cache/`; `--offline`
replays without calls. `.runtime/jev-ledger.jsonl` records every paid call.

`bench/heldout-200.json` is split by family (`bench/split.mjs`). The parser
was developed on `dev` and evaluated once on `test` at commit `d10d6c7`:

| Split | Clear | Ambiguous | Unsupported | Total |
| --- | --- | --- | --- | --- |
| dev (tuned) | 62/62 | 19/20 | 20/20 | 101/102 |
| test (frozen, first run) | 46/58 | 14/20 | 17/20 | **77/98** |

Later fixes used the test failures, so subsequent 200-case scores (197/200)
are development scores, not held-out estimates. The two Codex corpora above
use a different schema and policy and were reviewed manually.
