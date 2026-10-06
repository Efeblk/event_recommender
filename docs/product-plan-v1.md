# Bi' Plan product plan: v1 and v2 ranking

Owner: the user. Written 2026-10-03. This plan has priority over older plans,
reports and runbooks in `docs/`. If `AGENTS.md` conflicts with this plan, follow
this plan and record the conflict in the status log at the end.

## Product definition

**v1:** A user types a request in Turkish or English. Bi' Plan returns the
relevant, correct and bookable Istanbul events. That is the complete v1 product.
Each request is independent. One request produces one response. Do not use
earlier requests, plans, filters, clarification text or shown event IDs.

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
- Request parsing: the field reader (`web/parser/fields.ts`) with the span-v2
  plan protocol, and `web/lib/plan-evidence.ts` for hard constraints.
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
   negations and two independent replacement requests. Use the earlier human-test
   requests
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

0. Keep vectors current: indexing runs hourly with a daily call window
   (`GCP_STAGING_INDEXING_UNTIL=open`). Done in PR 56.
1. Add one scheduled monitor workflow. Every hour, it calls `/api/ready` on
   staging. If the result is not ready, or if `lastCheckedAt` is more than
   14 h old, the workflow fails. GitHub then sends a failure email.
   Done in PR 57 (job `monitor` in `gcp-collector.yml`; the collector identity
   trusts only that file).
2. Let scheduled collection run for 7 days. Do not deploy during that time,
   unless you must fix a fault.
3. Write down a 5-line recovery procedure in `gcp-deployment.md`: how to see a
   failure, deploy the last good SHA, run a collection and check
   `/api/ready`. Done in PR 57.

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
- Remove the span-first parser (`web/parser/parse-core.ts`, `extract.ts`,
  `gliner.ts`) and its tests after the field reader passes a staging human test.
- Domain request model: after about 1,000 logged and reviewed requests, train
  a small model on the field reader's judgments and compare both on the same
  reviewed set. Switch only if it matches accuracy. Set a retention period for
  `requestLog/` objects before production.
- Field reader gaps: vague replacements of one bound ("onu 21.00 yap"), "the
  other option" of an OR group, and the scope of a modifier over coordinated
  types ("quiet concerts and theatre").
- Remove unused conversational helpers and their historical tests. The v1 API
  and golden runner use `recommendRequest`, which reads only the current message.

## Status log

- 2026-10-03: Plan written. `master` = `bad42d0`. Staging deployed
  (37148883212). Scheduled collection is on. Collection 37149121969 succeeded.
- 2026-10-04: [PR 45](https://github.com/Efeblk/event_recommender/pull/45) starts
  Phase 0 tasks 1–2 from `bad42d0`. The user accepted `AGENTS.md` on 2026-10-04.
  `AGENTS.md` has 62 lines. Archived 41 files and added the current v1 architecture.
  Merge is pending exact-revision CI. Runtime and workflow tasks 3–5 follow.
  Local checks passed: 131 repository links, archive preservation and diff checks.
  Source changes only update documentation paths in comments. No paid calls.
- 2026-10-04: Resolved the instruction conflict in favor of this plan.
  PostgreSQL migration and the older launch gates do not define v1 scope.
  PostgreSQL code stays in its current folders. Workflow removal is pending.
- 2026-10-04: PR 45 merged as `7a7e676`. All eight CI checks passed on `dd33560`.
  The merge has the same Git tree. The local and remote PR branch are deleted.
  Phase 0 tasks 1–2 are delivered. Tasks 3–5 are now in progress.
- 2026-10-04: [PR 46](https://github.com/Efeblk/event_recommender/pull/46)
  implements Phase 0 tasks 3–5. Local checks passed on Node 22.23.3.
  Removed the Cloudflare runtime. Node is the default build and preview.
  PostgreSQL code stays in its current folders. Its workflow steps are removed.
  Public collection artifacts contain explicit JSON report paths and no raw pages.
  Checks passed: 771 web tests, 274 collector tests, typecheck, lint, deployment
  checks, Node build/smoke, and 45 browser tests. One collector test and one
  browser test were skipped. All 130 documentation links resolve. No paid calls.
  The accepted AGENTS.md policies remain. The file now has 61 lines.
  CI, staging deploy, collection and readiness checks are pending.
- 2026-10-04: PR 46 merged as `a0aaf5d`. All seven checks passed on `3df6ba1`.
  The merge has the same Git tree. The local and remote PR branch are deleted.
  [CI](https://github.com/Efeblk/event_recommender/actions/runs/37157806177) and
  [Bi Plan](https://github.com/Efeblk/event_recommender/actions/runs/37157806178)
  passed on `master` at `a0aaf5d`.
- 2026-10-04: [Staging deploy 37158069593](https://github.com/Efeblk/event_recommender/actions/runs/37158069593)
  succeeded on `a0aaf5d`. The verified image runs as `biplan-staging-00036-jpq`.
  The deployment artifact preserves the image digest and source revision.
  `/api/ready` returned 200 at `2026-10-03T22:25:25.021Z`, with 8,724 eligible
  events and no pending search publication. Staging remains private.
  The T3 Code browser loaded the live catalog. All six home cards matched their
  nine stored provider observations. The cards were distinct. No paid calls.
- 2026-10-04: [Collection 37157847678](https://github.com/Efeblk/event_recommender/actions/runs/37157847678)
  succeeded on `a0aaf5d`. Canonical readback passed. The durable checkpoint has
  14,559 source records. The report lists 4,315 refreshed pages, 150 failed pages
  and 5 quarantines. Provider coverage remains partial.
  Artifact `11287985394` contains 10 JSON/JSONL files and no raw page files.
  The publication receipt and source report remain in the run artifact.
  Indexing was disabled: zero requests and zero attempts.
- 2026-10-04: Final `/api/ready` returned 200 at `2026-10-03T23:15:33.943Z`.
  It reported 8,847 eligible events and no pending search publication.
  Its checkpoint time matches collection `37157847678` at
  `2026-10-03T22:56:52.970Z`. All Phase 0 acceptance checks passed.
  This status update changes documentation only. Keep the verified staging image
  from `a0aaf5d`; its runtime contents are unchanged. No paid AI calls.
- 2026-10-04: Cleanup. Removed the legacy Python project (`src/`, `tests/`,
  `frontend/`, `config/`, `scripts/`, Python and Docker files) and its `CI`
  workflow. The deploy gate no longer requires the `test` check. The root
  `.gitignore` no longer hides new `collector/lib/` files. Removed extra
  worktrees and merged branches; `archive/postgres-catalog-staging-wip-2026-10-03`
  remains.
- 2026-10-04: Phase 1 preparation pins collection `37181072133` and its
  `collector/state/events.json`: 14,577 source records, 29,467,263 bytes,
  SHA-256 `20ad813f83491e2014396bc628b2193058c51ef92b620d1f2cac04918ac7efe6`.
  The frozen time is `2026-10-04T06:50:27.793Z`. Production preparation admits
  8,845 sessions. A private GCS archive has the same verified SHA-256.
- 2026-10-04: The user approved all 40 golden requests and expected constraints
  (25 Turkish, 15 English, two corrections). The user approved a $2 Phase 1 Jev
  cap and unrestricted Voyage use. No paid calls have been made in Phase 1 yet.
  The current index estimate is 3,920 documents, approximately 1.22 million
  Voyage tokens ($0.15; conservative byte envelope $0.48, no free-credit assumption).
  The old `37061051538:1` reservation is still in flight. Recovery is pending.
- 2026-10-04: The golden runner uses production parsing, identity, retrieval and
  ranking. It caches provider responses and preserves failed attempts. Labels
  remain pending. The offline catalog audit finds hard matches for 34 requests;
  six require empty-result review. Full indexing, the scored baseline, user label
  review and staging p95 remain pending. Phase 1 is not complete.
- 2026-10-04: [PR 50](https://github.com/Efeblk/event_recommender/pull/50)
  merged as `6ccc264`. All six CI checks passed on `f63edde`. The branch is
  deleted. Recovered the old `37061051538:1` response: six vectors and 1,892
  tokens, with zero new paid calls. Its private recovery receipt remains under
  `embedding-audit/staging/3ae905c06ef26ad917d367f08a246d9f3fd5980bee3910c12c61543981ac27a8/37061051538/`.
  The reservation is cleared. A new finite index window is recorded; automated
  indexing stays disabled while the approved manual full-index job runs.
- 2026-10-04: Preserved the first partial baseline in
  `web/work/phase-one/baseline-partial.json`. Voyage query four returned HTTP 429.
  New paid baseline calls stopped. The first three requests exposed a Sunday
  date error: "this weekend" selected October 10–11 instead of October 3–4.
  The fix keeps this weekend on Sunday, shares 21-second Voyage pacing across
  local jobs, and records an explicit recovery separately from the failed charge.
  Lowercase district names now survive mixed-case currency text such as `TL`.
  Local checks passed: 785 web tests, typecheck and lint on Node 22.23.3.
  Node build/smoke and GCP configuration checks passed with zero cloud/AI calls.
  An initial paced recovery exhausted the evaluation embedding timeout while
  waiting. That failed attempt stays recorded. The harness timeout includes its
  shared pacing wait; staging keeps the production timeout. Document accounting
  locks no longer cover provider waits. The separately recorded recovery passed.
  Full indexing and the recovered diagnostic baseline are running. Their partial
  vector coverage cannot pass the final quality gate. Labels remain pending.
- 2026-10-04: Oracle comparison now follows production evidence semantics:
  per-ticket and per-person ceilings compare the same listed ticket price;
  positive companion atoms describe attendees; equivalent De Morgan trees keep
  their exclusions. Group totals and strict comparisons stay distinct. The
  approved requests and expected constraints are unchanged. The diagnostic run
  has exposed category-negation scope and attendee-dancing interpretation
  failures. A calm partner request is empty and needs full-index/source review.
- 2026-10-04: The paced diagnostic run reached all 40 requests. No further
  provider failure occurred. Its first complete replay made zero paid calls and
  used 103 cached responses. It preserves 10 category violations in `tr12`, an
  unsupported beginner request (`en08`), and the attendee-dancing mismatch
  (`tr19`). Source review found two duplicate sessions under variant titles in
  `tr02` and `tr03`; the exact-title audit missed them. The full-index run still
  has pending documents. This diagnostic is not a passing Phase 1 score.
- 2026-10-04: [PR 51](https://github.com/Efeblk/event_recommender/pull/51)
  merged as `da0a4ef`. All six CI checks passed on `fa65052`; its branch is
  deleted. The second fix batch corrects negation scope, attendee dancing,
  beginner preferences, superseded district references and structured calm
  shortlist coverage. Three source-reviewed title pairs and one venue pair
  preserve distinct times, venues and audience policies.
- 2026-10-04: `web/work/phase-one/fix-one.json` completed all 40 requests:
  zero hard violations and zero automatic duplicate candidates. Its run hash
  is `8d0e573afcd5f9b0b3d63c8e29cad6c22df881722955c5c2edcaa94718b23e00`.
  The district correction exposed a superseded exclusion; its fix passes a
  zero-paid replay. Merging the Discman offers requires new rankings for the
  English correction chain. `fix-two.json` is filling those cache entries.
  Checks pass: 790 web tests, typecheck, lint, 275 collector tests (one skipped),
  GCP configuration, Node build and smoke. Full indexing, source labels, user
  sample review and staging latency remain pending. Partial vectors cover
  3,934 of 8,831 eligible sessions; this diagnostic cannot pass Phase 1.
- 2026-10-04: `fix-two.json` completed 40 requests with zero parser mismatches,
  hard violations or automatic duplicate candidates; it reused 103 responses
  and made two new ranking calls. Source review then found a hologram circus
  and pub quiz sold under `Tiyatro`. Ranking now checks the described program
  when it contradicts a provider category. Preserved targeted probes exclude
  both entries and retain matching plays. `fix-two-format.json` checks the
  policy across all 40 requests. Full vectors and reviewed labels remain pending.
- 2026-10-04: [PR 52](https://github.com/Efeblk/event_recommender/pull/52)
  merged as `cf66417` after all six checks passed on `64d3b1a`; its branch is
  deleted. The 40-request format diagnostic and zero-paid replay share result
  hash `d0dbe5ec209d9e7d07bf469345127c7dff5c3a46eecf85550004fa2b38c9ec18`.
  The replay uses 105 cached responses. Full coverage and labels remain pending.
- 2026-10-04: The source audit of empty results finds 84 age-supported theatre
  sessions excluded by the broad `show` category. The two child-show empties
  are incorrect. A narrow follow-up includes theatre in shows, retains age
  evidence and category exclusions, and passes 791 web tests, typecheck, lint,
  Node build and smoke. `child-shows.json` reruns all 40 approved requests.
  This follow-up exceeds the two planned fix PRs in task 6; obtain user approval
  for the concrete additional PR before merge. Phase 1 remains incomplete.
- 2026-10-04: The user approved the additional child-show fix in
  [PR 53](https://github.com/Efeblk/event_recommender/pull/53). It merged as
  `bb5f123` at 12:40 UTC after all six checks passed on `bb67eba`; its branch
  is deleted. Both child requests return ten age-supported plays. The preserved
  40-request diagnostic and zero-paid replay share result hash
  `60d05f813659e83c4a7468478179f1a802ba97aad57dd1c2ebe2cb1795158af3`.
  Full indexing, final labels, user sample review and staging latency remain pending.
- 2026-10-04: Private staging deployment
  [37203260179](https://github.com/Efeblk/event_recommender/actions/runs/37203260179)
  succeeded on `bb5f123`; all six exact-commit CI checks and the immutable Linux
  candidate checks passed. Revision `biplan-staging-00037-f2m` receives 100% traffic.
  Health reports the expected SHA and `/api/ready` returns 200. IAM remains private.
  The frozen-catalog source audit confirms 84 supported matches for each child
  request and zero hard matches for `tr21`, `tr22`, `tr24` and `tr25`.
  Full-vector coverage and measured acceptance remain pending.
- 2026-10-04: Full indexing published 1,418 new vectors and read back all 3,948
  document hashes. `vectors.json` covers all 8,831 frozen eligible sessions;
  SHA-256 is `a793e40584120cefb97099e0a384e9a15ad5597166cc25a55ec30102bb0e4841`.
  `full-baseline.json` starts the 40-request full-vector run. Scheduled collection
  [37201756266](https://github.com/Efeblk/event_recommender/actions/runs/37201756266)
  succeeded and published 8,699 eligible sessions (205 failed pages, 13 quarantines).
  A readback found 152 new document hashes; incremental indexing reuses the captured
  cache and preserves the frozen export. Staging latency awaits that coverage.
- 2026-10-04: The first full-vector baseline completed 40 requests; its
  zero-paid replay matches result hash
  `618e36b5f296d129004267e3b5ca792c1bc8652df5dd95a8801f6f87e403799d`.
  Source review found a duplicated Rossi Suadiye social event, a talk sold as
  a concert and a child-only workshop in a friends' dance request. These prevent
  acceptance. A focused fix adds the reviewed Rossi title pair, keeps separate
  Sanat dance-night source clocks while displaying one programme, and tightens
  format/audience scoring. Checks pass: 794 web tests, typecheck, lint, Node build
  and smoke, 275 collector tests (one skipped). `full-fixed-two.json` reruns all
  40 requests. This additional fix PR needs user merge approval under task 6.
- 2026-10-04: Incremental indexing completed at 13:48 UTC. It published the
  remaining 152 vectors and read back 4,275 frozen/current document hashes.
  The frozen vector export is unchanged. Final coverage readback, result labels,
  user sample review and staging latency remain pending.
- 2026-10-04: The user approved the additional fix in
  [PR 54](https://github.com/Efeblk/event_recommender/pull/54). It merged as
  `1989694` at 14:24 UTC after all six checks passed on `4a1bf8b`; its branch
  is deleted. `full-fixed-three.json` and its zero-paid replay complete 40
  requests with result hash
  `b0bcd6f53db8d388381d5f9794864edf712365c6e1c2accd80d81cf7cff4ea6c`.
  Source review labels all 286 cards: zero hard violations or duplicates,
  four correct empties, and relevant top-three cards for 36/40 requests (90%).
  The user reviewed and approved 17 actual result lists. Labels bind the fixture,
  catalog, original run and result hashes. `frozen-quality-final.json` passes
  the frozen quality bar. Staging latency remains pending.
- 2026-10-04: `index-verification-final-three.json` confirms all 3,832 current
  staging document hashes and all 8,831 frozen eligible sessions have vectors.
  The private published catalog is fully indexed. No source checkpoint changed
  during verification; frozen export hash remains `a793e40584120cefb97099e0a384e9a15ad5597166cc25a55ec30102bb0e4841`.
- 2026-10-04: Pin the approved golden fixture to CRLF in `.gitattributes`.
  Git's stored LF blob otherwise changes the raw fixture hash on Linux.
  Export checks with `core.autocrlf=false`, `true` and `input` all preserve
  the approved hash `b4fc63d47fe2de9f25c1b61098cc14f66c08455802c9c2ec664b309ec224c4d0`.
  The requests, constraints and existing captured responses are unchanged.
- 2026-10-04: Private staging deploy
  [37209512632](https://github.com/Efeblk/event_recommender/actions/runs/37209512632)
  succeeded on merged fix `1989694`. All six master checks and immutable image
  checks passed. `staging-latency-one.json` measured all 40 serial searches:
  HTTP 200 for every request, p95 5.530 s, maximum 16.782 s. The 10.383 s and
  16.782 s responses stay included; no timed search was excluded or retried.
  Source SHA stayed fixed. The benchmark flag affects visitor limits only.
  `staging-latency-final-restored.json` verifies normal limits on active revision
  `biplan-staging-00040-w9z`, 100% traffic, private IAM and full index readiness.
- 2026-10-04: Phase 1 is complete. `phase-one-acceptance-final.json` passes all
  acceptance checks: full frozen/current vectors, 40 labelled requests, 17
  user-reviewed lists, zero hard violations or duplicates, four correct empties,
  36/40 relevant top-three results (90%), matching zero-paid replay (112 cache
  hits), and staging p95 5.530 s. Jev accounting is $0.92805 against the approved
  $2 cap, including the conservative $0.80 staging reserve; exact staging token
  usage is not exposed. Voyage remains under the user's unrestricted approval.
  Frozen catalog and result hashes remain recorded above. Phase 2 has not started.
- 2026-10-04: [PR 56](https://github.com/Efeblk/event_recommender/pull/56)
  merged as `88492e1` and deployed (37214269011). Indexing runs hourly with a
  daily window (`GCP_STAGING_INDEXING_UNTIL=open`, 96 calls). First hourly run
  37225790152 succeeded with 0 pending documents. Phase 2 started.
- 2026-10-04: PR 57 adds the hourly `monitor` job and the recovery steps.
  The 7-day unattended run starts at its merge. No deploy is needed: the runtime
  is unchanged.
- 2026-10-05: Kept GitHub as the collection clock. PR 58 (Cloud Scheduler
  dispatch) was reverted in PR 59. Cloud Monitoring emails if the authenticated
  `/api/ready` uptime check fails or no collection is published for 14 h
  (`docs/gcp-collector.md`). The unused Cloud SQL instance, its secrets and
  identity were deleted (PR 60).
- 2026-10-05: Two collection faults were seen and fixed; the catalog never
  expired. Run 37291537657 failed with import HTTP 400: carried-forward
  retirement stamps were older than the server's 72 h limit (fixed in PR 61).
  Run 37296836433 hit the 60-minute job limit during a 20-minute import; the job
  now has 90 minutes (PR 62). Collection
  [37304234732](https://github.com/Efeblk/event_recommender/actions/runs/37304234732)
  succeeded: 8,788 eligible events, `lastCheckedAt` 2026-10-05T12:19:09Z.
  No deploy; the runtime is unchanged.
- 2026-10-05: The user approved opening staging for 24 h to friends. At 13:46 UTC
  `allUsers` received `roles/run.invoker` and `BIPLAN_PREVIEW_TESTING=true`
  (revision `biplan-staging-00041-4hr`, same image `88492e1`) turned off the
  shared visitor limit. `AI_DAILY_LIMIT=100` still applies (at most about $2/day).
  Admin endpoints return 401 without the sync token. Close at 2026-10-06 13:47
  UTC: remove the `allUsers` binding and set `BIPLAN_PREVIEW_TESTING=false`.
  Five live searches before opening returned correct results.
- 2026-10-05: A staging search "yarın iki kişilik sevgilimle taksim civarı
  konser olmayan etkinlik" returned `unsupported_constraint`. The parser's
  unsupported-clause judgment (`unsupported_s0`) scored "konser olmayan" at
  0.58–0.66 (limit 0.55). Taksim and "sevgilimle" were not the cause. The
  question now names an excluded event type, topic or genre as supported.
  The sentence then scores 0.28; valet and smoke-free venue requests stay
  unsupported. Parser benchmark (200 cases, live, about $0.04 in total): 186
  before and 186 after; unsupported 40/40 in both runs; false unsupported 2 → 1.
  One borderline ambiguous case (`en-ambiguous-12`) changed on an unrelated
  edit judgment. Not deployed yet.
- 2026-10-05: Deployed `9102e0b` to staging (run
  [37377931807](https://github.com/Efeblk/event_recommender/actions/runs/37377931807)).
  The deploy removed `allUsers` and set `BIPLAN_PREVIEW_TESTING=false`. Both were
  restored for the approved 24 h test on revision `biplan-staging-00044-85f`
  (same image). The test still closes at 2026-10-06 13:47 UTC. The live search
  "yarın iki kişilik sevgilimle taksim civarı konser olmayan etkinlik" returned
  16 cards for 2026-10-07: Beyoğlu hard, Taksim preferred, no concerts. Source
  review found one duplicate: "Stand Up Açık Mikrofon Beyoğlu Çarşamba"
  (Biletix) and "Stand Up Taksim Gecesi & Açık Mikrofon Çarşamba" (Bubilet).
  Both are İnfiniti Sahne at 20:30 with the same programme. This is open.
- 2026-10-06: Duplicate fix for the İnfiniti Sahne open-mic night. One title
  seed joins the Biletix, Bubilet and Biletinial titles for the same Wednesday
  and Thursday 20:30 sessions. "Bi Şaka" stays a separate show. Audit of the
  2026-10-05T12:38 staging checkpoint (14,416 listings): sessions 11,288 →
  11,272. Unreviewed splits stay at the same 8; same-provider sessions stay 0.
  `audit-identity-snapshot.ts` now lists the unresolved same-venue,
  same-time title pairs (439 pairs, 1,108 session pairs) for source review.
  The fix applies after a deploy and the next collection publication.
- 2026-10-06: Deployed `58b76e2` to staging (run
  [37381425679](https://github.com/Efeblk/event_recommender/actions/runs/37381425679)).
  GitHub did not fire the scheduled collector runs from 23:47 to 02:47 UTC.
  Monitor run [37408484720](https://github.com/Efeblk/event_recommender/actions/runs/37408484720)
  failed on a 15 h old catalog. Collection
  [37423794561](https://github.com/Efeblk/event_recommender/actions/runs/37423794561)
  published the catalog at 07:07 UTC. The same search returned 16 cards for
  2026-10-07. The open-mic night is now one card with Biletix, Biletinial and
  Bubilet offers. "Bi Şaka Stand Up" stays a separate card. No duplicates.
  The friends test closed at 13:56 UTC: `allUsers` removed and
  `BIPLAN_PREVIEW_TESTING=false` on revision `biplan-staging-00047-m8n`.
  Anonymous requests return 403.
- 2026-10-06: User approved a second 24 h friends test. Opened at 14:12 UTC
  on revision `biplan-staging-00048-vfx` (image `58b76e2`): `allUsers`
  run.invoker and `BIPLAN_PREVIEW_TESTING=true`. Catalog published 07:07 UTC.
  An anonymous search for the same request returned 15 cards. The borderline
  "Bu Gece Boğazdayız" card dropped out. The test closes at 2026-10-07
  14:12 UTC: remove `allUsers` and set `BIPLAN_PREVIEW_TESTING=false`.
- 2026-10-06: New request parser (field reader). The span-first parser dropped
  conditions its patterns did not know (the friends-test search "iki gün sonra
  taksim civarı sevgilimle gidebileceğim etkinlik" lost its date). The field
  reader asks Jev for each supported field of the whole message and lets code
  resolve it. PR #70 (day-count patterns for the old parser) is closed.
  Benchmarks, `jev-1.13.0`, about $0.66 of Jev calls:
  - Frozen 200-case plan benchmark (written for the old parser, which scores
    186/200 on it): 179/200. Clear 117/120, unsupported 40/40, ambiguous
    22/40. Of the 21 failures, 8 differ only by product policy, the same as
    the old parser (bare budgets as ticket prices, romantic as a preference).
  - New realistic first-turn set (`web/parser/bench/realistic-v1.mjs`, 40
    requests, written after the reader): old parser 30/40, all failures
    dropped conditions; field reader 36/40 on the first run, 37/40 after
    fixes that the set prompted, so the set is no longer independent.
  Median parse time 0.43 s (about 17k input tokens, $0.0007 per request).
- 2026-10-06: Deployed `b2d435d` (field reader, PR #71) to staging (run
  [37492849530](https://github.com/Efeblk/event_recommender/actions/runs/37492849530)).
  The friends test was restored on `biplan-staging-00050-ckl` and still closes
  at 2026-10-07 14:12 UTC. Live searches, cards reviewed against date,
  district and type: "iki gün sonra taksim civarı sevgilimle..." now has the
  date (11 cards, 2026-10-08, Beyoğlu); "yarın iki kişilik sevgilimle taksim
  civarı konser olmayan etkinlik" 14 cards, no concerts, one open-mic card;
  "bu cuma akşamı kadıköyde caz konseri, kişi başı 600 tl'yi geçmesin" 1 card
  (21:30, 500 TL); "fikirtepe civarında bu hafta sonu ne var" 8 Kadıköy cards
  (Fikirtepe is not in the neighbourhood list). "önümüzdeki 10 gün içinde
  ücretsiz sergiler" was empty: no listing confirms a free price. The first
  request after the deploy took 29 s (cold start); later ones 1–3 s.
- 2026-10-06: Request log for parser evaluation and training. It is active only
  while an approved staging test runs and the page shows a notice.
- 2026-10-06: Deployed `871aa91` (request log, PR #73) to staging (run
  [37504718574](https://github.com/Efeblk/event_recommender/actions/runs/37504718574)),
  revision `biplan-staging-00052-hck` with the friends test restored. The
  first logged user search, "üç gün sonra sevgilimle gideceğimiz 1000tl kişi
  başı taksim civarı konser olmayan etkinlik", asked for clarification: the
  number finder needed a space after digits, so "1000tl" had no candidate, and
  "Taksim civarı" made the price "around". Fix: every digit run is a
  candidate; the budget question limits "civarı" to the word before it. The
  search now reads 2026-10-09, Beyoğlu (Taksim preferred), partner, no
  concerts, at most 1000 TL per person. Realistic set: 36/40 (Jev variance on
  three earlier failures and "bu ay").
- 2026-10-06: [PR 75](https://github.com/Efeblk/event_recommender/pull/75)
  makes each request independent, as the user requested. The page sends only
  the current message. The API ignores old plans, history, filters, pending
  text and event IDs. The server selects the parser protocol. Editing uses the
  full message. Retries send the same request. Each new search clears old results.
  Local checks passed on Node 22.23.3: 815 unit tests, typecheck, lint, Node
  build/smoke, 46 deployment checks and 31 browser checks (one viewport skip).
  The T3 browser confirmed two message-only requests and replacement of the
  first result. No paid calls. Failed browser logs and traces stay in
  `web/work/request-isolation/`. The 40-case golden preparation passed on the
  frozen catalog (`web/work/phase-one/request-isolation-preparation.json`).
  `tr25` and `en15` now state all conditions. The revised fixture needs user
  review before a new scored run. The scored attempt stopped at that gate.
  CI and merge remain pending. Local GCP sign-in has expired. Staging deployment
  remains pending; the approved friends-test window stays as it is.
- 2026-10-07: PR 75 merged as `60e38d0`. Exact master CI passed (run
  [37524716202](https://github.com/Efeblk/event_recommender/actions/runs/37524716202)).
  Staging deployment passed (run
  [37535356620](https://github.com/Efeblk/event_recommender/actions/runs/37535356620)).
  Revision `biplan-staging-00055-j9k` serves the independent-request fix.
  Its SHA and image digest match the deployment provenance artifact.
  Anonymous `/api/health` and `/api/ready` return 200. Readiness is true with
  8,835 eligible events. The T3 browser also opened the live health endpoint.
  The friends test has `allUsers` run.invoker and `BIPLAN_PREVIEW_TESTING=true`.
  It still closes at 2026-10-07 14:12 UTC. No paid calls. Deployment provenance
  and live checks stay in `web/work/request-isolation/`.
