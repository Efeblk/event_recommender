# Recommendation verification — 24 September 2026

This follow-up addresses the variety, follow-up interpretation and provider deadline issues recorded in [the previous evaluation](hard-prompt-fixes.md). It remains a local preview; no site was deployed.

## Changes

- Diversify the full ranked pool before selecting the 16 Jev candidates, and show up to five distinct, clearly named shows. Venue/session facts and ticket offers remain separate.
- Send stable show exclusion keys alongside session and venue-specific production keys. Typed alternatives in Turkish or English retain constraints and exclude previously shown shows, including other venues.
- Merge the reviewed Boğaziçi Komedi Kulübü open-mic title variants only when venue and timestamp match.
- Handle inflected uncertainty exclusions, coordinated genre exclusions, waived accessibility requirements, dotted clock bounds and “same date” follow-ups. Keep explicit requirements separate from optional mood preferences.
- Require positive source evidence for ordinary family-friendly suitability in both AI and fallback results. Generic family wording still does not prove the absence of profanity or sexual content when those are explicit requirements.
- Reject specific district metadata when an explicit address district contradicts it. Treat unqualified “klasik” as insufficient classical-music evidence.
- Advance the verified collection checkpoint during local refresh and replace the local snapshot only after canonical readback.
- Bound the complete Voyage/Jev request lifecycle, including response-body parsing, to 15 seconds without retry. The website aborts at 40 seconds and displays a retry action. These guards do not establish the cause of the previous host/runtime stall.

## Validation

187 unit/regression tests, typecheck, lint, production build and compiled Worker/D1/R2 smoke tests pass. The Voyage adapter also passes a real-workerd test with a deliberately stalled response body.

Eight new prompts and their expectations were recorded before live execution. Several phrase-level defects were found offline and fixed first, so this is a fresh regression evaluation, not an untouched held-out accuracy benchmark. The raw reports and source-based grading are preserved below.

## Refreshed catalog

The September 24 collection verified 920 detail pages across all three providers.
It produced 2,810 records, with 31 failed pages, one quarantined record and three
carried records. All seven listing traversals completed, while six had bounded
detail sampling; this is not an exhaustive inventory of every provider event.
The canonical D1 readback contains 2,909 records (including retained older rows),
2,749 of which were eligible at verification time. Health and readiness both
return HTTP 200; the checkpoint was genuinely advanced from the new collection.

The source audit found one merged session whose Biletix district said Beyoğlu
while the matched Bubilet address ended Kadıköy/İstanbul. District-filtered
requests now reject this inconsistent evidence instead of silently trusting
one field. It also found a food festival using “klasik bir konser gecesi” to
mean a conventional concert; that phrase no longer certifies classical music.

## Live results and provenance

- [Initial eight requests](../evals/reports/2026-09-24-fresh-prompts.json), code `0d59d36`: **5 pass, 2 partial, 1 fail**. Date, budget and evidence handling passed; unrecognized provider title aliases caused repeated İnfiniti cards and an Efsahne repeat in alternatives.
- [Three affected cases retested](../evals/reports/2026-09-24-fresh-prompts-alias-fix.json), code `aaed3b7`: **3 pass** after separate, reviewed İnfiniti and Efsahne alias families were added. Same venue and timestamp remain necessary for ticket-offer merging.
- [Final runtime verification](../evals/reports/2026-09-24-runtime-verification-final.json): health/readiness HTTP 200; 2,409 canonical eligible sessions; all 1,236 unique documents indexed, zero pending. The backfill made 24 successful batches, embedding 747 missing documents without retries.

Independent review therefore verifies **8/8 scenarios across the two runs**—five initial passes plus three focused retests. This is not an uninterrupted eight-case run on the final revision. All 11 HTTP requests succeeded, taking 243–3,688 ms; there were no provider retries or recorded timeouts in these runs. A readiness preflight stopped while the final build was still starting, before any provider call; the focused evaluation began only after the build completed.

| Scenario | Verified outcome |
| --- | --- |
| Ordinary family-friendly comedy | Fani But Funny, 800 TL, with explicit family-viewing evidence. |
| Strict absence of swearing and sexual content | Empty with an evidence explanation; neither exact absence is established. |
| Three people, 1,800 TL total | Five distinct stand-up titles on September 27, each at most 600 TL; İnfiniti provider offers merged. |
| English dotted clock | September 25, Beyoğlu, strictly after 19:30 and at most 600 TL. Okan Reis is clearly a concert; the second listing advertises DJ-accompanied live performance, making its concert format less certain. |
| Classical, excluding jazz and rock | The 500 TL cello program; the food festival is correctly absent. |
| Tired-day mood, theatre or stand-up | Two distinct Beyoğlu shows, September 25 at 20:30, within 700 TL. The conflicted Kadıköy row is absent. |
| Step-free entry explicitly waived | İlayda Kayser Quartet, September 25 at 21:00, 712 TL, with jazz repertoire evidence. |
| Same constraints, higher budget, alternatives | Empty after prior shows are excluded; date, district, time and categories retained, budget raised to 900 TL. |

## Browser verification and limits

A user-supplied T3Code integrated-browser screenshot confirms the refreshed site and catalog render. The integrated automation client first returned Chromium error pages and then disconnected (`No preview automation host is available`), preventing the final automated click-through. Native controls were not used after the user requested the integrated browser. Before that request, Safari verified the ambiguous-budget clarification; it does not substitute for a final integrated-browser interaction test.

These checks establish the tested local flows, not general natural-language accuracy or universal deduplication. Title aliases remain deliberately reviewed and bounded. Missing mandatory source evidence produces empty results rather than a model guess. No public deployment or PR merge was performed.
