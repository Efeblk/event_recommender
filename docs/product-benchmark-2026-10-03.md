# Product tests and benchmarks — 2026-10-03

Bi’ Plan's main offline suites pass on current Node 22. All ten authorized staging requests returned HTTP 200, with search p50/p95 of 3.62/4.07 seconds, and every returned offer matched captured source evidence. Product correctness still fails: Turkish `tür fark etmez` introduces an unwanted tour constraint, a calm evening request returns afternoon/weak-fit cards, and six-year-old suitability is not represented. Local compiled filter search also misses its concurrency target, likely duplicate choices appear in the historical fixture, and the standard Cloudflare smoke check fails. This is a development assessment, not public-launch qualification.

## Revision and scope

Tested application revision: `9f82f31b0abd6a3e991a5f3c9c60f4615093e0da`. The tracked tree was clean during the runs. No application, schema, dependency-lock, deployment, or provider data files were changed. Dependencies were installed from their locks. Node `v22.13.1` tests the documented minimum; Node `v22.23.3` satisfies the major-22 pin in `web/.nvmrc`. This report is the only tracked addition.

The local phase used zero paid-provider or cloud calls and disposable D1 instances. After GCP authentication was renewed, the staging phase used **exactly ten recommendation requests**, no automatic retries, and one cumulative **$1 reservation** including auxiliary reads. Actual provider token usage and billed dollars are not exposed by the serving API and remain unknown. No resources were provisioned, preparation jobs started, catalog embeddings regenerated, or deployments changed. API/browser fixtures establish local contracts; the separate staging evidence establishes only the bounded live cases below. Runtime/hardware, source hashes, command receipts, complete logs, screenshots, raw timing samples, and harnesses are preserved in the evidence bundle.

## Verification results

| Check | Result | Evidence / qualification |
| --- | --- | --- |
| Web `npm test`, Node 22.23.3 | 754 passed, 0 failed | TAP 11.86 s; wall 12.74 s |
| Collector `npm test`, Node 22.13.1 | 274 passed, 0 failed, 1 skipped | TAP 7.05 s; wall 7.48 s; real PostgreSQL pipeline test is opt-in |
| Web typecheck / lint | Both passed | Wall 18.48 / 4.29 s |
| Deployment configuration tests, Node 22.23.3 | 75 passed | GCP configuration check also passed; no cloud access |
| Frozen conversation contracts | 20/20 passed | Fixture reference date retained; no live requests |
| Desktop/mobile browser contracts | 43 passed, 1 skipped | 30.1 s; Chromium, two workers; recommendation APIs mocked |
| Cloudflare / Node builds | Both passed | Wall 112.01 / 18.30 s; concurrent check/build activity, not build-speed benchmarks |
| Compiled Node smoke | Passed | UI, public configuration, authorization, missing-storage handling; no GCP/AI calls |
| Voyage adapter in workerd | Passed | Offline loopback provider; run separately because the combined smoke command stopped early |
| Standard compiled Cloudflare smoke | **Failed twice** | Node 22.13.1 and 22.23.3; application logged `/api/admin/collection` HTTP 413 before Undici `terminated` / `ECONNRESET` |

The smoke failure occurs while consuming the oversized-request rejection response. A local Wrangler/Miniflare/workerd transport issue is plausible, consistent with the failure family already mentioned in `scripts/smoke.mjs`; its cause is **not proven**. The standard command remains failed, and assertions after that point have not passed in this run. No modified smoke test substitutes for that result.

On Node 22.13.1, web tests were 753/754 and deployment configuration tests were 71/72: child/plain Node test processes imported `.ts` without enabling type stripping and failed with `ERR_UNKNOWN_FILE_EXTENSION`. Both complete suites passed on 22.23.3. This reveals a verification-runner compatibility gap in the advertised minimum version; it does not establish an application runtime failure.

The T3 integrated browser opened successfully. Its actual unmocked local UI showed the stale-catalog notice and withheld event cards. Visually inspected desktop (1280×800) and mobile (375×812) screenshots showed no horizontal overflow or console errors. One desktop navigation observed 502 ms DOMContentLoaded and 529 ms load; that single observation is not a frontend performance distribution. The browser contract suite separately checked hydration, keyboard submission, retry snapshots, clarification choices, budgets, alternatives, and resets.

## Warm recommendation-pipeline benchmark

The checked-in cached-Voyage benchmark could not run because this worktree has no local embedding cache. A preserved work-artifact harness used deterministic synthetic **1,024-dimensional** vectors and a Jev support stub instead. The catalog's original clocks were retained and the request clock was frozen to its newest observation; this is historical replay, not current availability.

Of **4,076** source rows, **3,603** were eligible at that reference time and **3,245** had synthetic vectors. Every one of **130 measured requests** passed the full eligible set into retrieval before selecting and returning 16 production identities accepted by the deterministic support stub. There was one warm-up and ten batches each at concurrency 1, 4, and 8. Module/catalog/vector loading occurred before timing.

| Concurrent requests | Measured requests | Request p50 | Request p95 | Median amortized process CPU/request |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 10 | 142 ms | 155 ms | 140 ms |
| 4 | 40 | 601 ms | 676 ms | 156 ms |
| 8 | 80 | 1,160 ms | 1,329 ms | 145 ms |

Nearest-rank percentiles use retained individual wall samples. CPU at concurrency greater than one is process CPU for a batch divided by its request count. Promise concurrency uses one Node event loop; it is not parallel-isolate throughput. Peak host-process RSS was **326.8 MiB** and heap **231.1 MiB**. All predeclared broad local CPU/batch/memory thresholds passed.

At concurrency 1, injected dependency medians were candidate delivery 0.003 ms, vector-map lookup 0.554 ms, query-embedding stub 0.005 ms, and ranking stub 0.023 ms. Most elapsed time was internal filtering, exact vector/lexical retrieval, deduplication, and shortlisting. Concurrent stage wall samples overlap and include sibling-request work; they cannot be summed as exclusive stage costs or interpreted as provider latency.

Six targeted fixture checks passed: strict budget, category, Turkish negation, mandatory accessibility evidence, missing-vector lexical discovery, and production distinctness. The existing fictional saved-score evaluator passed 12/12 whole lists, 9/9 positive top-1 cases, 3/3 expected-empty cases, precision 1.0, and its labeled positive-case candidate recall 1.0. Those are bounded regression results. Synthetic full-catalog vectors have no labeled relevance oracle and no ANN branch, so this run does **not** measure real Voyage recall, Jev quality, or approximate-versus-exact recall. Passing identity-key assertions also does not prove semantic distinctness, as the compiled-card review below shows.

## Compiled filter-search benchmark

The real compiled Worker ran against disposable D1, with AI disabled and visitor rate limiting explicitly bypassed for diagnostic timing. An untouched baseline first verified 4,076 stored rows, **zero currently eligible rows**, and HTTP 503 `catalog_unavailable`. Then a **synthetic time-shifted historical fixture** uniformly moved session, observation, offer, and admission-window clocks; it changed no other source fields. Original and transformed hashes are retained. These synthetic clocks are not fresh provider observations.

The transformed health count was 3,784 eligible rows; requests received 2,896 canonical candidates after the store's preparation/filtering. Five batches at each concurrency, following a warm-up, produced **65 retained measured responses**. The first post-setup request took 1,016 ms; setup and prior health reads prevent treating it as a controlled cold start.

| Concurrent requests | Measured requests | Dispatch p50 | Dispatch p95 | Target p95 <1,000 ms |
| ---: | ---: | ---: | ---: | --- |
| 1 | 5 | 936 ms | 947 ms | Pass |
| 4 | 20 | 3,604 ms | 3,746 ms | **Fail** |
| 8 | 40 | 7,516 ms | 8,031 ms | **Fail** |

There were **zero unexpected HTTP errors**. Each response contained 16 cards. All **1,040 card appearances and 1,235 offer appearances** passed the harness's transformed-source, freshness, price, category, currency, and link checks. An independent audit additionally matched every card title and venue to untouched original records, and manually reviewed all **16 unique cards**. This is fixture integrity, not current ticket-provider verification or subjective relevance.

Server-Timing candidate-stage p50/p95 was 787/799 ms at concurrency 1, 1,332/2,577 ms at 4, and 4,277/6,972 ms at 8. Server-total p95 was 941, 2,735, and 7,207 ms respectively. Candidate work dominates the recorded server time; these spans do not separate SQL, record decoding, canonicalization, and JavaScript work. Dispatch includes additional local transport/queue waits. This is a measured local bottleneck to investigate, not proof of a particular SQL defect or deployed capacity limit.

Although all responses had distinct implementation identity keys, independent review found **likely repeated choices**: two “The Sisters 90s 2000s Pop Gecesi” spelling variants at Blind İstanbul (14-minute clock difference), and three “İstanbul Oktoberfest” variants at Life Park with identical clocks. Their record IDs and full families are preserved in the card/family audits. The time discrepancy and festival day/pass variants require conservative identity review; no automatic merge was performed and no overall semantic-distinctness pass is claimed.

The first Worker attempt completed its timing loops but failed the p95 assertion before emitting detailed output. Its exact harness and failure receipt are retained. A single local rerun persisted full output before the same target assertion, then correctly exited 1. Only the retained rerun supplies the table above; it does not relabel or erase the initial failure.

## Authorized staging AI evaluation

Private staging: [Bi’ Plan on Cloud Run](https://biplan-staging-igfexsu5aa-uc.a.run.app). GCP access was verified after authentication renewal. Before and after the evaluation, 100% of traffic served `biplan-staging-00034-fdd`, application SHA `9f82f31b0abd6a3e991a5f3c9c60f4615093e0da`, immutable image digest `sha256:6f155a4e1c44dc700723d35d7a151a7f242025d8c6e26552e1060ff2e76e3bbd`. No test-only rate-limit bypass was enabled. The runtime used span-v2 intent parsing, one CPU, 2 GiB, maximum one instance, request concurrency 32, and a 300-second server timeout.

Acceptance was frozen before the calls: zero unexpected errors, stale/unsupported offers or hard-constraint violations; serial request p95 below 8 seconds; every-card source and semantic review; empty-result catalog audit. Calls were paced at least 13 seconds apart, concurrency 1, no automatic retries. Slots 9–10 were reserved for confirmation. After case 07 failed, slot 9's planned English correction was replaced, before that call, with an independent diagnostic that removed only `tür fark etmez` from case 07. The original fixture and a hashed addendum are retained; old results were not rewritten. This leaves English follow-up correction untested live.

| Case | Returned cards | Elapsed | Outcome and review |
| --- | ---: | ---: | --- |
| 01 Turkish concert, October 4, Kadıköy, ≤1,000 TRY/person | 1 | 3,704 ms | Constraints/source pass: Çağrı Sinci, offers 499/599 TRY |
| 02 English theatre, October 4 after 20:00, excluding stand-up, ≤800 TRY/person | 8 | 4,069 ms | Encoded constraints/source pass; subjective genre labels depend on source taxonomy |
| 03 Four people, stand-up under 2,000 TRY, unspecified budget basis | 0 | 1,385 ms | Correct total/per-person clarification; not an empty search |
| 04 Follow-up “Toplam bütçe.” | 16 | 2,093 ms | Four-person total <2,000 TRY preserved; each selected base price <500 TRY |
| 05 October 5, mandatory wheelchair access | 0 | 3,616 ms | Conservative empty: no positively supported sessions in the frozen typed-evidence oracle |
| 06 Six-year-old child, no profanity or sexual content | 0 | 4,066 ms | Content exclusions represented; age-six suitability unrepresented/unverified |
| 07 October 4–11, calm intimate evening with partner, “tür fark etmez” | 0 | 2,267 ms | **Fail:** unwanted hard `category:tour`; intended date-only oracle has 2,540 eligible raw provider rows |
| 08 Alternatives to case 07 | 0 | 1,488 ms | **Fail/contaminated:** unsupported-constraint clarification inherited the failed parent; alternatives exclusion not exercised |
| 09 Independent case 07 with “tür fark etmez” removed | 5 | 3,583 ms | No unwanted tour filter, but **2/5 afternoon cards** and weak calm/intimate fit |
| 10 Repeat case 01 | 1 | 3,881 ms | Exact same card and both offers; confirmation pass |

All ten calls returned HTTP 200; protocol success is not product correctness. Nearest-rank end-to-end p50/p95 for the **eight search responses** (including empty searches) was **3,616/4,069 ms**, meeting the predeclared latency threshold. All ten interactions, including the two clarifications, were 3,583/4,069 ms. There was no sustained or concurrent load test. Health/checkpoint reads preceded the first search, so neither a controlled cold start nor a cache-hit distribution was measured. Stage samples and their denominators are retained separately; interpretation, embeddings and ranking timings are real serving spans, not exclusive provider billing or CPU measurements.

| Serving stage | Samples | p50 | p95 |
| --- | ---: | ---: | ---: |
| Server total, search responses | 8 | 3,317.7 ms | 3,776.7 ms |
| Catalog | 8 | 338.1 ms | 480.5 ms |
| Daily limit | 8 | 81.0 ms | 146.5 ms |
| Interpret | 8 | 192.4 ms | 241.8 ms |
| Candidates | 8 | 313.1 ms | 382.9 ms |
| Vectors | 5 | 66.3 ms | 207.0 ms |
| Query embedding | 5 | 136.0 ms | 652.8 ms |
| Rank | 5 | 205.2 ms | 289.6 ms |

Only the five nonempty semantic paths exposed vector/embedding/rank stages; missing stages are not zero-duration samples. These small samples do not support tail-latency extrapolation.

Independent review checked **31 card appearances and 50 offer appearances** against the immutable captured collection checkpoint. Every offer matched record ID, link, base price, currency, venue, category, availability and observation clock; every card matched its returned hard plan and encoded fixture constraints. No within-response semantic duplicate pair was identified. This verifies evidence consistency, not current checkout stock, four adjacent seats, fees, or a newly fetched provider-page response. Group affordability uses listed aggregate starting prices, so fee-inclusive checkout affordability remains unverified.

The wheelchair/content empties reflect missing positive evidence; they do not prove that no suitable Istanbul events exist. The six-year-old requirement remains in original text but has no typed age condition. In case 07, deterministic folding maps `tür` to the configured tour alias `tur`, before Jev judges intent; plain `sakin`/`samimi` are also absent from the typed preference vocabulary. An offline parser diagnostic preserves minimal examples and counterexamples. This is a confirmed interpretation defect; no product fix was applied.

Case 09's whole-list review separates source validity from relevance. “Notthing Hill” at 20:00 and “Brotherhood” at 20:00 are plausible partner outings. “Hikayeden Adamlar – Kırık Kalpler Partisi” at 21:00 has party framing and weak evidence for calmness. “Couple Quiz” at 16:30 and the Minoa cinema quiz at 16:00 violate the requested evening; the typed plan has no time atom. The original fixture did not encode an evening clock bound, so this additional failure is preserved as independent review rather than retroactively changing its oracle. Scores do not establish these events' calmness or suitability.

Before and after the calls, health reported **8,534 stored canonical records / 8,502 eligible**, with observation clocks from October 2–3. The raw checkpoint contained **14,774 provider records** and was byte-identical across the evaluation: SHA-256 `a6cefbe47e7b2fdf92b56f1045b0e85533176e5c303f0a521bcc474baf388b80`. These are different counting units. Current freshness therefore differs from the stale bundled fixture. The collection report nevertheless marked every provider's coverage incomplete and the cycle `complete:false`, stopped by its time budget. Its summary reports 3,513 refreshed pages, 410 failed pages and five quarantined records. Provider-specific verified, retired, stale, failed and unattempted counts remain in the checkpoint; these counts must not be added across different units or presented as complete Istanbul coverage.

The durable ledger reserved $0.10 for auxiliary reads plus $0.09 per search ($0.02 AI / $0.07 infrastructure), totaling **$1 for ten consumed slots**. No ledger reset or extra search was used. The conservative code/list-price envelope is $0.132 AI plus $0.087 full-timeout Cloud Run compute for ten requests, before auxiliary accounting; this is a ceiling estimate under the recorded input/resource assumptions, not an invoice. Pricing sources: [TypeSafe Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [Voyage](https://docs.voyageai.com/docs/pricing), [Cloud Run](https://cloud.google.com/run/pricing). Free-tier credits were not assumed. Actual provider call/token counts and billed cost remain unknown; existing unrelated resource billing is outside this test's incremental scope. The temporary local identity-token file was deleted after postflight checks.

## Freshness, coverage, costs, and remaining work

The untouched bundled catalog has **zero eligible current records** because even its newest observation is beyond the 72-hour window. Its fail-closed HTTP 503 response is a correctness result, not a successful-search latency result. The latest checked-in collector report ended September 22 and reports 907 events, 319 pages, and 58 failed pages; it is historical evidence and cannot establish October 3 inventory coverage. No live collection was performed or represented as complete.

The bounded staging section measures real search latency and case-level interpretation/relevance, and verifies current deployed freshness. Actual billed search cost, preparation cost/performance, remote PostgreSQL performance, approximate-versus-exact retrieval recall, controlled Cloud Run cold starts and capacity remain **unmeasured**. Synthetic stub timings cannot estimate their cost or reliability. Durable PostgreSQL integration, Linux Docker CI, managed recovery and unattended monitoring were not rerun. A small nonrandom ten-case evaluation is not a calibrated ranking-quality or global recall estimate.

Priorities from this assessment: fix the `tür`/tour collision, preserve evening/mood and child-age intent, and strengthen relevance evidence; investigate compiled candidate-stage contention and historical duplicate families; resolve the standard smoke failure and minimum-Node runner gap; complete declared provider coverage. Any later live confirmation must use a new concrete authorization or remaining authorized budget; this task's ten slots are exhausted. No fixes or deployment changes were made as part of the benchmark.

## Preserved evidence

Evidence directory: [`web/work/product-benchmark-2026-10-03/`](../web/work/product-benchmark-2026-10-03/). It is intentionally ignored by Git and must be retained with this report.

- `manifest.json`: revision, environment, dataset hash, and individual file hashes.
- `web-checks/`, `collector/`: complete test logs and per-command receipts, including failed minimum-version runs.
- `browser-results.json`, `ui/`: browser results and integrated-preview screenshots.
- `smoke*.log`, `*-result.json`: unchanged standard-command outcomes, including both Cloudflare failures.
- `recommendation/`: UTF-8 raw samples, original console capture, exact harness, predeclared thresholds, replay output, and failed fixture evidence.
- `collector/worker-benchmark-retry-raw.json`: all retained Worker bodies, headers, Server-Timing, source transformation and timings; run/failure receipts and both harness versions are alongside it.
- `worker-card-review.json` and the family-audit artifact: original source records, independent title/venue checks and duplicate-choice concerns.
- `staging/`: frozen live cases and addendum, ten durable attempt reservations, byte-exact request/response bodies, per-case receipts and audits, parser diagnostic, whole-list review, latency samples, cost envelope and unchanged before/after health/checkpoint evidence. Authentication credentials are excluded.

The recommendation harness initially used an invalid ASCII city value `Istanbul`, which strict admission rejected. That fixture was corrected to the repository's supported `İstanbul`/`Kadıköy` shape before any successful timing; the failed attempt remains preserved. No product policy or old evaluation output was changed to produce a passing result.
