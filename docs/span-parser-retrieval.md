# Span parser retrieval integration

`span-v2` is the default interpreter whenever `TYPESAFE_API_KEY` is configured;
without it the application falls back to `rules`, which needs no provider.
`INPUT_INTERPRETER` can still select `rules`, `jev-v1` or `span-v2` explicitly,
and deployment configuration defaults to `span-v2`. `/api/site` advertises the
request version; the UI sends a versioned plan through follow-ups, alternatives,
and retries, shows grouped required and preferred conditions, and clears it on
a new search. Changing interpreter versions requires a new search.

The serving transport imports the pure parser core and makes one bounded
TypeSafe request using server credentials. It does not import the standalone
benchmark cache, key loader, or optional GLiNER service. Invalid provider answers,
ambiguity, and outages preserve the previous plan and require clarification.

Retrieval evaluates the entire hard condition tree against every eligible
catalog event before hybrid lexical/Voyage retrieval selects at most 16 distinct
candidates. The same admitted pool serves fallback search. Jev receives the
exact tree and source evidence; every distinct shortlisted event passing the
existing support threshold may be returned. Query text is not reparsed into
another set of constraints. Existing cached document vectors and conservative
session/offer identity remain in use.

The plan state also keeps the user's own messages since the last reset (at
most four; bare "show me others" requests are not added). They join the plan's
concepts in the retrieval query and reach Jev as `request` and `history`, so
performers, titles and other words the typed plan cannot express still drive
relevance. They never admit an event; only the hard condition tree does.

Required event types match every catalog label they cover: "show" admits
`Gösteri`, `Stand-up` and `Dans`, and courses and workshops admit both
`Eğitim` and `Workshop`. Required topics outside the source-checked genres are
supported only by a whole-word mention in the event title, description or
provider category; a missing mention is unknown. An excluded genre or topic
follows legacy exclusion: only a source mention excludes the event, and a
source that both mentions and denies it stays unknown. Negated guarantees
(content, experiences) still need explicit evidence.

Unknown source evidence cannot satisfy a hard constraint or its negation.
Conflicting positive and negative evidence remains unknown. Neighborhoods, outdoors/beginner
policies, approximate budgets, nearest ordering without a location, and
conditional party-size logic currently require clarification. Optional wishes
remain preferences. Group budgets require one unambiguous party count.

Offline tests exercise extraction, actual parser composition with supplied model
answers, grouped source admission, initial requests, follow-ups, reset, failure
preservation, full-catalog retrieval, the 16-candidate bound, ranking payloads,
and fallback parity. Browser fixtures mock provider answers. These establish
deterministic integration behavior, not current model interpretation accuracy.
No new paid model calls or deployment were performed. The historical 197/200
development replay does not measure this revision; an independently reviewed,
bounded live language evaluation remains the next gate before activation.

## Verification on October 2

On the uncommitted implementation based on `4d5adca`, Node 22.23.3 passed all
626 web tests, typecheck, lint, the Worker build and compiled smoke checks,
and the isolated Node build and compiled smoke check. Deployment configuration
checks passed, including 31 configuration tests after adding the opt-in setting.
The T3 browser showed `(konser VEYA tiyatro)` separately from the optional
`sakin` preference and verified plan clearing with a mocked response.

Raw local logs are preserved in `web/work/span-retrieval-final-checks.log`,
`span-retrieval-compiled-checks.log`, `span-retrieval-node-checks.log`, and
`span-retrieval-config-checks.log`. The compiled-check log preserves the initial
Node packaging failure; the later Node log records the successful correction.
`web/work/span-retrieval-source-manifest.txt` records the final changed-source
hashes. Later configuration/documentation edits do not change the tested runtime
modules. Linux image verification in exact-revision CI and live interpretation
evaluation remain outstanding; these local checks do not establish deployment
or public-launch readiness.

## Benchmark on October 2

Live runs used the existing TypeSafe and Voyage keys within a USD 1 task cap.
The parser ledger records USD 0.017; ranking usage was not recorded, and the
estimate from request sizes is about USD 0.10–0.15 in total. Raw logs and results are preserved locally
in `web/work/span-bench-20261002/`.

- Parser, frozen 200 cases: 190/200 at first, 194/200 after fixing dotted
  Turkish clocks ("20.00") being rejected as invalid dates. Remaining failures
  are model judgments (hedged "olabilir" alternatives, two party corrections, a
  keep-only edit, quiet/theatre preference scope). These cases shaped the
  parser, so this is a development score, not a held-out estimate.
- End-to-end flow: 18 conversations (22 turns) through `recommend()` over the
  September 29 prepared catalog (7,719 eligible events, all with cached
  vectors), evaluated as of 2026-09-29 15:00 Istanbul. The final run returned
  164 cards with no hard-constraint violations against source fields; named
  performers and titles (Duman, Teoman, Hamlet), corrections, resets, group
  budgets and exclusions behave as expected.

The same 18 conversations through the previous `rules` default (browser
request behavior reproduced) returned 18 cards violating requested facts and
mishandled several turns: the performer was dropped after a budget
clarification, an English request ignored its week, district and cheapest
order, "tarih temalı" was read as a date, parking was silently ignored, and the
reset to ceramics and free Beyoğlu events came back empty. This comparison is
why `span-v2` became the default.

Fixed during the benchmark: museum/exhibition visits split into a second tour
type, duplicate restated conditions, budget-basis ambiguity without choices,
negated genres excluding everything, and span-v2 ranking requests exceeding
the 100 KB Jev limit (the plan policy is now sent once instead of per
candidate; the default ranking prompt is unchanged from before the span
integration). Corrections such as "aslında pazar olsun" are judged against
the whole plan.

Known gaps outside this change: seating evidence is absent from current
sources, so a required seated concert is empty; some identical sessions from
different providers are not merged because venue names differ ("BBS Sahne",
"B-B-S SAHNE YENİBOSNA"), so alternatives can repeat a show; the Voyage key
rate-limits back-to-back query embeddings, which falls back to lexical search;
one card per show may not be its soonest session.
