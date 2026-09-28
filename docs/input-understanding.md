# Structured input interpretation

The experimental `INPUT_INTERPRETER=jev-v1` path interprets the current message
before catalog filtering. The default, `rules`, preserves the existing runtime.
The [original evaluation](input-understanding-evaluation-2026-09-28.md) and
[complete-plan revision](input-plan-flow-evaluation-2026-09-28.md) record the
language-quality evidence and remaining gates. Keep the new path disabled
until those gates pass. Its implementation is not a public-readiness claim.
Clients opt into the versioned protocol with `intentVersion: 1` and return the
previous response's `intentState` on the next turn. A rules-era conversation
without structured state asks for a new search instead of losing old requirements.

The state contains validated filters, source-evidence requirements, and optional
mood, companion, and interest preferences. It contains no verified event facts.
An interpretation either commits a complete update or returns the previous state
with a clarification. Date and amount arithmetic remains in code. The model
selects from closed choices and source spans; it cannot invent filter values.
Going with a partner does not require a documented romantic atmosphere.

## Revised flow: choose an outing plan

The first Jev request proposes typed operations; those answers are not yet
authoritative filters. Code checks exact values and constructs at most eight
complete candidate plans from plausible semantic alternatives. Each plan
distinguishes hard conditions from optional wishes and carries forward prior
conditions unless the request changes them. The bound is a cost and latency
limit, not a claim that every human request has eight or fewer interpretations.

A second Jev request makes one choice over the complete plans. It must choose
a faithful interpretation of the whole request, or abstain when none fits or
the meaning is unclear. It cannot separately repair fields or pick the closest
available plan. Code validates and commits the selected plan atomically. This
keeps related meanings, such as child suitability versus whole-family
suitability, together in the final decision. Literal titles remain opaque to
both interpretation requests and are restored locally without rewriting them.

The same model supplies both rounds, so correlated mistakes remain possible.
Candidate-plan coverage and final selection accuracy are separate evaluation
questions. A correct interpretation missing from the bounded candidate set
must produce clarification, not silent relaxation or an extra automatic call.

The page shows **Olmazsa olmazlar** and **Tercihler** separately. Users can
correct the plan in ordinary language without a mandatory confirmation step.
During clarification, the visible summary explicitly remains the prior plan.

On the structured path, retrieval and ranking use the committed state. They do
not reparse historical messages. Filters and source-evidence checks still apply
to every candidate, including fallback results. Unknown mandatory evidence is
not support. Full eligible-catalog retrieval precedes the 16-event shortlist;
every distinct shortlisted event above the support threshold can be returned.
Retrieval text is deterministic Turkish/English prose, while the ranker also
receives the optional preferences separately from mandatory requirements.
Neither companion context nor a mood preference establishes a venue fact.

Responses include a diagnostic funnel: storage rows retrieved, eligible merged
sessions before and after source checks, supported/unknown/contradicted counts
for each mandatory condition, alternative exclusions, shortlist size, vector
coverage, and threshold-qualified returns. These counts explain where options
were lost; they do not set a target result count. Fallback results have no Jev
support probability, so their threshold-qualified count is `null`.

Budget ambiguity offers **Kişi başı** and **Toplam** buttons. Buttons and typed
answers use the same bounded `pendingInput` protocol. Unresolved user text stays
separate from committed state, so a short reply retains the original amount,
party size, date, and exclusions. The latest reply overrides conflicting pending
wording. The server rejects malformed pending state and never truncates constraints
to fit the input limit; an overlong exchange asks for a new complete request.
Success clears the pending input. Reset clears pending input, committed state,
and client history. Neither path infers an unmentioned group size.

## Evaluation and rollout

`npm run test:input-intent` validates the frozen fixture and request contract
without calling a provider. `npm test` includes deterministic parser, state,
integration, and benchmark-evaluator checks. Mocked answers establish code
behavior, not natural-language accuracy.

`scripts/check-input-intent.mjs --live` requires explicit case IDs, a bounded
call allowance, an ignored evidence directory, and a server-side
`TYPESAFE_API_KEY` environment variable. It records requests without authorization
headers, raw responses for both provider rounds, token usage, latency, fixture
date, and source provenance. Call/token limits apply to each actual provider
request, including the plan selection round.
Preserve failed runs. Replay evaluates captured interpretations; it does not
prove that changed questions would produce the same answers. Historical
single-round evidence is labeled separately from the full revised flow.

Keep the feature disabled until representative live interpretations and resulting
cards have been reviewed. Evaluate extraction and clarification separately from
event relevance and recall. An empty result requires a catalog availability
check. Passing the offline fixture contract is not a release gate by itself.
The GCP staging workflow exposes an explicit `input_interpreter` choice, defaults
to `rules`, validates the selected value, and records it with deployment
provenance. A configuration rollback asks existing structured conversations to
start again, rather than reconstructing and losing old constraints.

## Cost and failure behavior

An interpreted search uses at most two Jev calls before retrieval. Existing query
embedding and shortlist ranking can then add one Voyage and one Jev call.
Clarification or interpretation failure stops before retrieval/embedding/ranking.
Provider calls have deadlines and no automatic retries. Document embeddings are
reused; interpretation does not regenerate them.

`AI_DAILY_LIMIT` counts application requests, not provider calls or money. Measure
actual usage before enabling the feature; the interpretation rounds change the cost
per search. Disabling the feature is a runtime configuration rollback, separate
from cloud billing alerts and the existing public-release gates.
