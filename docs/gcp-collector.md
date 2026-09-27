# GCP staging collector

`Collect GCP staging event data` supports manual runs and a six-hour schedule for the private staging Cloud Run service. The scheduled job is inert unless the repository variable `GCP_STAGING_COLLECTION_ENABLED` is exactly `true`; merging the workflow does not enable collection. Manual dispatch remains available from the default `master` branch.

Configure a separate `gcp-staging-collector` GitHub environment with:

- `BIPLAN_URL`: the service's direct `https://…run.app` URL.
- `GCP_COLLECTOR_WORKLOAD_IDENTITY_PROVIDER`: a collector-specific GitHub Workload Identity Federation provider restricted to this workflow.
- `GCP_COLLECTOR_SERVICE_ACCOUNT`: a dedicated service account that can impersonate through that provider and has only Cloud Run invoker access to the staging service.
- `SYNC_TOKEN`: the environment secret matching the application's staging sync token.

Restrict that environment to `master` and do not configure required reviewers, because a reviewer gate would prevent scheduled jobs from running unattended. Keep the deployment identity and required-reviewer rules on the separate `gcp-staging` environment. The collector Workload Identity Federation provider independently checks the repository and owner numeric IDs, repository name, `master` ref, exact workflow path, and the `gcp-staging-collector` environment subject.

The workflow requests a short-lived Google identity token whose audience is `BIPLAN_URL`. The collector sends it in `X-Serverless-Authorization`, which Cloud Run consumes for IAM. It keeps the application's sync token in `Authorization`; the two authentication layers are independent. Neither token is written to artifacts or logs.

Each run restores the canonical private checkpoint before collection, preserves source failures and quarantined records through the existing collector pipeline, imports the successful report, saves a checkpoint, reads it back, and uploads the same bounded evidence artifacts as the existing collector workflow. Collection retains its limit of 100 and 20 discovery pages, with no automatic provider retries. It does not call TypeSafe or Voyage and does not index embeddings. Embedding indexing remains a separate, explicitly authorized operation that should reuse existing vectors.

Before enabling the repository variable, apply and verify the dedicated identity's updated environment subject, complete a successful manual run, and inspect its checkpoint readback and source-health artifacts. Then review the expected collection and storage cost separately before setting `GCP_STAGING_COLLECTION_ENABLED=true`. Leave the variable absent or set to any other value to keep scheduled collection disabled. Enabling it is an operational action outside deployment.

After activation, collect at least 48 hours of successful scheduled staging evidence before public release. Manual runs, merged configuration, and an enabled variable do not by themselves satisfy that gate.
