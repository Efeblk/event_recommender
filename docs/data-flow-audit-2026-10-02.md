# Data flow audit and rebuild plan (2026-10-02)

Status: audit and proposal only; no code changed. Existing database contents,
snapshots and merged IDs do not need to be preserved.

Evidence: code at `4b2cdce`, provider fixtures in `collector/tests/fixtures`,
and the committed snapshot `web/data/events.json` (Sep 26, older record format).
Not verified: live provider payloads (whether they expose stable venue IDs), and
the current staging catalog.

## 1. Current flow

```
GitHub Actions cron
  ├─ collect.yml      → collector → snapshot JSON → POST /api/admin/import → Cloudflare D1/R2
  └─ gcp-collector.yml (every 6 h, staging)
                      → collector → snapshot JSON → POST /api/admin/import → Firestore/GCS
                                                    checkpoint → buildSearchCatalog → GCS search catalog
                                                    → index-collected-embeddings (Voyage)
PostgreSQL (staging drills only, not fed by the scheduled collector)
  frozen import (import.ts → catalog-knowledge.ts) and canonical/batch/page jobs (migrations 002–013)
```

| Stage | Where | Notes |
|---|---|---|
| Discover/fetch | `collector/run.mjs`, `discovery.mjs`, `coverage.mjs` | Solid: robots, pacing, bounded budgets, durable coverage, retired vs failed pages. |
| Extract | `collector/adapters.mjs` (Biletix, Bubilet), `biletinial.mjs` | Provider-specific, well guarded against partial pages. Emits a flat `EventRecord`. |
| Reconcile/publish | `collector/pipeline.mjs`, `publish.mjs` | Carries fresh records 72 h, publication gate, batched import. |
| Identity/merge | `web/lib/event-merge.ts` + three other places (below) | The weak point. |
| Search build | `web/lib/materialized-catalog.ts` (GCP), request time (Cloudflare) | Merge runs here. |
| Canonical store | `collector/preparation/` (PostgreSQL) | Large, separate, not on the live path. |

## 2. Findings

### Identity (the reported merge problem)

1. **Four independent identity rules, none sharing logic.**
   - `mergeEventSessions` (`web/lib/event-merge.ts`): exact instant + normalized
     title + normalized venue, plus ~30 hand-written venue aliases and ~45 title
     alias groups.
   - `productionKey` (`collector/pipeline.mjs:53`): exact title|venue|category hash.
   - `catalog-knowledge.ts:205`: venue entity = hash of exact
     name/city/district/address, so each provider spelling becomes a separate venue.
   - SQL `canonical_accept` (`migrations/005…sql:250`): exact
     title/venue/district/address text.
2. **No venue entity anywhere.** Every rule compares venue *name strings*. The
   snapshot has 319 distinct normalized venue strings across three providers.
   Spelling differences caused 146 of the 218 audited duplicate pairs.
3. **Venue evidence is discarded at extraction.** Bubilet JSON-LD has
   `geo.latitude/longitude` and a street address per venue (fixture
   `bubilet.json`); the collector keeps only the address. Biletix provides only
   `venueTown`; Biletinial gives `districtName` but no address for ~35% of
   sessions. Per provider in the snapshot: Bubilet 0% district, Biletix 0%
   address. Provider venue IDs are not captured; whether they exist in live
   payloads still needs checking.
4. **Identity is recomputed from strings on every build**, and on the Cloudflare
   path per request (`store.cloudflare.ts:217`), against the rule "never merge
   identities in a search request". No merge decision is stored, so a decision
   cannot be reviewed, reused or overridden.
5. **Record IDs include the venue name** (`hash(url|startsAt|venue)`), so a
   provider renaming a venue looks like one session deleted and another created.

### Evidence and reprocessing

6. **Raw provider responses are not retained in production**; only a content
   hash per page is kept (`--save-html` is local debugging only). A parser or
   normalizer fix needs a refetch, and past decisions cannot be re-derived.
   AGENTS.md calls for private object storage for raw responses.
7. **Extraction and normalization are fused.** Adapters emit the final flat
   record (truncated description, mapped category, one venue string), so the
   original fields are not kept separately from normalized ones.
8. **The collector imports web internals** (`web/lib/source.ts`,
   `event-format.ts`, `event-timing.ts`); category mapping lives in `web/`.

### Storage and publication

9. **Three storage backends**: D1/R2, Firestore/GCS, and PostgreSQL, each with its
   own import/checkpoint/publication code. The selected target, PostgreSQL, is
   not connected to scheduled collection.
10. **PostgreSQL preparation is large relative to what it does**: 4,651 lines of
    SQL (12 migrations, 9 functions redefined 2–3 times), 1,848 lines of
    JS/TS and 2,932 lines of verification scripts. Two publication paths coexist
    (per-record 004/005 and batch/page 006/007). Identity there is the strictest
    of all, so moving to it as-is would make duplicates worse.

### What is worth keeping

- Collector discovery, pacing, coverage accounting, partial-page rejection,
  timezone/price guards and provider-specific extraction knowledge.
- Embedding cache by document hash, Voyage profile handling.
- The operating principles in AGENTS.md: leases/fencing, idempotent jobs,
  pinned publications, atomic pointer switch.

## 3. Recommendation

Do not patch the merge rules again. Rebuild the stages between extraction and
search on PostgreSQL with a fresh schema, keep the collector's fetch/discovery
code, and retire D1 and Firestore once the new path is live. Start from a clean
migration 001, since current data does not need to be kept.

### Target flow

```
fetch (existing collector)
 → raw store: content-addressed raw response in object storage + fetch row
 → extract (pure, versioned): raw → provider listings with original fields
 → normalize (pure, versioned): title key, venue key, category, district, geo
 → resolve venues → resolve sessions → group shows
 → offers (per listing) → search documents + cached embeddings
 → validate → publish manifest → atomic pointer switch
web: reads a pinned publication only; no identity work at request time
```

Every derived stage can be re-run from stored raw data with no refetch.

### Provider listing contract (extract output)

Provider, provider event ID/URL, provider session IDs, raw title, raw category,
description, start instant + source timezone evidence, venue
`{name, providerVenueId?, address?, district?, geo?}`, ticket tiers/prices,
availability, observed time, extractor version, raw object reference. Listing
IDs are built from provider identifiers (URL/event code + session IDs, or
instant when none exists), not from venue names.

### Venue resolution

- Venue entities with aliases and evidence. Match a listing venue by, in order:
  provider venue ID → geo within a small radius plus a name-token overlap →
  compact name key + same district → otherwise a new venue.
- Two geo-close venues with unrelated names (separate halls, neighbouring
  stages) stay separate unless a reviewed alias or decision links them.
- Ambiguous matches go to the decision step below. Accepted decisions add
  aliases, so the same spelling resolves deterministically next time.

### Session resolution

- Candidates: listings from **different providers** at the same city and exact
  instant, at the same resolved venue (or ambiguous-venue pairs).
- Auto-merge: same venue entity, same title key (normalized title with generic
  category labels removed only inside their category: `Konser`: konser/konseri;
  `Tiyatro`: oyunu/tiyatro oyunu; `Stand-up`: stand up).
- Never merge: same provider; audience/format/adaptation conflict; venues
  resolved to different entities.
- Ambiguous: one Jev typed judgment per pair over the supplied evidence, merged
  only above a threshold calibrated on human-labelled pairs. Failures leave the
  pair unmerged and do not block publication.
- Every decision is stored with input hash, rule/model version and outcome; it
  is reused while inputs are unchanged and can be manually overridden.
  Today's alias lists become seed overrides.

### Schema (minimal)

`fetches`, `raw_objects`, `listings` (extracted, versioned), `venues`,
`venue_aliases`, `productions`, `sessions`, `session_listings`,
`identity_decisions`, `offers`, `search_documents`, `publications`,
`publication_sessions`, `jobs`/`job_attempts`. Typed columns for
decision-critical fields; raw provider detail stays in object storage and JSONB.

## 4. Phases

1. **Extraction contract and raw retention (first deliverable).** Collector
   writes raw responses to object storage and emits provider listings with full
   venue evidence (geo, address, district, provider venue ID if present) and
   name-independent IDs. Remove the collector's imports from `web/lib`.
   Acceptance: fixtures re-extract from stored raw data with identical output;
   every listing carries its raw object reference.
2. **Identity module, deterministic.** Pure TS module for venue and session
   resolution over listings, with a frozen labelled pair set (positives and the
   known counterexamples: Evde Tiyatro vs Cafe Theatre Koşuyolu, Bakırköy Butik
   vs BBS Yenibosna, Cem Adrian JJ Arena vs Yahya Kemal Beyatlı). Can run inside
   the current GCP `buildSearchCatalog` immediately, which fixes live duplicates
   before the database work. Acceptance: zero wrong merges on held-out pairs;
   suffix-only and spelling-only duplicate families merge without alias entries.
3. **Fresh PostgreSQL schema and jobs.** New migration set replacing 002–013;
   bounded, leased, idempotent jobs per stage; publication manifest and pointer
   switch; web reads pinned publications. Scheduled collection feeds it.
   Acceptance: re-running on unchanged input makes no external calls and
   produces identical publications; a changed listing recomputes only its
   dependents.
4. **Jev for ambiguous pairs.** Rubric, calibration on labelled pairs, decision
   storage and reuse, bounded call budget (needs approval).
5. **Cutover.** Staging on the new path, parity and duplicate audit against the
   old output, then retire the D1 and Firestore paths and their import endpoints.

## 5. Decisions needed

- Confirm rebuilding the preparation layer (PostgreSQL schema, migrations
  002–013 and their verify scripts) instead of extending it.
- Confirm retiring the Cloudflare D1/R2 fallback after cutover, or keep it.
- Approve a Jev call budget before phase 4.
