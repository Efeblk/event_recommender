# Private GCP staging execution evidence — September 27, 2026

Status: the private staging foundation, first application deployment, preserved-catalog bootstrap, bounded UI check, first manual collection and publication, authenticated Cloud Monitoring uptime check, and controlled alert-delivery test are complete. Post-collection readback and application probes passed. Source refresh remains partial, with failures and carried records preserved. This record is not public-release approval, a capacity result, or unattended-soak evidence.

## Authorization and boundaries

The user explicitly authorized a dedicated private GCP staging project, possible resulting charges, and a project-filtered TRY 100 monthly budget alert. The alert is a notification threshold, not a spending cap. No public invocation, production deployment, paid subscription, scheduled collection, or public launch was authorized by this work.

The service remains private. Staging uses request-based CPU, zero minimum instances, one maximum instance, 1 CPU, 1 GiB memory, concurrency 32, and a 300-second request timeout. Runtime, deployment, and collector identities are separated. Secret values, personal email addresses, billing identifiers, and monitoring resource IDs are intentionally absent from this report.

Foundation readback verified the project-filtered TRY 100 monthly budget alert, private Cloud Storage, Firestore Native, and Secret Manager with three pinned application secret versions. The final Terraform plan showed no drift after provisioning. This verifies the reviewed staging foundation at that point; it does not turn the budget alert into a hard cap or prove future configuration stability.

## Exact revision, deployment, and CI

- Exact deployed revision: `12f4202106854c003f59a737c82e936670ae64ab`, merged through [PR #6](https://github.com/Efeblk/event_recommender/pull/6).
- Seven CI checks passed on that exact merge revision; the [commit checks](https://github.com/Efeblk/event_recommender/commit/12f4202106854c003f59a737c82e936670ae64ab/checks) remain the canonical CI record.
- Manual [deployment workflow run 36307939756](https://github.com/Efeblk/event_recommender/actions/runs/36307939756), attempt 1, succeeded.
- Deployed image digest: `sha256:11f76763bdbf365d1137c27b6dca851707d3b76e5d0cf7c7257a9ea615070f15`.
- Region: `us-central1`; environment: `staging`.
- Cloud Run readback reported revision `biplan-staging-00001-nct` ready and receiving 100% of traffic. That infrastructure condition preceded catalog readiness and was not treated as application readiness.
- Build provenance records Linux `amd64`, Node `v22.23.2`, npm `10.9.8`, the source revision, and lockfile hashes.

The later stream-listener diagnostic fix is isolated at exact revision `de37326dba665e4300c9edcc1337cd54127eaa22` in draft [PR #8](https://github.com/Efeblk/event_recommender/pull/8). All seven of its CI checks passed, but it remains unmerged and was not deployed for this execution. All runtime evidence in this report comes from the original `12f4202` deployment.

## Application probes and request accounting

The initial private-service check used seven non-AI requests. It verified unauthenticated IAM denial (`403`), authenticated health and exact revision (`200`), correct pre-bootstrap unready state (`503`), separation of IAM and application authorization (`401`), disabled legacy sync (`410`), pre-provider request validation (`400`), and the server-rendered shell (`200`).

After bootstrap, two authenticated HTTP readback calls verified the published checkpoint and embedding-index status. Full vector-snapshot verification was performed separately by the bootstrap SDK path. A first UI harness attempt failed before it could write valid evidence: hydration was checked before pending module requests completed, then context teardown caused a route exception. Its actual request count is unavailable, so the full 40-request cap is conservatively reserved. The corrected harness drained routed requests, awaited hydration, sanitized child-process failures, and produced a valid 17-request report at `2026-09-27T09:22:09.834Z`.

The maximum accounted application-probe total is 76, below the authorized 100-request limit:

| Activity | Count |
| --- | ---: |
| Deployment workflow health probe | 1 |
| Initial private-service probes | 7 |
| Bootstrap publication readback | 2 |
| Failed UI attempt, conservatively reserved | 40 |
| Successful UI rerun | 17 |
| Post-collection checkpoint and embedding status readback | 2 |
| Post-collection private-service probes | 7 |

Cloud Monitoring checks and collector requests are separate operational activity and are not included in this application-probe total. No Jev or Voyage provider call was made by these probes.

The final seven-request probe passed at `2026-09-27T09:54:46.154Z`: unauthenticated access remained denied, authenticated health matched the deployed revision, readiness returned `200` with `ready=true`, independent application authorization remained enforced, legacy sync remained disabled, invalid recommendation input was rejected before provider work, and the home shell rendered. Readiness reported 4,938 stored records and 4,577 in its available-record view.

## Bootstrap, publication, and readback

The preserved input contained 4,595 raw event records across 1,696 source pages. The import completed with 4,595 imported and zero skipped records. The preserved Voyage cache contained 1,718 entries with its exact endpoint, model, 1,024 dimensions, input type, text profile, document hashes, and vectors; all 1,718 entries were verified without generating a new vector or calling Voyage.

| Evidence | SHA-256 |
| --- | --- |
| Reconstructed checkpoint audit input | `6445304618957bd1599f02947d7973ea462fb568ce5930a5fac89916beb81867` |
| Published checkpoint readback | `4c54659e01648cb47071b1162db65a8b25291aa49d17bbad8466806d96c472b6` |
| Preserved and verified vector snapshot | `44e32c3eef837a5c193eaabef2ed5a06eb318eb35f5c2a06454fcbc39f0d552b` |

The audit input and published checkpoint hashes differ by design. The server created a new publication envelope saved at `2026-09-27T09:18:44.958Z`, while preserving the original report completion time `2026-09-26T21:23:49.008Z` and audit provenance, including the original saved time `2026-09-26T21:30:14.188Z`. Historical source timestamps were not rewritten as fresh collection evidence.

Bootstrap instrumentation recorded one bucket-metadata-read wrapper call, eight store-read wrapper calls, two blob-read wrapper calls, 59 high-level store-write wrapper calls, and two blob-write wrapper calls. The 59 write calls include 53 import batches; they do not mean 59 individual Firestore writes. These are diagnostic wrapper-call counts, not RPC counts, billing-operation counts, or a guarantee that SDK transactions and retries produced no additional service operations.

The authenticated application readback matched the published checkpoint: 4,595 stored records and application readiness `true`. The readiness status reported 4,260 currently eligible records. This status count uses the catalog's available-record view and is distinct from the offline retrieval analysis, which found 3,444 eligible merged sessions. The checkpoint summary contained 4,370 events and 4,264 available entries; these related counts measure different stages and must not be substituted for one another.

The offline retrieval coverage calculation found 1,887 distinct eligible documents, of which 1,566 had matching cached vectors, covering 2,992 eligible merged sessions. The remaining 321 eligible documents did not have matching cached vectors. The verified total of 1,718 cache entries includes entries outside the current eligible set, so it is not complete eligible-document coverage.

The authenticated `/api/admin/embeddings` status agreed with the offline current-catalog calculation: 3,444 eligible merged sessions, 1,887 eligible documents, 1,566 indexed documents, and 321 pending documents. This was a status readback, not a provider call or regeneration of missing vectors.

An earlier import was stopped preventively when its short-lived token was unlikely to remain valid for the full run. Cleanup removed 133 unpublished source heads and two leases while preserving immutable objects; no published catalog existed. During bootstrap, the Storage SDK emitted repeated `PassThrough` listener-count warnings. Successful publication and readback showed no data loss. The warnings alone do not establish a retained-listener leak; PR #8 addresses the diagnostic separately.

## UI and visible-card evidence

The successful bounded UI rerun verified health, readiness, application authorization separation, disabled legacy sync, validation before provider work, the home shell, hydration, controlled chat reset, and completion of all intercepted UI requests. Desktop and mobile screenshots were saved privately. Image requests were deliberately blocked, so this run does not verify remote image availability or rendering.

The review artifact records a passing comparison of all six visible cards against preserved checkpoint rows, including expected displayed TRY prices. It does not persist the observed DOM fields side by side with those rows. This is a bounded review of those six rendered cards against stored data, not a fresh provider-page check or a review of AI recommendations.

The first harness failure omitted a valid report and is preserved as a failure. The corrected rerun did not overwrite or reinterpret that attempt.

## Credential-handling incident

Raw private tool output from the failed UI attempt included a short-lived Google identity token. The token was not committed, published, or copied into this report; no application API key was exposed, and no credential file was committed. The identity token had an expiration time of `2026-09-27T10:19:44Z`. The harness was changed locally to catch route failures and sanitize child-process output. This incident remains part of the private execution record even though the credential was time limited.

## Authenticated monitoring

An authenticated Cloud Monitoring uptime check is active for the private Cloud Run `/api/ready` endpoint. It uses Cloud Monitoring service-agent OIDC authentication and the managed `cloud_run_revision` resource form. The arbitrary URL form rejected this OIDC configuration, and `validateSsl` is not supported for the Cloud Run resource form; neither unsupported form is represented as active configuration.

The active check runs from three US checker regions every 300 seconds with a 10-second timeout and expects HTTP 200. A readback at `2026-09-27T09:32:31.6628865Z` found green time series from all three configured locations. Cloud Run request logs showed three actual monitoring requests taking 82–138 ms on a warm instance. These samples verify authenticated reachability at that time; they are not an Istanbul latency measurement, a cold-start result, a capacity test, or an uptime history.

The associated email alert policy uses a 600-second failure condition. A controlled authenticated 404 check exercised notification delivery without causing an application outage. The user confirmed receipt of the test email at `2026-09-27T09:43Z`. Cleanup first disabled and then deleted the temporary policy before deleting the temporary uptime check, because Google rejects deletion of a check still referenced by a policy. GET readbacks returned `404` for both temporary resources, and cleanup completed at `2026-09-27T09:44:06.914Z`; the automatic cleanup helper then observed the completed state and exited.

At `2026-09-27T09:44:07Z`, the real monitoring check still had three locations reporting true, with the latest samples at `09:42Z`. Service IAM remained private: there was no public invoker and exactly one monitoring-service-account invoker binding. The controlled delivery test therefore verifies the configured email path and cleanup procedure, not public accessibility or an actual application outage.

A final monitoring readback at `2026-09-27T09:55:28.7467032Z` again found all three locations reporting true, with latest samples between `09:52:10Z` and `09:52:40Z`. Service IAM still had no public invoker and one service-level monitoring invoker binding.

## Manual collection and publication

Manual private collector [workflow run 36308807152](https://github.com/Efeblk/event_recommender/actions/runs/36308807152) succeeded on exact revision `12f4202106854c003f59a737c82e936670ae64ab`. Collection finished at `2026-09-27T09:47:17.603Z`; publication saved a new canonical checkpoint at `2026-09-27T09:53:26.565Z`. The receipt reports 4,109 imported records, zero omitted expired records, 4,938 canonical stored records, and successful canonical readback. This manual run does not count toward the required unattended observation period.

The collection report contains 4,708 reconciled records, including 4,577 available records and 599 carried records. It refreshed 1,416 pages, recorded 134 failed pages, quarantined zero records, and refreshed at least one page from every provider. These are separate stages: the server's canonical catalog also retains previously stored records and therefore has a different total.

An independent offline audit verified exact equality between all 4,938 HTTP checkpoint event objects and the workflow's canonical state artifact, with no duplicate IDs. The total comprises 4,109 records fetched this run, 599 collector-carried records, and 230 additional historical server-retained records. All 829 retained older records match their original bootstrap objects, including unchanged timestamps for all 258 retained records on failed-page URLs. No retained older record belongs to a successfully refreshed page. Refreshed pages by provider were Biletinial 817, Bubilet 513, and Biletix 86.

| Post-collection evidence | SHA-256 |
| --- | --- |
| Original collector report | `fe3e8b96e8c1282df442dee80e56871cdc72bb3106f18be754cac01071f286d7` |
| Canonical state artifact | `6af9352787d801a241f236d7f4d3bc1d202eaed46fca0cac969d24625c65963d` |
| Private HTTP checkpoint envelope | `6dc5d541f0fd463e966b42c76d4d8e32f473d42d25bade0200470f1713d4c954` |

The state artifact is an event array and the HTTP checkpoint includes an envelope; their whole-file hashes therefore differ despite exact event-object equality. At readback, 222 stored records were older than the 72-hour freshness limit and 227 had past session times; these groups can overlap. One expired historical record also lacks a source field. The eligibility implementation excludes stale and past records, so storage totals do not represent currently recommendable events.

All recorded failure categories were reviewed:

| Provider | Failure reason | Pages |
| --- | --- | ---: |
| Biletinial | `schema_missing` | 52 |
| Biletinial | `unsupported_category` | 42 |
| Biletinial | `no_verified_sessions` | 21 |
| Bubilet | `schema_missing` | 3 |
| Bubilet | `no_verified_sessions` | 2 |
| Biletix | `unsupported_category` | 13 |
| Biletix | `no_verified_sessions` | 1 |

There were 133 failures with one recorded attempt and one with two attempts. The preserved report does not establish the first-attempt cause for that page. No automatic AI-provider retry or new AI call occurred.

Six listing traversals reached `exhausted`; Biletinial stand-up stopped at `short_page`, discovering 37 items against a reported total of 56. Five listings were marked limited. The collector bounded new detail discovery while revisiting known productions, so the run does not establish complete provider coverage. Failed pages and older carried records remain distinct from successfully refreshed pages.

The post-collection embedding status reports 3,723 eligible merged sessions, 2,083 distinct eligible documents, 1,535 indexed documents, and 548 pending documents. This replaces the earlier bootstrap coverage count for the refreshed catalog; no new vectors were generated.

Draft [PR #7](https://github.com/Efeblk/event_recommender/pull/7) separately prepares a six-hour collector schedule with a repository-variable opt-in and dedicated collector environment. It remains draft, disabled by default, unmerged, and unapplied; this execution did not create that environment or enable the schedule.

## Evidence limitations and remaining release gates

- The bootstrap used preserved historical data; the subsequent manual run refreshed 1,416 pages but retained failures, incomplete discovery, and carried records. Stored totals and successful readback do not establish complete freshness or coverage.
- Complete eligible embedding coverage is pending for 548 documents after collection. No embedding regeneration or live Jev/Voyage evaluation occurred in this execution.
- The six visible cards were checked against the preserved checkpoint, not current provider pages. Turkish and English recommendation conversations, follow-ups, corrections, resets, group budgets, alternatives, fallback behavior, and empty-result recall still need bounded live review.
- Recorded source failures and the incomplete listing still require provider-level diagnosis before claiming complete coverage.
- Three warm monitoring samples and bounded probes do not characterize Cloud Run cold starts, memory, sustained latency, scaling, quotas, Firestore transaction retries, storage growth, or provider costs.
- Recovery drills remain: isolated restore, immutable-image rollback, missing referenced object, stale lease, provider outage, and safe cleanup of unreferenced objects and expired counters.
- Trusted client-IP behavior still needs qualification against forged forwarding headers before changing the conservative shared mode.
- No 48-hour unattended collection and monitoring record exists. Scheduled evidence must use the deployed revision and original run artifacts; manual and local runs do not qualify.
- Production requires separate resources, current account and cost review, completed launch gates, and explicit public-deployment authorization.

This evidence establishes a functioning private staging baseline at the stated cutoff. It does not establish production capacity, public readiness, or authorization to publish.
