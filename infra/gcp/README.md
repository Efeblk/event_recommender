# GCP staging infrastructure

This Terraform configuration prepares the GCP side of the migration. It has not been applied. It creates no project, billing association, Cloud Run service, secret values, service-account keys, or public endpoint. The GitHub deployment workflow owns Cloud Run revisions; Terraform owns the surrounding resources and identity permissions.

Use an **existing, billing-linked project dedicated to Bi Plan staging**. Set `project_id` explicitly, inspect that project's existing resources and billing association, then set `dedicated_billing_project_confirmed = true`. The plan also reads the project and rejects an absent billing association. A project with an unrelated `(default)` Firestore database or application resources is unsuitable. Do not import or repurpose those resources to make this plan succeed.

## Prepared resources

| Resource | Configuration |
| --- | --- |
| Firestore | Native Standard `(default)` database; same region as the app; deletion protection; pessimistic server transactions |
| GCS | Private Standard bucket; uniform bucket access; public access prevention; seven-day soft delete; no automatic object expiry; destruction protected |
| Artifact Registry | Regional Docker repository; retain at least three recent versions per package; delete untagged versions older than seven days |
| Secret Manager | Three secret names only: sync token, TypeSafe key, Voyage key |
| Runtime identity | Firestore data access; bucket object read/create; access to those three secrets |
| Deployment identity | Registry write; Cloud Run developer and invoker; service IAM read/update; permission to run as the runtime identity |
| Collector identity | Cloud Run invocation only; no direct database, bucket, secret, or deployment permission |
| GitHub federation | Separate deployment and collector pools; repository and owner numeric IDs, repository name, staging environment, exact branch and workflow checks |
| Optional budget | Project-filtered monthly alert; defaults to USD 5 when an existing billing account is explicitly supplied |

The default region is `us-central1`. Firestore, the bucket, registry, and Cloud Run output all share that region. Choose the region before creation: changing a database location is a migration. Staging and production should use separate dedicated projects and state; these files deliberately prepare staging only.

No lifecycle deletion rule is attached to GCS. A source head may still reference an old successful page after repeated collection failures. Deleting objects by age alone could break recovery. Future garbage collection must verify all live catalog, vector, and source references first. Seven-day soft delete can incur retention storage charges after an authorized deletion. Database PITR, scheduled backups, and Firestore TTL deletion are not enabled by this free-first preparation; their recovery/cost implications need a deliberate launch decision.

The registry cleanup keeps at least three versions, not exactly three. Tagged commit images remain until an explicit retention decision removes their tags or versions. Storage and indexing traffic can accumulate: vector publication currently rewrites a whole immutable profile snapshot per indexing batch, and collection publication reads the durable source pages. Budget alerts do **not** stop spending or guarantee a free bill.

## Identity boundaries

The runtime cannot delete or overwrite GCS objects. Its create-only permission matches immutable uploads. It has no Cloud Run administration rights. Secret values are loaded by Cloud Run using the runtime identity; Terraform never receives them.

`roles/run.developer` covers deployment. A separate custom role supplies only `run.services.getIamPolicy` and `run.services.setIamPolicy`, which the workflow needs for `--no-allow-unauthenticated`. These permissions can modify service invocation policies, so the deployment identity must remain restricted to the reviewed workflow. Cloud Run deployment and invocation bindings are project-scoped because the service does not exist until the first workflow run. This is another reason the project must be dedicated to staging. There is no project Owner, Editor, Run Admin, broad Secret Accessor, or service-account Token Creator grant.

The collector and deployment workflows have separate federation pools. A valid collector token therefore cannot acquire the deployment identity through a shared repository principal. Both require GitHub environment `gcp-staging`, the selected branch, and their exact workflow path. Repository ID `1107941471` and owner ID `108200358` were read from GitHub for `Efeblk/event_recommender` on 2026-09-27. Reverify IDs when changing repository ownership or configuration.

Configure the GitHub environment's reviewers and deployment-branch restrictions before use. Terraform checks OIDC claims; it cannot establish or verify GitHub environment protection settings. The trusted branch defaults to `master`, the repository's default branch verified through the GitHub API on 2026-09-27. A first deployment from `t3code/gcp-migration` requires an explicit reviewed variable override and matching GitHub environment restrictions. No wildcard branch trust is used.

## Local validation without GCP sign-in

Requires Terraform 1.7 or newer, below 2.0. The Google provider is pinned to `8.4.0`, and its dependency lock file is committed. Initialization downloads the signed provider; mocked tests make no GCP calls.

```powershell
terraform -chdir=infra/gcp init -backend=false
terraform -chdir=infra/gcp fmt -check -recursive
terraform -chdir=infra/gcp validate
terraform -chdir=infra/gcp test
```

The tests exercise a private staging plan, identity restrictions, optional budget configuration, rejection of an unconfirmed project, and rejection of a mismatched billing account. A successful mocked plan validates configuration logic; it is not evidence that an account permits creation or that the cloud application works.

## After project selection and an authorized provisioning step

1. Verify the dedicated project, existing billing association, region, repository IDs, and protected GitHub environment. Copy `terraform.tfvars.example` to ignored `terraform.tfvars` and provide the actual project ID. Do not place credentials or secret values in this file.
2. Choose protected Terraform state storage and an administrative provisioning identity. The default is local state for preparation. Do not put Terraform state in the application's bucket: its runtime can read that bucket. A separate administrative state bucket/backend can be configured before the first apply. Preserve state securely; do not commit state or plans.
3. With appropriate administrator credentials, create and review a saved plan. Confirm it touches only the chosen project's new Bi Plan staging resources. Provisioning and any resulting charges require a separately authorized apply; none has been performed here.
4. Populate the three Secret Manager secret versions through an approved protected channel. This configuration contains only their names; a deployment cannot start successfully until the needed versions exist. Set the protected GitHub environment variables `GCP_SYNC_TOKEN_SECRET_VERSION`, `GCP_TYPESAFE_API_KEY_SECRET_VERSION`, and `GCP_VOYAGE_API_KEY_SECRET_VERSION` to the resulting positive numeric versions. The workflow pins these versions and rejects `latest`. They cannot be Terraform outputs because Terraform deliberately creates no secret versions or values.
5. Copy `terraform output -json github_environment_variables` values into the protected GitHub `gcp-staging` environment variables. It maps the non-secret resource names consumed by `.github/workflows/gcp-staging.yml` and `.github/workflows/gcp-collector.yml`, including separate collector identity/provider values; add the three secret-version variables from the preceding step separately. Configure the collector's existing application sync-token secret through the protected environment as described in its workflow documentation; do not put it in repository variables.
6. An authorized deployment workflow creates a private Cloud Run service with zero minimum instances, one maximum instance, 1 CPU, 1 GiB memory, and a 300-second request timeout. Infrastructure provisioning alone does not deploy or publish the app.

The collector workflow can then invoke the private service with its audience-bound identity token plus the application sync token. Verify federation, private health, import/checkpoint readback, current catalog/vector coverage, rate limits across instances, recovery, and the required unattended monitoring period in staging. Existing release gates still apply; neither Terraform validation nor a green deployment health probe establishes production readiness.

## Official references checked for this configuration

- [Google provider 8.4.0 release](https://github.com/hashicorp/terraform-provider-google/releases/tag/v8.4.0)
- [Firestore database resource](https://registry.terraform.io/providers/hashicorp/google/8.4.0/docs/resources/firestore_database)
- [GCS bucket resource](https://registry.terraform.io/providers/hashicorp/google/8.4.0/docs/resources/storage_bucket)
- [Artifact Registry cleanup policies](https://registry.terraform.io/providers/hashicorp/google/8.4.0/docs/resources/artifact_registry_repository)
- [Workload Identity Federation provider](https://registry.terraform.io/providers/hashicorp/google/8.4.0/docs/resources/iam_workload_identity_pool_provider)
- [Cloud Run IAM roles](https://docs.cloud.google.com/run/docs/reference/iam/roles)
- [Billing budget resource](https://registry.terraform.io/providers/hashicorp/google/8.4.0/docs/resources/billing_budget)
