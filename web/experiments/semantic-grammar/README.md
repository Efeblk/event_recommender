# Isolated semantic-grammar experiment

**Do not integrate this version.** It correctly executes only 13/120 clear constructed requests and weakens one Turkish coordinated exclusion. The speed result is useful; language coverage and scope are not qualified. No application source imports this experiment.

The implementation is a small Earley chart, with lexical edges that retain original UTF-16 ranges. Grammar productions compose typed predicates, AND/OR, parentheses, negation, hard/preferred conditions and state operations. Code copies exact amounts/bases and resolves dates against an explicit Istanbul reference date. A pure reducer applies a complete interpretation atomically. Missing budget basis and ambiguous correction targets can remain alternatives; unknown material causes refusal. There is no model, API key, package dependency or database access.

From this directory, with Node >=22.13:

```powershell
node --experimental-strip-types cli.mjs "maximum 700 TL per person"
node --experimental-strip-types cli.mjs "concert, preferably quiet"
npm test
```

The first example yields a hard `budget(lte, 700, TRY, per_person)` predicate. An omitted basis preserves per-person, per-ticket and group-total alternatives. These controlled examples do not establish everyday-language coverage.

The fixed 200-case constructed corpus is in [benchmarks/v1/heldout.json](benchmarks/v1/heldout.json), with [annotation provenance](benchmarks/v1/corpus-receipt.json). It has 100 Turkish/100 English cases, 120 clear/40 ambiguous/40 unsupported, 55 seeded states and 20 turns across ten actual-state chains. It is agent-authored and independently agent-reviewed, with correlated translated cases. Parent label review preceded the final grammar rewrite, so this is a frozen diagnostic, **not a fully blinded or externally human-labeled benchmark**. Original annotations and rejected draft are retained in ignored work artifacts.

To evaluate a future version, choose a new, empty evidence directory; the runner never overwrites a freeze or results:

```powershell
New-Item -ItemType Directory ../../work/semantic-grammar-new
node --experimental-strip-types run.mjs freeze benchmarks/v1/heldout.json ../../work/semantic-grammar-new
node --experimental-strip-types run.mjs run benchmarks/v1/heldout.json ../../work/semantic-grammar-new
```

This exposed corpus becomes regression/development data for future versions. Acquire genuinely independent labels before using a later pass as generalization evidence. The runner pins source/corpus hashes, passes only request fields to the parser, carries actual prior state after accepted turns, preserves state on refusal, records every result and verifies source spans and reducer consistency. Strict comparison preserves Boolean scope, modality, exact values and correction target IDs; only consecutive additions commute. Gold preflight never imports the parser.

The October 1 run made **zero provider calls**. It produced 14 accepted, 13 ambiguous and 173 unsupported results. Clear automatic correctness was 13/120 against 108 required; exact accepted correctness 13/14 against 98%; complete ambiguity representation 12/40 against 38 required; unsupported controls 40/40 refused. All output invariants passed, but those checks do not prove correct meanings. `Konser veya tiyatro olmasın; atölye olsun` incorrectly became `(concert OR NOT theatre) AND workshop`, instead of `NOT(concert OR theatre) AND workshop`. The implementation is preserved unchanged after this failure; no phrase patch or rerun followed.

Local sequential p95 was 1.364 ms across 199 warm calls (mostly refusals), or 2.068 ms across 26 warm non-refused calls, on Ryzen 7 7800X3D/Node 22.23.3. This excludes Jev, embeddings, retrieval, cloud performance and hosting cost. Guard development inputs took hundreds of milliseconds despite bounded chart work; the average diagnostic speed is not a worst-case HTTP guarantee.

There are 25 focused development/reducer checks. Full web typecheck and lint are also checked; no build, cloud deployment, CI or production quality claim is warranted. See [the evidence summary](../../../docs/response-quality-validation-2026-09-30.md#semantic-grammar-experiment-result-october-1) and ignored [raw outputs](../../work/semantic-grammar-20261001/raw-results.jsonl), [freeze](../../work/semantic-grammar-20261001/evaluation-freeze.json), [summary](../../work/semantic-grammar-20261001/summary.json) and [final review receipt](../../work/semantic-grammar-20261001/final-receipt.json).
