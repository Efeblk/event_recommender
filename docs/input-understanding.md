# Structured input interpretation

The experimental `INPUT_INTERPRETER=jev-v1` path interprets the current message
before catalog filtering. The default, `rules`, preserves the existing runtime.
The [September 28 evaluation](input-understanding-evaluation-2026-09-28.md)
has unresolved language-quality failures; keep the new path disabled until those
gates pass. Its implementation is not a public-readiness claim.
Clients opt into the versioned protocol with `intentVersion: 1` and return the
previous response's `intentState` on the next turn. A rules-era conversation
without structured state asks for a new search instead of losing old requirements.

The state contains validated filters, source-evidence requirements, and optional
mood, companion, and interest preferences. It contains no verified event facts.
An interpretation either commits a complete update or returns the previous state
with a clarification. Date and amount arithmetic remains in code. The model
selects from closed choices and source spans; it cannot invent filter values.
Going with a partner does not require a documented romantic atmosphere.

On the structured path, retrieval and ranking use the committed state. They do
not reparse historical messages. Filters and source-evidence checks still apply
to every candidate, including fallback results. Unknown mandatory evidence is
not support. Full eligible-catalog retrieval precedes the 16-event shortlist;
every distinct shortlisted event above the support threshold can be returned.

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
headers, raw responses, token usage, latency, fixture date, and source provenance.
Preserve failed runs. Replay evaluates captured interpretations; it does not
prove that changed questions would produce the same answers.

Keep the feature disabled until representative live interpretations and resulting
cards have been reviewed. Evaluate extraction and clarification separately from
event relevance and recall. An empty result requires a catalog availability
check. Passing the offline fixture contract is not a release gate by itself.
The GCP staging workflow exposes an explicit `input_interpreter` choice, defaults
to `rules`, validates the selected value, and records it with deployment
provenance. A configuration rollback asks existing structured conversations to
start again, rather than reconstructing and losing old constraints.

## Cost and failure behavior

An interpreted search uses at most one additional Jev call. Existing query
embedding and shortlist ranking can then add one Voyage and one Jev call.
Clarification or interpretation failure stops before retrieval/embedding/ranking.
Provider calls have deadlines and no automatic retries. Document embeddings are
reused; interpretation does not regenerate them.

`AI_DAILY_LIMIT` counts application requests, not provider calls or money. Measure
actual usage before enabling the feature; the additional call changes the cost
per search. Disabling the feature is a runtime configuration rollback, separate
from cloud billing alerts and the existing public-release gates.
