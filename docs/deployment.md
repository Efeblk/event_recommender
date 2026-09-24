# Cloudflare deployment

The web application deploys as a Cloudflare Worker with D1 (`DB`) and R2
(`COLLECTION_STATE`) bindings. Staging and production use separate Cloudflare
resources and separate protected GitHub environments. Deployment is manual;
pushes and pull requests never publish the Worker.

## One-time setup

Create a Worker, D1 database, and R2 bucket for each environment. In the matching
GitHub environment (`staging` or `production`), define these variables:

| Name                    | Value                                                         |
| ----------------------- | ------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID` | 32-character Cloudflare account ID                            |
| `CF_WORKER_NAME`        | Worker name containing `staging` or `production`              |
| `CF_D1_DATABASE_NAME`   | D1 name containing `staging` or `production`                  |
| `CF_D1_DATABASE_ID`     | D1 database UUID                                              |
| `CF_R2_BUCKET_NAME`     | R2 name containing `staging` or `production`                  |
| `CF_PUBLIC_URL`         | HTTPS Worker or custom-domain origin, with no path            |
| `TYPESAFE_MODEL`        | Optional Jev model; defaults to `jev-1.13.0`                  |
| `VOYAGE_MODEL`          | Optional Voyage model; defaults to `voyage-4-large`           |
| `VOYAGE_DIMENSIONS`     | Voyage vector size: 256, 512, 1024, or 2048; defaults to 1024 |
| `AI_DAILY_LIMIT`        | Shared recommendation-request cap (1–10000); defaults to 100  |
| `WORKERS_PLAN`          | `free` (default) or `paid`; controls the Worker CPU allowance |

Add `CLOUDFLARE_API_TOKEN` and `SYNC_TOKEN` as environment secrets. Add
`TYPESAFE_API_KEY` as an optional environment secret to enable Jev ranking, and
`VOYAGE_API_KEY` as an optional environment secret to enable semantic queries.
Without either provider the Worker uses the deterministic recommendation fallback. The API
token needs the least privileges sufficient to deploy Workers, apply D1
migrations, and bind/read/write the selected R2 bucket. Protect production with
required reviewers. Keep credentials in environment secrets. Resource IDs are
non-secret but are supplied as environment variables so each deployment is explicit.
Set `BIPLAN_URL` to the same origin as `CF_PUBLIC_URL` for collection and monitoring.
For a `workers.dev` origin, its hostname must begin with the exact Worker name.

## Validate locally

Use Node from `web/.nvmrc`, export the six non-secret variables above, and run:

```sh
cd web
DEPLOY_TARGET=staging npm run build
npm run deploy:config -- --env staging
npm run deploy:dry-run -- --env staging
```

These commands create `dist/server/wrangler.staging.json` beside the built
artifact so Wrangler's relative entry-point and asset paths remain valid. The
generated file is ignored local state and contains non-secret account resource IDs,
the Jev and Voyage models, Voyage dimensions, and the daily limit. It is included in the deployment artifact,
never with API keys or the sync secret.
Dry-run compiles and validates without contacting the
deployment API. `npm run local:start` remains the persistent local D1 path, and
ordinary Vite development retains the optional Sites preview integration.

## Deploy

Run **Deploy web Worker** in GitHub Actions. Select `staging` or `production`
and paste the full 40-character commit SHA. The workflow checks out and verifies
that exact SHA, validates deployment guards, and runs the web tests, typecheck,
lint, collector tests, production build, built-Worker smoke test, and Wrangler
dry-run. It uploads the built Worker plus a SHA-256 manifest and provenance JSON
for review before the first remote mutation. It then applies pending forward-only
D1 migrations and deploys the Worker with the strict `SYNC_TOKEN` secret and the
optional Jev and Voyage keys. Provider secrets are supplied only to the actual
deployment step through a protected temporary secrets file, never to build,
validation, dry-run, provenance, or artifact-upload steps.

The active recommendation route prefilters verified catalog facts in D1, then
uses Voyage semantic retrieval when `VOYAGE_API_KEY` is configured and Jev
ranking when `TYPESAFE_API_KEY` is configured. `AI_DAILY_LIMIT` is one shared
request cap for the recommendation route whenever either provider is configured.
Legacy `AI_*`, `OPENAI_*`, and `EMBEDDING_*` settings remain available only to
opt-in admin or backward-compatibility tooling and do not enable recommendations.

## Build the Voyage index

The admin embedding endpoint requires `Authorization: Bearer <SYNC_TOKEN>`.
`GET /api/admin/embeddings` reports index coverage without calling Voyage. Its
default behavior is therefore a safe dry run. `POST /api/admin/embeddings`
indexes at most 32 documents per request and requires the server-side
`VOYAGE_API_KEY`; the key is never sent to the browser or included in an index
artifact.

After starting the Worker locally on port 3001, inspect coverage first:

```sh
cd web
npm run embeddings:index
```

To write the index against an explicitly trusted loopback Worker, opt into live
requests:

```sh
npm run embeddings:index -- --live --origin http://127.0.0.1:3001 --allow-loopback-http
```

For collection automation, set the optional protected-environment variable
`INDEX_EMBEDDINGS=true`. Leave it unset until Voyage credentials and the target
catalog are ready. Indexing calls do not consume the recommendation request cap.

After propagation, `/api/health` must pass the two-minute liveness retry window.
Its deployment environment and exact 40-character commit revision must match the
requested rollout, which prevents an old Worker or wrong environment from being
accepted merely because it returns HTTP 200.
The workflow then reports `/api/ready` separately. A fresh environment can be
live while returning `checkpoint_missing`; this is an expected bootstrap state,
so deployment succeeds with a warning. Bootstrap the collection checkpoint and
require `/api/ready` to return `ready: true` before public release.
`WORKERS_PLAN=free` omits a custom CPU allowance and can validate account setup
and a small staging deployment without purchasing Workers Paid. It does not
prove this application's full catalog search will fit the Free plan's CPU and
subrequest limits. The semantic path scans and parses a large vector set, and
the deterministic path can scan thousands of event rows; measure both against a
production-sized catalog before relying on Free. Set `WORKERS_PLAN=paid` only
after deciding to upgrade; it configures a 30-second CPU allowance. No script
purchases or upgrades a plan.
For a provider-free local diagnostic using the current catalog and existing
read-only local Voyage cache, run:

```sh
cd web
node --experimental-strip-types scripts/benchmark-recommendation.mjs > /tmp/biplan-recommendation-benchmark.json
```

The script performs one warmup and three runs each at concurrency 1, 4 and 8.
It makes no provider calls or cache writes. Its Node CPU, wall-time and process
memory figures are directional evidence only; they exclude real D1 latency and
do not establish Cloudflare Worker capacity.

The 2026-09-24 local baseline used 2,909 source rows and 1,309 cached document
vectors (2,077 eligible event IDs shared those document vectors). After removing
unneeded date, time and district derivation for unconstrained requests, median
CPU fell from about 768 to 308 ms per request at concurrency 1, 964 to 319 ms at
concurrency 4, and 903 to 338 ms at concurrency 8. The largest observed process
RSS fell from about 974 MB to 549 MB. Both runs made zero network calls and zero
cache writes. Hardware, Node, workerd and D1 differ, so these numbers are not
billing estimates, but they remain strong evidence that the current full
semantic path should not be assumed to fit a 10 ms Free Worker CPU allowance.
Preserve the Free profile for small staging checks and measure a compiled Worker
before any production claim.

The compiled keyless path has a separate isolated smoke benchmark:

```sh
cd web
npm run build
node scripts/benchmark-worker.mjs > /tmp/biplan-worker-benchmark.json
```

It runs the production bundle in Wrangler's local workerd harness with a fresh
temporary D1/R2 state, then makes three batches each at concurrency 1, 4 and 8.
Provider keys are blank, so it measures the deterministic full-catalog path and
makes no paid calls. Recommendation rate-limit writes affect only the temporary
database. Host-process memory includes the harness and is not isolate memory.
The semantic path cannot be measured this way without either changing the
production provider endpoint or adding a supported outbound-service test hook;
the Node benchmark above remains the current provider-free semantic diagnostic.

Observability samples operational logs at 10%, disables
automatic invocation logs, and does not enable traces; application code must not
log request, chat, token, or event payloads.

Promote by deploying the same commit SHA to staging first, checking the site and
admin import/sync path, then dispatching production. Record the successful
Worker version ID printed by Wrangler.

## Rollback

Use `npx wrangler versions list --name <worker>` to identify a previously
healthy version. Run **Roll back web Worker**, select the environment, and enter
that canonical version UUID. The workflow validates that the Worker name belongs
only to the selected environment, rolls back Worker code non-interactively,
verifies that Cloudflare routes 100% of traffic to the requested version, and
checks that post-rollback liveness identifies the selected environment. It does
not require the unhealthy Worker to answer before starting recovery.

D1 migrations are never reversed automatically. A code rollback must remain
compatible with the current schema. If it does not, deploy a forward repair
migration or a compatible Worker version. Treat a failed post-deploy liveness
check as an incident: inspect Worker logs, then manually roll back to the last
known-good version. R2 objects are likewise preserved by rollback.
