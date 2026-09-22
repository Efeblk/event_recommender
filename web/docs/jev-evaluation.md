# Jev recommendation ranking and evaluation

Jev scores a shortlist of events against a request. It does not generate the application's conversational response or explanatory strings. Exact date, budget, category and availability rules stay in code; the interface shows event cards plus ordinary status and filter labels. The active request path is results-only: deterministic code interprets constraints and retrieves eligible events, keyword ranking selects at most 16 unique candidates, and Jev reranks only that shortlist.

The adapter in `lib/jev.ts` uses the official HTTPS `/v1/systemone` API, defaults to the pinned `jev-1.13.0` model, and asks one comparable Score question per candidate. Each question explicitly points to its candidate's state path. It sends at most 16 candidates with bounded descriptions, has a 15-second timeout, blocks redirects, validates all returned scores, and never retries paid calls automatically. It preserves original event objects; Jev cannot supply fabricated IDs, prices or URLs through this interface.

The public recommendation route uses this adapter when `TYPESAFE_API_KEY` is set. Without a key it returns an honest deterministic fallback. `AI_API_KEY` and `OPENAI_API_KEY` do not enable the recommendation route. The route performs no embedding calls.

## Run

Use Node 22.13+ from the repository root:

```sh
# No key or network calls; validates production-equivalent constraints and shortlists.
node --experimental-strip-types web/scripts/evaluate-jev.ts

# Explicit live evaluation; at most 12 requests. This uses provider credit.
# Put TYPESAFE_API_KEY in ignored web/.dev.vars or the process environment first.
node --experimental-strip-types web/scripts/evaluate-jev.ts --live --out /tmp/biplan-jev-evaluation.json
```

Optional `TYPESAFE_MODEL` selects another Jev model. No key, provider response body, or private chat log is written to the report. Live evaluation sends only the checked-in fictional test cases, never the user's conversations. The dry run reports each planned shortlist count and whether the labeled answer survives constraint filtering and keyword shortlisting, plus aggregate label-candidate recall. The live report additionally contains returned model versions/token usage, elapsed times, raw score/confidence values, accepted recommendations, labeled top-1 accuracy, and false positives for cases that should produce no match. A failed call stops the run rather than retrying or proceeding blindly; the loop remains serial and is bounded to the 12 fixtures.

Production currently accepts scores of 2 or higher on the four-level scale. This threshold is a provisional product policy, not a calibrated guarantee. A candidate below it is omitted, so top-1 accuracy is measured against the first accepted recommendation rather than the raw highest score. The two unsupported-preference fixtures should return no accepted recommendation; any accepted result is reported as a false positive.

## Measured fictional-fixture run

An authorized live run on 2026-09-22 completed all 12 serial calls with `jev-1.13.0`. The checked-in [sanitized report](../evals/reports/2026-09-22-jev-1.13.0.json) records the source fingerprints needed to identify the evaluated code and fixtures.

- The expected event ranked first among accepted results in all 10 labeled cases (10/10). Both unsupported-preference cases returned no accepted result (2/2; zero false positives).
- The run used 24,699 input tokens and 888 output tokens. Median latency was 286 ms and nearest-rank p95 was 3,876 ms across only 12 calls.
- Applying the published token rates produced an estimated cost of $0.001037358. This is an estimate, not an invoice.
- The serious-adult-play negation case ranked `drama` first, but the provisional threshold also accepted `rock` at 2.55, `comedy` at 2.52, and `electronic` at 2.32. Thus the correct top result does not mean every returned result was appropriate.

These results are encouraging fixture evidence, not evidence that the public experience is quality-ready. The sample is small, fictional, and designed around known distinctions. It does not measure live-catalog shortlist recall, real-user language, repeated-run variance, or whether the threshold of 2 is calibrated well enough for multi-result recommendations.

## Quality gate and operating checks

1. Repeat and expand the Turkish evaluation; inspect negation, follow-ups and unsupported preferences across varied phrasing. TypeSafe says English is its strongest training language, and one small Turkish fixture run does not establish production quality.
2. Add a representative, human-labeled sample from the real catalog. Compare against the current keyword ranking. Check shortlist recall as well as reranking: Jev cannot recover an event absent from the keyword shortlist of 16.
3. Record actual cost and p50/p95 latency over repeated runs. Published per-token pricing is not a per-search quote; all state/questions count toward usage.
4. Set an abstention/fallback policy from observed errors. Confidence describes the distribution, not the truth of event details. Unknown crowd size, romantic atmosphere or accessibility must stay unknown.
5. Keep Jev calls inside the shared paid-request budget and keep provider failure fallback visible. Do not route recommendation traffic through the legacy chat or embedding providers.

Mock tests establish API handling and preservation of event facts, **not model quality**. The completed 12-case live run is still a smoke evaluation, not sufficient evidence for a public-quality claim. Live-catalog evaluation and broader human-labeled quality checks remain required.

Sources checked 2026-09-22: [official skill](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md), [HTTP API](https://docs.typesafe.ai/api), [Score](https://docs.typesafe.ai/primitives/score), [reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe), [models/language support](https://docs.typesafe.ai/models), [confidence](https://docs.typesafe.ai/confidence).
