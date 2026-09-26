# Release readiness — 27 September 2026

**Not ready for public production.** Staging is deployed, but collection has not
completed a durable checkpoint. A read-only embedding coverage request hit the
live Worker's 10 ms CPU limit before any provider call. Recovery, current-catalog
AI quality, capacity and 48-hour unattended observation remain unverified.
Times below are UTC on September 26; the report date is Europe/Istanbul.

## Deployed revision and preserved evidence

[PR 4](https://github.com/Efeblk/event_recommender/pull/4) was merged with staging
publication authorization. [Deployment run 36270539179](https://github.com/Efeblk/event_recommender/actions/runs/36270539179)
successfully published revision `4de58c1d9a0dd499efa373a6092d0ec06e2bd6fd` to
`https://biplan-staging.efeblk.workers.dev`, Worker version
`db3282f2-6514-4a81-935b-229adb29d02d`. Health returned HTTP 200 with that exact
revision and environment. Readiness returned HTTP 503, `checkpoint_missing`.
This is deployment evidence, not successful application readiness.

Core CI for the deployed revision passed in runs
[36269943075](https://github.com/Efeblk/event_recommender/actions/runs/36269943075)
and [36269943073](https://github.com/Efeblk/event_recommender/actions/runs/36269943073).
Independent download verification checked all 95 compiled files, both lockfiles,
and configured-secret absence in artifact `10915875895`. Its compiled manifest
SHA-256 is `c8b72053b08336ff81bf14042872a74b925f3af7cb0d6338e943d2aa2c6657ab`.
The previous missing-hidden-files failure remains in the September 26 report.

Staging has dedicated Workers, D1 and private R2 resources. No subscription or
unrelated account resource was changed. The deployment used `WORKERS_PLAN=free`.
The account subscription inventory endpoint returned HTTP 403, so no claim is
made about other account subscriptions. The effective limit below is measured.

## Failed bootstrap attempts and CPU diagnosis

Three manual bootstrap attempts reused the original report from collection run
[36263215393](https://github.com/Efeblk/event_recommender/actions/runs/36263215393).
Each stopped at its first failure, made no automatic retry and did not advance
the checkpoint. Successful preceding batches did update D1; publication across
the entire report is not one transaction.

| Attempt | Publisher used | Outcome |
| --- | --- | --- |
| 20:57:19–20:59:36 | Original 30-page batches | HTTP 400. Offline replay found a session that expired while earlier batches were uploading. |
| 21:03:48–21:04:08 | Per-batch expiry check, 30 pages | HTTP 503; Cloudflare reported `exceededResources`. The specific resource was not captured. |
| 21:11:18–21:12:05 | Per-batch expiry check, 3 pages | 92 requests returned HTTP 200, then request 93 returned an empty HTTP 500. Cloudflare classified it as successful execution, CPU 7.207 ms. The application/internal cause remains unresolved. |

The publisher corrections are in the working-tree candidate based on
`1c38912e896add8a6780fa561968c0915d579ca8`; they were not part of the deployed
Worker or the original GitHub collection run. The first correction was tested
with 39 collector tests, the final three-page bound with 40. Original collection
reports and each failed result remain unchanged in ignored local evidence.

Two authenticated **GET** requests to `/api/admin/embeddings` then failed with
HTTP 503. This route only checks cache coverage; it does not call Voyage or Jev.
The second request, at 21:15:32, was captured with live Wrangler tail:

- Ray: `a41548d5d9ebb652-IST`.
- Worker version: `db3282f2-6514-4a81-935b-229adb29d02d`.
- Outcome: `exceededCpu`; CPU 10 ms; wall time 354 ms.
- Exception: `Worker exceeded CPU time limit.`

This confirms a CPU failure for this request. It does not establish the cause
of either earlier import failure. Tail collection stopped immediately; headers,
authorization, IP and network metadata were discarded before persistence.
The [sanitized evidence](../web/evals/reports/2026-09-27-staging-bootstrap.json)
preserves the distinguishing results. No staging recommendation or embedding
provider calls were made during these diagnostics.

## Rate-limit and publisher candidate

The candidate adds five AI-enabled requests per IP per fixed UTC minute and
twenty per hour. Keyless fallback allows sixty per hour. The shared AI-enabled
request cap remains 100 per UTC day by default. These are request counts, not
token or currency budgets. Provider billing and admin indexing are separate.

IP buckets apply to valid API attempts before catalog work, including requests
that subsequently receive a catalog-unavailable response. This bounds catalog
database work during outages; it can also temporarily limit a legitimate client
after an outage. The shared AI daily counter is consumed only after catalog
readiness. Only Cloudflare's client IP header is trusted; forwarded headers do
not bypass the limiter. Shared-network users share an IP allowance.

Each D1 bucket update is atomic. Sequential bucket updates are conservative:
an earlier bucket can be consumed before a later bucket denies a request.
`Retry-After` identifies the first failing bucket, not a guarantee that every
other bucket will be available at that time. The UI preserves the existing
results on HTTP 429 and removes the immediate retry button.

The collector rechecks expiry immediately before every upload, counts omitted
sessions, preserves the source report and sends at most three whole source
pages per request. Smaller batches reduce per-invocation database work; the
failed third bootstrap demonstrates that this alone has not fixed staging.

Initial Windows checks used Node 24.11.1 on this dirty candidate: 243 web tests,
40 collector tests, 31 deployment tests, typecheck, lint, build, compiled D1/R2
and Voyage checks, and 13 browser tests passed (one intentional skip). A rerun
that only changed PATH did not prove the npm scripts used Node 22: the Windows
system npm wrapper selects its bundled executable. Its logs are preserved as
unproven version evidence. Verification must invoke npm through the pinned
Node 22 executable and pass the resulting commit's Node 22 CI; earlier results
are not relabelled.

The intermediate browser rerun had one failure (12 passed, one skipped): the
needs-input test typed into the server-rendered textarea before hydration.
The test now waits for the mocked catalog card to appear before typing. The
full suite then passed 13 tests, one skipped, with no runtime change. The
failure log is preserved; its Playwright trace was overwritten by the initial
focused rerun and is unavailable. This limitation is not hidden by the pass.
The rate-limit smoke test checks real compiled Worker/D1 concurrency. A local
provider interceptor is verified with a positive control before asserting zero
outbound provider transports after daily-cap denial.

## Monitoring and remaining gates

Repository variable `SCHEDULED_COLLECTION_ENVIRONMENTS` is `["staging"]`.
Manual real collection run
[36271239817](https://github.com/Efeblk/event_recommender/actions/runs/36271239817)
uses merge revision `1c38912e896add8a6780fa561968c0915d579ca8`; it was still
collecting at this report's initial cutoff. Manual runs cannot qualify as
scheduled soak evidence.

The free UptimeRobot readiness-monitor setup request returned HTTP 200 at
21:04:49. The service requires the owner to click the email activation link and
activate the monitor. Its reply is not proof of an active monitor. Activation
has not been confirmed, and no successful 48-hour observation period has begun.

An isolated paid-profile configuration has been prepared for review only. Its
only effective difference is `limits.cpu_ms: 30000`. Cloudflare documents a
[$5/month minimum Workers Paid subscription](https://developers.cloudflare.com/workers/platform/pricing/)
and a [10 ms Free HTTP CPU limit](https://developers.cloudflare.com/workers/platform/limits/).
AI services and usage above included allowances are separate. No paid profile
was deployed or subscription purchased. Continuing on Free requires workload
optimization or an architectural change followed by new cloud measurements;
a paid allowance would also require retesting, not waive any release gate.

Remaining gates: a healthy checkpoint and complete eligible embedding coverage;
resolution of the import HTTP 500; live current-catalog quality review of every
card and empty result; bounded cloud load and telemetry; D1/R2 recovery and
known-good rollback; activated independent alerts and 48 hours of scheduled
evidence on the candidate; then separate production publication authorization.
