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

## Product and architecture

- Bi’ Plan recommends Istanbul events from multiple ticket providers. Keep the interface simple: a hero with a chat input, event cards, support section, and reserved advertising areas. Donation and ad integrations remain placeholders until destinations/providers are chosen.
- `collector/` owns collection and publishing; `web/` owns the application, recommendation pipeline, and Cloudflare integration. Use Node from `web/.nvmrc` (both packages require Node >=22.13).
- Retrieve across the full eligible catalog using Voyage embeddings and lexical signals before shortlisting up to 16 distinct candidates for TypeSafe Jev. The shortlist is not the database search limit. The default response shows up to two supported results, with alternatives available.
- Preserve Turkish and English constraints through follow-ups, corrections, resets, and group-budget changes. Hard constraints and mandatory source-evidence checks apply to both AI recommendations and fallback search. Unknown price, accessibility, or venue policy is not positive evidence.
- Merge provider offers conservatively: require matching session time and venue plus a supported title identity. Preserve source links, prices, and raw IDs; do not merge different sessions or adaptations merely because titles resemble each other.
- Keep failed collection pages, quarantined records, and stale data distinguishable from successfully refreshed records. Preserve durable checkpoints and embedding-cache reuse.

## Verification

- Prefer the T3Code integrated browser for UI checks. If its automation host is unavailable, report that limitation and use headless Playwright when possible; avoid native desktop control unless necessary.
- Run checks appropriate to changed paths. Web checks include `npm test`, `npm run typecheck`, and `npm run lint` from `web/`; collector checks use `npm test` from `collector/`. Deployment changes also need `npm run test:deploy-config` from `web/`.
- Build before compiled smoke or browser checks: from `web/`, run `npm run build`, then `npm run test:smoke` and, when relevant, `BIPLAN_BROWSER_START=1 npm run test:browser`. The isolated browser suite mocks provider calls. Do not run competing builds against the same output directory.
- `web/scripts/check-release-cases.mjs` checks the frozen conversational fixture offline. Its relative dates use the fixture's reference date; do not blindly reuse old dated fixtures for a new live run against today's catalog.
- For live evaluation, use existing authorization and a bounded call budget; otherwise prepare offline checks first. Keep request pacing, application rate limits, and no automatic retries. Reuse cached document embeddings rather than paying to recreate unchanged vectors.
- Review every returned card against source evidence, not just HTTP success or the first result. Review empty results against actual catalog availability; empty does not automatically mean correct. Distinguish hard-constraint correctness, subjective relevance, and recall.
- Preserve frozen cases and original provider responses, including failures. Record the tested runtime revision, dirty-state provenance, actual calls and limitations. Never rewrite old results to make a new policy appear to have passed live testing.
- Local Node/workerd timing and host memory are diagnostics, not measurements of Cloudflare CPU limits, isolate memory, or production capacity.

## Deployment and cost

- Follow the user's free-first preference for development and staging. `WORKERS_PLAN=free` is the default; only select a paid profile when measured needs justify it and existing user authorization covers the change. Preparing a profile does not activate a subscription.
- The current cloud architecture uses Workers for the app, D1 for structured data, and private R2 storage for collection checkpoints and recovery. R2 activation is separate from Workers Paid. Verify account state when needed rather than assuming an earlier activation or permission failure still applies.
- Keep staging and production resources separate; do not reuse unrelated account resources. Keep credentials in ignored local settings such as `web/.dev.vars` or protected deployment secrets. Never print, commit, or request secrets in chat.
- Preparing the project for publication is not itself authorization to publish publicly or purchase a plan. Continue already-authorized local work, tests, and PR work without asking for permission again.
- When pushing or updating a PR, check CI on the exact latest revision and address failures. Do not describe a previous green revision as verification of later changes.
- Use [docs/launch-checklist.md](docs/launch-checklist.md) and [docs/deployment.md](docs/deployment.md) for release gates. Public readiness requires actual staging evidence, recovery drills, capacity checks, and at least 48 hours of unattended collection/monitoring; local smoke tests cannot substitute for these.
- The [September 24 release audit](docs/release-readiness-2026-09-24.md) contains historical results and outstanding gates at that time. Recheck changing account state, catalog freshness, and deployment status; avoid copying dated counts or blockers into permanent assumptions.
