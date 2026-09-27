# Demo hosting comparison — September 27, 2026

The owner prefers a free demo before considering paid hosting and already has a
Google Cloud account. Evaluate Cloud Run first as an alternative to continuing
the Cloudflare Free-specific retrieval rewrite. This is a recommendation for a
prototype, not a hosting migration or spending authorization. Nothing has been
deployed to Google Cloud or AWS.

## Cost comparison

| Option | Published compute allowance or minimum | Fit for this application |
| --- | --- | --- |
| Cloudflare Workers Free | 10 ms CPU per invocation | The deployed full-catalog path has failed before AI. The small final-candidate probe does not establish reliable capacity. |
| Cloudflare Workers Paid | $5/month minimum plus overages | Smallest application migration; larger CPU allowance. The owner has not authorized activation. |
| Google Cloud Run, request-based billing | 2 million requests, 180,000 vCPU-seconds and 360,000 GiB-seconds per month, with the free allowance based on US-central pricing | A conventional Node container is a promising fit. Database, storage, builds, image registry and network usage must be priced separately. |
| AWS Lambda | 1 million requests and 400,000 GB-seconds per month | Compute can also be free for a small demo, but this repository needs an additional packaging/invocation compatibility check beyond its storage migration. |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Cloud Run pricing](https://cloud.google.com/run/pricing),
[Lambda pricing](https://aws.amazon.com/lambda/pricing/).
Observed failures are in the [Free capacity record](free-demo-capacity-2026-09-27.md).

Illustrative calculation, not a measured bill: 100 recommendation requests/day
for 30 days, each taking 10 seconds on a 1-vCPU/1-GiB Cloud Run instance with no
overlap, uses 30,000 vCPU-seconds and 30,000 GiB-seconds. At the published base
rates and with unused free allowances, that is $0 in Cloud Run compute charges.
The equivalent 1-GiB Lambda example consumes 30,000 GB-seconds, also below its
allowance. Neither calculation includes startup time, other application traffic,
monitoring, storage, databases, network transfer, builds or AI-provider calls.
Cloud Run bills active request time, including time waiting for providers;
Workers' CPU billing model is different. See [Cloud Run billing
settings](https://docs.cloud.google.com/run/docs/configuring/billing-settings).

An existing Google account does not establish eligibility for new-customer
credits. The recurring free tier requires an active billing account; on a paid
billing account excess usage can be billed. Google's trial credit is separate
from the recurring allowance. [Google Free Program](https://docs.cloud.google.com/free/docs/free-cloud-features).
AWS's new-account Free plan also has a limited lifetime, currently at most six
months or until credits run out. [AWS Free Tier](https://aws.amazon.com/free/).

## Migration and performance

The installed Vinext version supports a Node standalone server, but the current
application imports `cloudflare:workers` and uses D1 and R2 bindings. Copying the
current Worker artifact into a container will not work. A Node target needs
environment, database, checkpoint-storage and trusted-client-IP adapters, plus
deployment and recovery checks. The collector can retain its HTTPS interface.

A local compatibility spike used Node 22.23.3 and the installed Vinext 1.0.0-beta.9
to build and start a standalone server in an isolated scratch directory. The
homepage and site-settings endpoint returned HTTP 200. Health, events and
readiness returned HTTP 503 because no database/checkpoint adapter was provided.
The first packager attempt failed to resolve a nested dependency through the
scratch dependency junction; pointing `NODE_PATH` at that existing dependency
directory allowed the second build to pass without installing packages. Both
logs were preserved. This proves the framework's local Node entrypoint, not a
complete application migration, Linux container build or Cloud Run performance.
The [Node compatibility record](../web/evals/reports/2026-09-27-node-compatibility.json)
preserves the results; logs and the full source hash manifest remain under
`web/work/cloud-run-compatibility/`.

Cloud Run's local filesystem is ephemeral, so it cannot hold the sole writable
catalogue, checkpoint or shared rate counters. [Container runtime
contract](https://docs.cloud.google.com/run/docs/container-contract).
Cloud SQL is not required: an external SQLite-compatible service is another
candidate that could preserve more of the current SQL. For example, Turso lists
a free 5-GB tier with 500 million row reads and 10 million writes per month.
Its compatibility, regional latency and backup/restore behavior have not been
tested here. [Turso pricing](https://turso.tech/pricing).
Do not substitute an always-on managed database without pricing it: Cloud SQL's
published base shared-core price starts at $0.0105/hour, before storage and other
charges. [Cloud SQL pricing](https://cloud.google.com/sql/pricing).

Comparable user-visible performance is unproven. Cloud Run can scale to zero,
which can delay the first request after idle; keeping instances warm changes
the bill. [Cloud Run overview](https://docs.cloud.google.com/run/docs/overview/what-is-cloud-run).
Compare the same full catalogue, 1,024-dimensional cached vectors and
recommendation policy. Measure cold and warm homepage/search latency, provider
time separately, concurrency, rate-limit enforcement and recovery. Do not
claim equivalent quality by reducing the catalogue or shortening vectors.

## Current decision boundary

Preserve the Cloudflare staging resources and historical evidence. The compact
SQL experiments and unfinished prepared-retrieval draft remain local reference
work, not an activated runtime path. Prototype the Node build locally before
choosing or provisioning a database or deploying Cloud Run. No subscription,
production publication, or paid plan has been authorized.

On this PC the Google Cloud CLI is installed, but read-only project/billing
listing failed because its stored authentication could not refresh. That stored
account did not match the email supplied for monitoring. No Google project or
billing state was verified, and the existing CLI configuration was not changed.

The retained application change reuses Jev's Istanbul date formatter and its
serialized request body, preserving the provider payload contract. TypeScript
now excludes ignored scratch and generated-output directories so experiments
cannot enter the application type check. Node 22 unit tests, type checking,
lint, the existing Cloudflare build and compiled D1/R2/Voyage smoke checks passed.
Those local checks do not remove the outstanding staging capacity gate.
