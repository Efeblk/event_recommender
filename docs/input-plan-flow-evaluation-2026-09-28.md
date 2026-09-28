# Complete-plan interpretation evaluation — September 28, 2026

The draft now proposes bounded complete outing plans and asks Jev to select a
faithful plan before any new filters commit. `INPUT_INTERPRETER=rules` remains
the default. No staging or preview deployment was changed during this revision.
The [earlier evaluation](input-understanding-evaluation-2026-09-28.md) and its
failures remain historical evidence; this report does not replace them.

## Implementation

- Exact dates, times, prices, party arithmetic, and state validation remain in
  code. Applicable uncertain scalar choices stop before plan selection.
- Plausible semantic operations form a bounded internal beam; at most eight
  distinct valid complete plans reach the second request. Audience
  counterfactuals preserve prior conditions while challenging an invented new
  child/family condition. Genre alternatives can preserve an independent prior
  genre instead of merging everything into one OR group.
- One final Choice selects an entire plan or abstains. It sees the actual
  rejection consequences of mandatory conditions, optional wishes, masked
  titles, prior state, and the pending/latest message relationship. It receives
  no proposer probability or preferred-plan label. Selection requires probability
  at least 0.55 and confidence at least 0.1; these are operational thresholds,
  not a claim of calibrated application accuracy.
- Soft conditions are retained using canonical optional text. Literal titles
  are preserved locally and masked consistently in both provider requests.
- Natural Turkish/English retrieval text replaces internal tags. The ranker
  also receives optional preferences separately. Full eligible-catalog hybrid
  retrieval, the 16-candidate cap, source checks, and the 0.7 support threshold
  remain in place; every distinct passing shortlisted event can return.
- The UI shows required conditions and preferences, with correction/reset
  controls. Candidate-funnel diagnostics distinguish missing source evidence,
  contradictions, exclusions, vector coverage, and ranking rejection.

No new API, model subscription, dependency, or document-embedding profile was
introduced. Interpretation uses at most two provider requests under one shared
eight-second deadline, with no automatic retry or repair round.

## Frozen cases and live results

`web/fixtures/input-plan-audit-v1.json` contains 14 frozen targeted cases,
referenced to September 28 at noon in Istanbul. SHA-256:
`7e47e0135328c445ba3a63107858e67d96f8122050d7d19cba4520bf7a5bfd5c`.
These are known regressions and contrasting cases, not an independent held-out
sample or a replacement for the existing 58-case fixture.

| Run | Cases passing | Actual interpreter calls | Input tokens |
| --- | --- | --- | --- |
| `plan-pilot-01` | 10 / 14 | 27 | 148,712 |
| `plan-focus-02` | 6 / 6 | 12 | 63,698 |

The first run preserved three behavior failures: a resolved group-budget reply
over-clarified, coordinated optional atmosphere wishes became mandatory, and a
hard-to-soft seating correction over-clarified. Its fourth mismatch was the
frozen expectation of no category for “Find a play titled …”: the actual theatre
category is a reasonable reading of that wording, while the literal title and
budget stayed intact. The frozen result remains a failure; its expectation was
not rewritten to increase the score.

The follow-up changed candidate construction and the plan comparison, not the
support threshold. Unlikely tail operations stopped introducing unrelated
optional activities. Plans explained mandatory rejection versus optional
ordering, and code-derived group-budget arithmetic was explicitly identified.
Duplicate canonical hard/soft labels were removed without rewriting titles.

The final six live checks passed:

- A short “toplam” reply preserved Saturday, partner attendance, concert
  exclusion, strict 1,000 TL total, and a derived strict 500 TL per-person cap.
- Child suitability did not add an independent family requirement.
- Explicitly asking for both audiences retained both.
- “Mümkünse sakin, kalabalık olmayan romantik bir şey” retained preferences
  without introducing mandatory atmosphere requirements.
- Optional romance plus mandatory seating kept their different strengths.
- A prior seating requirement could become optional while retaining the wish.

Both runs recorded stable source hashes. They executed the working tree based
on `8129071de3587b3b40f3c7f7e0037a646699832c`, with the dirty-state manifest and
source copies recorded before each run. Evidence is preserved under ignored
`web/outputs/flow-revision-20260928/`; authorization headers and credentials are
not stored. The final six-case result does **not** turn the earlier 14-case run
into a new full-suite pass, and the earlier independent 7/8 result is unchanged.

## Recommendation/card checks

Two additional live ranking and query-embedding checks reused the captured
successful interpretation states and real catalog/vector snapshot. The catalog
was captured at `2026-09-27T22:51:36.641Z`: 5,310 provider records, 139 failed
collection pages, and 1,362 carried records. These are snapshot facts, not a
claim that every record was freshly collected. Exact existing Voyage
`voyage-4-large` 1,024-dimensional document vectors were reused.

| Request | Eligible sessions | Shortlist | Returned |
| --- | --- | --- | --- |
| Saturday, partner, no concerts | 121 | 16 | 11 |
| Same, under 1,000 TL total for two | 47 | 16 | 14 |

All 25 returned cards were reviewed against their captured source records and
passed date/category checks. Every card in the budget case was below 500 TL per
person; 499.50 TL correctly remained eligible. All eligible sessions in these
two cases had cached vectors. Counts were consequences of filtering and support
scores, not fixed result targets.

Subjective quality is not fully established. “Stand up Bekarlar Gecesi” still
appeared in the partner budget case; its singles-themed title is a relevance
concern, not proof that couples are prohibited. “3D Hologram Sirki” had a
source-described visual experience, but its brief description did not establish
a particular audience. Marketing copy for two plays mentioned different dates;
their session date/source discrepancy was already investigated in the earlier
report. No new ticket availability or checkout-price verification is claimed.

These were local downstream checks with captured interpretation states, not
deployed end-to-end tests, current-catalog completeness measurements, or
shortlist recall measurements. No empty result occurred in these two searches.

## Verification and cost

- 452 web tests passed, including provider-cap enforcement through a mocked
  CLI process and adversarial whole-plan/rollback tests.
- Typecheck, lint, frozen conversational contracts/replays, deployment-config
  checks, GCP-config checks, Node build/smoke, and Cloudflare build/smoke passed
  locally.
- Desktop/mobile Playwright: 37 passed, one expected skip. The integrated
  browser inventory was empty; headless Playwright was used. The new plan
  summary was also visually inspected on desktop/mobile and its correction/reset
  controls were checked without additional provider calls.
- Linux container verification and exact-head CI are required when updating
  the draft PR. Local measurements are not Cloud Run capacity evidence.

This revision used 39 interpretation calls, two ranking calls, and two Voyage
query calls. Jev input: 244,769 tokens; Voyage query input: 16 tokens. Estimated
list-price usage was **US$0.01028222**, below the stated US$0.03 ceiling, without
assuming provider free credits. No document embeddings were regenerated.
Earlier experimental spending is recorded separately in the earlier report.

## Remaining gate

Keep the interpreter disabled on the public preview. Broader fresh language
evaluation, independent candidate-plan coverage, final-selection accuracy,
subjective relevance, and retrieval recall still need measurement. A correct
plan can be omitted by the bound, and two decisions from the same model can
make correlated mistakes. The original deployment, recovery, capacity, and
48-hour unattended observation gates also remain separate from this revision.
