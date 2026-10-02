# Data pipeline rebuild plan

Status (2026-10-02): local rebuild implemented and verified; managed activation,
live Jev calibration and cutover remain pending. Findings and evidence:
[data-flow-audit-2026-10-02.md](data-flow-audit-2026-10-02.md).

| Phase | Implemented locally | Remaining gate |
|---|---|---|
| 1 | Immutable filesystem raw store, every-fetch ledger, pure extraction, strict shared listing contract and compatible EventRecord adapter | Confirm private CI raw destination/IAM/retention; live provider venue-ID evidence |
| 2 | Deterministic venue/session resolution and guarded seeds; GCP materialization uses it; frozen held-out audit | Deploy and compare current source-verified cards |
| 3 | Fresh PostgreSQL schema, leased/fenced incremental stage jobs, raw replay CLI, manifests, guarded publication/rollback and opt-in pinned HTTP reader | Managed connectivity, reviewed roles/storage and new bounded staging allowance; scheduled preparation is disabled by default |
| 4 | Typed bounded Jev client, safe cluster application, durable evidence/model/calibration cache and offline failure/replay fixtures | Approved cumulative live-call budget and human-reviewed held-out calibration; CLI remains deterministic |
| 5 | Serving switch and legacy-deployment guard prepared | Side-by-side staging verification, explicit activation, then legacy removal; 48 hours unattended collection before public-readiness claim |

The existing serving and preparation paths remain available. No provider, cloud
or paid inference calls were made for this rebuild. Three injected judgments in
the database test are offline fixtures, not live calibration. This does not
claim a managed migration or public-launch readiness.

## Goal

One data pipeline from provider fetch to published search catalog, where:

- raw provider responses are kept, so every later stage can be re-run without
  refetching;
- venue and session identity are decided once, in preparation, with stored and
  reviewable decisions;
- the same session listed by several providers becomes one card with all
  offers, and different sessions are never merged;
- the web app only reads a pinned, published catalog.

Existing databases, snapshots and IDs do not need to be preserved.

## Non-goals

- Changing discovery, pacing, coverage accounting or provider-specific parsing
  rules beyond what the new output contract needs.
- Recommendation, interpretation or ranking changes.
- Merging across different start times, or work/adaptation relationships.
- New paid cloud resources without separate approval.

## Target layout

```
contracts/                 shared, versioned types + JSON schemas (no runtime deps)
  listing.ts               ProviderListing v1
  publication.ts           published session/offer/search record v1
collector/
  run.mjs, discovery.mjs, coverage.mjs …   kept: fetch, pacing, coverage
  raw/                     raw response store (filesystem locally, GCS in cloud)
  extract/                 pure extractors: raw → ProviderListing[] (one per provider)
  normalize/               pure: title key, venue key, category, district, geo
  identity/                venue resolution, session resolution, decisions
  db/migrations/001-*.sql  fresh PostgreSQL schema
  jobs/                    bounded, leased stage jobs + publish
web/
  lib/catalog-reader.ts    reads a pinned publication; no identity logic
```

`web/lib/event-merge.ts`, `collector/pipeline.mjs` `productionKey`,
`web/lib/catalog-knowledge.ts` and `collector/preparation/` are removed once
their replacements are live.

## Contracts

### ProviderListing v1 (extract output)

| Field | Notes |
|---|---|
| `listingId` | Hash of provider + provider event ID/URL + provider session IDs; instant only when the provider has no session ID. Never includes venue name. |
| `provider`, `providerEventId`, `providerSessionIds[]`, `url` | As given by the source. |
| `title`, `description`, `category` | Raw source values, untruncated. |
| `startsAt`, `timezoneEvidence` | Instant plus how the timezone was established. |
| `venue` | `{ name, providerVenueId?, address?, district?, geo?: {lat, lon} }`, raw values. |
| `tiers[]` | Price, currency, availability per ticket tier; no aggregation. |
| `availability`, `attendanceTiming?` | Session level. |
| `observedAt`, `extractorVersion`, `rawObjectRef` | Provenance. |

### Raw object

Content-addressed (`sha256`) response body plus fetch metadata (URL, method,
status, headers subset, fetchedAt, collector revision). Stored once and
referenced by every listing extracted from it.

## Stages

1. **Fetch** (existing collector) → raw object + `fetches` row.
2. **Extract** → `listings` rows (versioned; re-runnable from raw).
3. **Normalize** → per-listing keys: `titleKey` (category-scoped generic label
   removal: `Konser` konser/konseri, `Tiyatro` oyunu/tiyatro oyunu, `Stand-up`
   stand up), `venueCompactKey` (no spaces/punctuation), normalized category,
   district from field or address, geo.
4. **Resolve venues** → `venues`, `venue_aliases`. Order: provider venue ID →
   geo within radius **and** name-token overlap → compact key + same district →
   new venue. Geo-close venues with unrelated names stay separate.
5. **Resolve sessions** → `sessions`, `session_listings`, `identity_decisions`.
   - Candidates: different providers, same city, exact instant, same or
     ambiguous venue.
   - Auto-merge: same venue entity + same `titleKey` + no policy conflict.
   - Never merge: same provider; child/adult, workshop/performance or
     adaptation conflict; different resolved venues.
   - Ambiguous: left unmerged in phase 2; Jev judgment in phase 4.
   - Decisions store input hash, rule/model version, outcome, evidence; reused
     while inputs are unchanged; manual overrides win. Current
     `VENUE_ALIASES`/`TITLE_ALIASES` become seed overrides.
6. **Group shows** → production/show identity across sessions (replaces
   `canonicalShowKey` / `displayShowIdentity`).
7. **Offers** → one offer per listing with its tiers; card price chosen from
   available offers (current `selectOffer` rules).
8. **Search records** → document text/hash, cached Voyage embeddings by
   document hash, lexical tokens.
9. **Validate and publish** → manifest, counts, mandatory checks, atomic pointer
   switch with previous-version guard; retain rollback versions.

Every stage runs as a bounded, idempotent job keyed by subject + input hash +
stage version, with leases, fencing, recorded attempts and cost. External calls
(Voyage, Jev) run outside transactions. Optional failures (embedding, Jev)
leave lexical coverage and unmerged listings; integrity failures block
publication.

## Schema (migration 001)

`raw_objects`, `fetches`, `listings`, `venues`, `venue_aliases`, `productions`,
`sessions`, `session_listings`, `identity_decisions`, `offers`,
`search_documents`, `publications`, `publication_sessions`, `active_publication`,
`jobs`, `job_attempts`. PostGIS `geography` on venues; pgvector on
`search_documents`; trigram index on venue names and aliases. Typed columns for
decision-critical fields; provider extras in JSONB.

## Phases

Each phase ends with a usable result and its own checks.

### Phase 1: raw retention and listing contract (first deliverable)

- Add `contracts/listing.ts` + JSON schema.
- Collector stores raw responses (`collector/raw/`), filesystem locally and
  existing staging bucket under a new prefix in CI (confirm bucket use).
- Move extraction into `collector/extract/` as pure functions over raw objects;
  capture Bubilet geo/address, Biletix `venueTown`, Biletinial `districtName`,
  and provider venue IDs if live payloads have them (check first).
- Remove collector imports of `web/lib/*` by moving category/timing helpers into
  `contracts/` or `collector/normalize/`.
- Keep the current `EventRecord` output via an adapter so the live GCP path keeps
  working.

Acceptance: every listing references a stored raw object; re-extracting
fixtures from raw gives identical output; listing IDs stay stable when a venue
name changes; existing collector tests pass.

### Phase 2: deterministic identity module

- `collector/identity/` venue + session resolution over listings, pure TS.
- Labelled pair set from frozen snapshots: positives (suffix-only,
  spelling-only, both) and counterexamples (Evde Tiyatro vs Cafe Theatre
  Koşuyolu; Bakırköy Butik vs BBS Yenibosna; Cem Adrian at JJ Arena vs Yahya
  Kemal Beyatlı; same-provider two-venue listings). Held-out split.
- Audit script reporting candidates, auto-merges, never-merges, unresolved.
- Wire into current GCP `buildSearchCatalog` in place of
  `eventSessionIdentityKey`/`mergeEventSessions` grouping (live duplicate fix
  before the database work).

Acceptance: zero wrong merges on held-out pairs; suffix-only and spelling-only
families merge with no alias entries; no card has two offers from one
provider; web and collector test suites pass.

### Phase 3: PostgreSQL pipeline

- Migration 001 and stage jobs (extract → … → publish) in `collector/jobs/`.
- Scheduled collection (`gcp-collector.yml`) writes raw objects and runs the
  jobs against staging PostgreSQL.
- `web/lib/catalog-reader.ts` reads the pinned publication; HTTP SQL budget
  separate from preparation budget.

Acceptance: unchanged input re-run makes no external calls and produces an
identical publication; one changed listing recomputes only its dependents;
interrupted/stale jobs cannot complete; rollback restores the previous
publication.

### Phase 4: Jev for ambiguous pairs

- Rubric and typed output for "same session at the same place"; threshold
  calibrated on the labelled set; decisions stored and reused.
- Bounded per-run call budget, approved before the first live call.

Acceptance: zero wrong merges on held-out pairs; recall reported separately for
deterministic and Jev paths; Jev failure leaves pairs unmerged and publication
proceeds; re-run on unchanged input makes no Jev calls.

### Phase 5: cutover and removal

- Run old and new paths side by side on staging; compare card counts,
  duplicate audit, every-card source review on a sample.
- Switch staging serving to the new path, then remove D1/R2 and Firestore
  import/checkpoint code, `collector/preparation/`, `event-merge.ts`,
  `catalog-knowledge.ts` and their tests/workflows.

Acceptance: staging serves only the new publication; 48 h unattended
collection on the new path before any public-readiness claim.

## Verification per phase

- `collector/`: `npm test`. `web/`: `npm test`, `npm run typecheck`,
  `npm run lint`; `npm run build` + `npm run test:smoke` when serving changes;
  `npm run test:deploy-config` / `test:deploy:gcp`, `build:node`,
  `test:smoke:node` for workflow or GCP changes.
- PostgreSQL phases: migration tests on an empty database, job
  interruption/idempotency/stale-completion tests, publication pin/rollback test.
- No paid calls in phases 1–3 except reusing cached embeddings; phase 4 needs a
  budget.

## Risks

| Risk | Mitigation |
|---|---|
| Providers expose no venue IDs and Biletix/Biletinial lack geo | Compact key + district + seed aliases; ambiguous pairs stay unmerged until Jev. |
| Geo radius merges neighbouring halls | Require name-token overlap as well as distance; counterexample tests. |
| Rebuild stalls the live staging catalog | Phases 1–2 keep the current GCP path working; old path removed only in phase 5. |
| Raw storage growth | Content addressing deduplicates; explicit retention per prefix; size reported per run. |
| Scope creep into enrichment/scoring | Out of scope; this plan stops at publication. |

## Open decisions

1. Retire the Cloudflare D1/R2 fallback in phase 5, or keep it.
2. Approve the raw mirror destination and prefix-scoped IAM (see below).
3. Jev live-call budget, before any phase 4 calibration call.

## Local execution and managed activation

Use Node 22 from `web/.nvmrc`. `collector/run.mjs` retains the original response
bytes before parsing, including supplemental, failed, empty and incomplete
responses. Its output includes `raw-fetches.json`, `provider-listings.json` and
`pipeline-raw-collection.json`; raw bodies and fetch receipts are under
`collector/state/raw/` by default. Raw admission defaults to 512 MiB including
existing files (`--raw-directory` / `--raw-max-bytes` override it). Admission
failure stops acceptance; there is no automatic deletion or indefinite-retention
claim. References must be reviewed before any cleanup.

The current-run handoff always declares **partial** scope. It preserves original
observation clocks and explicitly includes failed, quarantined and unvisited
URLs. A successful zero-record extraction stays a verified page, without an
invented cancellation. If that URL already has listing heads, zero records
withhold those offers and require reconciliation before publication. Historical coverage is never upgraded to complete by
replay. Publication blocks on unresolved page failures. A full collection needs
a sealed declared inventory/horizon and matching fresh receipts.

Configure an isolated PostgreSQL database with PostGIS, pgvector and pg_trgm.
Supply `BIPLAN_PG_HOST`, `BIPLAN_PG_PORT`, `BIPLAN_PG_DATABASE`, `BIPLAN_PG_USER`
and `BIPLAN_PG_PASSWORD` in protected local settings/environment. Remote TCP
requires `BIPLAN_PG_TLS=require` (and trusted `BIPLAN_PG_CA` where needed);
Cloud SQL Unix sockets are supported. No default machine database is selected.
From `collector/`:

```sh
npm run pipeline -- --initialize --raw-collection output/pipeline-raw-collection.json --raw-directory state/raw --max-jobs 20000 --time-ms 300000
npm run pipeline -- --raw-collection output/pipeline-raw-collection.json --raw-directory state/raw --publish --expected-previous none
```

Use `none` only for the first publication. Subsequent publishes require the exact
active publication ID, and rollback uses
`npm run pipeline -- --rollback PUBLICATION_ID --expected-previous ACTIVE_ID`.
The initializer validates its installed migration hash and does not replay the
old preparation migrations. The fresh namespace is `biplan_pipeline`; existing
canonical data is untouched. Publication receives a separate finite SQL/process
window after preparation, with a fenced pointer change and reserved close time.

For HTTP, `CATALOG_BACKEND=pipeline` opts the Node runtime into this reader with
the same protected connection settings; default serving remains snapshots.
Each request pins one immutable publication, verifies its content, checks all
canonical member heads before ranking, and revalidates the exact selected offer
before rendering. Current readiness is never cached by publication alone.
Collector prices are aggregate starting prices with unknown checkout fees:
they are informational and cannot satisfy a hard budget. Prepared search text,
lexical tokens and location evidence are shared contracts. Missing cached
vectors retain lexical coverage; the CLI makes no embedding calls.

Optional Jev use is an injected preparation resolver, not an enabled CLI option:
`resolveIdentityWithJev(listings, judge)` with
`createPostgresIdentityJudgmentCache(pool)`. Supply a distinct `identityVersion`
covering the deterministic rule, rubric, pinned model and calibration so stage
reuse cannot mask a changed judgment profile. Zero calls is the default. Only
calibrated positive pairs can join provider-disjoint clusters, and every
cross-pair must pass. A failure or unknown judgment leaves ambiguity split.

The collector workflow preserves raw artifacts for **14 days** and contains an
opt-in preparation step (`GCP_STAGING_PIPELINE_ENABLED`), with no publication or
serving switch. Do not activate it before durable raw storage and staging
connectivity/roles are reviewed. The proposed mirror destination is the existing
private bucket `biplan-staging-efeblk-biplan-staging-data`, prefix
`staging/pipeline/raw/v1/`. The adapter permits only that exact destination and
uses create-only objects plus exact generation/byte verification. Cloud upload
remains disabled (`BIPLAN_RAW_GCS_ENABLED` is unset). The user's "idk" reply did
not confirm use; no IAM changes were made. Grant only prefix-scoped object
creation and exact-object reads if approved; the adapter needs no delete or list
permission. Review retention against publication/rollback references first.

The prior [managed staging allowance](gcp-postgres-staging-validation-2026-09-30.md)
is exhausted at 24/24 Jobs. This rebuild has used zero managed Jobs and zero live
Jev calls. A fresh bounded allowance is required before managed validation.
Local tests cannot replace side-by-side every-card source review, cloud recovery,
capacity evidence or the unattended collection gate.

## Verification evidence

The database suite uses only the container labelled `biplan.preparation=catalog-enrichment-v1`
and the isolated database `biplan_pipeline_rebuild`, whose ownership comment it
checks before resetting **that database's new schema**. It verifies raw fixture
replay, immutable ingestion, unchanged external-call reuse, exactly one affected
normalize/offer/identity/search job after a listing change, real interrupted
resume, stale-lease rejection, publication pinning, pointer conflicts, rollback,
source withholding and finite publication admission. Run with
`BIPLAN_PIPELINE_DB_TEST=1 node --experimental-strip-types --test collector/tests/pipeline-db.test.mjs`.
Without that flag, the ordinary collector suite skips the destructive isolated
database test.

The frozen held-out identity set has five labelled pairs: three expected merges
and two venue counterexamples, with exact family/source-record assertions.
`npm run identity:audit` reports zero wrong merges, zero missed merges and
deterministic recall 1 on this small fixture. It is not a live catalog recall or
Jev calibration measurement. Typed timing conflicts, transitive negatives,
duplicate providers and corrupted judgment caches have separate regressions.

The five-pair fixture missed a venue regression: identity v2 split 160 of the
legacy merge's 674 multi-provider cards (3,419 cards vs 3,328) because identical
venue names joined only with a precise district on both sides. Identity v3
(`deterministic-identity.v3`) treats missing or side-only districts as
compatible, maps unambiguous neighbourhoods to districts, takes district
evidence from field, address ending and venue name together (a conflict needs
disjoint evidence), and links descriptor/spelling variants only through unique
one-word extensions. On the frozen snapshot it produces 3,132 cards with no
legacy merge split, no same-provider session, and every new merge family
reviewed as the same session. `web/scripts/audit-identity-snapshot.ts` is the
full-catalog gate (`web/tests/identity-snapshot-audit.test.ts`); it fails on any
unreviewed legacy split or same-provider session. Remaining misses (for example
Turkcell Sahnesi vs Zorlu PSM - Turkcell Sahnesi, Kozzy vs KKM) need seeds or the
Jev path. The JSON evidence summary below predates identity v3.

Raw local receipts are retained in `../web/work/pipeline-rebuild-verification/`.
The final sanitized evidence summary is
[pipeline-rebuild-local-verification.json](pipeline-rebuild-local-verification.json).
No PR/CI revision or deployed image is implied by a dirty local working tree.
