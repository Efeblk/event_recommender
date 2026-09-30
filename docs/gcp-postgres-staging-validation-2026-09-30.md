# PostgreSQL staging validation — 2026-09-30

Authorization remains `user-approval-2026-09-30-gcp-postgres-staging-bundle`: USD 10–12/month ongoing, up to USD 3 one-time validation, one isolated restore for at most two hours, and zero paid AI calls. This checkpoint is staging evidence, not public readiness or public-launch approval.

## Verified foundation

The dedicated `biplan-staging-efeblk` Cloud SQL instance is PostgreSQL 17 on zonal `db-f1-micro`, with 10 GiB SSD, storage growth disabled, no HA or PITR, seven retained automated backups, and deletion protection. The frozen active publication remains `publication-caddc0f698a50a46d2bc3bcc70f94507d562ec7024d1254e328b300e5f526b1b` with 7,719 sessions, 10,024 offers, 7,693 cached 1,024-dimensional vectors, and 26 lexical-only sessions. This frozen legacy publication does not prove fresh provider inventory or complete fee evidence.

Main-schema verification passed after tracked migrations 009 and 010. It confirmed 48 relations, the unchanged active publication, runtime/preparer direct-write denial, and current hashes `a10f624b…6992` for migration 009, `12e0d6c…f4bc` for migration 010, and `ec3097a…e1e` for roles. The immutable source receipt is `main-schema-repair-1790757999456.json`, SHA-256 `26d9815afe27929731840cae2b8d07db123f42c3dd3a449d40605bdbde2f99a5`.

The isolated restore existed for 91.11 minutes, inside the 120-minute cap. The restored instance was deleted before the deadline. Its owned on-demand backup now reads `DELETED`, and project backup metadata is empty; automated retention on the main instance remains unchanged. Evidence: `recovery-drill.json`, SHA-256 `8f1b36292f331e5814dcedfec4ed080d47465e338c2dece8975992579d81687e`.

## Managed preparation and recovery evidence

The clone drill persisted one page, accepted two records, sealed the batch after migration 010, and prepared both sessions with zero pending. Lease reclaim incremented the fence and rejected the stale worker. It used 8 of the authorized 24 Job executions and made zero provider or AI calls.

The drill stopped at the cleanup deadline before publication. Publication, pointer rollback, and published-batch replay were not reached. This is a real remaining managed-publication/recovery gate; the sealed and prepared synthetic batch does not establish it. Evidence: `managed-clone-drill-final-evidence.json`, SHA-256 `c0eeaca2d44b149008201043a96c1a376cc9a7a31dd64379e41af4c0051972d5`. Earlier failed Job executions remain part of that receipt.

## HTTP candidate evidence

Image `us-central1-docker.pkg.dev/biplan-staging-efeblk/biplan-staging/biplan-postgres-http@sha256:f3a6d2e91371424f8fe9bd7e3e7de20e85fba9b277c478c08a99d9378f76d5bf` was built from revision `05379e9f7abdec0f5f8e3e626012652dcff5caef`. Its local build log SHA-256 is `c7dd4fe5c95ae0797d9d83177aaf7b9965b5e43f186c70fc4d4c55dda8f4328c`; the registry readback is preserved separately.

A three-query read-only sizing diagnostic at the runtime 5-second statement timeout measured 1,000 rows in 2,979 ms plus 19 ms parse, 2,000 rows in 1,516 ms plus 38 ms parse, and a 4,000-row timeout (`57014`) at 5,218 ms. The counterintuitive sample timings are observations, not proof of a general optimum; 2,000 is the largest tested passing page. Evidence: `bounded-page-sizing.json`.

A complete 2,000-row-page read then passed all 7,719-session/10,024-term integrity guards in five SQL statements but took 12.991 seconds through this PC's proxy. That diagnostic does not demonstrate an improvement over the prior smaller-page read. The deployed and retained fallback therefore remains 1,000 rows. Cold `candidates` loads roughly 47 MB of immutable JSON through sequential database pages; warm projection takes roughly 0.5 seconds. The next serving change must move verified artifact construction into preparation, preserving database publication pinning and mandatory final checks. Evidence: `bounded-generation-read-1790758986852.json`; this is not Cloud Run timing.

The final zero-traffic candidate passed correctness for all five source-verified recommendation requests with rules-only interpretation and no AI secrets. It failed both predeclared latency targets: cold lexical was 11.714 seconds against 8 seconds, and concurrency-four p95 was 5.493 seconds against 4 seconds. Server-Timing showed the cold request dominated by candidate work and the concurrent requests shared waits across catalog, publication pinning, candidates, and source revalidation; WAN measurements do not isolate Cloud Run CPU. Evidence: `candidate-acceptance-1790758214802.json`, SHA-256 `db3c175e751a34814bf5ada77c63a757f98513668c50306cd78f01cfd80a7252`.

The cumulative HTTP ledger remains 25 actual calls. Within the same original USD 3 validation cap, the bounded no-AI ceiling is now 40: five calls for exactly one new-candidate performance run, four guarded cutover/rollback checks only if all gates pass, and six reserved confirmations. This is one cumulative ledger, permits no automatic retries, adds no resources or paid AI, and does not authorize another 13-request correctness run. The runtime fix still requires fresh performance acceptance; the failed measurement cannot be replaced by offline timing.

Private `biplan-staging-00021-ril` and preview `biplan-preview-20260927-00019-fod` remain at 100% traffic. PostgreSQL candidates remain unpromoted, and the preview service remains unchanged. Required collector coverage and preparation receipts are still absent, so PostgreSQL readiness remains intentionally 503. Neither service is ready for PostgreSQL cutover while the latency and managed-publication gates remain open.

## Cost and remaining scope

Actual billed cost is unavailable and remains `null`; no zero-cost claim is made. The conservative validation estimate, including the read-only sizing diagnostic and bounded remaining HTTP allowance, is at most USD 1.00 within the existing USD 3 allowance, based on the previously recorded finite resource and execution bounds. No paid AI calls occurred. The TRY 100 alert is an alert, not a cap.

The smallest remaining path is the single reserved no-AI performance confirmation after the runtime fix, then completion of the managed publication/pointer rollback/replay drill within the existing Job allowance. Public launch additionally needs fresh declared provider coverage, trustworthy preparation receipts, fee evidence for hard budgets, capacity evidence, 48 hours of unattended monitoring, and separate publication authorization.

Raw evidence is retained under ignored `web/work/catalog-foundation/gcp-preflight-20260930/`; failed receipts are preserved alongside later results.
