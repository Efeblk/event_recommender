# Jev evaluation before public integration

Jev can independently score a shortlist of events against a request. It cannot generate the application's conversational response or explanatory strings. Keep exact date/budget/availability rules in code; use ordinary source-grounded templates or the existing text-generation provider for explanations.

The experimental adapter in `lib/jev.ts` uses the official HTTPS `/v1/systemone` API, a pinned `jev-1.13.0` model, and one comparable Score question per candidate. Each question explicitly points to its candidate's state path. It sends at most 16 candidates with bounded descriptions, has a 15-second timeout, blocks redirects, validates all returned scores, and never retries paid calls automatically. It preserves original event objects; Jev cannot supply fabricated IDs, prices or URLs through this interface.

It is **not connected to the public recommendation route** yet. Adding a key alone does not enable Jev or change the existing keyless preview.

## Run

Use Node 22.13+ from the repository root:

```sh
# No key or network calls; validates the fixtures and request construction.
node --experimental-strip-types web/scripts/evaluate-jev.ts

# Explicit live evaluation; at most 12 requests. This uses provider credit.
# Put TYPESAFE_API_KEY in ignored web/.dev.vars or the process environment first.
node --experimental-strip-types web/scripts/evaluate-jev.ts --live --out /tmp/biplan-jev-evaluation.json
```

Optional `TYPESAFE_MODEL` selects another Jev model. No key, provider response body, or private chat log is written to the report. Live evaluation sends only the checked-in fictional test cases, never the user's conversations. The report contains actual returned model versions/token usage, elapsed times, baseline choices, labeled top-1 accuracy, and raw score/confidence values. A failed call stops the run rather than retrying or proceeding blindly.

## Gate before enabling

1. Run the Turkish fixture evaluation with an authorized key; inspect negation, follow-ups and unsupported preferences. TypeSafe says English is its strongest training language, so Turkish quality must be measured.
2. Add a representative, human-labeled sample from the real catalog. Compare against the current keyword ranking and a selected chat model. Check shortlist recall as well as reranking: Jev cannot recover an event absent from its candidates.
3. Record actual cost and p50/p95 latency over repeated runs. Published per-token pricing is not a per-search quote; all state/questions count toward usage.
4. Set an abstention/fallback policy from observed errors. Confidence describes the distribution, not the truth of event details. Unknown crowd size, romantic atmosphere or accessibility must stay unknown.
5. Only then wire the adapter behind an explicit server-side feature flag and include its calls in the application's shared AI request budget. Keep failure fallback visible and retain the existing provider path.

Mock tests establish API handling and preservation of event facts, **not model quality**. The initial 12 fictional cases are a smoke evaluation, not sufficient evidence for a public-quality claim.

Sources checked 2026-09-22: [official skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md), [HTTP API](https://docs.typesafe.ai/api), [Score](https://docs.typesafe.ai/primitives/score), [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe), [models/language support](https://docs.typesafe.ai/models), [confidence](https://docs.typesafe.ai/confidence).
