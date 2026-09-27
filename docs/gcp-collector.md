# GCP staging collector

`Collect GCP staging event data` supports manual runs and a six-hour schedule for the private staging Cloud Run service. A scheduled run starts only when the repository variable `GCP_STAGING_COLLECTION_ENABLED` is exactly `true` and `GCP_STAGING_COLLECTION_UNTIL` is a canonical UTC timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`) that is still in the future and no more than 60 hours away. Missing, malformed, expired, or overly distant deadlines skip collection before the collector environment or credentials are used. Merging the workflow does not enable collection. Manual dispatch remains available from the default `master` branch and does not require either schedule variable.

Configure a separate `gcp-staging-collector` GitHub environment with:

- `BIPLAN_URL`: the service's direct `https://…run.app` URL.
- `GCP_COLLECTOR_WORKLOAD_IDENTITY_PROVIDER`: a collector-specific GitHub Workload Identity Federation provider restricted to this workflow.
- `GCP_COLLECTOR_SERVICE_ACCOUNT`: a dedicated service account that can impersonate through that provider and has only Cloud Run invoker access to the staging service.
- `SYNC_TOKEN`: the environment secret matching the application's staging sync token.

Restrict that environment to `master` and do not configure required reviewers, because a reviewer gate would prevent scheduled jobs from running unattended. Keep the deployment identity and required-reviewer rules on the separate `gcp-staging` environment. The collector Workload Identity Federation provider independently checks the repository and owner numeric IDs, repository name, `master` ref, exact workflow path, and the `gcp-staging-collector` environment subject.

The workflow requests a short-lived Google identity token whose audience is `BIPLAN_URL`. The collector sends it in `X-Serverless-Authorization`, which Cloud Run consumes for IAM. It keeps the application's sync token in `Authorization`; the two authentication layers are independent. Neither token is written to artifacts or logs.

Each run restores the canonical private checkpoint before collection, preserves source failures and quarantined records through the existing collector pipeline, imports the successful report, saves a checkpoint, reads it back, and uploads the same bounded evidence artifacts as the existing collector workflow. Collection retains its limit of 100 and 20 discovery pages, with no automatic provider retries. It never calls TypeSafe. The optional Voyage follow-up below is disabled by default and requires its own reviewed window and call budget; collection alone does not imply complete embedding coverage.

Before enabling scheduled collection, apply and verify the dedicated identity's updated environment subject, complete a successful manual run, and inspect its checkpoint readback and source-health artifacts. Then review expected collection and storage cost separately. Set `GCP_STAGING_COLLECTION_UNTIL` first to an expiry at most 60 hours in the future, then set `GCP_STAGING_COLLECTION_ENABLED=true`. For a 48-hour initial soak, use the full 60-hour window and enable shortly before a scheduled tick. GitHub scheduling delays can still shorten the evidence span, so verify the actual artifact timestamps instead of treating the deadline as proof of 48 hours. The deadline is checked when the gate job starts; it does not extend itself.

After the workflow and collector environment changes are integrated, an authorized operator can create the bounded window from PowerShell with:

```powershell
$collectionUntil = (Get-Date).ToUniversalTime().AddHours(60).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
gh variable set GCP_STAGING_COLLECTION_UNTIL --body $collectionUntil
gh variable set GCP_STAGING_COLLECTION_ENABLED --body true
```

Leave `GCP_STAGING_COLLECTION_ENABLED` absent or set to any other value to keep scheduled collection disabled. To stop early, unset it or set it to `false`; after the deadline, scheduled runs fail closed even if the enable variable remains `true`. Extending the window requires a separate deliberate update to the deadline after reviewing usage. These repository-variable changes are operational actions outside deployment.

```powershell
gh variable set GCP_STAGING_COLLECTION_ENABLED --body false
```

After activation, collect at least 48 hours of successful scheduled staging evidence before public release. Manual runs, merged configuration, configured variables, and skipped scheduled jobs do not by themselves satisfy that gate.

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
| `GCP_STAGING_INDEXING_UNTIL` | Canonical UTC expiry, at most 60 hours after the start |
| `GCP_STAGING_INDEXING_MAX_CALLS` | Integer 1–32 for the entire window, across collection runs |

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

Successful batches merge through the existing lease-fenced vector writer without
deleting old cached vectors. A bounded stop leaves surplus documents pending and
returns exit 2; a failure returns exit 1. Both remain visible as a failed indexing
step, while an already published collection still receives its own soak report.
The always-upload artifact includes `collection-embedding-index.jsonl` and
original admin HTTP response files; server-side provider evidence remains in the
private bucket. These records must distinguish publication success, embedding
coverage, skipped indexing and failed/partial attempts. This feature has offline
fault and cost-bound tests; its later deployed revision needs its own live
evidence and cannot inherit qualification claims from an earlier image.
