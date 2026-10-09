# Jev recommendation ranking and evaluation

Jev judges a shortlist of events against the current request. It does not
generate a conversational response or event facts. Each call to
`recommendRequest` reads only the current message. The field reader uses Jev to
classify supported request fields. Code resolves the plan and applies exact
date, place, budget, category, negation, age, availability and source-evidence
checks. Retrieval then reads the full eligible catalog and selects at most 16
distinct candidates. Jev judges only that shortlist. Without Voyage
configuration or a usable index, retrieval uses keywords.

The adapter in `lib/jev.ts` uses the official HTTPS `/v1/systemone` API. It
defaults to the pinned `jev-1.13.0` model. It asks one comparable Score question
per candidate. An explicit mood preference also adds a program-fit question.
Each question points to its candidate's state path. The adapter sends at most
16 candidates with bounded descriptions. It has a 15-second timeout, blocks
redirects, validates all answers and never retries paid calls automatically.
It preserves original event objects. Jev cannot supply IDs, prices or URLs.

The recommendation route uses this adapter when `TYPESAFE_API_KEY` is set.
Without a key, the route selects the rules interpreter and an identified
deterministic fallback. This keyless path also applies when the request text
contains a mood, because it has no field-reader plan. The no-unverified-card
guard applies only when the field reader produced a plan with an explicit mood
preference and Jev ranking then became unavailable. `AI_API_KEY` and
`OPENAI_API_KEY` do not enable the route. With
`VOYAGE_API_KEY` and a usable document index, the route makes one query
embedding call before Jev. See [Voyage retrieval](voyage-retrieval.md). The
saved-score evaluator below uses the keyword path. It is not a Voyage quality
evaluation.

## Run

Use the Node version in `web/.nvmrc`. Run these commands from the repository
root:

```sh
# No key or network calls; replay recorded scores through current filtering.
node --experimental-strip-types web/scripts/evaluate-jev.ts

# Save the offline report (CI runs this same zero-call check).
node --experimental-strip-types web/scripts/evaluate-jev.ts --out /tmp/biplan-jev-replay.json

# Explicit live evaluation; at most 12 requests. This uses provider credit.
# Put TYPESAFE_API_KEY in ignored web/.dev.vars or the process environment first.
node --experimental-strip-types web/scripts/evaluate-jev.ts --live --out /tmp/biplan-jev-evaluation.json
```

Optional `TYPESAFE_MODEL` selects another model for live evaluation. No key, provider error body, or private chat log is written to the report. Live evaluation sends only the checked-in fictional test cases, never the user's conversations. A failed call stops the run rather than retrying or proceeding blindly; the loop remains serial and is bounded to the 12 fixtures.

The default run uses the checked-in [saved-score
snapshot](../evals/replays/2026-09-24-jev-1.13.0-probabilities.json). It applies
current constraints, shortlisting and the production admission function to the
answers from that historical live run. It performs no requests and reads no API
key. A custom snapshot can be selected with `--replay PATH`; this cannot be
combined with `--live`. Missing candidate scores make replay incomplete rather
than receiving guessed values.

Both modes report candidate recall, accepted IDs, recommendation precision across the whole list, forbidden secondary results, top-1 accuracy, and expected-empty correctness. No-match cases have no candidate-recall value. An empty result for a positive case is a failed case; a correct first card with an unrelated second card is also a failure. CI fails if the offline replay is incomplete or any list is incorrect. Live mode additionally records model/token usage and latency. This test suite's small fictional labels do not establish broader model accuracy.

Production does not accept candidates from the numeric score alone.
`selectJevEvents` first requires the returned event to be a canonical shortlist
candidate and the four-level probability vector to be valid. It then sums the
probabilities for support levels 2 and 3. That support probability must be at
least `MIN_JEV_SUPPORT_PROBABILITY`, currently `0.7`. Explicit mood requests
also require program-fit probability of at least `0.7`. The numeric score orders
the admitted candidates. Code returns every distinct admitted candidate, up to
the 16-candidate shortlist. These thresholds are product policy, not calibrated
guarantees.

## Historical measured fictional-fixture run

An authorized live run on 2026-09-22 completed all 12 serial calls with
`jev-1.13.0`. The checked-in [sanitized
report](../evals/reports/2026-09-22-jev-1.13.0.json) records the source
fingerprints for the evaluated code and fixtures. The findings below preserve
the original score-based policy. They do not describe current admission.

- The expected event ranked first among accepted results in all 10 labeled cases (10/10). Both unsupported-preference cases returned no accepted result (2/2; zero false positives).
- The run used 24,699 input tokens and 888 output tokens. Median latency was 286 ms and nearest-rank p95 was 3,876 ms across only 12 calls.
- Applying the published token rates produced an estimated cost of $0.001037358. This is an estimate, not an invoice.
- The serious-adult-play negation case ranked `drama` first, but the provisional threshold also accepted `rock` at 2.55, `comedy` at 2.52, and `electronic` at 2.32. Thus the correct top result does not mean every returned result was appropriate.

These results are encouraging fixture evidence, not evidence that the public experience is quality-ready. The sample is small, fictional, and designed around known distinctions. It does not measure live-catalog shortlist recall, real-user language, repeated-run variance, or whether the threshold of 2 is calibrated well enough for multi-result recommendations.

## Historical filtering regression and offline evidence

In that historical conversational path, the adult-play failure had a
deterministic cause: the phrase "ciddi bir oyun" did not select theatre, and the
child-show exclusion missed inflected audience wording such as "çocuklar".
Contextual stage-play wording then selected theatre before retrieval. Bounded
positive child-audience evidence was excluded when requested. Ambiguous game
wording stayed unclassified. Category changes and resets cleared conflicting
history, while alternatives preserved current preferences. These guards also
applied to the keyless and provider-outage paths.

At that time, the model prompt and score threshold remained unchanged. With
the saved scores, the original twelve cases passed the whole-list check: ten
accepted cards were labeled appropriate, both unsupported requests remained
empty, and three unrelated secondary cards were excluded before Jev. The
immutable historical live report still records the original failure. This was
a filtering regression check with reused scores. It was not a second live
evaluation and it does not validate the current probability-based policy.

## Quality gate and operating checks

1. Use the Phase 1 golden set for current Turkish and English requests. Inspect
   negations and unsupported preferences across varied phrasing. One small
   Turkish fixture run does not establish product quality.
2. Use representative, human-reviewed labels from the frozen real catalog.
   Check shortlist recall as well as Jev judgment. Jev cannot recover an event
   absent from the shortlist of 16.
3. Record actual cost and p50/p95 latency over repeated runs. Published per-token pricing is not a per-search quote; all state/questions count toward usage.
4. Set an abstention/fallback policy from observed errors. Confidence describes the distribution, not the truth of event details. Unknown crowd size, romantic atmosphere or accessibility must stay unknown.
5. Keep Jev calls inside the approved paid-request budget. Keep provider
   failure behavior visible. Do not route recommendation traffic through legacy
   chat or embedding providers.

Mock tests establish API handling and preservation of event facts, **not model quality**. The completed 12-case live run is still a smoke evaluation, not sufficient evidence for a public-quality claim. Live-catalog evaluation and broader human-labeled quality checks remain required.

Sources checked 2026-09-22: [official skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md), [HTTP API](https://docs.typesafe.ai/api), [Score](https://docs.typesafe.ai/primitives/score), [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe), [models/language support](https://docs.typesafe.ai/models), [confidence](https://docs.typesafe.ai/confidence).
