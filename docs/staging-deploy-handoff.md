# Handoff: ship identity v3 to GCP staging and verify

Status (2026-10-02): local review and checks complete; deployment pending.
Worktree `C:\Users\efeba\.t3\worktrees\event_recommender\t3code-ffc8b24d`,
branch `t3code/rebuild-data-pipeline` (base `4b2cdce`). Background:
[data-flow-audit-2026-10-02.md](data-flow-audit-2026-10-02.md),
[data-pipeline-rebuild-plan.md](data-pipeline-rebuild-plan.md).

## Execution checkpoint

The user confirmed exclusive worktree ownership. The current staging checkpoint
contains 14,702 listings; the pre-deploy identity audit found 26 unreviewed
legacy splits and zero same-provider sessions. The user explicitly waived
preserving the current data because collection will be rerun. Preserve the
audit as historical evidence; it did not pass. Validate newly verified records
from the single bounded collection run separately from carried records. The
existing collector does not guarantee a fresh-only replacement or exhaustive
provider coverage. Wrong merges still require investigation before acceptance.

Local review fixed retained-listing projection validation, removed internal
listing/search fields from public cards, and included shared contracts in the
source-ingestion image. Node build cleanup now retries transient Windows locks.
PostgreSQL serving/preparation, raw GCS mirroring and Jev enrichment remain off.

Current local evidence (Node 22.23.3): web 741/741; collector 268 passed plus one
ordinary-suite database skip; isolated PostgreSQL integration 2/2 with no
external calls; typecheck, lint, deployment configuration (73/73), GCP checks,
Node and Worker build/smoke passed. Frozen v3 audit passed: 4,076 listings,
3,328 legacy cards, 3,132 v3 cards, zero unreviewed splits or same-provider
sessions. Raw logs, receipts, original staging checkpoint and its failed audit
are retained under ignored `web/work/staging-identity-v3/`. The older
`pipeline-rebuild-local-verification.json` remains unchanged historical evidence.

The existing staging and collector environments permit `master` only. Use the
normal PR merge and exact merged-revision CI before dispatching; keep the
current `span-v2` interpreter. The one authorized collection run remains
bounded to 2,000 detail pages, 6,000 HTTP requests and 40 minutes. The task's
cumulative Voyage allowance is at most four calls, with existing cache reuse
and no retries; preserve and restore any existing indexing-window variables.
No Jev evaluation calls or new resources are authorized.

## Goal

Deploy the branch to GCP staging so the live catalog build uses the
deterministic identity module (rule `deterministic-identity.v3`), then prove on
the staging catalog that duplicate cards drop and nothing merges wrongly.
Everything else on the branch (PostgreSQL pipeline reader, preparation step,
raw-response cloud mirror, Jev) stays disabled. Close the task when the
acceptance checks below pass; do not start the cutover or other phases.

## Current state

- Uncommitted: the pipeline rebuild (phases 1–4, local) plus the identity v3
  fix. v3 changed `collector/normalize/identity.ts`,
  `collector/identity/resolve.ts`, `collector/tests/identity.test.mjs`, and
  added `web/scripts/audit-identity-snapshot.ts` and
  `web/tests/identity-snapshot-audit.test.ts`.
- Frozen-snapshot result (`web/data/events.json`, 4,076 listings): legacy merge
  3,328 cards; v3 3,132 cards; 0 legacy merges split; 0 sessions with two
  listings from one provider; all 116 new merge families reviewed as correct.
- Passing on the dirty tree: collector `npm test` (268 pass, 1 skipped:
  `pipeline-db.test.mjs`), web `npm test` (743), `npm run typecheck`,
  `npm run lint`, `npm run build:node`, `npm run test:smoke:node`.
- Not run: `BIPLAN_PIPELINE_DB_TEST=1` database test, `npm run build` +
  `npm run test:smoke`, deploy-config tests, Docker build.

## Steps

### 1. Confirm ownership

Another agent wrote most of this branch. Confirm with the user that nobody else
is editing the worktree before committing. Do not use bare `git stash`.

### 2. Run the skipped database test

From the repo root, with the labelled local container described in
`data-pipeline-rebuild-plan.md` ("Verification evidence"):

```sh
BIPLAN_PIPELINE_DB_TEST=1 node --experimental-strip-types --test collector/tests/pipeline-db.test.mjs
```

It uses only the isolated `biplan_pipeline_rebuild` database. If the container
is not available, report that and continue; do not point it at any other
database.

### 3. Review the parts nobody reviewed

Identity was reviewed; the rest of the diff was not. Run `/code-review` (or a
manual review) on `git diff 4b2cdce` with focus on:

- `.github/workflows/gcp-collector.yml` (raw artifacts, opt-in
  `GCP_STAGING_PIPELINE_ENABLED` step): must stay off by default and must not
  upload to GCS (`BIPLAN_RAW_GCS_ENABLED` unset).
- `web/Dockerfile`, `web/Dockerfile.dockerignore`, `web/scripts/build-node.mjs`:
  the image now needs `collector/identity`, `collector/normalize` and
  `contracts/`; no secrets, state or raw data may enter the image.
- `web/lib/recommend.ts`, `web/lib/store.node.ts`, `web/lib/catalog.ts`,
  `web/lib/materialized-catalog.ts`: default serving must remain the snapshot
  path unless `CATALOG_BACKEND=pipeline` is set.

Fix real defects; record unrelated findings separately instead of expanding scope.

### 4. Full local checks

From `web/`: `npm test`, `npm run typecheck`, `npm run lint`,
`npm run test:deploy-config`, `npm run test:deploy:gcp`, `npm run build:node`,
`npm run test:smoke:node`, then `npm run build` and `npm run test:smoke`.
From `collector/`: `npm test`, `npm run identity:audit`.
`node --experimental-strip-types web/scripts/audit-identity-snapshot.ts` must
exit 0. Do not run competing builds on the same output directory.

### 5. Commit, push, PR, CI

Commit in logical units (pipeline rebuild; identity v3 fix + gate; docs). Push
the branch, open a PR to `master`, link it to the thread, and wait for every
required check on the exact head SHA. Fix failures and re-check the new SHA; an
earlier green revision does not count.

### 6. Deploy to staging

Run the `Deploy GCP staging` workflow (`gcp-staging.yml`) via
`workflow_dispatch` with `expected_sha` = the exact green head SHA (40 chars)
and the interpreter currently used on staging (check the last successful run;
do not change it). Do not set `CATALOG_BACKEND=pipeline`,
`GCP_STAGING_PIPELINE_ENABLED` or `BIPLAN_RAW_GCS_ENABLED`. Record the image
digest and revision. Follow `docs/gcp-deployment.md` for rollback.

### 7. Rebuild the staging catalog

The catalog's search index is rebuilt with the new identity only when a
collection checkpoint is published. Trigger `Collect GCP staging event data`
(`gcp-collector.yml`) once via `workflow_dispatch`, or wait for the 6-hourly
run. This makes a small number of paid Voyage embedding calls for new or
changed card text (cached vectors are reused); no Jev calls. No other paid
calls are authorized by this handoff.

### 8. Verify on staging

- Download the published checkpoint events (the collector run's artifact or
  `GET /api/admin/collection` with the existing protected token; never print
  secrets) and run
  `node --experimental-strip-types web/scripts/audit-identity-snapshot.ts <events.json>`.
- Compare `/api/events` card count before and after deployment for the same
  checkpoint window.
- Every-card review of merged cards for a sample of at least 30 multi-offer
  cards across all three providers: same title, start time and venue on every
  source page. Include the counterexamples: Evde Tiyatro vs Cafe Theatre
  Koşuyolu, Bakırköy Butik Sahne vs BBS Sahne Yenibosna, and Cem Adrian at JJ
  Arena vs Yahya Kemal Beyatlı must stay separate.
- `/api/ready` returns 200; the UI shows merged cards with all provider offers.

## Acceptance

- Snapshot audit on the staging checkpoint: 0 unreviewed legacy splits, 0
  same-provider sessions, fewer cards than the legacy merge.
- No wrong merge in the reviewed sample; counterexamples separate.
- CI green on the deployed SHA; staging serving healthy.
- Report: deployed SHA/image, checks run per revision, card counts, sample
  results, Voyage calls made, and anything left unverified.

## Stop and ask the user if

- a legacy merge is split or any wrong merge appears on staging;
- CI or deploy needs settings, secrets, IAM or resources beyond the existing
  workflow;
- the change would enable the PostgreSQL pipeline, GCS raw mirror, Jev calls or
  any new paid resource.

## Out of scope

Pipeline cutover, raw GCS mirror, managed PostgreSQL runs, Jev calibration,
removing legacy paths, the 48-hour unattended gate and public launch.
