# GCP staging collector

`Collect GCP staging event data` is a manual-only workflow for the private staging Cloud Run service. It has no schedule until staging soak collection is explicitly approved.

Configure the `gcp-staging` GitHub environment with:

- `BIPLAN_URL`: the service's direct `https://…run.app` URL.
- `GCP_COLLECTOR_WORKLOAD_IDENTITY_PROVIDER`: a collector-specific GitHub Workload Identity Federation provider restricted to this workflow.
- `GCP_COLLECTOR_SERVICE_ACCOUNT`: a dedicated service account that can impersonate through that provider and has only Cloud Run invoker access to the staging service.
- `SYNC_TOKEN`: the environment secret matching the application's staging sync token.

The workflow requests a short-lived Google identity token whose audience is `BIPLAN_URL`. The collector sends it in `X-Serverless-Authorization`, which Cloud Run consumes for IAM. It keeps the application's sync token in `Authorization`; the two authentication layers are independent. Neither token is written to artifacts or logs.

Each manual run restores the canonical private checkpoint before collection, preserves source failures and quarantined records through the existing collector pipeline, imports the successful report, saves a checkpoint, reads it back, and uploads the same bounded evidence artifacts as the existing collector workflow. It does not call TypeSafe or Voyage and does not index embeddings. Embedding indexing remains a separate, explicitly authorized operation that should reuse existing vectors.

Before enabling a schedule, verify the dedicated identity's least-privilege IAM binding, inspect the checkpoint readback and source-health artifacts, and complete the required unattended staging soak.
