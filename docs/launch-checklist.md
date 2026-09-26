# Public beta launch sequence

This checklist records gates, not a claim that the application is deployed. The chosen target is the user's Cloudflare account, with independent staging/production Workers, D1 databases and R2 buckets. A workers.dev address is sufficient initially; a custom domain can follow.

1. **Review and CI:** commit the local backend/UI and operational work, open a PR, and require green web/collector/config tests, typecheck, lint, both build paths, and isolated D1/R2 smoke checks on the exact commit. No push deploys the site.
2. **Account setup:** give the deployment identity access to Workers, D1 and the selected R2 buckets, prepare the resources, and configure separate staging/production runtime and deployment-approval environments following [deployment.md](deployment.md). Check current account permissions and R2 activation; historical failures are not evidence of the present state. Browser OAuth authenticates the developer PC; unattended Actions need an account-scoped API token. Never paste credentials into a chat or commit them.
3. **Staging bootstrap:** after authorization to publish staging, manually deploy the tested SHA. The workflow prepares and uploads one compiled artifact before entering the deployment environment. Check `/api/health` with matching environment/revision; first-run `/api/ready` may correctly report no checkpoint. Run the actual collector workflow against staging, with durable restore and checkpoint/readback enabled. Require `/api/ready` to become ready.
4. **Unattended observation:** set repository variable `SCHEDULED_COLLECTION_ENVIRONMENTS` to `["staging"]` and collect at least 48 hours of real scheduled workflow evidence, with no unexplained missed collection interval. Verify refresh from all three expected sources, source failures, canonical readback, catalogue age/counts and monitor failures. Pass the [soak verifier](soak-verification.md) for the exact deployed revision; manually dispatched runs cannot qualify as unattended evidence. GitHub scheduled jobs can be delayed or disabled; enable workflow-failure notifications and an independent external readiness/heartbeat monitor before wider release.
5. **AI evaluation:** provision Voyage and TypeSafe keys through secure local/server settings. Build the Voyage index with the authenticated indexing driver, verify coverage, and measure semantic/hybrid shortlist recall; see [Voyage retrieval](../web/docs/voyage-retrieval.md). The active results-only Jev path needs live Turkish quality and latency tests. Use its opt-in evaluation harness; inspect Turkish negation, follow-ups, unsupported preferences, hard-constraint interpretation, acceptance thresholds and real-catalog recall before public use. Require whole-list precision and no forbidden secondary matches, not just a correct first card. The initial 12-call live run exposed one such failure; offline replay checks the filtering fix using those saved scores and is not a new live model measurement. Record actual usage and establish limits.
6. **Recovery and load:** validate a known-good Worker rollback, a D1 backup/restore exercise in staging, R2 checkpoint recovery, provider failure fallback and a representative short burst of concurrent recommendation requests. Use the [staging drill](staging-drills.md) to preserve restore and bounded-load evidence, and collect actual Cloudflare CPU/memory/limit telemetry. Expired rate-limit entries are cleaned in bounded batches; monitor D1 usage. Keep Vinext pinned and retest upgrades.
7. **Limited beta:** after all gates and publication authorization, promote the successful staging run's exact compiled artifact to production using `staging_run_id`; production performs no rebuild. Run a fresh collection/checkpoint, require readiness, and invite the first 20–50 testers. Verify privacy/data-use and source/price notices before accepting public chats. Donations and ads remain placeholders until destinations/providers are chosen. Broader promotion follows observed operation and user feedback.

Start staging with `WORKERS_PLAN=free`, which omits the paid CPU allowance. This
is a setup and measurement profile, not evidence that the production-sized
catalog or semantic search fits the Free plan. Promote on Free only after the
full catalog, concurrent request, collection and monitoring gates pass within
its CPU and subrequest limits; otherwise choose the paid Worker allowance. A
separate initial $5–10 AI budget was proposed only if live AI is enabled. These
are planning allowances, not permission to purchase a plan. The deployment
scripts do not change billing subscriptions. R2 remains required for durable
collection checkpoints; replacing it with D1 would require chunking and
transactional recovery work rather than a configuration-only fallback. R2
account activation, provider access and domain availability depend on the
account.

## Evidence

- `web/scripts/smoke.mjs`: real compiled Worker, isolated D1/R2; import/auth/restart behavior, canonical checkpoints, stale/missing checkpoint detection.
- `collector/tests/reliability.test.mjs`: simulated HTTP restore, partial-import failure, checkpoint receipt/readback and readiness failures.
- `collector/output/soak-evidence.json`: generated evidence for one real run; never a substitute for elapsed observation.
- `web/scripts/evaluate-jev.ts`: dry run by default; `--live` explicitly sends up to 12 evaluation calls and records returned token usage/latency.
- GitHub deployment artifacts: exact SHA, build hashes, non-secret configuration and provenance.
- [September 27 readiness record](release-readiness-2026-09-27.md): deployed staging identity, confirmed CPU failure, local rate-limit checks and outstanding cloud gates. Historical observations do not replace rechecking the candidate revision.

Do not mark cloud deployment, the 48-hour observation, live AI quality, restore drills or tester acceptance complete until each has its own recorded evidence.
