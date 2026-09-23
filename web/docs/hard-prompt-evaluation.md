# Live hard-prompt evaluation — 23 September 2026

**Verdict: functional, but not reliable enough for complex recommendation requests.**

Evaluated commit `336bac2` through the actual local `/api/recommend` endpoint with Voyage and Jev configured, using the existing real catalog. Twelve requests ran without retries, paced 25 seconds apart. Expectations were written before execution; every returned card was reviewed against the request and its source facts. A separate reviewer inspected catalog evidence independently. No runtime code or prompts were changed during the evaluation.

Strict assessment: **4 pass, 2 partial, 6 fail**. This is a small, deliberately difficult diagnostic set, not an estimate of accuracy across typical users. All twelve HTTP requests returned 200; eleven responses were successfully Jev-ranked and one stopped at pre-model clarification. Successful HTTP responses clearly do not establish recommendation quality.

Raw prompts, expectations, follow-up history, filters, full returned events and timings: [live report](../evals/reports/2026-09-23-hard-prompts.json).

| Case | Assessment | Observed result |
|---|---|---|
| Exhausted; quiet seated conversation tonight, no loud music | Partial | Safely returned nothing because the required atmosphere was not verified. However, the parser forced `Konser` from a negated music preference. |
| Wants to laugh; no concerts/children; ≤₺800 per person | Pass | Five comic shows within budget, with source-supported comedy. The same show appeared at two different venues: valid sessions, but limited variety. |
| Serious adult dramatic theatre; no children/comedy | Pass | Hizmetçiler, Lady Macbeth, Evlilikte Ufak Tefek Cinayetler, Koku and Ballı Süt had supporting dramatic themes. This does not establish an official adult-only admission rating. |
| “İki kişiyiz, toplam 1200 TL”, weekend stand-up | Fail | Asked for party size even though two people were explicitly stated. Should have applied ≤₺600 per ticket for September 26–27. |
| Saturday, only Kadıköy, after 20:30, stand-up ≤₺500 | Fail | Returned nothing despite qualifying 21:45 sessions priced ₺200–₺300. |
| Explicitly verified step-free entry and accessible toilet | Pass | Returned nothing; the catalog does not supply the required accessibility evidence. The generic empty-state wording could explain the missing evidence better. |
| Sunday morning kayaking/rowing; no boat party or concert | Partial | Safely returned nothing, but incorrectly set category `Konser` despite the exclusion. No requested activities exist in the catalog. |
| Comedy with mother; no sexual humour/swearing; omit uncertain matches | Fail | Fani But Funny had family-friendly source evidence. Three additional cards—Bengi İdil Uras twice and Özlem Kosif—did not establish the required content restrictions. Their inclusion was unsupported, not proof that their actual shows violate those restrictions. |
| English-written request: this Saturday, comedy, under ₺600, no concerts/children | Fail | Date and budget filters were absent. Returned September 23 (Wednesday) and November 8 (Sunday), not September 26. English was the request language, not a requested show language. |
| Switch from stand-up to jazz; remove budget; retain weekend | Fail | Correct weekend/category/budget fields, but returned Duman, Gülşen, Derya Bedavacı and two candle concerts with no supplied jazz evidence. Parent request had already failed clarification, so this is also not proof of successful state retention. |
| More choices with the same laughter/budget/exclusion preferences | Pass | Kept ≤₺800 and no-concert preferences; returned different source-supported comic productions. |
| “İki kişiyiz, bütçemiz 800 TL” without total/per-person clarification | Fail | Silently assumed ₺800 per ticket. Returned Edepsiz Komedi at ₺658 per person, which would cost ₺1,316 for two if ₺800 meant total. |

## Diagnosed causes

1. **Constraint parsing is brittle.** Party-size extraction recognizes `iki kişi` but misses `iki kişiyiz`. English date/amount wording and longer Turkish negations are not reliably converted to filters. Embeddings do not repair filters that already excluded candidates.
2. **Session selection happens too early.** For the late-Kadıköy request, `uniqueEvents` chooses the earlier session before ranking. The 21:45 Ada Bar session (`99717da914fbe566f8f86681`, ₺250) is replaced by its 19:00 sibling; the 21:45 Vohu session (`session-ad97388c8b4987eefd5ca8e75e5675a8`, ₺200) is replaced by its 20:00 sibling. A third valid 21:45 candidate (`b68537827b1bae4d0318e354`, ₺300) survives among only four productions, so premature grouping explains part, but not all, of the miss. The ranker also failed to accept an available match. This was not caused by the 16-candidate limit in this case.
3. **Partial relevance is being accepted as satisfaction of mandatory preferences.** The current Jev threshold accepts scores at level 2, whose rubric explicitly permits important preferences to remain unknown. That policy is unsuitable for “only jazz” or “do not suggest unless content restrictions are supported.” Thin descriptions such as just an artist’s name further limit evidence.

## What should change before claiming robust understanding

- Extract and validate a structured request: must-have constraints, exclusions, optional mood preferences, dates, local start times, location and budget basis. Ask clarification only when the request is actually ambiguous, and test inflected Turkish plus English.
- Keep session-level candidates until exact date, time and location requirements have been applied. Group productions for display only after selecting a matching session; preserve cross-provider offer merging.
- Separate mandatory-constraint verification from relevance ranking. Unknown mandatory properties should not be accepted because the event matches a broad category. Improve source descriptions and explicitly represent missing facts.
- Preserve this run as the baseline, add the failures as regression cases, and rerun a new live evaluation after fixes. Do not overwrite this report or treat the existing unit/smoke suite as a quality benchmark.

No implementation fix is claimed by this report. No website was deployed.
