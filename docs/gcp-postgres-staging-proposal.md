# GCP PostgreSQL staging proposal

Status: **bounded staging bundle approved by the user on 2026-09-30; authorization reference: `user-approval-2026-09-30-gcp-postgres-staging-bundle`**. The [machine-checkable plan](../web/deploy/gcp-postgres-staging-plan.json) records this authorization. It covers only the named staging bundle and caps below, with no production/public rollout or new paid inference. Local `gcloud` credentials currently require interactive reauthentication, so live project drift, billing, quotas, IAM, and name availability must be read back before any apply. The existing authorization covers the private Cloud Run/Firestore/Storage foundation, three application secrets, and its TRY 100 alert.

The requested decision is one bounded staging activation bundle, not a chain of routine approvals. Approval covers the instance/database/extensions/roles, preparation service account, two password secret containers and secure value generation/transfer, verified frozen import with cached vectors, updates to the existing private and preview staging services, bounded preparation Jobs, authenticated integration/capacity/interruption checks, isolated restore for at most two hours, database cutover, and rollback drills. Its ongoing estimate is USD 10–12/month, with at most USD 3 of additional one-time cloud validation usage and zero new paid-provider calls. Once approved, these in-scope steps proceed without asking again.

Additional concrete authorization is required only to expand this scope: public or production publication; new paid-provider calls or a provider budget extension; `db-g1-small` or another tier, HA, replica, or another long-lived instance; storage above 10 GiB or automatic growth; PITR or backup retention beyond seven; an isolated restore beyond two hours; one-time validation usage above USD 3; or a revised ongoing estimate above USD 12/month.

## Proposed bounded staging resource

Create one `biplan-staging-catalog-pg17` Cloud SQL Enterprise PostgreSQL 17 instance in the existing dedicated `biplan-staging-efeblk` project and `us-central1`. Use the zonal `db-f1-micro` shared-core development tier, 10 GiB SSD, no HA, and deletion protection. Shared-core instances have no Cloud SQL SLA and are for development/testing; this proposal makes no production sizing or availability claim.

Disable automatic storage growth, leaving a reviewed 10 GiB capacity ceiling. This prevents an ingestion defect from silently increasing provisioned storage cost, but the instance can reject writes or go offline when full. Add storage-usage alerting before import and stop preparation well before exhaustion. Storage cannot be assumed shrinkable during incident response.

Enable standard automated backups with seven retained backups. Keep point-in-time recovery explicitly off for this bounded staging phase. The bundle includes one isolated same-tier restore for at most two hours within its USD 3 one-time validation cap. Choose a low-traffic maintenance window before apply.

Use the instance's public IP only as transport for the authenticated Cloud SQL connector. Configure no authorized networks and no direct database exposure. Attach `biplan-staging-catalog-pg17` to the private Cloud Run service and connect through its `/cloudsql` Unix socket. Grant `roles/cloudsql.client` only to the existing runtime identity and the proposed bounded preparation-job identity. This avoids a Serverless VPC Access connector, private-service-access allocation, and their additional fixed/operational cost for staging. It does not make the service public: Cloud Run IAM remains private and database authentication is still required.

The exact proposed names are:

| Resource | Name |
| --- | --- |
| Instance | `biplan-staging-catalog-pg17` |
| Database/schema | `biplan_catalog` / `biplan` |
| Runtime password secret | `biplan-staging-db-runtime-password` |
| Preparation password secret | `biplan-staging-db-preparation-password` |
| Existing runtime service account | `biplan-staging-runtime@biplan-staging-efeblk.iam.gserviceaccount.com` |
| Proposed preparation service account | `biplan-staging-preparation@biplan-staging-efeblk.iam.gserviceaccount.com` |

Secret Manager contains the two generated database passwords in separate secrets. Secret values must never enter Terraform variables/state, command output, GitHub variables, images, logs, or chat. Runtime may access only its password; preparation may access only its password. Pin numeric secret versions in deployments.

The source-ingestion Job may read exact objects under `staging/preparation/sources/` in the existing private staging bucket. Its conditional object-viewer binding grants no bucket listing or writes; it receives no runtime AI secrets or Firestore access. Each source artifact must be created without overwrite, retained through publication/rollback, and verified by generation and SHA-256 before any database call. This follows [Cloud Storage's object-prefix IAM conditions](https://docs.cloud.google.com/storage/docs/access-control/iam#conditions). The operator uploader and offline manifest renderer are described in the [preparation README](../collector/preparation/README.md#portable-source-ingestion); managed transfer/execution remain separate acceptance steps. Preparing these tools or this binding does not activate a Job.

## Database ownership and privileges

An administrator installs `postgis`, `vector`, and `pg_trgm`, creates the database/schema, and runs reviewed migrations. Applications never use the built-in `postgres` account. Use a `NOLOGIN` `biplan_owner` owner, `NOLOGIN` `biplan_reader` and `biplan_prepare` roles, and two `NOSUPERUSER NOCREATEDB NOCREATEROLE` logins: `biplan_web` inherits only read privileges; `biplan_preparer` inherits the preparation privileges needed by the approved migrations and job procedures.

Revoke public database/schema creation and default public function execution. Give the reader connect, schema usage, selected table/view reads, and execution only on explicitly reviewed read functions. Give preparation narrowly enumerated table/sequence/function privileges. Do not grant ownership, extension administration, role creation, database creation, broad `ALL`, or arbitrary schema creation to either login. Apply matching default privileges for future objects. Review every `SECURITY DEFINER` function in the preparation SQL: pin a safe `search_path`, schema-qualify referenced objects, revoke public execution, grant only the intended role, and ensure callers cannot replace referenced functions or operators.

The separate installation administrator must be able to inherit and set the `biplan_owner` role to transfer schema/object ownership and replay later reviewed migrations. This membership is administrative, never granted to either application login. Schema transfer temporarily requires the target owner to have database `CREATE`; the role installation transaction revokes it before committing. An existing owner created by another administrator requires explicit reviewed role-administration authority; do not bypass that failure through Cloud SQL system roles. `catalog:verify:managed-admin` exercises installation/replay with a local non-superuser database owner. Extensions are preinstalled separately in that fixture, so it does not prove managed extension privileges or Cloud SQL IAM.

Keep the request pool at two connections, with a 30-second idle timeout and a 5-second statement timeout. Keep the preparation pool at two, job parallelism at one, and Cloud Run at zero minimum/one maximum instance. A preparation Job gets no automatic retries and a 30-second database statement timeout unless a specific migration needs a reviewed exception. Never hold a transaction across Voyage, Jev, provider HTTP, or object-storage calls.

## Estimated incremental cost

Google's current `us-central1` list prices show `db-f1-micro` at USD 0.0105/hour, SSD at USD 0.000232877/GiB-hour, and used backup storage at USD 0.000109589/GiB-hour. At 730 hours, compute is about USD 7.67/month, 10 GiB SSD about USD 1.70/month, and 10 GiB average used backup storage about USD 0.80/month. Budget **USD 10–12/month** for this bounded instance before tax, network egress, restore drills, and exceptional usage. This is an estimate, not a quote or spending cap. Google bills account-currency SKUs; no invented TRY conversion is provided. See [Cloud SQL pricing](https://cloud.google.com/sql/pricing), [shared-core limitations](https://docs.cloud.google.com/sql/docs/postgres/machine-series-overview), and [supported extensions](https://docs.cloud.google.com/sql/docs/postgres/extensions).

The existing project-filtered TRY 100 alert stays unchanged. It is notification only and does not stop spending. Before approval, read back the billing account currency, actual alert, current spend/quotas, and whether the estimate can cross the alert. Do not weaken or silently replace that alert.

If representative import or query tests demonstrate that 0.614 GB is insufficient, stop. Record the failure, working set, concurrency, p50/p95 latency, and projected `db-g1-small` cost, then request authorization for that scope expansion before resizing. The bundle does not include an upsize or HA.

## Staged migration and rollback

First replay schema and migrations on disposable local PostgreSQL 17, including clean install, idempotent rerun, privilege-denial tests, lease/fencing interruption, and rollback fixtures. Validate all 7,719 frozen sessions, 10,024 offers, publication pins, content/dependency hashes, known identity families, lexical coverage, exact-vector baseline, and final selected-offer revalidation. Reuse compatible cached Voyage vectors; this proposal authorizes zero new AI calls.

After bundle approval and provisioning, create extensions and roles through an administrative migration step, import the verified frozen base in bounded batches, verify immutable object references before database commits, and run the full comparison before activating any database-backed publication. Then test the managed adapter on a private staging candidate with exact revision/digest, authenticated health/readiness, pool exhaustion, restart, interrupted Job, stale completion, and rollback evidence. Cut over the private/preview staging service only after those checks pass; cutover and rollback drills are included in the bundle.

Keep the current Firestore coordination, private GCS snapshots, previous publication, and previous immutable Cloud Run image operational throughout the experiment. Rollback switches traffic to that tested image and its compatible Firestore/GCS publication; it does not depend on a partly imported Cloud SQL database. Do not delete or mutate preserved source evidence during import. No public rollout follows automatically.

## Read-only preflight and separately approved execution

After interactive reauthentication, the preflight is read-only: verify active account and explicit project, billing association/currency, enabled APIs, service/traffic/digest, IAM bindings, existing resource-name collisions, quotas, current budget alert, storage/Firestore health, and absence or exact state of any SQL instance. Save a non-secret plan and require review. Never rely on the unrelated default CLI project.

The following is the proposed operator sequence after reauthentication. The first block is read-only. It prints identities and configuration, never secret payloads:

```powershell
$project = 'biplan-staging-efeblk'
$region = 'us-central1'
$instance = 'biplan-staging-catalog-pg17'
gcloud projects describe $project --format=json
gcloud billing projects describe $project --format=json
gcloud services list --enabled --project=$project --format=json
gcloud run services describe biplan-staging --project=$project --region=$region --format=json
gcloud sql instances list --project=$project --format=json
gcloud sql instances describe $instance --project=$project --format=json
gcloud secrets list --project=$project --format='value(name)'
gcloud projects get-iam-policy $project --format=json
```

An absent instance makes the final describe return not-found; that is expected inventory evidence, not permission to create it. Budget readback uses the billing-account-scoped Budgets API only after confirming the project's actual billing account and must redact billing/contact identifiers from shared receipts.

The Terraform implementation is deliberately inert by default. `postgres_staging_enabled` defaults to `false`, so it does not enable the SQL Admin API or create a database, service account, secret container, or IAM binding. After the single activation bundle is approved, an operator records a non-secret reference to that approval in `postgres_activation_authorization_reference` and sets `postgres_staging_enabled=true`. Terraform rejects an enabled configuration without that reference. This is an audit link to the approval already given, not another per-step permission gate.

Once the bundle is approved, an authorized administrator generates a saved plan and inspects it before any mutation:

```powershell
terraform -chdir=infra/gcp init
terraform -chdir=infra/gcp fmt -check -recursive
terraform -chdir=infra/gcp validate
terraform -chdir=infra/gcp test
terraform -chdir=infra/gcp plan -var='postgres_staging_enabled=true' -var='postgres_activation_authorization_reference=USER_APPROVAL_REFERENCE' -out=gcp-postgres-staging.tfplan
terraform -chdir=infra/gcp show -json gcp-postgres-staging.tfplan
# Provisioning command: do not run before approval of the activation bundle.
terraform -chdir=infra/gcp apply gcp-postgres-staging.tfplan
```

The optional Terraform resources contain only the named SQL instance/database, preparation identity, two empty secret containers, and least-privilege Cloud SQL/secret bindings. Terraform does not create secret versions or database passwords, roles, extensions, migrations, Cloud Run revisions, or Jobs. Those remain protected migration and deployment workflow steps within the same approved bundle. The saved plan must not replace existing Firestore, bucket, service, image, IAM boundary, budget, or public policy; any such replacement invalidates the plan.

The SQL Admin API is included only when the opt-in is enabled. Secret values are generated and transferred through a protected channel outside Terraform state. Cloud Run attachment and bounded preparation Job deployment remain workflow-owned. The single activation request enumerates the exact bundle and cost caps above; after approval, provisioning, secure secret population, deployment, import, cutover, restore, and rollback testing are ordinary execution steps within that authorization.

Imperative resource-creation commands such as `gcloud sql instances create`, `gcloud secrets create`, Cloud Run deploy/update, SQL role/schema execution, and Job execution are intentionally absent. The shown Terraform apply command is inert documentation and may consume only the exact saved plan after approval; generate that plan from reviewed infrastructure code instead of copying unaudited creation commands from documentation.
