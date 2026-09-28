# Agent workflow

Optimize token usage by matching the model and scope to the task.

- Use `gpt-6-astra` for substantial planning, architecture decisions, and difficult reasoning.
- Use `gpt-5.6-sol` as the default worker for implementation, debugging, tests, and routine reviews.
- Subagents are authorized. Choose their model according to difficulty: use Sol for bounded work, and Astra when complexity or unresolved uncertainty warrants it. A lighter model may handle simple, well-defined tasks when it reduces total cost.
- Handle trivial edits directly; do not spawn agents or add a planning phase solely to follow these defaults.
- Delegate only concrete, independent subtasks while the parent continues useful work. Avoid duplicate investigations and overlapping file edits.
- Give workers a concise plan, relevant paths, constraints, and acceptance criteria. Prefer targeted context over copying the entire conversation.
- When specifying a subagent model override, use `fork_turns: "none"` with a self-contained brief, or a small positive turn count when recent context is needed; do not combine overrides with `fork_turns: "all"`.
- Reuse existing findings and run checks appropriate to the change. Escalate to Astra when Sol encounters a substantive reasoning blocker rather than repeating unproductive attempts.

These are model-selection defaults for sessions and delegated tasks. This file does not change the model of an already running agent; apply them through the available model-selection controls.

## Delivery cadence and scope

- Deliver a usable milestone early. For work likely to exceed 30 minutes, state the first concrete deliverable, its acceptance checks, and the expected expensive or slow steps. Share the working URL as soon as a deployed milestone is usable; do not withhold it while unrelated release gates run.
- Reassess scope after 30 minutes without a usable milestone. Identify the actual blocker, elapsed time, completed work and smallest remaining path. Continue necessary authorized work, but do not silently turn a focused fix into hours of broader production qualification.
- Separate the requested fix from public-launch readiness. Keep the launch checklist accurate, but treat long soak periods and unrelated capacity work as explicit outstanding gates rather than prerequisites for handing over a working test link.
- Investigate a defect's affected family before repeated rollout cycles. For example, when organizer-prefixed titles cause duplicates, inspect all such titles in the current catalog, including counterexamples, before deploying individual aliases one at a time.
- Batch related fixes and review them before the final build/deploy/live-test cycle. Once the agreed acceptance checks pass, close the task instead of adding speculative improvements, extra reviews or another evaluation round. Record newly discovered unrelated issues separately.
- Keep progress reports concrete: what works now, what is still failing, and what the current wait will establish. If only CI remains, say so plainly. Avoid repeatedly presenting a deployed, verified fix as unfinished development.
- Keep documentation proportional. Prefer one concise evidence summary linking preserved raw artifacts; do not create repeated reports merely to restate the same result. Handle documentation-only requests directly without application builds or live API calls.

## Product and architecture

- Bi’ Plan recommends Istanbul events from multiple ticket providers. Keep the interface simple: a hero with a chat input, event cards, support section, and reserved advertising areas. Donation and ad integrations remain placeholders until destinations/providers are chosen.
- `collector/` owns collection and publishing; `web/` owns the application, recommendation pipeline, and cloud storage/runtime adapters. Use Node from `web/.nvmrc` (both packages require Node >=22.13).
- Retrieve across the full eligible catalog using Voyage embeddings and lexical signals before shortlisting up to 16 distinct candidates for TypeSafe Jev. The shortlist is not the database search limit. Return every distinct shortlisted event that passes the support threshold; do not impose a separate fixed result count or fill with unsuitable events. Keep alternatives available and retain the bounded shortlist to control per-request cost.
- Preserve Turkish and English constraints through follow-ups, corrections, resets, and group-budget changes. Hard constraints and mandatory source-evidence checks apply to both AI recommendations and fallback search. Unknown price, accessibility, or venue policy is not positive evidence.
- Merge provider offers conservatively: require matching session time and venue plus a supported title identity. Preserve source links, prices, and raw IDs; do not merge different sessions or adaptations merely because titles resemble each other.
- Keep failed collection pages, quarantined records, and stale data distinguishable from successfully refreshed records. Preserve durable checkpoints and embedding-cache reuse.
- “Every event” means exhausting the supported providers' discoverable inventory within the documented horizon, not sampling a fixed number of pages. Report verified, retired, failed, quarantined and unvisited counts separately; attempted pages are not necessarily successfully collected events, and provider coverage is not all of Istanbul.

## Verification

- Prefer the T3Code integrated browser for UI checks. If its automation host is unavailable, report that limitation and use headless Playwright when possible; avoid native desktop control unless necessary.
- Run checks appropriate to changed paths. Web checks include `npm test`, `npm run typecheck`, and `npm run lint` from `web/`; collector checks use `npm test` from `collector/`. Deployment changes also need `npm run test:deploy-config` from `web/`.
- Reuse passing evidence for unchanged code. After a test-only or documentation-only correction, rerun the affected checks rather than automatically repeating every local build, container test and paid evaluation. Required exact-revision CI still applies; record which checks ran on which revision and prove tree equality when reusing runtime evidence.
- GCP changes also require `npm run test:deploy:gcp`, `npm run build:node`, and `npm run test:smoke:node`; verify the Linux Docker image in CI. `dist-node` is isolated from the Cloudflare build.
- Build before compiled smoke or browser checks: from `web/`, run `npm run build`, then `npm run test:smoke` and, when relevant, `BIPLAN_BROWSER_START=1 npm run test:browser`. The isolated browser suite mocks provider calls. Do not run competing builds against the same output directory.
- `web/scripts/check-release-cases.mjs` checks the frozen conversational fixture offline. Its relative dates use the fixture's reference date; do not blindly reuse old dated fixtures for a new live run against today's catalog.
- For live evaluation, use existing authorization and a bounded call budget; otherwise prepare offline checks first. Keep request pacing, application rate limits, and no automatic retries. Reuse cached document embeddings rather than paying to recreate unchanged vectors.
- Establish one cumulative live-evaluation budget for the task, including a reserved final confirmation. Track all ledgers and addenda against that total; creating another ledger does not reset the budget. Prefer offline replay and source audits while fixing known defects. Any budget extension must fit existing authorization or receive approval for its concrete additional scope and cost.
- Review every returned card against source evidence, not just HTTP success or the first result. Review empty results against actual catalog availability; empty does not automatically mean correct. Distinguish hard-constraint correctness, subjective relevance, and recall.
- Check semantic distinctness separately from source validity: two fully source-verified cards can still be duplicates. Coverage audits must assert their expected family labels and record IDs, not merely report success for whichever records their matcher happened to select.
- Preserve frozen cases and original provider responses, including failures. Record the tested runtime revision, dirty-state provenance, actual calls and limitations. Never rewrite old results to make a new policy appear to have passed live testing.
- Local Node/workerd timing and host memory are diagnostics, not measurements of Cloudflare CPU limits, isolate memory, or production capacity.

## Deployment and cost

- Follow the user's free-first preference for development and staging. `WORKERS_PLAN=free` is the default; only select a paid profile when measured needs justify it and existing user authorization covers the change. Preparing a profile does not activate a subscription.
- GCP is the selected target: Cloud Run for the Node app, Firestore for coordination and rate limits, private Cloud Storage for catalog/checkpoint/vector snapshots, and Secret Manager. The existing Workers/D1/R2 deployment remains a fallback. Follow `docs/gcp-deployment.md`; do not assume local migration tests establish GCP deployment, IAM, latency or capacity. Keep exact embedding profiles and cached vectors during migration.
- Keep staging and production resources separate; do not reuse unrelated account resources. Keep credentials in ignored local settings such as `web/.dev.vars` or protected deployment secrets. Never print, commit, or request secrets in chat.
- Preparing the project for publication is not itself authorization to publish publicly or purchase a plan. Continue already-authorized local work, tests, and PR work without asking for permission again.
- When pushing or updating a PR, check CI on the exact latest revision and address failures. Do not describe a previous green revision as verification of later changes.
- Reuse an already tested immutable image when its runtime contents are unchanged; do not rebuild or redeploy merely to attach a documentation or merge-commit SHA. Preserve the original image provenance and record the relationship to the newer commit. Where dependencies allow, run merged-commit CI alongside staging verification instead of serializing both waits.
- If collection or monitoring is temporarily paused for maintenance, record its prior state and deadline, restore it as soon as compatible code is available, and verify restoration before finishing. Do not extend a bounded authorization window or count maintenance time as unattended evidence.
- Use [docs/launch-checklist.md](docs/launch-checklist.md) and [docs/deployment.md](docs/deployment.md) for release gates. Public readiness requires actual staging evidence, recovery drills, capacity checks, and at least 48 hours of unattended collection/monitoring; local smoke tests cannot substitute for these.
- The [September 24 release audit](docs/release-readiness-2026-09-24.md) contains historical results and outstanding gates at that time. Recheck changing account state, catalog freshness, and deployment status; avoid copying dated counts or blockers into permanent assumptions.
