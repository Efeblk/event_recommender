# Release readiness — 26 September 2026

**Not yet ready for public production.** Local Windows verification and release
automation are prepared. Staging publication, real Cloudflare capacity, recovery
exercises, and at least 48 hours of unattended operation still need evidence.
This record supplements the historical September 24 audit; it does not rewrite
earlier failures or turn local results into cloud measurements.

## Candidate and local evidence

The readiness changes follow `be1a450` (conversational fixes and preserved live
results) and `561a682` (Windows setup and cross-platform CI), based on
`ea8da5a9a16bfe81bd753b60aa8acba5b2229eab`. Tests below ran on the working tree
containing this document. The resulting commit and GitHub checks must be recorded
by the release workflow before any candidate is deployed.

| Check | Observed result |
| --- | --- |
| Web unit tests on Node 22.23.3 | 239 passed |
| Collector tests on Node 22.23.3 | 35 passed |
| Deployment, artifact, promotion, rollback, and drill tests | 27 passed |
| Typecheck and lint | Passed |
| Normal and standalone Cloudflare builds | Passed on Windows |
| Compiled D1/R2 and Voyage workerd smoke checks | Passed for both build paths |
| Isolated desktop/mobile browser suite | 13 passed; one intentionally skipped; providers mocked |
| Frozen conversational fixture and historical saved-score replay | 20/20 and 12/12 offline |
| Standalone deployment dry-run | Passed; compressed upload 1,218.60 KiB |

The [hard-test record](../web/evals/reports/2026-09-26-windows-hard-final.md)
preserves 36 local application requests, review of all 34 returned card instances,
two direct traces, the original failures, and the remaining conservative empty
answer for an ambiguous quiet-evening request. Those runs used the earlier
catalog and dirty runtime hashes recorded there. They are not fresh staging
quality measurements for this later catalog.

The intended AI experience requires both TypeSafe Jev and Voyage credentials.
Their absence enables limited fallback behavior; successful fallback tests do
not establish AI product quality. Stale or empty catalogs now return an explicit
503 before consuming provider calls or recommendation quota.

## Fresh collection and preserved failures

GitHub collection run
[36263215393](https://github.com/Efeblk/event_recommender/actions/runs/36263215393)
ran at revision `ea8da5a9a16bfe81bd753b60aa8acba5b2229eab` from
18:37:55 to 19:04:22 UTC. It collected 3,861 events, including 3,790 available
events, and refreshed 1,269 pages across the three providers (518 Biletinial,
623 Bubilet, 128 Biletix). It retained 233 failed pages, one carried-forward
record, and no quarantined records. Discovery recorded six complete, one
incomplete, and six limited outcomes. A successful workflow is not a claim that
every provider page succeeded.

This was an artifact-only run: publication, checkpoint, and indexing steps did
not run against staging. Its original report, events, and soak evidence remain
in the workflow artifact and an ignored local copy.

The first local import rejected six sessions that had expired during the delay
between collection and publication. The publisher now omits only valid, already
expired sessions, records their count and bounded ID list, preserves the source
report, and still rejects malformed or wholly expired input. The successful
local import published 3,854 incoming events and checkpointed a canonical
4,076-record snapshot at `2026-09-26T19:26:46.651Z`. Retaining unrefreshed source
records explains why the canonical snapshot is larger than the incoming report.
The checked-in seed was refreshed from that canonical readback.

## Cloud and automation state

- Cloudflare browser/Wrangler OAuth works on this Windows PC. The dedicated
  staging D1 database and private R2 bucket exist, and R2 is active. No billing
  subscription was changed; the candidate uses the `free` Worker profile.
- The `biplan-staging` Worker is not deployed. Its intended origin is
  `https://biplan-staging.efeblk.workers.dev`. Production resources are not
  configured, and unrelated account resources were left alone.
- Runtime GitHub environments `staging` and `production` remain unattended.
  Separate `staging-deploy` and `production-deploy` environments require the
  repository owner's review for deploy/rollback. Staging configuration and the
  sync/provider secrets were installed securely. The long-lived Cloudflare
  automation API token is still missing; local OAuth cannot replace it in Actions.
- The earlier [readiness monitor run](https://github.com/Efeblk/event_recommender/actions/runs/36265877841)
  failed: staging had no Worker and production had no configured URL. The failure
  remains recorded. No 48-hour observation window has started.

Deployment builds once, preserves a compiled SHA-256 manifest, and verifies it
before remote mutations. Production promotes the exact successful staging
artifact. Collection and monitor evidence record the actual deployed revision,
GitHub run, and schedule event; manually dispatched or artifact-only results
cannot satisfy unattended observation. Deployment credentials are restricted to
the steps that need them, outside dependency installation and artifact upload.

## Remaining release gates

1. Require green core CI for the exact candidate commit and review its immutable
   staging artifact. Install the automation token securely and obtain staging
   publication authorization.
2. Deploy staging, verify exact health identity, publish/checkpoint the actual
   collected catalog, reuse unchanged embeddings, and require readiness and full
   eligible embedding coverage.
3. Run bounded live quality tests against the current staging catalog. Review
   every card and every empty result against source evidence. Retain provider
   failures and actual usage; do not reuse old relative-date fixtures blindly.
4. Execute and preserve the [D1/R2 recovery and load drills](staging-drills.md),
   verify a known-good Worker rollback, and measure Cloudflare CPU, memory, and
   limit/error telemetry. Local timing and host memory do not establish capacity.
5. Enable scheduled staging collection and monitoring, workflow-failure
   notifications, and an independent external readiness monitor. Pass the
   [soak verifier](soak-verification.md) for at least 48 overlapping elapsed hours
   on the candidate revision with all three sources refreshed.
6. Configure isolated production resources and promote only after all gates and
   explicit publication authorization. Purchasing a paid plan remains a separate
   decision, if actual capacity measurements justify it.

Dependency audits found no production web vulnerabilities and no high/critical
findings. Remaining moderate reports concern development-only Drizzle tooling
and Crawlee's transitive `stream-json` dependency; no dependency downgrade or
unsupported override was applied. These audit results do not constitute a full
security assessment.
