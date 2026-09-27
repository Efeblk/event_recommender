# Private GCP staging proposal — September 27, 2026

Status: prepared for review; no project creation, billing link, GCP resource
creation, secret transfer or deployment has been performed. Google CLI sign-in
and read-only account checks succeeded. The integrated browser is unavailable,
so remaining trial credits have not been verified.

## Target and boundaries

Create a new dedicated project, proposed ID `biplan-staging-efeblk` (availability
is not yet confirmed). Use the existing active billing account, whose currency
is TRY. Do not enable billing on the old event prototype or change the unrelated
project already using that account. Production will use a separate project.

| Item | Proposed configuration |
| --- | --- |
| Region | `us-central1`, chosen for storage free-tier eligibility; Istanbul latency still needs measurement |
| Application | Private Cloud Run `biplan-staging`, request-based CPU, minimum 0 / maximum 1 instance, 1 CPU, 1 GiB, concurrency 32, timeout 300 seconds |
| Database | Firestore Native Standard `(default)`, deletion protection, no PITR or scheduled backups |
| Data | Private regional Cloud Storage, immutable source/checkpoint/vector objects, seven-day soft delete |
| Images | Regional Artifact Registry; first deployment uses one reviewed Linux image |
| Secrets | Three existing credentials transferred directly to Secret Manager and pinned to numeric versions |
| Deployment | Separate runtime, deploy and collector identities; GitHub federation restricted to this repository, `master`, protected `gcp-staging`, and exact workflows |
| Budget | Project-filtered TRY 100/month alert; notifications at TRY 50, TRY 100, and forecast TRY 100; default billing IAM recipients |
| Terraform state | Ignored local state for initial provisioning, backed up privately on this PC; move to a separate administrative backend before unattended infrastructure changes |

The budget is an alert, not a spending cap. The instance maximum and application
rate limits also do not cap all charges. No public invocation, scheduled
collection, paid subscription, committed-use purchase, load balancer or Cloud
Build service is included. GitHub Actions builds the container.

## Initial verification scope

Provision the reviewed infrastructure, transfer the three existing secrets,
deploy one private revision, bootstrap one preserved checkpoint and cached vector
profile, then run at most 100 non-AI application probes and one manual collection.
The preserved migration inputs contain 4,595 raw event records across 1,696 source
pages and 1,718 vectors; the two input files total approximately 25 MiB. These are
historical input counts, not claims about today's fresh catalog or vector coverage.
Bootstrap retains their original timestamps, failures, profile and hashes.

This initial scope does not regenerate embeddings or call Jev. Subsequent live AI
evaluation will use a separately recorded, bounded call budget under existing
provider authorization. Keep unattended schedules disabled until private staging
works and its ongoing usage has been reviewed.

## Cost basis and uncertainty

Google requires an active billing account even for free-tier use. Several
allowances are shared with other projects on the same billing account, so a
dedicated project does not provide a fresh allowance for every service. Assume
no trial credits when reviewing this proposal.

| Service | Published free allowance relevant to this profile | Initial usage basis |
| --- | --- | --- |
| Cloud Run | 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests/month for request-based billing | Scales to zero; one private revision and bounded probes; actual startup and request time must be measured |
| Firestore | 1 GiB storage, 50,000 reads and 20,000 writes/day for one free database/project | About 1,700 source heads plus pointers and counters; measure actual SDK operations and transaction retries |
| Cloud Storage | 5 GB-months, 5,000 Class A and 50,000 Class B operations/month in eligible US regions | About 1,700 bootstrap page objects plus audit/checkpoint/vector objects; repeated collection can exceed the monthly operation allowance |
| Artifact Registry | 0.5 GiB-month across the billing account | Compressed image size is not yet measured; retained images can exceed this allowance |
| Secret Manager | 6 active versions and 10,000 accesses/month across the billing account | 3 versions; accesses grow with container starts |

For scale only, two billed Cloud Run hours at 1 CPU and 1 GiB would cost about
USD 0.19 before free allowances, using Google's published USD request-based
rates. This is an illustrative compute calculation, not a total-cost estimate
or an enforced two-hour limit. Storage, database operations, registry, network,
tax and provider usage are separate. The TRY account is billed using Google's
TRY SKUs, not a currency conversion promised here. Zero cost cannot be guaranteed.

Official sources checked September 27, 2026:

- [Free-tier conditions](https://docs.cloud.google.com/free/docs/free-cloud-features)
- [Cloud Run pricing](https://cloud.google.com/run/pricing)
- [Firestore pricing](https://cloud.google.com/firestore/pricing)
- [Cloud Storage pricing](https://cloud.google.com/storage/pricing)
- [Artifact Registry pricing](https://cloud.google.com/artifact-registry/pricing)
- [Secret Manager pricing](https://cloud.google.com/secret-manager/pricing)

## Execution and evidence

Land the reviewed GCP workflows on the default branch and verify CI on the exact
deployment revision. Create the protected GitHub environment before federated
access. After authorization, create the dedicated project and billing link,
verify both, save and inspect the real Terraform plan, and apply only if it
matches this resource scope. The current six mocked plan tests do not establish
cloud permissions or account quotas.

Use the isolated Google CLI identity explicitly for provisioning; do not reuse
this PC's older default application credentials. Keep tokens out of output and
Terraform variables/state. Verify private IAM denial, authenticated health,
bootstrap readback, catalog/vector coverage, rate limits and collection results.
Record exact revision, image digest, input hashes, calls and limitations.

Deployment alone is not public readiness. Recovery drills, capacity and latency
measurements, live source-evidence checks, independent monitoring and at least
48 hours of unattended evidence remain release gates.
