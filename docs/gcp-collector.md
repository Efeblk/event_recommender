# GCP staging collector

The [product plan](product-plan-v1.md) defines current scope and acceptance checks.
Use [the v1 architecture](architecture.md) for the current data flow.

`Collect GCP staging event data` supports manual runs and a six-hour schedule.
The service is private. A scheduled run requires
`GCP_STAGING_COLLECTION_ENABLED=true`. `GCP_STAGING_COLLECTION_UNTIL` must be
the literal `open` or a future canonical UTC timestamp
(`YYYY-MM-DDTHH:mm:ss.sssZ`) no more than 60 hours away. Missing or invalid values
skip collection before credentials are used. `open` keeps collection active
without an expiry. It does not enable paid indexing. Manual dispatch uses
`master` and does not require either schedule variable.

The workflow serves the v1 snapshot path. PostgreSQL preparation is frozen.
Its opt-in workflow step is removed. Raw provider pages under
`collector/state/raw/` are excluded from public workflow artifacts.
JSON collection, coverage, publication and indexing reports remain available.

Configure a separate `gcp-staging-collector` GitHub environment with:

- `BIPLAN_URL`: the service's direct `https://…run.app` URL.
- `GCP_COLLECTOR_WORKLOAD_IDENTITY_PROVIDER`: a collector-specific GitHub Workload Identity Federation provider restricted to this workflow.
- `GCP_COLLECTOR_SERVICE_ACCOUNT`: a dedicated service account that can impersonate through that provider and has only Cloud Run invoker access to the staging service.
- `SYNC_TOKEN`: the environment secret matching the application's staging sync token.

Restrict that environment to `master` and do not configure required reviewers, because a reviewer gate would prevent scheduled jobs from running unattended. Keep the deployment identity and required-reviewer rules on the separate `gcp-staging` environment. The collector Workload Identity Federation provider independently checks the repository and owner numeric IDs, repository name, `master` ref, exact workflow path, and the `gcp-staging-collector` environment subject.

The workflow requests a short-lived Google identity token whose audience is `BIPLAN_URL`. The collector sends it in `X-Serverless-Authorization`, which Cloud Run consumes for IAM. It keeps the application's sync token in `Authorization`; the two authentication layers are independent. Neither token is written to artifacts or logs.

Each run restores the canonical private checkpoint and cached coverage backlog before collection, preserves source failures and quarantined records, imports verified pages, saves a checkpoint, reads it back, and uploads evidence artifacts. Each scheduled run is bounded to 2,000 detail pages, 6,000 HTTP requests, 40 minutes, and 20 pagination requests per listing; unfinished listing cursors and detail URLs remain durable for later runs. The 40-minute collection allowance reserves the rest of the 90-minute job for publication and indexing; import alone took about 20 minutes for 4,400 source pages in October 2026. Source HTTP 429/5xx retries are bounded; publication and paid AI calls have no automatic retries. Verified empty pages carry an explicit retirement timestamp, preventing older imports from resurrecting removed sessions. Collection never calls TypeSafe. The optional Voyage follow-up below is disabled by default and requires its own reviewed window and call budget; collection alone does not imply complete embedding coverage.

Before enabling scheduled collection, apply and verify the dedicated identity's updated environment subject, complete a successful manual run, and inspect its checkpoint readback and source-health artifacts. Then review expected collection and storage cost separately. Set `GCP_STAGING_COLLECTION_UNTIL` first to an expiry at most 60 hours in the future, then set `GCP_STAGING_COLLECTION_ENABLED=true`. For a 48-hour initial soak, use the full 60-hour window and enable shortly before a scheduled tick. GitHub scheduling delays can still shorten the evidence span, so verify the actual artifact timestamps instead of treating the deadline as proof of 48 hours. The deadline is checked when the gate job starts; it does not extend itself.

After the workflow and collector environment changes are integrated, an authorized operator can create the bounded window from PowerShell with:

```powershell
$collectionUntil = (Get-Date).ToUniversalTime().AddHours(60).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
gh variable set GCP_STAGING_COLLECTION_UNTIL --body $collectionUntil
gh variable set GCP_STAGING_COLLECTION_ENABLED --body true
```

To keep scheduled collection on without renewal, set `GCP_STAGING_COLLECTION_UNTIL` to the literal `open`. Collection makes no paid calls; Voyage indexing keeps its own bounded window. A skipped scheduled run shows a "Scheduled collection skipped" warning.

```powershell
gh variable set GCP_STAGING_COLLECTION_UNTIL --body open
gh variable set GCP_STAGING_COLLECTION_ENABLED --body true
```

Leave `GCP_STAGING_COLLECTION_ENABLED` absent or set to any other value to keep scheduled collection disabled. To stop early, unset it or set it to `false`; after the deadline, scheduled runs fail closed even if the enable variable remains `true`. Extending the window requires a separate deliberate update to the deadline after reviewing usage. These repository-variable changes are operational actions outside deployment.

```powershell
gh variable set GCP_STAGING_COLLECTION_ENABLED --body false
```

Phase 2 requires seven days of scheduled collection and an hourly readiness
monitor. Manual runs and skipped jobs do not prove that acceptance condition.
The older 48-hour observation procedure above describes a bounded window.
Use `open` for the product plan's seven-day check.

To verify the active private publication without starting collection or indexing,
run the workflow with `verify_only=true`:

```powershell
gh workflow run gcp-collector.yml -f verify_only=true
```

The verification-only run uses the collector's private identity and the same
concurrency group as collection, so it waits for an active collection instead of
interrupting it. Its `gcp-ready-staging-<run-id>-<attempt>` artifact contains only
`ready.json`, `status.txt` and `validation.json`. The validator requires HTTP 200,
`ready: true`, an empty `reasons` array, a catalog observation no more than 14
hours old, no pending search publication, and matching canonical non-null
`latestCollectedAt`, `activeCollectedAt` and checkpoint `finishedAt` values. It
does not require the workflow commit to equal the deployed runtime commit.

This probe proves that the active publication is healthy and converged. An older
fresh publication can pass every check. To verify one target collection, compare
the artifact's checkpoint `finishedAt` with that collection run's publication
receipt and report, and verify the checkpoint hash in the collection evidence.
The manual probe does not count as an hourly Phase 2 monitor run.

If collection completes but publication fails, preserve the failed run before
recovery. Do not rerun its 40-minute fetch. Record the exact SHA-256 of
`collector/output/report.json` from its normalized artifact. Then dispatch the
same workflow with the failed run ID and that digest:

```powershell
gh workflow run gcp-collector.yml -f publish_existing_run=37846165394 -f publish_existing_report_sha256=e9a2f3211b809bd0e152581ae2a8a8f1b27ff2a0a925a000fa2c2386b8186ad3
```

Replay mode is mutually exclusive with verification and normal collection. It
downloads only `gcp-event-data-staging-<source-run-id>`, requires one failed run
from this repository, workflow and default branch, and binds the report bytes to
the supplied digest and the artifact collector revision. It validates every
prepared import envelope before staging writes. It also requires the deployed
revision to equal the replay workflow revision and refuses a newer active checkpoint.
It publishes the original report with unchanged observation times. It does not
restore a checkpoint, collect provider pages, save coverage or run indexing.
The replay job is bounded to 45 minutes and never retries publication
automatically. Its publish status remains in the evidence if a step fails or is
cancelled before the final readiness check.

The replay passes only when the canonical checkpoint and `/api/ready` report the
artifact's exact `finishedAt`. Its evidence artifact contains safe source,
digest, preflight, publication and readiness summaries. A source page that is
newer than the preserved report still stops checkpoint publication. Never alter
the report timestamp to bypass that guard.

GitHub schedules can be delayed or skipped. The catalog stays valid for 72 hours,
so a few missed runs are harmless. Cloud Monitoring emails through channel
`biplan-staging-uptime-email`, independently of GitHub:

- `biplan-staging-ready-failure`: the authenticated uptime check of `/api/ready`
  fails in two locations for 10 minutes.
- `biplan-staging-catalog-not-refreshed`: no `POST /api/admin/collection` with
  HTTP 200 (log metric `biplan_collection_published`) for 14 hours.

## Optional bounded embedding follow-up

Deploy the audited-index implementation to private staging before enabling this
step. Merging code or enabling collection does not activate indexing. Leave
`GCP_STAGING_INDEXING_ENABLED` unset or `false` until the concrete PR, provider
budget and deployment revision have been reviewed. Activation requires these
repository variables:

| Variable | Required value |
| --- | --- |
| `GCP_STAGING_INDEXING_ENABLED` | Exactly `true` |
| `GCP_STAGING_INDEXING_FROM` | Canonical UTC timestamp when the reviewed window starts |
| `GCP_STAGING_INDEXING_UNTIL` | Canonical UTC expiry, at most 60 hours after the start, or `open` for a daily window renewed at 00:00 UTC (`FROM` is then ignored) |
| `GCP_STAGING_INDEXING_MAX_CALLS` | Integer 1–96 for the entire window (per UTC day when `open`), across all runs |

An hourly schedule (`47 * * * *`) in the same workflow runs only the `index_only` job when indexing is enabled. It does not collect. Each run makes at most 4 calls.

Align expiry with the collection observation window. The CLI and server reject
expired, future-starting, malformed or overlong windows. The server will not
replace an active window with a different start/expiry/budget; changing variables
cannot silently refill an active budget. Unset the enable variable to stop future
follow-up steps. No cloud variable, IAM grant or provider key is added by the PR.

After successful publication the workflow refreshes the collector's existing
HTTP identity and runs `web/scripts/index-collected-embeddings.mjs`. It uses the
same sync token and Cloud Run invoker identity; the runtime keeps the Voyage key
and existing GCS/Firestore privileges. The CLI pins the deployed revision, checkpoint hash and exact
`voyage-4-large`, 1024-dimension document profile returned by the server. Document
text hashes deduplicate sessions, and matching cached vectors are reused exactly.
Price, date and freshness changes alone do not alter embedding text. A fully
cached catalog performs one status GET and no provider call.
An older endpoint without audited metadata is rejected after that GET, before
its legacy POST can be called. Disabled indexing writes a zero-request artifact
without requesting an indexing identity token or reading application credentials.

Each run admits at most 4 provider attempts, at most 32 documents and 8000 UTF-8
input-text bytes per call, and at most 32000 input-text bytes per run. Failed
admissions still consume the reserved call allowance. The run identity is GitHub
`run_id`, never `run_attempt`, so rerunning the workflow cannot reset its budget.
The CLI spaces batches 61 seconds apart; the server additionally enforces a 21s
minimum and 9000-token rolling reservations. Fetch is outside Firestore transaction
callbacks, so transaction retries cannot repeat a provider request. There are no
automatic HTTP or provider retries.

The 32000-token run threshold and window threshold (`maxCalls × 8000`) use observed
Voyage usage plus conservative input-byte reservations. They are **not exact
pre-call billing caps**: one bounded charged response can report usage above its
reservation. Such an overshoot is retained and halts indexing immediately.
The hard limits are the number of admitted calls and input bytes. Storage writes,
including a full vector snapshot per successful batch, also consume resources.

Before any vector publication, private create-only GCS objects preserve original
request JSON, response status, original response bytes encoded as base64, hashes,
timestamps and usage under `embedding-audit/staging/<window-hash>/<run-id>/`.
Responses are capped at 4 MiB; non2xx and partial failures are preserved too. No
authorization headers or raw provider bodies are returned in the admin response.
Literal or JSON-escaped reflected runtime keys suppress raw capture and leave a
credential-suppressed failure record. Never describe suppressed or partial bytes
as a complete response. Admin responses expose only audit object references,
hashes, usage and indexing progress.

Firestore's `biplan/staging/embeddingIndex/window` document and per-run records
reserve a durable in-flight attempt before the paid call. Capture, checkpoint,
validation or publication uncertainty leaves the window halted/in-flight even if
the process disappears. Subsequent scheduled runs stop before another paid call.
There is no automatic reset endpoint: inspect original audit receipts, hashes,
the pinned catalog and current vector head before any explicitly reviewed
recovery. Reuse valid captured vectors after a publication failure rather than
paying for the same input again. Preserve original failed evidence and admission
counts during recovery.

Successful batches use the existing vector writer and retain cached vectors.
A bounded stop leaves documents pending and returns exit 2. The workflow records
a warning and keeps the successful collection result. A fatal indexing failure
returns exit 1 and fails the job. An already published collection still receives
its own soak report in both cases.
The always-upload artifact includes `collection-embedding-index.jsonl` and
original admin HTTP response files; server-side provider evidence remains in the
private bucket. These records must distinguish publication success, embedding
coverage, skipped indexing and failed/partial attempts. This feature has offline
fault and cost-bound tests; its later deployed revision needs its own live
evidence and cannot inherit qualification claims from an earlier image.
