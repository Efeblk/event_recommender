# Bi' Plan product plan: v1 and v2 ranking

Owner: the user. Written 2026-10-03. This plan has priority over older plans,
reports and runbooks in `docs/`. If `AGENTS.md` conflicts with this plan, follow
this plan and record the conflict in the status log at the end.

## Product definition

**v1:** A user types a request in Turkish or English. Bi' Plan returns the
relevant, correct and bookable Istanbul events. That is the complete v1 product.

**v2:** Enrich the data so that the best events come first. The first v2 step is
ranking and scoring the events.

Everything else is out of scope until v1 is live. Out-of-scope work includes
new providers, promotions, the PostgreSQL cutover, quality dimensions,
capacity work beyond the beta load, and new architecture.

## Current state (2026-10-03, `master` = `bad42d0`)

What works:

- Collection from Biletinial, Bubilet and Biletix through
  `.github/workflows/gcp-collector.yml`. Scheduled collection is on, every 6 h
  (`GCP_STAGING_COLLECTION_UNTIL=open`). The last run (37149121969) had
  174 failed pages and a ready catalog with 8,502 eligible events.
- Identity and merge: `collector/identity/resolve.ts` (`deterministic-identity.v5`).
  In the last human test, all returned cards were correct and there were no
  duplicate cards.
- Request parsing: span-v2 (`web/parser/`), with `web/lib/plan-evidence.ts`
  for hard constraints.
- Retrieval: BM25 and Voyage vectors combined with reciprocal rank fusion
  (`web/lib/hybrid.ts`). Then up to 16 candidates go to the Jev AI judge
  (`web/lib/recommend.ts`, `web/lib/jev.ts`).
- Staging: the private Cloud Run service `biplan-staging` (GCP project
  `biplan-staging-efeblk`, region `us-central1`). You deploy it with
  `gcp-staging.yml` and an approval gate.

What does not work or is missing:

- Semantic search covers only part of the catalog. Indexing is off
  (`GCP_STAGING_INDEXING_ENABLED=false`) because no embedding budget is approved.
- No alert is sent when a scheduled collection fails or the catalog goes stale.
- The repository has two runtimes (Cloudflare and GCP), a half-done PostgreSQL
  path and more than 40 documents in `docs/`. Agents spend time on this
  machinery instead of on the product.
- There is no fixed, repeatable relevance test set. Each test round uses new
  queries, so the results of different rounds cannot be compared.

## Working rules for the agent

1. Work on one branch and one PR at a time from `master`. Merge it before you
   start the next one. Do not create extra worktrees. Delete each branch after
   its merge.
2. Each phase below has acceptance checks. When the checks pass, the phase is
   complete. Do not add extra evaluation rounds or unrelated improvements.
   Record new unrelated issues in the "Later" list at the end of this file.
3. Do not write new report documents. Update the status log at the end of
   this file with short lines: date, PR or run ID, and result.
4. Paid calls (TypeSafe/Jev, Voyage) need a budget that the user approves. Ask
   once per phase, with a cost estimate. Deploys to staging and approval of the
   `gcp-staging` gate are permitted for the steps in this plan.
5. If you work for more than 2 hours with no merged PR, stop. Then write in the
   status log what blocks you.
6. Never print or commit secrets.

## Phase 0: Simplify the repository (target: 2–3 days)

Goal: the repository contains only what v1 uses, and agents get short and
correct instructions.

Tasks:

1. Replace `AGENTS.md` with a short file (target: less than 80 lines). Keep the
   working rules from this plan, the verification commands and the cost and
   secret rules. Remove the long target-architecture text. Link to this plan.
   Show the new file to the user before you merge it.
2. Move old dated reports and plans from `docs/` to `docs/archive/`. Keep only
   these files at the top level: `product-plan-v1.md`, `gcp-deployment.md`,
   `gcp-collector.md` and one short `architecture.md` that describes the real
   v1 flow (collect → identity → checkpoint → import → search). Fix the links.
3. Remove the Cloudflare runtime: `deploy.yml`, `rollback.yml`, `collect.yml`,
   `monitor.yml`, the Cloudflare parts of `web.yml`, `store.cloudflare.ts`,
   `legacy-sync.cloudflare.ts`, the Wrangler configuration and the Cloudflare
   build and smoke scripts. Keep all GCP tests green.
4. Freeze the PostgreSQL path: remove the opt-in "Prepare replacement
   PostgreSQL catalog" step from `gcp-collector.yml`, and remove the
   `postgres-contracts` CI job if nothing on the v1 path uses it. Do not
   delete the PostgreSQL code in this phase. Move it to a clearly named folder
   or leave it, and record the decision in the status log.
5. Stop uploading raw provider pages (`collector/state/raw/`) as public
   workflow artifacts. The repository is public. Keep the small JSON reports.

Acceptance:

- CI is green on `master`.
- A staging deploy and one collection succeed after the changes.
- `/api/ready` returns 200.
- `AGENTS.md` is short and the user accepted it.

## Phase 1: Correct retrieval, measured (target: 1 week)

Goal: show with a fixed test that a user request returns relevant and
correct events.

Tasks:

1. **Golden set.** Create `web/fixtures/golden-v1.json` with 40 requests:
   25 Turkish and 15 English. Include typos, dates ("bu akşam", "hafta sonu",
   "ekim sonunda"), districts and sides, budgets, groups, categories, moods,
   negations and two follow-up corrections. Use the earlier human-test requests
   (`span-parser-human-cases.test.ts`, `docs/archive/product-benchmark-2026-10-03.md`)
   as a start. For each request, record the expected hard constraints. The
   user reviews the 40 requests before the first scored run.
2. **Frozen catalog.** Save one collection artifact (`state/events.json`) as
   the test catalog. Use a fixed reference time. Keep large files out of git,
   and record the run ID and hash.
3. **Runner.** Create `web/scripts/golden-run.ts`. It runs every request
   against the frozen catalog and writes, for each request, the top 10 cards,
   their record IDs and the time taken. Cache the parser and Jev responses by
   request text and catalog hash, so that a repeated run makes no paid calls.
4. **Labels.** For each request, label the returned top 10 cards with
   relevant, partly relevant or not relevant. Labels go in
   `web/fixtures/golden-v1-labels.json`. The user labels or reviews a sample
   of at least 10 requests. For an empty result, check the catalog to see
   whether a matching event exists.
5. **Embeddings.** Estimate the Voyage tokens and cost for all current
   documents. Ask the user once. After approval, reset the indexing window
   variables, clear the stuck `inFlight` reservation from run 37061051538 and
   index the full catalog. Then remove the "partly ready" notice.
6. **Fix batch.** Find the failures in the golden run. Group them by cause.
   Fix them in one or two PRs. Then run the golden set again. Each later PR
   that changes parsing, retrieval or merging must run the golden set.

Acceptance (the v1 quality bar):

- 0 hard-constraint violations (date, place, budget, category, negation, age)
  in all top-10 lists.
- 0 duplicate cards (the same session from different providers shown twice).
- At least 85% of requests have a relevant card in the top 3.
- Every empty result is correct: the frozen catalog has no matching event.
- p95 end-to-end time below 8 s on staging, one request at a time.

## Phase 2: Run unattended (target: 3–4 days, mostly waiting)

Tasks:

1. Add one scheduled monitor workflow. Every hour, it calls `/api/ready` on
   staging. If the result is not ready, or if `lastCheckedAt` is more than
   14 h old, the workflow fails. GitHub then sends a failure email.
2. Let scheduled collection run for 7 days. Do not deploy during that time,
   unless you must fix a fault.
3. Write down a 5-line recovery procedure in `gcp-deployment.md`: how to see a
   failure, deploy the last good SHA, run a collection and check
   `/api/ready`.

Acceptance: 7 days with no failed collection that you did not see, and the
catalog never stale.

## Phase 3: Private beta (target: 1–2 weeks)

Tasks:

1. The user selects the access method (an invite link or an allow list) and
   the URL. Do not make the service public without the user's approval.
2. Add a simple feedback path: a thumbs up or down on each card and on each
   result list. Store it with the request text, the parsed plan and the
   returned record IDs. Store no personal data.
3. Invite 5–10 people. After one week, group the feedback. Fix the top
   problems in one batch. Add each fixed failure to the golden set.

Acceptance: the user decides that v1 is good enough to open to more people.

## v2: Ranking and scoring (start only after Phase 3)

Goal: when many events match a request, the best ones come first.

Current ranking: BM25 + vector rank fusion selects 16 candidates. Jev judges
whether each candidate supports the request. Ties use the start time. No
event-level quality signal exists.

Steps:

1. **Measure first.** Extend the golden labels to graded relevance (0–3)
   for the top 10. Add metrics to the runner: NDCG@5 and precision@3. Record the
   baseline before you change the ranking. No ranking change merges unless it
   improves NDCG@5 and keeps the Phase 1 acceptance checks.
2. **Cheap event signals from data we already have** (no AI, computed at
   collection time, stored on the event):
   - completeness: description, image, exact venue, exact price;
   - offer signals: number of providers, lowest price, price spread;
   - time: how close the event is to the requested time; sold-out or
     nearly sold-out state when a provider shows it;
   - venue: number of events at the venue and how well its location is known.
   Unknown values are neutral. They are not a penalty.
3. **Score composition in code.** Write one versioned function
   (`ranking.v1`) that combines retrieval rank, Jev support and the event
   signals with fixed weights. Tune the weights only on the golden labels.
   Hard constraints always apply first.
4. **AI-assisted enrichment (optional, needs a budget).** Run one bounded job
   at collection time that tags each new or changed event with typed fields
   (audience, mood, language, indoor or outdoor, family suitability) from its
   description. Cache by content hash, so that unchanged events cost nothing.
   Use the tags for filtering and ranking only after the labels show a gain.
5. **Feedback signal.** After the beta collects enough thumbs up and down,
   test whether feedback improves ranking. Keep new events visible. A new event
   without feedback must not drop below the others.

Acceptance for each v2 step: NDCG@5 improves on the golden set, all v1
checks still pass, and the per-request cost does not increase without approval.

## Decisions the user must make

- Approve `AGENTS.md` (Phase 0).
- Approve the embedding budget (Phase 1, task 5).
- Review the golden requests and label a sample (Phase 1).
- Select the beta access method and URL (Phase 3).
- Approve any AI enrichment budget (v2, step 4).

## Later (not in v1)

- PostgreSQL cutover and the target architecture in
  `docs/archive/catalog-enrichment-architecture.md`.
- More providers. Promotions and discounts.
- Performance at more than 4 concurrent users. The local benchmark measured a
  p95 of 3.7 s at 4 concurrent requests.
- Collector throughput: a global limit of 1 request each second over all
  providers. It takes 2–3 runs to refresh all Biletix pages.

## Status log

- 2026-10-03: Plan written. `master` = `bad42d0`. Staging deployed
  (37148883212). Scheduled collection is on. Collection 37149121969 succeeded.
- 2026-10-04: Phase 0 started from `bad42d0`. Tasks 1–2 are prepared for review.
  `AGENTS.md` has 62 lines. Archived 41 files and added the current v1 architecture.
  User acceptance and merge are pending. Runtime and workflow tasks 3–5 follow.
  Local checks passed: 131 repository links, archive preservation and diff checks.
  Source changes only update documentation paths in comments. No paid calls.
- 2026-10-04: Resolved the instruction conflict in favor of this plan.
  PostgreSQL migration and the older launch gates do not define v1 scope.
  PostgreSQL code stays in its current folders. Workflow removal is pending.
