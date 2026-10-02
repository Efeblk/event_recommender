# Data flow audit (2026-10-03)

Scope: the live GCP staging flow at `master` `d900772` plus PR #34
(identity v4), after collector run 37061051538 crashed in indexing. Evidence:
code, the exact saved staging objects under
`t3code-ffc8b24d/web/work/staging-identity-v3/` (ignored), and offline
measurements. No network, cloud or provider calls. Earlier audit:
[data-flow-audit-2026-10-02.md](data-flow-audit-2026-10-02.md).

## Current flow

```
GitHub Actions gcp-collector.yml (every 6 h when enabled; staging paused)
  restore checkpoint (33 MB JSON) → collect (≤2000 details, 40 min)
  → POST /api/admin/import (Firestore pages)  → POST /api/admin/collection
      HTTP service: rebuild checkpoint + buildSearchCatalog (identity) → pendingSearch (56 MB)
  → POST /api/admin/embeddings?audited=1 (same HTTP service, bounded window)
      → Voyage → vectors → activateSearchCatalog only if zero vectors missing
Cloud Run serving: 1 GiB, 1 CPU, concurrency 32; reads active search (60 MB)
PostgreSQL pipeline (PR #31): built, disabled, not on the live path
```

## Findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| 1 | Critical | **New data cannot go live without full paid embedding coverage.** `activateSearchCatalog` returns `activated:false` if any document lacks a vector. Cancellations, time/price changes and identity fixes wait behind optional enrichment; contradicts AGENTS.md ("missing vectors retain lexical coverage", critical changes must not wait). | `web/lib/store.gcp.ts` `activateSearchCatalog` (`if (missing) return …`) |
| 2 | Critical | **Hard staleness deadline.** Active catalog last checked 2026-10-02 10:03 UTC; it becomes stale at **2026-10-05 10:03 UTC** (72 h). After that readiness fails and searches return nothing unless finding 1 is fixed or ~430 documents are embedded. | `active-search.json` `sourceStatus`, `statusFor` 72 h cutoff |
| 3 | High | **Preparation runs inside the public HTTP service.** Checkpoint rebuild, identity resolution over all listings, and paid indexing run in request handlers on serving instances. The heap crash took serving down (503). AGENTS.md requires separate job execution. | `/api/admin/collection`, `/api/admin/embeddings`; `store.gcp.ts` checkpoint save → `buildSearchCatalog` |
| 4 | High | **Whole-catalog JSON in memory does not fit the sizing.** Pending search 56 MB costs ~226 MB heap to load (108 MB string + 118 MB parsed); checkpoint 33 MB costs ~119 MB. Instances cache up to two catalogs plus vectors, at concurrency 32 in 1 GiB. Catalog grew 4,076 → 14,881 listings in one run. PR #33 lowers indexing peak (~518 MB replay) but the model grows linearly with the catalog. | offline `JSON.parse` measurement; `gcp-staging.yml` `--memory 1Gi --concurrency 32` |
| 5 | High | **Embedding budget is counted in calls, capped at 8,000 input bytes per call** (~5–6 documents). 430 pending documents "need 114 calls" only because of this cap; Voyage bills by token (~0.14 M tokens here at ~315 tokens/document). Authorizations should be in tokens/cost; batches can be far larger. | `web/lib/audited-index.ts` `auditIndexLimits` (`inputBytesPerCall: 8000`, `inputBytesPerRun: 32000`); `batch-plan.json` |
| 6 | Medium | **Search catalog repeats events across time versions:** 8,398 groups, 19,106 versions, 10,769 event copies for 3,813 distinct documents. Inflates size, memory and activation checks. | `pending-search.json` |
| 7 | Medium | **Two catalog systems.** The selected PostgreSQL pipeline exists but is disabled; staging runs on Firestore pointers plus JSON blobs. Fixes (identity, activation, memory) must be made twice until cutover. | `gcp-collector.yml` opt-in step; `CATALOG_BACKEND` default |
| 8 | Medium | **A crashed indexing request leaves a paid response unaccounted.** Run 37061051538 has `inFlight` set and 1,892 tokens unrecorded; recovery needs a manual operator script. Accounting should be committed with the vector save, or recovered automatically by the next run from the stored receipt. | `run.json`, `window.json`, `recover-attempt.mjs` |
| 9 | Low | **Same-provider double listings** (one session listed twice by one provider) show as duplicate cards by design; 3 in the fresh catalog. Needs a reviewed rule if they should collapse. | identity v4 gate on fresh catalog |

Resolved since the previous audit: identity v3/v4 venue and title splits
(fresh catalog 86 → 4 unreviewed splits, PR #34); indexing heap fix (PR #33,
merged, undeployed).

## Recommended order

1. **Before 2026-10-05 10:03 UTC:** activate a new catalog without waiting for
   embeddings: missing vectors fall back to lexical retrieval for those
   documents (as AGENTS.md requires). Code change in `activateSearchCatalog` plus
   readiness/diagnostics showing vector coverage. No paid calls needed.
2. Move checkpoint publication and indexing out of the HTTP service into a
   bounded Cloud Run Job (the PostgreSQL preparation job image already exists),
   or at minimum a separate admin service with its own memory.
3. Replace the per-call byte cap with a token budget per window and normal
   batch sizes; authorize spend in tokens.
4. Commit vector save and token accounting together, and let the next run
   settle a stored-but-unaccounted receipt automatically; then retire the
   manual recovery script.
5. Store one copy of each event per catalog with validity intervals instead of
   repeated time versions; stream or shard rather than parse whole catalogs.
6. Decide the cutover to the PostgreSQL pipeline so these fixes land once.

Items 1, 3 and 4 are local code changes; 2, 5 and 6 are larger and need
planning. Deploying anything to staging still needs explicit authorization.
