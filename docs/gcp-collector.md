# GCP staging collector

`Collect GCP staging event data` supports manual runs and a six-hour schedule for the private staging Cloud Run service. A scheduled run starts only when the repository variable `GCP_STAGING_COLLECTION_ENABLED` is exactly `true` and `GCP_STAGING_COLLECTION_UNTIL` is a canonical UTC timestamp (`YYYY-MM-DDTHH:mm:ss.sssZ`) that is still in the future and no more than 60 hours away. Missing, malformed, expired, or overly distant deadlines skip collection before the collector environment or credentials are used. Merging the workflow does not enable collection. Manual dispatch remains available from the default `master` branch and does not require either schedule variable.

Configure a separate `gcp-staging-collector` GitHub environment with:

- `BIPLAN_URL`: the service's direct `https://…run.app` URL.
- `GCP_COLLECTOR_WORKLOAD_IDENTITY_PROVIDER`: a collector-specific GitHub Workload Identity Federation provider restricted to this workflow.
- `GCP_COLLECTOR_SERVICE_ACCOUNT`: a dedicated service account that can impersonate through that provider and has only Cloud Run invoker access to the staging service.
- `SYNC_TOKEN`: the environment secret matching the application's staging sync token.

Restrict that environment to `master` and do not configure required reviewers, because a reviewer gate would prevent scheduled jobs from running unattended. Keep the deployment identity and required-reviewer rules on the separate `gcp-staging` environment. The collector Workload Identity Federation provider independently checks the repository and owner numeric IDs, repository name, `master` ref, exact workflow path, and the `gcp-staging-collector` environment subject.

The workflow requests a short-lived Google identity token whose audience is `BIPLAN_URL`. The collector sends it in `X-Serverless-Authorization`, which Cloud Run consumes for IAM. It keeps the application's sync token in `Authorization`; the two authentication layers are independent. Neither token is written to artifacts or logs.

Each run restores the canonical private checkpoint before collection, preserves source failures and quarantined records through the existing collector pipeline, imports the successful report, saves a checkpoint, reads it back, and uploads the same bounded evidence artifacts as the existing collector workflow. Collection retains its limit of 100 and 20 discovery pages, with no automatic provider retries. It does not call TypeSafe or Voyage and does not index embeddings. Embedding indexing remains a separate, explicitly authorized operation that should reuse existing vectors.

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
