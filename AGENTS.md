# Agent instructions

Read [the product plan](docs/product-plan-v1.md) first.
The product plan has priority over older instructions and archived documents.
Use [the v1 architecture](docs/architecture.md) for the current system.

## Product scope

- v1 returns relevant, correct and bookable Istanbul events from a request.
- Support Turkish and English requests.
- Keep dates, places, budgets, categories, negations and age limits correct.
- Do not show duplicate sessions or events without required source evidence.
- Retrieve from the full eligible catalog before the shortlist of up to 16.
- Return each distinct shortlisted event that passes the support threshold.
- Keep collection work outside search requests.
- Leave PostgreSQL, new providers, promotions and quality scoring outside v1.
- Start v2 ranking only after Phase 3.

## Work rules

- Work on one branch and one PR from `master` at a time.
- Merge that PR before the next PR. Delete the branch after merge.
- Do not create extra worktrees.
- Complete each phase when its acceptance checks pass.
- Put unrelated issues in the product plan's Later list.
- Update the product plan's status log with the date, PR or run ID, and result.
- Do not create new report documents. Link to preserved evidence.
- Stop after 2 hours without a merged PR. Record the blocker in the status log.
- Show the Phase 0 `AGENTS.md` to the user before merge. Get user acceptance.
- Use short sentences and active voice. Follow ASD-STE100 Simplified Technical English.
- Keep technical names, commands, paths and quoted source text exact.
- Use `gpt-6-astra` for substantial planning and difficult reasoning.
- Use `gpt-5.6-sol` for implementation, tests and routine reviews.
- Handle trivial edits directly. Reuse existing findings.

## Verification

- Use Node from `web/.nvmrc`. Both packages require Node >=22.13.
- For web changes, run `npm test`, `npm run typecheck` and `npm run lint` in `web/`.
- For collector changes, run `npm test` in `collector/`.
- For deployment changes, run `npm run test:deploy-config` in `web/`.
- For GCP changes, also run `npm run test:deploy:gcp`, `npm run build:node`
  and `npm run test:smoke:node` in `web/`. Verify the Linux Docker image in CI.
- Build Node before browser checks. Use `npm run build:node` in `web/`.
- Use `BIPLAN_BROWSER_START=1 npm run test:browser` when a browser check applies.
- Prefer the T3 Code browser. Report an unavailable host before using Playwright.
- For documentation changes only, check links and the diff. Do not build or call APIs.
- Check CI on the exact latest PR revision. Fix failures before merge.
- Review every returned card and every empty result against source evidence.
- Preserve failed results. Do not treat old evidence as a new live test.

## Cost, deployment and secrets

- Ask once per phase for a paid TypeSafe/Jev or Voyage budget. Give a cost estimate.
- Keep paid calls within that budget. Do not retry paid calls automatically.
- Prefer free development and staging options. New paid resources need user approval.
- Staging deploys and approval of the `gcp-staging` gate are permitted by the plan.
- Keep staging private. Public access needs user approval.
- Keep staging and production resources separate.
- Never print or commit secrets. Use ignored local settings or protected secrets.
- Follow [GCP deployment](docs/gcp-deployment.md) and [GCP collection](docs/gcp-collector.md).
