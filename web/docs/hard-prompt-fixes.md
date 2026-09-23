# Recommendation constraint fixes — 23 September 2026

The original [live evaluation](hard-prompt-evaluation.md) found 4 passes, 2 partials and 6 failures. Its report is unchanged. This change fixes the diagnosed constraint, session selection and unsupported-evidence failures; it does not establish unrestricted natural-language understanding.

## Changes

- Shared party-size interpretation recognizes Turkish inflections and common English forms. Explicit total budgets divide by party size; ambiguous group budgets request clarification.
- English weekdays/currency, category alternatives, coordinated negation, district and Istanbul-local clock bounds become validated filters. District/time filters remain visible and clearable in the website.
- Venue/address evidence can resolve coarse provider district fields, but cannot override an explicitly conflicting district. An unambiguous source address can fill a missing address within an already matched session.
- All eligible sessions remain until exact filtering and ranking finish. Production deduplication then chooses the best remaining session, before the 16-candidate Jev request.
- A bounded bilingual evidence checker rejects missing mandatory genre/content/accessibility facts before both AI ranking and deterministic fallbacks. Ordinary moods stay soft. Generic family-friendly text is not proof of no swearing or sexual humour.
- Jev receives local timestamps and evidence checks. Its level-2 rubric permits only optional preferences to remain unknown.
- Reviewed Ada Bar weekday/time title aliases remove an additional cross-provider duplicate; distinct start times and open-microphone shows remain separate.

## Evaluation provenance

The first post-fix run completed seven successful requests and then reached the local hourly visitor limit. Its partial results and the subsequent blocked attempt are preserved separately. Resetting only the loopback visitor's test counter allowed the bounded final run; public limit code and daily AI usage were not changed. Provider retries remain disabled, and requests are paced 25 seconds apart.

- [Original baseline](../evals/reports/2026-09-23-hard-prompts.json)
- [Intermediate partial run](../evals/reports/2026-09-23-hard-prompts-after-fixes.json)
- [Rate-limited attempt](../evals/reports/2026-09-23-hard-prompts-limit-blocked.json)
- [Attempt during local restart](../evals/reports/2026-09-23-hard-prompts-restart-blocked.json), stopped before a provider call

The main final-build evaluation used commit `14f05b4`; the delayed-alternatives follow-up used `06676e3`. The final run completed eight cases, then its English request timed out and workerd logged an internal error. The recorded duration was 592,971 ms despite a 45-second client timeout; the underlying runtime/host cause is not established. The Worker was restarted and a separate bounded continuation covered the remaining four cases. This is not an uninterrupted reliability pass.

- [Final-build run](../evals/reports/2026-09-23-hard-prompts-final.json)
- [Final-build continuation](../evals/reports/2026-09-23-hard-prompts-continuation.json)

## Source-based result review

| Case                                           | Result                                                                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Quiet seated conversation tonight              | Empty; no false concert category is forced. The source cannot establish the requested atmosphere.                                                                                                                |
| Laughter, no concerts/children, ≤₺800          | Five supported comedy choices within budget; Ada Bar provider variants appear once with their own offers.                                                                                                        |
| Serious adult drama, no comedy/children        | Baba, Babamı Kim Öldürdü, Koku, Ballı Süt and Hizmetçiler have supplied dramatic narrative evidence.                                                                                                             |
| Two people, ₺1,200 total, weekend              | Correct ₺600 per-ticket maximum and September 26–27; three valid stand-up productions.                                                                                                                           |
| Kadıköy, Saturday after 20:30, ≤₺500           | Two distinct 21:45 performances: Ada Bar at ₺250 and Vohu at ₺200, both with merged offers.                                                                                                                      |
| Verified step-free entry and accessible toilet | Empty with an evidence explanation; both properties are mandatory.                                                                                                                                               |
| Sunday rowing/kayaking, no boat party/concert  | Empty with an evidence explanation; concert category no longer forced.                                                                                                                                           |
| Verified no swearing/sexual humour             | Conservative empty result. `Fani But Funny` has family-friendly wording, but neither exact absence is established. This removes the original unsupported cards while sacrificing a plausible family-safe option. |

| English Saturday comedy under ₺600 | Three September 26 stand-up productions, ₺200–₺250; both allowed categories and concert exclusion retained. |
| Switch to jazz, remove budget, keep weekend | Correct September 26–27 dates, no budget, concert category and stand-up exclusion; empty because no jazz evidence is available. |
| Alternatives | Initial continuation exposed a repeated production after its first session had started. Commit `06676e3` adds stable production exclusion IDs to website requests; the [focused live verification](../evals/reports/2026-09-24-alternatives-fix.json) returned no previously shown production. Several different venues still offer the same show, limiting variety. Older API clients sending only expired session IDs do not gain this client-side context. |
| Ambiguous two-person ₺800 budget | Requests clarification instead of silently applying ₺800 per person. |

Independent review of the 12 cases before the delayed-alternatives follow-up fix: **10 pass, 2 partial, 0 fail** on recommendation quality. The two partials are strict family-content recall and alternatives (repetition/variety). The focused follow-up fixes repetition of previous productions; it does not claim to solve cross-venue variety. The English request also had a separately recorded operational timeout before succeeding after the Worker restart.

These prompts informed the fixes, so their rerun is a regression check, not held-out accuracy. The strict family-content case has a precision/recall tradeoff rather than an unqualified quality win. The bounded phrase taxonomy can still miss unfamiliar language. Missing source data is not repaired by model confidence.

## Offline and runtime validation

- 167 unit/regression tests pass, plus 12 deployment-configuration tests.
- TypeScript, lint, production build and compiled Worker/D1/R2 smoke tests pass.
- The Voyage transport adapter passes in real workerd against a local mock.
- Historical Jev score replay passes all 12 fixture cases with zero paid calls; its old rubric scores are not a new quality measurement.
- Safari browser check verified visible district/time chips, empty-state behavior and clearing all filters.

Local `/api/health` succeeds. `/api/ready` still returns `503 checkpoint_stale` because the collection checkpoint is older than 24 hours; source rows remain eligible under their separate 72-hour freshness window. This work does not refresh the scraper checkpoint or publish the site.
