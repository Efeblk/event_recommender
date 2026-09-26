# GCP deployment

GCP is the selected target as of September 27, 2026. This migration is prepared
locally; it has not created resources or deployed to Google Cloud. Google sign-in
was deferred at the user's request. The existing Cloudflare staging deployment
is retained for comparison and recovery.

## Architecture

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
bounded at 20 MiB/20,000 records, vector objects at 128 MiB/20,000 entries.

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
docker build -t biplan-gcp-local .
```

`build:node` copies source into an isolated temporary directory and writes only
`web/dist-node`. It excludes local credentials. It does not compete with the
Cloudflare build output. `npm run build` and the existing D1/R2 smoke test continue
to verify that fallback. Node smoke verifies compiled startup, UI, authorization
and missing-storage behavior; it does not claim a real GCP integration test.

Review [the infrastructure definition](../infra/gcp/README.md), its plan, the
selected project and billing account after sign-in. Use a dedicated Bi' Plan
staging project and separate production resources. Do not reuse the unrelated
project configured in this PC's old gcloud session. Never run `terraform apply`
as part of a read-only account check. No resource activation or spending has
been authorized by preparing these files.

The manual **Deploy GCP staging** workflow builds and checks a candidate before
entering the protected `gcp-staging` GitHub environment. Configure required
reviewers on that environment before use. Workload Identity Federation replaces
downloaded service-account keys. Supply the infrastructure outputs as environment
variables. Keep runtime, deployment and collection identities separate. Secret
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
explicit `/api/admin/collection` publication. The Cloudflare fallback retains
its legacy route. See [private GCP collection](gcp-collector.md) for the manual
collector workflow. Cloud Run IAM uses `X-Serverless-Authorization`; the separate
application sync token uses `Authorization`.

No unattended schedule is enabled initially. After staging works, enable the
approved schedule and independent monitoring deliberately, then collect 48 hours
of evidence. An external free monitor cannot query a private IAM endpoint without
an authentication bridge; the old Cloudflare monitor is not evidence of GCP
uptime. Choose and verify that bridge before relying on external outage alerts.

## Cost and abuse controls

The proposed staging profile uses request-based CPU, zero minimum instances,
one maximum instance, one CPU, 1 GiB memory and concurrency 32. The default AI
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

## Release gates

Before public release, record actual GCP deployment identity, catalog/vector
coverage, source-evidence review of every returned card, live Turkish/English
quality, provider failure behavior, authenticated recovery/rollback and measured
memory/latency under load. Exercise loss of a referenced object, a stale lease,
and restoration into an isolated project/bucket. Keep the original checkpoint
and previous image digest. Local timings and fake SDK tests are not Cloud Run
capacity or IAM evidence. Complete [the launch checklist](launch-checklist.md).

The initial SDK install includes the Storage SDK's transitive `gaxios -> uuid`
moderate advisory GHSA-w5hq-g745-h8pq. Our storage path does not call the affected
UUID variants with caller-provided buffers. Track the upstream fix; do not force
a potentially incompatible major transitive override just to suppress the audit.
