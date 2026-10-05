# GCP deployment

The [product plan](product-plan-v1.md) defines current scope and release checks.
Use [the v1 architecture](architecture.md) for the current data flow.
PostgreSQL cutover is outside v1. Cloudflare runtime files and workflows are removed.

GCP staging was first deployed on September 27, 2026. After Google sign-in and
explicit approval of the private staging proposal, the dedicated staging
foundation was provisioned with a TRY 100 budget alert, and one private
application revision was deployed, bootstrapped, and verified. See the
[September 27 execution evidence](archive/gcp-staging-execution-2026-09-27.md). This
private staging execution is not a public launch. These records describe
historical checks. They do not establish current readiness.

The [September 27 validation record](archive/gcp-staging-validation-2026-09-27.md)
records the subsequent embedding completion, live recommendation/source review,
rollback, full isolated restore, bounded capacity checks and remaining gates.
The subsequent [catalog coverage record](archive/catalog-coverage-2026-09-28.md)
tracks the expanded provider inventory, conservative offer merging, source
quarantines and current embedding/publication evidence. Earlier complete-vector
counts do not establish coverage of the enlarged catalog.

## Current v1 architecture

The table and procedures below describe the snapshot/Firestore system used by v1.
The [earlier PostgreSQL design](archive/catalog-enrichment-architecture.md)
remains archived. Do not start that migration as part of v1.

The separately approved [September 30 PostgreSQL staging evidence](archive/gcp-postgres-staging-validation-2026-09-30.md)
records the provisioned database, frozen import, preparation/export Jobs and recovery
tests. It does not change the v1 snapshot deployment. That Cloud SQL instance,
its secrets and preparation identity were deleted on 2026-10-05
(`postgres_staging_enabled = false`); recreating it requires new approval.

| Component | Service | Stored data |
| --- | --- | --- |
| Node application | Cloud Run | Stateless Vinext standalone container |
| Coordination | Firestore Native | Published snapshot pointers, source heads, leases and rate counters |
| Private data | Cloud Storage | Immutable source pages, canonical checkpoints and embedding snapshots |
| Credentials | Secret Manager | Sync token, TypeSafe Jev key and Voyage key |
| Images and deployment | Artifact Registry, GitHub Actions | Reviewed container images and deployment provenance |

The catalog remains fully searchable. A request resolves the published pointer
and reuses its immutable in-memory catalog/vector snapshot; the shortlist remains
at most 16 distinct candidates for Jev. The number of Firestore reads does not
grow with the number of events on each recommendation request. Google hosting
does not replace Jev or Voyage: their keys are required for the intended AI path,
and provider charges remain separate.

Imports stage each successfully refreshed source independently. Publication
writes a complete checkpoint, then switches the Firestore pointer in a
transaction guarded by a live lease and the previous revision. Readers cannot
see a partly uploaded publication. Failed sources remain distinguishable through
the original report and their original checked times. Stale imports cannot
overwrite newer source heads. Objects include content hashes; inconsistent or
missing catalog objects fail closed. There is no automatic seed catalog on GCP.

Voyage caches retain their exact endpoint, model, dimension, document profile and
document hash. A changed key alone does not invalidate vectors. Each indexing
batch publishes a whole immutable vector snapshot; this is suitable for the
current catalog but must be measured before growing the index. Catalogs are
bounded at 32 MiB/20,000 records, vector objects at 128 MiB/20,000 entries.

## Prepare and review

Use Node from `web/.nvmrc` (22.13 or newer). The Dockerfile pins Node 22.23.3.

```sh
cd web
npm ci
npm test
npm run typecheck
npm run lint
npm run test:deploy-config
npm run test:deploy:gcp
npm run build:node
npm run test:smoke:node
docker build -f Dockerfile -t biplan-gcp-local ..
```

`build:node` copies source into an isolated temporary directory and writes only
`web/dist-node`. It excludes local credentials. `npm run build` is an alias for
that Node build. Node smoke verifies compiled startup, UI, authorization
and missing-storage behavior; it does not claim a real GCP integration test.

Review [the infrastructure definition](../infra/gcp/README.md), its plan, the
selected project and billing account after sign-in. Use a dedicated Bi' Plan
staging project and separate production resources. Do not reuse the unrelated
project configured in this PC's old gcloud session. Never run `terraform apply`
as part of a read-only account check. No resource activation or spending has
been authorized by preparing these files.

The manual **Deploy GCP staging** workflow builds and checks a candidate before
entering the protected `gcp-staging` GitHub environment. The product plan permits
staging deploys and approval of that gate. Workload Identity Federation replaces
downloaded service-account keys. Supply the infrastructure outputs as environment
variables. The collector uses the separate reviewer-free, `master`-restricted
`gcp-staging-collector` environment described below; keep runtime, deployment and
collection identities separate. Secret
Manager resources initially contain no versions; transfer existing ignored local
credentials securely after account setup and pin their numeric versions for
deployment. Do not print secret values, place them in Terraform variables/state,
or pass them as Docker build arguments.

The deployment workflow is staging-only, manual, and authenticated. It does not
enable APIs, create infrastructure, grant public invoker access or publish on
push. Check the exact candidate's CI and container digest. Initial health can
succeed with an empty database; readiness must remain false until bootstrap and
checkpoint publication complete.

## Bootstrap and collection

Use the latest preserved collector checkpoint and its original report. Dry-run
the migration tool first; see `web/scripts/gcp-bootstrap.mjs`. Preserve the raw
input and its SHA-256. Import cached Voyage vectors with their exact profile and
document hashes; do not call the embedding provider to regenerate unchanged
documents. Do not invent a fresh report timestamp for old data. A bootstrap may
correctly remain unready when its source data is stale.

The legacy in-request `/api/admin/sync` returns 410 on GCP after authorization.
Use the durable multi-provider collector pipeline: source imports followed by
explicit `/api/admin/collection` publication. See [private GCP collection](gcp-collector.md) for the gated
collector workflow. Cloud Run IAM uses `X-Serverless-Authorization`; the separate
application sync token uses `Authorization`.

The six-hour collector schedule remains disabled unless the repository variable
`GCP_STAGING_COLLECTION_ENABLED` is exactly `true` and
`GCP_STAGING_COLLECTION_UNTIL` is a valid future canonical UTC timestamp no more
than 60 hours away, or the literal `open` (scheduled collection without an
expiry; collection makes no paid calls, and indexing keeps its own window).
Missing, malformed, expired, and overly distant deadlines fail closed; manual dispatch remains available without these variables. After a
successful manual run, IAM verification, and cost review, set the deadline first
and enable the schedule deliberately. See [private GCP collection](gcp-collector.md)
for activation and the stop procedure. Phase 2 requires an hourly readiness
monitor and seven days of scheduled collection. Historical monitoring checks
do not prove that acceptance condition. Keep the schedule active unless a
specific maintenance task requires a pause. Record and restore any pause.

## Cost and abuse controls

The deployed private staging profile uses request-based CPU, zero minimum instances,
one maximum instance per revision, one CPU, 2 GiB memory and concurrency 32
(raised from 1 GiB on 2026-10-03 after a cold search load of the
14,928-listing catalog used 1,104 MiB). This
revision setting is not a service-wide hard spending cap. The default AI
cap is 100 recommendation requests per day, shared across instances, with the
existing burst and rolling user limits enforced transactionally in Firestore.
IAM keeps staging private. `BIPLAN_CLIENT_IP_MODE=shared` deliberately puts
anonymous requests in one conservative bucket until direct Cloud Run header
behavior is qualified. Before public release, test forged `X-Forwarded-For` and
`CF-Connecting-IP` values against the deployed direct `run.app` endpoint, then
enable `cloud-run-direct` only for that topology. A load balancer, CDN or other
proxy requires a fresh trust analysis. IP limits are not authenticated user quotas.

Use the free-tier eligible `us-central1` default for the demo only after checking
latency from Istanbul. A European region may improve latency but changes storage
free-tier eligibility. Google requires an active billing account for free-tier
usage. Cloud Run can scale to zero, but Firestore operations, retained objects,
registry storage, builds, secret access and network traffic may incur charges.
Whole-profile vector rewrites and per-source snapshot writes also consume storage
operations. Free allowances do not guarantee a zero bill. See Google's
[free-tier conditions](https://docs.cloud.google.com/free/docs/free-cloud-features)
and [Cloud Run pricing](https://cloud.google.com/run/pricing).

Budget alerts are notifications, not a hard spending cap. Maximum instance count
also does not cap total request/storage/provider costs. Do not enable paid
features, purchase a plan or promise a fixed bill without reviewing the concrete
account and usage estimate with the user. Backups/PITR and Firestore TTL deletion
are not assumed free or enabled implicitly.

Old immutable objects and expired rate counters require bounded maintenance.
Do not apply a blanket object-age deletion rule: a failed source may still point
to an old live object. Prune only objects proven unreferenced by all retained
catalog/source/vector heads, with a recovery window. Storage growth and this
maintenance policy are production gates.

## Release checks

Use the phase acceptance checks in [the product plan](product-plan-v1.md).
Phase 0 needs green CI on `master`, a successful staging deploy and collection,
HTTP 200 from `/api/ready`, and user acceptance of the short `AGENTS.md`.
Phase 1 measures retrieval against a fixed test set. Phase 2 requires seven days
of collection and monitoring. Phase 3 needs the user's choice of private beta
access and URL. Public access needs separate user approval.

The [old launch checklist](archive/launch-checklist.md) is historical reference.
Its unrelated capacity and PostgreSQL work does not block the v1 test link.
Keep the original checkpoint and previous image digest for recovery.

The initial SDK install includes the Storage SDK's transitive `gaxios -> uuid`
moderate advisory GHSA-w5hq-g745-h8pq. Our storage path does not call the affected
UUID variants with caller-provided buffers. Track the upstream fix; do not force
a potentially incompatible major transitive override just to suppress the audit.

## Recovery

1. See the failure: the hourly `monitor` job in `Collect GCP staging event data`
   fails and GitHub sends an email. Open the run; the error line names the cause.
2. Find the last good SHA: `gh run list --workflow gcp-staging.yml --status success --limit 1 --json headSha`.
3. Deploy it: `gh workflow run gcp-staging.yml -f expected_sha=<SHA> -f input_interpreter=span-v2`, then approve the `gcp-staging` gate.
4. Collect: `gh workflow run gcp-collector.yml` and wait for success.
5. Check: `curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" <BIPLAN_URL>/api/ready` returns 200 with `"ready":true`.
