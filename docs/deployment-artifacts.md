# Deployment artifact integrity

The manual Worker workflow separates preparation from remote mutation.

The `prepare` job has no deployment environment or deployment secrets. It checks out the requested 40-character revision, requires the core `CI` and `Bi Plan` checks to have succeeded for that revision, installs locked dependencies, and runs the offline release, parser, replay, Worker smoke, and browser checks. It builds the Worker once and records:

- a SHA-256 digest for every compiled file under `web/dist`;
- the exact commit revision;
- Node, npm, and Wrangler versions;
- the web and collector lockfile digests.

The compiled directory and provenance directory are uploaded as one workflow artifact. The protected `deploy` job checks out only the release scripts and downloads this prepared artifact. It verifies the complete compiled manifest before generating the selected environment's Wrangler configuration. Target-specific Worker, D1, and R2 bindings therefore remain outside the immutable compiled manifest while staging and production consume identical preparation rules.

GitHub environments separate unattended runtime access from approval-gated mutations. Scheduled collection and monitoring use `staging` and `production`; these environments hold the runtime destinations needed by unattended jobs and must not require reviewers. Worker deployment and rollback use `staging-deploy` and `production-deploy`; these environments hold the corresponding deployment variables and secrets and can require reviewers. The workflow input and every generated/runtime environment value remain `staging` or `production`—the `-deploy` suffix selects only the GitHub approval boundary.

Immediately before the first remote mutation, deployment verifies the compiled manifest again and rejects any compiled file containing the configured deployment secret values. D1 migration and Worker deployment commands run only after those checks pass. Temporary Wrangler secret files are removed in a `finally` block.

After a successful staging deployment, the workflow records the run ID, revision, environment, and compiled-manifest digest in a separate staging evidence artifact. Production requires that staging run ID. It verifies through the GitHub API that the source run belongs to this repository and deployment workflow, completed successfully, and used the requested SHA. It then reads the unattended `staging` environment and requires staging `/api/health` to report the exact revision and staging identity, and `/api/ready` to report ready. The later production mutation enters the reviewer-protected `production-deploy` environment.

Production performs no build. It downloads the compiled artifact and staging evidence from that exact successful run, verifies the artifact against both its internal file manifest and the manifest digest recorded after staging deployment, and generates only the production binding configuration. The compiled bytes deployed to production are therefore the bytes tested and deployed by staging.

The workflow does not deploy on pushes or pull requests, purchase a Workers plan, create Cloudflare resources, or make provider calls during preparation. Approval and configured Cloudflare credentials from the selected `-deploy` environment remain necessary before deployment or rollback can mutate remote state.
