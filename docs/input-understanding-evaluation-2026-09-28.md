# Input interpretation evaluation — September 28, 2026

The structured interpreter is experimental and remains disabled by default.
Local contract and UI checks do not establish natural-language quality. The
existing preview has not been changed by the runs below.

## Method and preserved evidence

The frozen `web/fixtures/input-intent-v1.json` contains 58 Turkish, English, and
mixed-language cases referenced to September 28 in Europe/Istanbul. It covers
dates, budgets, exclusions, corrections, resets, source-evidence requirements,
and quoted instruction-shaped titles. Exact normalized filters and requirement
groups are compared; clarification must leave committed state unchanged.

Ignored local evidence is under `web/outputs/input-understanding-20260928/`.
Each run preserves original redacted requests, raw responses, usage, latency,
and source snapshots. These runs use Jev 1.13.0, explicit case lists, a task
initial allowance of 120 interpretation calls, 1.5-second pacing, and no retries.
They make no query-embedding, document-embedding, or recommendation-ranking calls.

| Run | Cases / provider calls | Exact passes | Findings |
| --- | --- | --- | --- |
| pilot-01 | 7 / 7 | 3 | Overclarification from category choices and bare-budget boundaries. |
| pilot-02 | 7 / 7 | 6 | Budget fields correct; action misclassified as alternatives. Candidate source changed during the run; diagnostic only, with a separate provenance note. |
| pilot-03 | 7 / 7 | 6 | Hard fields correct; overlapping quoted-title interest options split probability. Source snapshots stable. |
| broad-01 | 10 / 9 | 0 | Initial rock requirement overclarified, causing dependent-state failures. Additional capability-description and clearing/reset failures found. Source snapshots stable. |
| review-01 through review-06 | 58 / 57 | 40 | Full frozen fixture. Remaining errors include overclarification, lost genre OR, overly restrictive family/optional preferences, and known representation differences. All six source snapshots stable. |
| verify-01 through verify-06 | 58 / 57 | 41 | Diagnostic only: saved source contains corrupted Turkish instructions. Also exposed unsafe interpretation of instruction-shaped titles and unwanted requirements. Stable snapshots do not make a defective prompt valid. |
| final-pending | 4 / 3 | 4 | Short typed per-person/total replies retain pending Saturday, partner, and concert exclusion; unsupported pending condition stays blocked; reset makes no provider call. Predates subsequent reducer review fixes. |
| final-focus-a | 8 / 8 | 7 | Corrected initial Turkish encoding and title isolation. Optional mood request still clarified. Predates subsequent reducer review fixes; not final-source verification. |
| final-focus-b | 8 / 8 | 5 | Two exact failures are the documented jazz/category policy difference. An English literal-title request overclarified without clearing its prior budget. Other accepted states passed. |
| final-heldout | 8 / 8 | 7 | Independently authored, immutable oracle; child cancellation overclarified and preserved the previous state. This result remains 7/8 after subsequent fixes. |
| final-focus-c | 9 / 9 | 6 | Unwanted additional family requirement; child cancellation and dependent accessibility cancellation overclarified. |
| post-review-six | 6 / 6 | 4 | Final interpreter questions. Child cancellation with age and total budget, independent access removal, whole-family paraphrase, and scoped mandatory seating pass. Child suitability still adds a family requirement; optional mood wording overclarifies. |

These are successive diagnostic runs, not independent test-set accuracy estimates.
Earlier failures remain failures. A later prompt or reducer does not retroactively
change an earlier result. `broad-01` predates the evaluator carrying unresolved
parent text; subsequent runs explicitly record and forward that pending text,
matching the application protocol.

The `verify-*` source corruption was introduced while editing UTF-8 text on
Windows. Its failures cannot be attributed only to the model. Later source
inspection found additional malformed curly quotes and question-mark substitutions;
the source and serialized request now have an encoding regression check. Original
bad source, provider requests, and failures remain preserved. Literal event titles
are now replaced with opaque local tokens before any provider-visible candidate
or state is built; validated selections are restored locally.

After the full fixture, 87 calls had consumed 859,373 input tokens, an estimated
US$0.0361 at the [published Jev rate](https://docs.typesafe.ai/models) of
US$0.042 per million input tokens. Output tokens are uncharged under that rate.
The task allowance was then set to at most 180 calls and 1.8 million cumulative
input tokens (US$0.0756 at that rate) for fixes and independent checks. Before
each request, the evaluator reserves the full 64,000-token provider context;
missing usage consumes that reservation. These are provider token estimates,
not a cloud bill or a general account spending cap.

After reviewing those failures, one final six-case diagnostic batch extended the
internal call allowance to 186. The original monetary ceiling stayed below
US$0.08: its guard counted interpretation **and ranking** input tokens against a
1.9-million-token ceiling (US$0.0798), reserving 64,000 before each new request.
The final total was 186 interpretation calls and 1,785,393 input tokens, plus
two ranking calls and 30,252 input tokens. Two Voyage query calls used four
tokens in total; no document embeddings were generated. Estimated combined
provider cost is **US$0.07626**, using the published Jev rate and
[Voyage's US$0.12/million rate](https://docs.voyageai.com/docs/pricing), before
any free credits. No cloud bill or account-wide cap is implied.

## Frozen-case interpretation notes

The following issues were identified by review before the remaining cases were
run. Preserve their raw exact-match results and adjudicate separately:

- `tr-tonight`: “canlı müzik” can reasonably select the concert category.
- `tr-soft-preference`: `mood: calm` preserves “sakin” without duplicating it as
  an interest; the uncrowded and romantic preferences must still survive.
- `category-clear-correction`: theatre selection with a redundant concert
  exclusion is equivalent for immediate eligibility, but persistence after a
  later category reset needs its own test.
- `requirement-and-group`: “quiet” can express optional calmness or a mandatory
  venue condition; unknown quietness must not be presented as verified.
- `en-category-typo`: theatrical improv can be broader than stand-up.

Subsequent policy review also identified `en-basic` and its descendants: the
frozen expected state infers the concert category from jazz alone. The current
policy treats an explicit jazz requirement as independent from an explicit
concert category. Keep the original exact failures and report this policy
difference separately; do not count them as proof of language failure or success.

The evaluator now checks inherited annotated preferences as well as current-turn
directives, and separates unexpected clarification, missed clarification,
accepted-state mismatches, and explicit safety/atomicity failures. Historical
`safetyErrors` included status mismatches; do not compare that counter across
evaluator versions as if all failures were unsafe recommendations.

## Rollout gate

**Not cleared. Keep `INPUT_INTERPRETER=rules`.** The final interpreter still
adds an unrequested family constraint to one child-suitability request and asks
for clarification on optional mood wording. These can reduce recall or cause
frustrating follow-ups. Do not activate the feature on the existing public
preview, describe it as production-ready, or treat mocked contract tests as a
substitute for resolving these live failures. The code is an experimental,
reviewable implementation behind a default-off switch.

The next quality iteration must separate mutually related audience intentions
without a narrow wording whitelist, distinguish optional preference uncertainty
from hard-constraint uncertainty, and then run a fresh, bounded conversational
evaluation. Preserve these failures and the independently frozen oracle.

Before enabling the feature, review representative live interpretations,
short typed clarification replies, and every returned event card against source
evidence on the exact deployed revision. Keep the ordinary catalog retrieval,
bounded shortlist, support threshold, and shared rate limits in force. Public
release gates, including unattended monitoring, remain separate.

## Real-catalog checks and their limits

The read-only snapshot captured at `2026-09-27T22:51:36.641Z` contained 5,310
records and 2,150 cached vectors for 2,238 distinct eligible document hashes.
The checkpoint SHA-256 is
`1fa1685f96fd456909feccc90a9a2b59e4783963922047ae8179f5c1e65b61ce`.
Failed collection pages and carried records were preserved, not treated as
freshly verified records.

Using previously captured successful interpretations, two live retrieval/ranking
runs returned 12 cards for Saturday, October 3, partner/non-concert intent and
15 cards after a total budget below TRY1,000 for two people. The eligible pools
were 121 and 47 session records respectively. Both used the bounded 16-item
shortlist and returned all events passing the existing support threshold; these
counts are observations, not new fixed result counts.

All 27 returned cards passed the supplied date/category filters; all 15 budget
cards had a sourced offer below TRY500 per person, including TRY499.50. A
singles-themed stand-up appeared in both partner lists with 0.84 support and
was judged a questionable subjective match. No returned card was overtly
child-directed. Schedule conflicts in marketing descriptions were checked
against official session listings for
[Delikanlı](https://www.biletix.com/etkinlik/5EF8H/ISTANBUL/tr),
[Yedi Kocalı Hürmüz](https://www.bubilet.com.tr/istanbul/etkinlik/yedi-kocali-hurmuz),
and [Bekarlar Gecesi](https://biletinial.com/tr-tr/tiyatro/stand-up-bekarlar-gecesi);
the October 3 sessions existed. Some Biletix pages could not be opened, so
alternate official offer pages were used where available.

These are local runs against a captured GCP catalog, using cached document
vectors and reused interpreter states. They are **not** end-to-end deployed
revision tests or a measurement of recall. `live-cards-01` preserves its exact
source hashes; it predates the last audience-question and fallback-classifier
changes. Three child-directed shortlisted candidates in the first run and one
in the second were rejected by Jev.

The separate zero-provider fallback audit reviewed all 48 cards across three
requests. Hard constraints passed. Explicit child-directed source titles and
descriptions are now softly demoted for partner intent, while remaining eligible;
explicit child/family/age requirements disable that demotion. Some family-looking
programs with unspecified audience remain in the dated fallback. No fictional
character blacklist or inference from all-ages ticket policies was introduced.

Final local checks: 427 web tests, typecheck, lint, both deployment configuration
checks, frozen conversational contract/replay checks, Node build, and Node smoke
passed. Desktop/mobile browser evidence is 35 passed and one expected skip;
its last local Cloudflare build predates the final audience-question edit, which
does not change UI behavior. Exact-revision CI must verify the final build,
including the Linux container, before any merge or deployment. The integration
browser host was unavailable; headless Playwright was used.
