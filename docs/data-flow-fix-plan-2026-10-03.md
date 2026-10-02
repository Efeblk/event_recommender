# Data flow fix plan (2026-10-03)

Status: proposed. Findings: [data-flow-audit-2026-10-03.md](data-flow-audit-2026-10-03.md).
Base: `master` `e566b26` (PR #33 memory fix and PR #34 identity v4 merged,
neither deployed). Staging is paused: any deploy, staging write, recovery run
or paid call needs explicit user authorization at the step that needs it.

## Deadline

The active staging catalog becomes stale at **2026-10-05 10:03 UTC**. Phase 1
must be merged, deployed and verified before then, or staging serves nothing.

## Phase 1: activate without waiting for embeddings (first deliverable)

Goal: a newly published catalog goes live after its mandatory checks, even when
some documents lack vectors; those documents use lexical retrieval.

Changes (`web/`):

- `lib/store.gcp.ts` `activateSearchCatalog`: activate when the pending catalog
  is valid and its profile matches; report `{ activated, missingVectors,
  documents }` instead of refusing on any missing vector. Keep the lease,
  revision and profile guards.
- Checkpoint publication (`/api/admin/collection`): publish the new search
  catalog directly as `search` after its integrity checks; vectors catch up
  later. Keep `pendingSearch` only if needed for in-flight indexing.
- Readiness and `currentPublished`: expose vector coverage (documents with and
  without vectors) as diagnostics; coverage below 100% is not "not ready".
- Retrieval needs no change: `recommend.ts` already uses dense ranking only for
  candidates with vectors and lexical ranking for the rest. Add a test that a
  candidate without a vector can still be returned.

Acceptance:

- Unit tests: activation with 0%, partial and full vector coverage; stale
  lease/revision still rejected; profile mismatch still rejected.
- `npm test`, `npm run typecheck`, `npm run lint`, `npm run test:deploy-config`,
  `npm run test:deploy:gcp`, `npm run build:node`, `npm run test:smoke:node`.
- Offline replay against the saved staging objects: the 2026-10-02 pending
  catalog would activate with 430 documents lexical-only.

Ship (needs authorization): PR → exact-SHA CI → `Deploy GCP staging` with the
merged SHA (includes PR #33 and PR #34) → one collector run with indexing
disabled → verify `/api/ready`, card counts, identity gate on the live
checkpoint, every-card review of a sample, and vector-coverage diagnostics.

## Phase 2: settle the stuck paid response

Goal: the 1,892 tokens from run 37061051538 are accounted once and its six
vectors saved, without a new provider call.

- Independent review of `recover-attempt.mjs` (hardened 2026-10-03; 9 offline
  tests). It is in the local archive
  `C:\Users\efeba\event_recommender-archive\2026-10-03\t3code-ffc8b24d\web\work\staging-identity-v3\index-recovery\`;
  copy it back into a checkout's `web/work/staging-identity-v3/index-recovery/`
  to run, since it imports `web/lib` by relative path.
- Needs authorization: dry run against staging, then `--apply`.
- Acceptance: run `accountedAttempt=1`, window `inFlight=""`, six vectors read
  back, immutable recovery receipt stored, no catalog activation by the script.

## Phase 3: token-based embedding budget and safe accounting

Goal: spend is authorized and measured in tokens; a crash cannot leave paid
work unaccounted.

- `lib/audited-index.ts`: replace `inputBytesPerCall: 8000` /
  `inputBytesPerRun: 32000` and the call-count window with a token budget per
  window (provider batch limits as the only per-call cap). Workflow variables
  carry the token budget.
- Commit vector save and token accounting in one guarded step; if a stored
  provider receipt exists without accounting, the next run settles it from the
  receipt (same checks as the recovery script) before any new call. Retire the
  manual script afterwards.
- Tests: budget exhaustion, crash after provider response, crash after vector
  save, replay without double accounting.
- Embedding the ~430 pending documents (~0.14 M tokens observed) needs an
  approved token budget.

## Phase 4: move preparation out of the HTTP service

Goal: checkpoint rebuild, identity resolution and indexing never run on
serving instances.

- Run checkpoint publication and indexing as a bounded Cloud Run Job (reuse the
  preparation job image/manifest pattern in `web/deploy/`), invoked by
  `gcp-collector.yml` instead of the admin HTTP endpoints. Keep the admin
  endpoints for reads only, or remove them.
- Size the job separately; serving keeps 1 GiB.
- Needs authorization: new Job resource and IAM in staging.

## Phase 5: smaller catalog representation

Goal: memory and object size stop growing with time-version duplication.

- Store each event once per catalog with validity intervals instead of
  repeated versions (8,398 groups / 19,106 versions / 10,769 copies today).
- Avoid parsing whole catalogs per instance: per-shard objects or the
  PostgreSQL reader.
- Acceptance: measured heap for the 14,881-listing catalog well under half of
  today's ~226 MB load cost; identical search results on a frozen query set.

## Phase 6: one catalog system

Decide the PostgreSQL cutover (pipeline from PR #31, currently disabled) so
Phases 3–5 are not built twice. Needs a managed staging allowance and the
launch-checklist gates (side-by-side review, 48 h unattended run).

## Out of scope

Same-provider double listings (3 cards; separate decision), ranking and
interpretation changes, public launch.

## Decisions needed

1. Authorize Phase 1 deploy and one verification collector run before
   2026-10-05 10:03 UTC.
2. Authorize the Phase 2 recovery (dry run, then apply).
3. Token budget for the pending documents (Phase 3).
4. Whether to do Phase 4/5 on the current GCP path or go straight to the
   PostgreSQL cutover (Phase 6).
