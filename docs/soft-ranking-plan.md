# Soft ranking signals: location and price (plan)

Status (2026-10-02): Phase 1 in PR #28. Phase 2 is implemented offline in a stacked PR and awaits a bounded live Jev evaluation. Phases 3–4 are not started.

## Goal

Let soft preferences (location, price) *nudge* the relevance ranking before the
16-candidate Jev shortlist. They must never override hard constraints or
mandatory evidence, and unknown evidence must stay neutral.

## Current state

- Retrieval: lexical BM25 + dense Voyage ranks are combined with reciprocal rank
  fusion (`web/lib/hybrid.ts`); ties fall back to start time.
- The default span-v2 parser already emits `plan.preferences` (soft conditions),
  including `location` (district/neighborhood) and `budget` atoms. Today they
  only add words to the retrieval query (`web/lib/plan-query.ts`). They do
  not influence ranking.
- `plan.order === 'cheapest'` already sorts by price; `'nearest'` is mapped to
  `'none'` because there is no user geolocation.
- `district` is only a hard filter (`isEligible` in `web/lib/search.ts`).
- "Anadolu/Avrupa yakası" is listed in `OUTSIDE_ISTANBUL`
  (`web/parser/lexicon.ts`), so a request for either side is treated as an
  unsupported location.
- Location data quality (local `web/data/events.json`, 4,076 sessions):
  1,980 have an empty `district` (most addresses still name the district);
  1,455 have only a side label (`İstanbul Avrupa` / `İstanbul Anadolu`); the
  rest mix districts with neighborhoods (`MECİDİYEKÖY`, `HARBİYE`, `MODA`).
  Some addresses contain a neighborhood that is also a district name
  (`Fatih, …, Büyükçekmece/İstanbul`). Only the district before
  `/İstanbul` is trustworthy.

## Design

Each active soft preference yields a signal `s ∈ [-1, 1]`. Unknown evidence
gives `0`. The mean signal adjusts a rank-derived base score:

```
base(rank) = 1 / (60 + rank + 1)            # same k as the existing RRF
final      = base × (1 + clamp(0.25 × mean(s), -0.25, +0.25))
```

The cap keeps relevance dominant. With k = 60, a fully matching event can climb
from about rank 15 to the top; a fully contradicting event drops at most about
20 places. The original order breaks ties. Preferences are ignored when there
are none, so default ranking is unchanged.

Location signal (per preference atom):

| Event location evidence | District preference | Neighborhood preference |
|---|---|---|
| Same district | +1 | +0.75 (district-level evidence only) |
| Same side (Avrupa/Anadolu), other district | +0.25 | +0.25 |
| Other side | −0.5 | −0.5 |
| Unknown / side unknown | 0 | 0 |

The event's location is resolved with explicit precision (`district`, `side`,
`unknown`). Sources, in order: the canonical `district` field; the
unique address district in `…<district>/İstanbul` form; a mapped neighborhood
label in the `district` field; a provider side label. Conflicts resolve to
`unknown`, never to a guess.

Budget signal (per preference atom, verified TRY price only; `group_total` needs
a known party count):

- `lt`/`lte`: within the limit gives +1; above it gives `−min(1, 2 × overshoot ratio)`
  (20 % over → −0.4).
- `gt`/`gte`: satisfied gives +1; otherwise −0.5.
- `approx`: within ±20 % gives +1; otherwise `−min(1, deviation ratio)`.
- Unknown price or currency → 0.

Other preference kinds (topic, experience, …) are neutral in Phase 1.

## Phases

1. **Ranking module + location resolver (this change, offline only).**
   - `web/lib/istanbul-location.ts`: district→side table, neighborhood→district
     table for the parser lexicon neighborhoods, `resolveEventLocation(event)`.
     The hard `district` filter is unchanged.
   - `web/lib/soft-preferences.ts`: signal computation and bounded rerank.
   - Wire it into `rankedCandidates` via `ResolvedRetrievalContext.preferences`
     (span-v2 plan path), so both shortlist and fallback ranking use it.
   - Unit tests: neutral unknowns, bounded movement, hard-filter independence,
     group budget basis, conflict→unknown, no-preference no-op.
   - Offline audit: location precision distribution over the local catalog.
   - Acceptance: `npm test`, `npm run typecheck`, `npm run lint` in `web/`;
     `check-release-cases.mjs` unchanged; no live calls.
2. **Side preferences in the parser.** Move "Anadolu/Avrupa yakası / Asian/
   European side" from `OUTSIDE_ISTANBUL` to a supported `side` location
   precision (hard and soft). This needs parser bench cases and a bounded live
   Jev evaluation, so the budget must be agreed first.
3. **Better location evidence in preparation.** Resolve venue location once in
   `collector/` (venue → district/side with precision and source), then later
   use PostGIS coordinates and travel-time buckets instead of side-level
   proxies. Add district adjacency only from a reviewed table or real
   coordinates, never from guesses.
4. **Category-relative price percentile and calibration.** A default price
   preference only applies when requested (`ucuz`), measured within category
   among eligible events. Tune weights on a human-reviewed held-out set (nDCG
   against the relevance-only baseline) with logged per-request features.

## Phase 1 result (2026-10-02)

- `resolveEventLocation` over the local `web/data/events.json` (4,076 sessions),
  using `web/scripts/audit-location-precision.ts`: 3,467 district (2,120
  Europe, 1,347 Asia), 594 side-only (302 / 292), 15 unknown. Of the unknowns,
  9 are provider conflicts (`İstanbul Avrupa` label with a Kadıköy address);
  the rest lack a recognisable district. This is a local snapshot, not
  the managed catalog.
- Soft location/budget nudges apply on the span-v2 plan path
  (`ResolvedRetrievalContext.softPreferences`) to both the Jev shortlist and
  the fallback ranking. The legacy intent path is unchanged.
- Checks in `web/`: `npm test` (724/724), `npm run typecheck`, `npm run lint`,
  `scripts/check-release-cases.mjs` (20 cases, 0 live requests). There were no
  live Jev/Voyage calls, so live relevance impact is not yet measured.

## Phase 2 result (2026-10-02, offline)

- `location` atoms gain `precision: 'side'` with canonical names
  `Avrupa yakası` / `Anadolu yakası`. The parser extracts Turkish (including
  inflected and lowercase forms) and English ("European/Asian/Anatolian side")
  surfaces. These are no longer in `OUTSIDE_ISTANBUL`, and Jev's
  supported-capabilities text lists them.
- A required side is supported or contradicted by the resolved venue side;
  unresolved or conflicting locations stay unknown and therefore do not pass.
  A preferred side scores +1 for the same side and −0.5 for the other side.
- The legacy (non-span) interpreter is unchanged and still reports sides as
  unsupported.
- Offline checks: parser composition tests with synthetic Jev answers, plus
  plan-evidence, validation and soft-scoring tests. `npm test`, typecheck,
  lint and release cases pass. The parser bench cannot run offline here (no
  Jev response cache), and the instruction text changed.
- Still needed before merge: a bounded live parser-bench run comparing the
  baseline with this change, including `gliner-cases-v2` cases that now
  expect "Anadolu yakası tercihimiz" as an applied preference rather than
  not applied. That case file's expectations must be updated with the
  evaluation, not before it.

## Non-goals

- No default "cheaper is better" or "sooner is better" bias without a request.
- No quality/value scoring until an evidence rubric is calibrated (see
  `catalog-enrichment-architecture.md`).
- No change to hard-constraint semantics or Jev support thresholds.
