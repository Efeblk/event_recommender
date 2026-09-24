# Stateful recommendation verification — 24 September 2026

Local testing only; no deployment. Synthetic Turkish and English conversations exercise the same history, filters and alternative exclusions sent by the website. These are API checks, not browser click-through or an unbiased accuracy benchmark.

## Baseline and fixes

The [16 frozen cases](../evals/cases/2026-09-24-real-user-journeys.json) cover informal spelling, date correction, time bounds, changed budgets, rejected suggestions, English preference removal, group size, conversation reset, mood, child age, free-only events, unsupported cities and contradictory constraints.

- [Baseline, `02d7ded`](../evals/reports/2026-09-24-real-user-baseline.json): **4 pass, 3 partial, 9 fail**. Missing constraints count as failures/partials even if the displayed cards coincidentally satisfy them. Parent failures propagate; these are scenario outcomes, not independent root-cause counts.
- [First complete rerun, `636a968`](../evals/reports/2026-09-24-real-user-after-fixes.json): **14 pass, 2 fail**. All 16 HTTP requests succeeded in 36–3,325 ms. Drama and mood requests still returned empty despite plausible catalog matches.

Corrections cover Turkish district suffixes, negated dates/free pricing, English constraint removal, party-size budgets, contradictory times, full preference resets, casual alternatives, provider-title aliases, topic-specific content waivers and source-supported child age. Later investigation found that a category switch cleared older intent only for one turn; the boundary now persists through subsequent follow-ups. Dramatic theatre requests now require drama evidence, without treating “dramaturg” as a genre.

## Retrieval and admission

The first mood trace exposed a weak shortlist. Limited candidate coverage now includes source-described acoustic, chamber/strings, recital and candle formats for calm optional preferences. These are candidates for ranking, not promises of quietness, romance or seating. Eligibility and mandatory evidence gates run first; resets, negations and original hybrid ranking order are retained.

The [second diagnostic trace](../evals/reports/2026-09-24-real-user-mood-trace-final.json), on `5e2fa78`, includes the acoustic and cello programs but still returns empty: expected scores 1.98 and 1.97 fail the old >=2 mean threshold. This trace intentionally remains an observed failure despite its chronological filename.

Jev admission now uses probability mass on supported rubric levels 2 and 3 (>=0.70); expected score remains the ordering signal. A mean of 1.98 alone cannot distinguish 98% level-2 support from a 51% level-1 / 49% level-3 split. Missing or invalid support probabilities fail closed. The 0.70 boundary is an initial product policy, not a calibrated accuracy guarantee. Provider confidence is not substituted for support probability.

## Final validation

209 unit/regression tests, typecheck, lint, production build and compiled Worker/D1/R2 smoke checks pass. The stalled-body Voyage adapter test also passes. One smoke invocation ran before the build artifact existed and exited without a provider call; it was rerun successfully after the build completed.

The [probability diagnostic](../evals/reports/2026-09-24-real-user-mood-probability.json), runtime `141d955`, records 89% supported probability for Okan Reis and 90% for the cello program. Both become the first two suggestions. Three lower-ranked suggestions support entertainment more clearly than calmness; ranking is useful but imperfect. Twelve of sixteen candidates clear the admission boundary, including weaker fits, so this trace does not establish calibrated precision.

The [four precision requests](../evals/reports/2026-09-24-admission-precision.json) retain the intended evidence boundaries: ordinary family suitability returns source-backed options; strict profanity/sexual-content absence and required step-free entry remain empty; mandatory quiet/no crowds also remains empty. These results do not prove that every possible mandatory phrase is recognized.

The [final complete 16-request run](../evals/reports/2026-09-24-real-user-final.json) meets **16/16 bounded expectations**, with qualified card relevance. Together with the four precision cases, this is **20/20 final scenario checks**, not a claim that every returned card is an equally strong match. The final report records `a5302ed`; its runtime code is identical to compiled `141d955` (the intervening commit only updates replay tooling). All final HTTP requests succeeded: the 16 journeys took 39–3,010 ms; the four precision requests took 250–2,452 ms.

One final request (`later_and_raise`) explicitly reported unavailable semantic retrieval, used lexical retrieval, and still received Jev ranking with correct filters and compliant cards. Its provider cause was not established. The precision runner overlapped the beginning of the final journey runner; this is not uninterrupted provider success. No request was automatically retried.

The drama results include three clearly supported plays and one mixed dramatic/humorous performance; the latter is less cleanly aligned with “not comedy.” The mood request has two leading format-backed matches and three weaker entertainment choices. Both previously empty flows are useful now, but ranking refinement remains warranted.

This task preserved **52 API requests across baseline, intermediate, final and precision runs**, plus **three direct ranking diagnostics** (each one query embedding and one Jev call). No failed baseline was overwritten.

## Provenance and limits

Each API runner spaces its own requests by 25 seconds, with no automatic retries. Local synthetic visitor addresses isolate these journeys from prior manual sessions; application hourly and daily limits remain enabled. Diagnostic traces call the recommendation function directly, with cached document vectors and at most one query embedding and one Jev call each. They are separate from API-flow evidence.

The current catalog has 2,394 canonical eligible sessions and all 1,229 required embedding documents cached; no reindex was needed for these changes. Title merging remains bounded: reviewed aliases or trailing stand-up format labels, with exact venue and session time required to combine ticket offers.

T3Code reports “No preview automation host is available.” The supplied screenshot demonstrates rendering, but automated final browser interactions remain unverified. Native computer controls were not used. Sparse provider descriptions remain a limitation: one alternate is labeled stand-up by the provider but titled as an interactive talk show, so its format evidence is weaker. These cases do not establish universal language understanding or complete deduplication.
