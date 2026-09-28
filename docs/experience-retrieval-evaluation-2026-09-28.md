# Experience extraction and retrieval evaluation — September 28, 2026

This draft adds four optional attendee desires: laughter, learning, participation,
and dancing. They guide retrieval and ranking without becoming category or
source-evidence filters. `INPUT_INTERPRETER=rules` remains the default. This
revision did not deploy to staging or change the public preview.

## What changed

The existing Jev proposal request extracts typed experience operations alongside
dates, budgets, exclusions, audience requirements, and concrete interests. The
existing whole-plan selection request audits their combined meaning. Adding the
four desires adds questions within those requests, not another provider round.

Reliable generic experience spans live only in the typed experience field. They
are not duplicated in opaque interests, which would otherwise survive a later
cancellation. Uncertain or inconsistent span classifications retain the exact
previous state and ask for clarification. Literal titles and concrete topics are
preserved, and older opaque interests are never silently reinterpreted.
Clear-all-preferences and reset operations preserve their different meanings.

Search expands the selected experiences into short Turkish/English concepts.
The final ranker receives the actual wish separately, so expansion terms do not
become invented user requirements. Its instructions distinguish attendee learning
from a performer's education, audience interaction from passive watching, and
attendee dancing from a staged dance performance.

The database still stores factual event records and cached numerical vectors,
not AI-generated experience tags. Voyage embeds title, category, venue, and
description using the existing `voyage-4-large` 1,024-dimensional profile. No
document vectors, model profile, database schema, cloud resource, or dependency
changed. Retrieval still considers the full eligible catalog before selecting
at most 16 distinct candidates; all candidates passing the existing support
threshold may return.

## Frozen comparison and limitations

The initial eight-case fixture is `web/fixtures/input-experiences-v1.json`, SHA-256
`34526b289227b8f4e8b03be954d888e95bec749654dee680c9a853c4eaa08a07`.
It uses September 28 at noon in Istanbul as its fixed reference instant. Both
baseline `50644e373c14321f1c5027a21b6060d0f8732351` and the revised dirty working
tree were evaluated against the same captured catalog. Requests, original
responses, source copies/hashes, dirty-state manifests, and failures remain in
ignored `web/outputs/experience-upgrade-20260928/comparison-01/`.

The strict original interpretation score was baseline 4/8 and revised 3/8. This
does **not** establish an overall accuracy improvement. The frozen scores were
not rewritten after discovering the following issues:

- Both versions inferred two attendees from partner attendance, which was a
  reasonable interpretation missing from the fixture's expected state.
- The revised interpretation normalized an explicit evening request to the
  existing 18:00 lower bound, also missing from that fixture's expected state.
- The revised learning request incorrectly broadened a children-event exclusion
  into a whole-family exclusion. The revised dancing request also added an
  unrequested general participation wish. These prompted instruction changes.
- “I do not want to participate, only watch” may express a strict aversion,
  rather than merely remove an optional wish. The revised auditor abstained;
  this remains an unresolved policy case. The baseline retained the old opaque
  participation text despite passing the fixture's hard-field checks.

The captured catalog contains 5,310 provider records, captured at
`2026-09-27T22:51:36.641Z`, with historical collection metadata of 139 failed pages
and 1,362 carried records. Its SHA-256 is
`89a7e12ac087c5dfb80e1684808b0c40f9428819c416aba249a23a60d9b5af8c`.
It is a frozen test snapshot, not a claim of present catalog freshness.

An evaluation-helper defect limited the initial Saturday cases to 90/121 cached
vectors: raw provider IDs were looked up after production session merging.
An offline check confirmed exact merged-document hashes recover 121/121 vectors.
The corrected helper uses those exact cached hashes. The original comparison
and its source snapshot remain untouched; its ranking results therefore have
partial vector coverage. Synthetic ranker captures in `retrieval.json` measure
the shortlist, not real Jev threshold-qualified recommendations.

## Initial card review

All 37 live-ranked cards were reviewed against the captured source records.
None violated the October 3 Istanbul-time or non-concert conditions. Partner
attendance was optional context, not a claim of proven romance.

| Case | Baseline cards | Revised cards | Assessment |
| --- | --- | --- | --- |
| Saturday laughter with partner, no concerts | 11 | 15 | More explicit comedy programs surfaced; some descriptions remained thin and one quiz had weak laughter support. |
| Saturday audience participation, no concerts | 5 | 6 | Several strong interactive programs, but a weak passive program remained and a strong baseline production dropped out. Mixed improvement. |

Counts are outcomes, not quality targets. A small hand-labeled set cannot
establish global recall, and exact raw-ID misses can represent another dated
session of the same production. Learning retrieval became more topical, but
neither learning nor dancing received a complete live rank/card evaluation.
Children-branded wording alone was not treated as explicit audience suitability.

## Final focused checks

The separate `web/fixtures/input-experiences-focus-v1.json` preserves four
revised-only checks: children-only exclusion, attendee dancing, independently
requested dancing plus participation, and explicit removal of the participation
preference while retaining date and concert exclusion. Its expected state was
frozen before any provider call. It does not replace the original eight cases
or resolve the original strict-aversion wording by changing its expectation.

All four focused interpretations passed in `focus-02`, using eight Jev calls.
Fixture SHA-256:
`93caff0c800d6fb542cac7c0fa64f8009847bf82c3930593e718b775a09295a6`.
This is a targeted recheck after prompt fixes, not an independent accuracy score
or a rerun of the full original suite.

Two final downstream searches reused the successful initial revised laughter
and participation states. They tested the updated retrieval/ranker code and
correct vector lookup, not a fresh end-to-end conversation. Each searched 121
eligible sessions with 121/121 cached vectors and shortlisted 16. The laughter
case returned 14 cards; participation returned six. Every returned card met the
date and category constraints, and every shortlisted candidate at or above
0.70 support returned while lower candidates were omitted.

All 20 final cards were source-reviewed. Laughter results still include a quiz
with weak laughter evidence and two thinly described comedy listings. Most
participation results have explicit interactive or quiz formats, but one
children's illusion show has an interactive title with little description of
what attendees do; another show's high support is stronger than its brief
interactive-format wording warrants. These are relevance/calibration concerns,
not hard-filter violations. No budget, child exclusion, accessibility, seating,
quietness, or venue-policy constraint was present in those two cases.

Both final stages recorded stable source hashes. The tested runtime was the
dirty working tree based on `50644e373c14321f1c5027a21b6060d0f8732351`; its exact
runtime source copies and hashes are in `focus-02/focus-manifest.json` and
`focus-source-snapshot/`. No runtime files changed after that capture. The final
run does not establish a controlled full-coverage baseline comparison, because
the original baseline was not reranked after correcting the helper.

## Verification and cost

The final local checks pass: 468 web tests, TypeScript, lint, frozen conversational
fixture contracts/replays, deployment configuration checks, GCP configuration,
Node build, and Node smoke. They include reset/clear/cancellation regressions,
uncertain typed-span atomicity, literal preservation, soft/hard separation, and
retrieval expansion versus ranker-request separation.

The Cloudflare build, compiled Worker/D1/R2 smoke, and Voyage/workerd smoke pass.
The isolated headless desktop/mobile browser suite passes 37 cases with one
expected skip. The plan summaries were visually inspected at both sizes; the
new experience appears under preferences without overflow. These mocked UI
checks do not measure provider accuracy or cloud CPU/capacity. Linux container
verification belongs to the exact-head CI checks linked in the draft PR.

This revision made 40 interpretation calls and six ranking calls to Jev, plus
two Voyage query-embedding batches. Durable attempt/response logs record 328,342
Jev input tokens and 222 Voyage query tokens. At the recorded list prices of
US$0.042 and US$0.12 per million input tokens respectively, the estimate is
**US$0.013817004**, below the US$0.03 ceiling. No free-credit assumption, automatic
retry, or document-embedding charge is included. Prior revisions' spending is
separately preserved in their historical reports.

## Rollout boundary

This is a bounded, gated upgrade. Representative broader language evaluation,
more relevance/recall review, and the existing staging/recovery/capacity and
48-hour unattended monitoring gates remain necessary before public release.
No threshold was lowered, fixed result count introduced, or unsuitable-card
filling added. Existing API keys suffice, and unchanged document embeddings
continue to be reused.
