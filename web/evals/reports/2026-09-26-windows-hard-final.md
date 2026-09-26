# Windows hard-test result — 26 September 2026

The detected constraint and ticket-consolidation defects were fixed and their affected behavior retested. The app is running locally at http://127.0.0.1:3001 with TypeSafe Jev and Voyage configured. This is local Windows verification, not a staging or public-release sign-off.

## What changed

- Negated “this weekend” no longer overrides an explicit replacement date.
- Venue/date indifference clears the requested fields without crossing clauses; “Mekân Beşiktaş olsun, tarih fark etmez” keeps Beşiktaş.
- Removing a budget retains the known group size. A later total budget reuses that size: four people and 3000 TL becomes 750 TL per person.
- “Ücretsiz olması gerekmiyor” no longer sets a zero budget; “çocuk tiyatrosuna” retains the theatre category.
- Turkish wheelchair-access requests now require affirmative source evidence before both Jev and fallback search. Unknown or negative accessibility evidence is rejected.
- Full-reset and conversational alternatives wording are recognized and covered by regression tests.
- Reviewed exact title/venue aliases consolidate Kütüphanedeki Ceset, JJ Arena and Mustafa Boz offers while preserving distinct times, venues, and named productions. Redd's Oct 3 card now includes the 1605 TL offer as well as the 3420 TL offer.
- Calming-language variants improve shortlist coverage. The acceptance threshold remains unchanged.

## Live review and preserved evidence

| Run | Scope | Result |
|---|---|---|
| [Baseline](2026-09-26-windows-hard-baseline.json) | 20 fresh Turkish/English requests, including follow-ups, contradictions, accessibility and empty-result checks | 20 HTTP 200 responses; review found definite interpretation and consolidation defects despite HTTP success |
| [First regression](2026-09-26-windows-hard-regression.json) | 12 targeted requests after the first fixes | 11 cases passed; budget removal still lost group size in this intermediate build |
| [Final state regression](2026-09-26-windows-final-state.json) | 4 requests after the remaining state fixes | 4/4 passed, including budget removal, restored total budget and independent venue/date handling |
| [Quiet-request trace before](2026-09-26-quiet-trace-before.json) / [after](2026-09-26-quiet-trace-after.json) | 2 bounded direct recommendation traces | Better candidate coverage; the result still remains empty below the evidence threshold |

All 34 returned card instances across the 36 HTTP requests were reviewed against the collected catalog, including source prices, dates, venues, categories and required evidence. Empty results were checked against catalog availability. The detailed [case-by-case review](2026-09-26-windows-hard-review.md) preserves the baseline failures and the intermediate failure; neither was rewritten as a pass.

The final build adds only the reviewed Mustafa Boz alias after the four-case live run. It was separately rebuilt and checked in the integrated browser: one card, two provider links, both 200 TL. No extra paid recommendation call was used for this listing change.

## Verification

- Web unit tests: **237/237**, including an isolated Node **22.23.3** run on Windows.
- Collector tests: **32/32** on Node 22; collector source was unchanged by these fixes.
- Typecheck and lint: passed. Deployment configuration: **15/15** passed.
- Final compiled build and Worker/D1/R2/Voyage smoke checks: passed.
- Final desktop/mobile browser suite: **11 passed, 1 intentionally skipped**; provider calls mocked in this isolated suite.
- Integrated T3 browser: real local homepage renders, no horizontal overflow at 375 px, duplicate offer consolidation verified.
- Frozen conversational fixture: **20/20** offline. Historical saved-score replay: **12/12**, with no provider calls; this is acceptance/filtering regression evidence, not a new live model-quality result.
- Final embedding coverage: **1092/1092** eligible unique documents cached, zero pending. Counts vary as sessions expire or merge.

## Runtime, calls and limits

Base revision: `ea8da5a9a16bfe81bd753b60aa8acba5b2229eab`, with uncommitted fixes. The local compiled runtime uses Node **24.11.1**; compatibility was also checked with Node 22. Source hashes distinguish the [first fixed build](2026-09-26-windows-hard-provenance.json), [final state-test build](2026-09-26-windows-final-state-provenance.json), and [final build](2026-09-26-windows-hard-final-provenance.json).

The HTTP runner sent **36 requests** with 25-second pacing and no automatic retries, using a separate synthetic local visitor for each suite while retaining application rate limits. **23 responses used Jev mode**. The HTTP harness does not expose exact provider transport counts; each request allows at most one Voyage query and one Jev call. The two diagnostic traces made exactly **2 Voyage query calls and 2 Jev calls**. Testing reused cached document embeddings and made no document-embedding calls. Earlier setup/indexing is outside this test-run budget.

Provider error bodies and recommendation errors are now preserved by the diagnostic helper with credentials redacted. Successful raw Jev bodies are available for the two traces; HTTP application responses, not raw provider bodies, are retained for the 36 application requests. New artifacts were checked for configured key/token values; none were found.

## Remaining limitation

For the vague quiet-evening request, the improved shortlist includes Candela Concert at 900 TL and Can Ozan at 850 TL. Candela's support score was 0.62 against the unchanged 0.70 threshold; the descriptions do not explicitly establish low noise. The empty answer remains conservative and may be less helpful than desired. This is unresolved subjective relevance, not a claim of perfect recall.

Source review used the collected snapshot; every ticket page was not re-fetched. These results do not measure Cloudflare production capacity or satisfy staging, recovery-drill, or unattended-monitoring release gates.
