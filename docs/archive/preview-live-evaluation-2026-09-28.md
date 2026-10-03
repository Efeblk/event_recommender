# Preview live evaluation — 2026-09-28

## Status

This document preserves both the initial failed evaluation and a separate follow-up on the temporary GCP preview. Visitor throttles are disabled for user-authorized testing; the shared 100-request daily AI cap remains. Reset handling, failure diagnostics and explicit UI retry behavior were fixed and deployed. The follow-up completed without interpreter availability errors, but complex interpretation and relevance issues remain. This is not publication-readiness evidence.

## Evaluated artifact

| Item | Value |
| --- | --- |
| Application source revision | `62680c2b27101d3087918ce97ba442e31750c998` |
| Cloud Run service revision | `biplan-preview-20260927-00007-q7l` |
| Container image | `us-central1-docker.pkg.dev/biplan-staging-efeblk/biplan-staging/biplan-preview@sha256:9a58e26534f936bdb54c259c005fd7392d2cf09946a57fbb722397675dd54405` |
| Deployment recorded | `2026-09-28T13:26:20.693Z` |
| Evaluation window | `2026-09-28T13:29:43.170Z`–`2026-09-28T13:32:46.929Z` |
| Interpreter configuration | `jev-v1` |
| Preview testing flag | Enabled on this temporary preview revision |
| Daily AI limit | 100 |
| Main service changed | No (`mainUnchanged: true`) |

The deployment record reports a successful deployment of the exact revision and image above. The temporary revision used a preview-only testing flag while retaining the daily AI cap. This result applies only to that revision and does not establish the state of any later deployment.

## Initial 30-turn result

The harness completed all 30 recommendation attempts without transport retries. All API requests returned HTTP 200 and the before/after source checks were stable. Application-level behavior was poor: 19 turns returned `interpreter_unavailable`.

| Classification | Turns | Meaning in the frozen evaluator |
| --- | ---: | --- |
| Pass | 5 | Machine assertions passed |
| Fail | 9 | Independent machine assertion failure |
| Contaminated | 16 | An ancestor failed, so the turn was excluded from independent accuracy |

Manual review found that two of the five machine passes were false passes caused by an under-specified clarification oracle:

- `budget_ambiguous` produced a generic `constraint_ambiguous` clarification instead of resolving the budget basis.
- `pending_second_ambiguity` returned `interpreter_unavailable`, but the old oracle checked only that a clarification occurred.

The machine totals therefore remain preserved as **5 pass, 9 fail, and 16 contaminated**, but they must not be read as five acceptable user flows. Contaminated descendants retain card and hard-constraint diagnostics; they do not count as independent interpretation successes.

### Card and empty-result audit

The run returned 34 cards across three turns. Every returned card was present in the frozen source catalog and passed both audits available at capture time:

- constraints in the response's committed intent state; and
- the fixture's asserted subset of requested filters and hard-evidence requirements.

This is **34 of 34 source-evidence and hard-constraint checks passed**. It does not establish subjective relevance for contaminated flows, correctness of unasserted preferences, or correctness of the interpretation that selected those constraints.

Three search turns produced genuinely supported empty results after auditing the complete frozen catalog:

- `laughter_seated`: 122 candidates remained before the seated-support requirement; none had positive seated evidence.
- `family_child_cancel`: 96 candidates remained before the step-free requirement; none had positive step-free evidence.
- `empty_free_access`: no catalog candidate satisfied the asserted filters even before accessibility evidence was applied.

Zero-card `needs_input` responses caused by clarification or interpreter failure are not counted among these three correct empty searches. Subjective review found the independent `dancing_attendee` result relevant. Results inherited by the budget and family branches remain contaminated. Two apparent title/venue clusters warrant conservative merge review, but the preserved evidence did not prove an incorrect merge.

### Request timing

Timing covers the full public Cloud Run response observed by the harness for each turn. It is wall-clock latency from one Windows client, not provider-only time or Cloud Run CPU time.

| Statistic | Value |
| --- | ---: |
| Requests | 30 |
| Minimum | 238 ms |
| Median | 3,037 ms |
| Mean | 4,845 ms |
| p95 | 15,476 ms |
| Maximum | 16,742 ms |
| Sum of per-turn response time | 145,354 ms |
| Run wall-clock window | 183,759 ms |

Per-turn durations, in fixture order, were: `741, 4103, 16742, 747, 5353, 463, 1753, 7542, 516, 1194, 7629, 635, 547, 8289, 8282, 469, 15476, 8332, 8293, 3037, 7161, 10285, 6898, 1081, 238, 6021, 2858, 1923, 8247, 499` ms. These values are retained so later summaries cannot hide slow or failed individual turns.

## Frozen catalog and embedding provenance

The final catalog capture was taken at `2026-09-28T13:29:09.995Z`, immediately before the run.

| Artifact | SHA-256 |
| --- | --- |
| Checkpoint | `2d35354a10c8781575548112305fb6c44270f36edea0a6789b1a1f6633e49b14` |
| Events | `de6098dc953c864674bf98f90408fa2873e50520757d81aba93c7fe1cbfe0a09` |
| Vectors | `ac4fa863686ed93472ba3e337d3e00f4d6ec0cfffd5988e55202757764b3882a` |

The snapshot contains 5,371 raw records, 3,978 eligible merged sessions after the production empty-filter/time gate, and 2,246 distinct document hashes. Vector coverage was 2,246 of 2,246. Of those documents, 2,189 reused identical cached vectors. Catch-up embedded the 57 missing documents in five calls using 10,777 input tokens, with a list-price estimate of **$0.00129324**. Capturing the final snapshot itself made no provider calls.

## Bounded cost record

The durable global ledger allows at most 40 recommendation attempts across all runs. Each slot reserves the conservative public upper bound before a request: up to three Jev inputs at 64,000 tokens and one Voyage query input at 32,000 tokens. At 40 attempts that bound is **$0.47616**. The document-embedding reserve is at most **$0.00768**, producing a combined conservative ceiling of **$0.48384**, below the $0.50 test ceiling selected for this run within the existing cost authorization. The initial 30 attempts account for a theoretical recommendation reserve of $0.35712; that is a bound, not measured spend.

The public API did not expose provider raw responses, internal call counts, or token usage. Actual recommendation-provider usage and cost are therefore unknown. The separately captured document catch-up token count and estimate above are known. Future traffic to the temporary public service is outside this test ledger, although the service-level daily AI limit remained active.

## Health observation and follow-up diagnostic

A separate 25-request `/api/health` observation used concurrency six and made no provider calls. The first observed request was 4,227 ms; the reported warm median was 240 ms and warm p95 was 306 ms. This was a small endpoint check from one Windows client. It is not an AI-throughput test, sustained-capacity test, or proven cold-start measurement.

One later local interpreter diagnostic consumed global ledger slot 31. Its single direct provider request took 9,911 ms and returned HTTP 503 with `upstream connect error or disconnect/reset before headers` and a latest reset reason of `connection timeout`; no usage was reported. The local helper used a 20-second diagnostic interpreter timeout rather than the deployed revision's 8-second timeout. It was not a request to the deployed application. This one direct-provider observation is evidence of one upstream connection failure, but it cannot attribute all 19 original `interpreter_unavailable` responses to that cause. The helper's wider elapsed time includes local preparation and is not provider latency.

## Evidence and limitations

The raw operational evidence is intentionally ignored by Git and must be retained alongside this tracked summary:

- `web/work/preview-e2e-20260928/runs/live-01/manifest.json`
- `web/work/preview-e2e-20260928/runs/live-01/summary.json`
- `web/work/preview-e2e-20260928/runs/live-01/*-response.json`
- `web/work/preview-e2e-20260928/runs/live-01/manual-review.md`
- `web/work/preview-e2e-20260928/global-ledger/attempt-slots/`
- `web/work/preview-interpreter-diagnostic-20260928/runs/interpreter-laughter-messy-01/diagnosis.json`
- `web/work/preview-interpreter-diagnostic-20260928/runs/interpreter-laughter-messy-01/provider-1-response.json`
- `web/work/preview-rollout-20260928/deployment-62680c2b2710/result.json`
- `web/work/preview-rollout-20260928/health-load.json`
- `web/work/preview-rollout-20260928/catalog-final/`

The harness captured complete public API responses and headers, fixture expectations, request lineage, timing, source hashes, and frozen catalog records used for card and empty-result review. The public endpoint did not expose raw Jev or Voyage bodies. The catalog audit proves only the fixture's asserted constraint subset plus committed-state constraints; it cannot prove unasserted intent. Subjective relevance remains a manual judgment. The health sample and single diagnostic are too small and differently configured to support a capacity or root-cause conclusion.

## Replacement app and follow-up

Source `f17e36c7abe3a40970e777e18c72f0b0e0874fbd` was deployed at
`2026-09-28T13:54:37.884Z` as `biplan-preview-20260927-00008-rpd`, using
`us-central1-docker.pkg.dev/biplan-staging-efeblk/biplan-staging/biplan-preview@sha256:b73f53e1151037953c9ea1f24982d474b569a99b160ed11c8de3a208d54f173d`.
Private staging, service IAM, secrets and infrastructure caps were unchanged.

The app recognizes complete standalone reset commands before constructing a Jev
request, including the failed Turkish reset example. Service failures now preserve
the existing UI state and offer an explicit retry of the byte-identical request.
They no longer ask the user to clarify their wording or duplicate failed input.
Safe structured logs distinguish failure phase, timeout, HTTP status, size and
response-validation errors without exposing text, keys or response bodies. The
eight-second deadline, strict validation and no-automatic-retry policy remain.
These changes do not establish that the provider-side connection failure was fixed.

All 481 web tests, typecheck, lint, fixture/release contracts, deployment/GCP
configuration checks, Node and Cloudflare build/smoke checks passed locally.
Desktop/mobile browser checks passed 39 with one skip. The exact Linux image
passed its real-container smoke. All seven CI checks passed on this exact app
revision: [Bi Plan](https://github.com/Efeblk/event_recommender/actions/runs/36430535814)
and [CI](https://github.com/Efeblk/event_recommender/actions/runs/36430535844).

The integrated browser had no connected automation surface. Headless Playwright
therefore tested the deployed UI. `ui-live-01` made two real searches: 10 cards
in 5,139 ms, followed by five alternatives in 1,777 ms. Date, strict price,
concert exclusion, laughter preference and state handoff passed; alternatives
did not repeat prior production identities. DOM card counts matched responses,
there were no console/page errors, and the 390-pixel layout had no horizontal
overflow. Desktop/mobile screenshots were visually inspected. External event
images were replaced with placeholders by the test, so image loading was not
verified. No provider calls were mocked in these two recommendation requests.

`live-02` then made six intentional focused rechecks against the same frozen
catalog. It preserved its own source copies and actual response lineage. Its
only dirty files were this report and the launch checklist; app source matched
the deployed revision. This run does not replace or relabel `live-01`.

| Case | Observed follow-up |
| --- | --- |
| `budget_ambiguous` | Generic clarification in 640 ms; still lacks the required total/per-person question |
| `budget_total_reply` | Correct total budget/date/exclusion state; 16 cards in 2,028 ms |
| `laughter_messy` | Correct Saturday/partner/non-concert/laughter state; 15 cards in 2,083 ms |
| `learning_no_children` | Hard filters passed; one quiz-night card in 2,003 ms; optional interests incorrectly retain clause fragments, and photography fit is unsupported |
| `family_access_budget` | Unnecessary `constraint_ambiguous` clarification in 906 ms |
| `literal_title` | Unnecessary `constraint_ambiguous` clarification in 769 ms |

The machine oracle counted four passes and two failures. The generic budget
clarification and malformed learning interests prevent interpreting that count
as four good user experiences. All eight deployed follow-up requests avoided
`interpreter_unavailable`; the new revision's structured-failure log query was
empty at capture. This small interval does not prove provider reliability.

The cumulative ledger contains **39 reserved slots**: 30 initial API calls, one
local provider diagnostic, two browser API calls, and six focused API calls.
No automatic retries occurred; the selected test ceiling was not increased.
Actual recommendation-provider token usage remains unavailable.

Follow-up evidence:

- `web/work/preview-rollout-20260928/deployment-f17e36c7abe3/`
- `web/work/preview-rollout-20260928/candidate-f17e36c7abe3/`
- `web/work/preview-rollout-20260928/checks-2026-09-28T13-42-06.216Z/`
- `web/work/preview-e2e-20260928/runs/ui-live-01/`
- `web/work/preview-e2e-20260928/runs/live-02/`

Both follow-up folders contain a `manual-review.md`. All **47 new cards and 75
offers** matched the frozen source records and passed their recorded hard
constraints. This is separate from interpretation and subjective quality. The
browser search did not retain an explicit solo companion state; one alternative
was only weakly supported for laughter. The budget reply's recovered state is
correct, but its conversation remains manually contaminated by the initial
generic clarification. Same-time/venue provider pairs for Kürk Mantolu Madonna
and Anna Karenina are probable missed merges: the budget response contains 16
cards but approximately 14 distinct choices. Conservative title-identity review
is needed before merging those pairs. No old results or merge policy were
changed to make this test pass.

Complex input understanding, subjective relevance, catalog coverage and a broader
independent live retest remain release gates. The catalog checkpoint also reports
140 failed collection pages and 1,393 carried records, which must remain distinct
from successful refreshes. Current-revision capacity/recovery qualifications and
the required 48-hour unattended observation are not established by these tests.
