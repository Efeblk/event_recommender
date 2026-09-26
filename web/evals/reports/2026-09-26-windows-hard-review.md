# Human review: 2026-09-26 Windows hard baseline

Reviewed the 20 frozen cases in `2026-09-26-windows-hard-baseline.json` against their stated intent and the raw `web/data/events.json` catalog. Times below are Istanbul local time when a boundary matters. This review separates interpreted-state correctness, hard source evidence, subjective relevance, and catalog recall.

Baseline revision: `ea8da5a9a16bfe81bd753b60aa8acba5b2229eab` (dirty worktree, as recorded by the runner). Baseline finished at `2026-09-26T18:35:38.490Z`. No provider or other external calls were made for this review.

## Overall assessment

- 11 cases pass without a material qualification: `group_comedy`, `group_four`, `english_classical`, `english_reset`, `dance_mood`, `late_boundary`, `contradiction`, `unsupported`, `no_match`, `date_correction`, and `budget_correction`.
- 6 cases have definite state or hard-constraint failures: `jazz_start`, `jazz_alternatives`, `genre_correction`, `group_clear_budget`, `child_age`, and `free_negated`.
- `accessibility` happens to return the correct empty result, but the requested wheelchair requirement is absent from the interpreted filters. It is therefore an unsafe enforcement gap rather than a clean pass.
- `quiet_mood` respects its only hard constraint. The follow-up traces show that retrieval improved, while source support remained below the unchanged recommendation threshold; whether to show the best candidate is an unresolved precision-versus-helpfulness choice.
- `exact_artist` returns the intended single Redd production card. Its baseline defect is loss of the cheaper same-session provider offer, not omission of other dates.

## Per-case review

| Case | Verdict | Evidence |
|---|---|---|
| `jazz_start` | Fail: date negation | Parsed `2026-09-26..27` instead of Oct 3. Empty is not itself disproved by the raw catalog: no Oct 3 Kadıköy concert at <=1200 contains explicit jazz/caz evidence. The date state is nevertheless unequivocally wrong. |
| `jazz_alternatives` | Fail: inherited wrong date | Retains the erroneous Sep 26–27 window from `jazz_start`, so it never evaluates the requested Oct 3 alternatives. No cards were returned. |
| `genre_correction` | Partial fail: district not cleared | `Arctic Monkeys Tribute`, 450 TRY, is a supported rock concert and is eligible. Date was cleared, but `district=Kadikoy` remained despite “Mekân ve tarih fark etmez,” which can suppress otherwise eligible rock recall. |
| `group_comedy` | Pass | Oct 4 filters, party 3, total 1800, derived max 600, and both Stand-up/Tiyatro categories are correct. Comedy Lab (200) and Kadıköy Stand-up Gecesi (300) have direct stand-up/comedy evidence and are distinct productions. |
| `group_four` | Pass | Party changes to 4 and derived per-person max changes to 450 while date, total budget, and category set remain. Both returned cards cost <=450 and have direct stand-up evidence. |
| `group_clear_budget` | Fail: budget not cleared | Response still has `maxPrice=450` and `totalBudget=1800`. The two cards shown are eligible, but the stale cap incorrectly narrows recall. The catalog includes an additional Oct 4 `Çocuk Stand-up` at 600, illustrating that events above 450 exist. |
| `english_classical` | Pass: justified empty | Correct Oct 10 concert and <=1500 filters; no child card leaked. No Oct 10 concert <=1500 has explicit classical/symphony/orchestra evidence. `Genshin Impact Senfoni Konseri` exists but costs 4450. |
| `english_reset` | Pass | Old constraints are cleared. Both cards are Oct 2 Beyoğlu stand-up events and cost 250/200, within 600. |
| `quiet_mood` | Hard constraints pass; unresolved evidence tradeoff | No card exceeds the 1000 cap because none are returned. In `2026-09-26-quiet-trace-before.json`, the 16-item shortlist contained no concerts. After the retrieval inflection fix, `2026-09-26-quiet-trace-after.json` contains two concerts: `Candela Concert` (900) and `Can Ozan Konseri` (850). Jev ranks Candela first but assigns only 0.62 support, below the unchanged 0.70 threshold, so the result remains empty. Candela's thousands-of-candles/light-atmosphere description is reasonable evidence for a calmer evening, but it does not explicitly promise low noise; Can Ozan is described as acoustic and electronic, which is even less conclusive. The current result is defensibly cautious, though possibly insufficiently helpful for a soft mood request. The trace supports neither claiming this is fixed relevance nor calling the empty result a definite recall failure. |
| `dance_mood` | Pass | `Machine Girl, Öncesi: DJ S1S0` is a concert at 750. Its source description explicitly says “Elektronik müzik” and describes an energetic performance; it contains no rap evidence. |
| `child_age` | Fail: category omitted; empty otherwise justified | Despite explicit “çocuk tiyatrosuna,” response `category` is null. The empty result is supported by the catalog: zero Oct 4 known-price Tiyatro records <=450 have explicit child/age-8 suitability. A 7–12 vocal workshop at 350.01 is category Konser and is not a substitute. |
| `accessibility` | Unsafe enforcement gap; observed empty correct | Oct 3/Tiyatro/<1000 state is present and no cards are returned. Among 32 raw catalog events satisfying those ordinary filters, none has explicit wheelchair/accessibility evidence (`tekerlek`, `wheelchair`, `engelli`, `engelsiz`, `erişilebilir`, `rampa`, or `asansör`). However, the response state does not capture the wheelchair requirement, so the safe empty depends on Jev selection and is not guaranteed for fallback or a different shortlist. |
| `late_boundary` | Pass | Returned sessions are 22:30 and 21:45 Istanbul time (stored 19:30Z and 18:45Z), both strictly after 21:00 and before 23:00. Both are stand-up and cost 350/300, within 750. |
| `contradiction` | Pass | Returns `needs_input`, no cards, for the impossible intersection “after 22:00 and before 20:00.” |
| `unsupported` | Pass | Returns `unsupported_location` and no Istanbul substitute for Ankara. |
| `free_negated` | Fail: negated free interpreted as zero budget | Response sets `maxPrice=0` for “Ücretsiz olması gerekmiyor” and returns empty. The raw Oct 9 catalog has no explicit jazz/caz concert <=800, so corrected search may also be empty, but the zero-budget state is wrong. |
| `exact_artist` | Card pass; same-session offer loss | Returned card is exactly `Redd Konseri`, Oct 3, category Konser. Returning one card is correct under the one-card-per-distinct-production policy; the Oct 30 and Nov 20 sessions are not missing recall for this response. The definite baseline defect is provider consolidation: the raw catalog has the same Oct 3 21:00 session from Biletinial at 1605 (`JJ Arena Ataşehir`), while the card exposes only Bubilet at 3420 (`JJ Arena`). The cheaper same-session source offer is lost because the venue aliases were not recognized as the same venue. |
| `no_match` | Pass | Returns empty despite 2123 broad candidates; no generic ballet/dance/theatre substitute is fabricated for the zero-gravity space-station request. |
| `date_correction` | Pass: justified empty | Correctly selects Sep 28 rather than “tomorrow,” retains Beşiktaş/Tiyatro/700, and returns empty. The raw Sep 28 catalog contains no matching Beşiktaş comedy theatre at <=700. |
| `budget_correction` | Pass: justified empty | Retains Sep 28, Beşiktaş, and Tiyatro while replacing 700 with 1700. Empty remains supported: the raw catalog has no Sep 28 Beşiktaş comedy theatre at <=1700. |

## Duplicate and source review

No returned pair contains duplicate productions. The group cases return distinct stand-up productions. Returning one Redd card is also intended because results are capped at one card per distinct production. The one material source-consolidation concern is `exact_artist`: two records strongly indicate the same Redd session (same title and timestamp, `JJ Arena` versus `JJ Arena Ataşehir`) but the baseline card preserves only the more expensive offer. This is a definite venue-alias merge defect; it should be fixed without weakening the rule that sessions must not be merged on title similarity alone.

## Empty-result rationale by case

| Case | Is empty supported by the catalog? | Qualification |
|---|---|---|
| `jazz_start` | Yes, on final card evidence | No Oct 3 Kadıköy concert <=1200 has explicit jazz/caz evidence. The response still fails because it searched Sep 26–27. |
| `jazz_alternatives` | Yes, on final card evidence | The same catalog absence makes an empty Oct 3 result plausible, but the response inherited the wrong Sep 26–27 window and therefore did not perform the requested search. |
| `english_classical` | Yes | No Oct 10 concert <=1500 has explicit classical/symphony/orchestra evidence; the explicit symphony event costs 4450. |
| `quiet_mood` | Ambiguous by design | The after trace retrieves Candela and Can Ozan, but neither explicitly guarantees a non-noisy evening. Candela reaches 0.62 source support, below 0.70. Empty favors evidence precision; showing Candela would favor usefulness for a soft preference. |
| `child_age` | Yes | No Oct 4 Tiyatro event <=450 has explicit suitability for age 8. The response still has a parsing defect because the requested Tiyatro category is absent. |
| `accessibility` | Yes for this catalog snapshot | Of 32 Oct 3 Tiyatro events under 1000 with known prices, none has explicit wheelchair-accessibility evidence. Enforcement is still unsafe because the requirement was not captured. |
| `free_negated` | Yes, on final card evidence | No Oct 9 concert <=800 has explicit jazz/caz evidence. The response still fails because it incorrectly sets `maxPrice=0`. |
| `no_match` | Yes | No source event supports a zero-gravity ballet at a space station, and the system correctly avoids a broad substitute. |
| `date_correction` | Yes | No Sep 28 Beşiktaş comedy theatre exists at <=700 in the raw catalog. |
| `budget_correction` | Yes | Raising the cap to 1700 still yields no Sep 28 Beşiktaş comedy theatre in the raw catalog. |

## Post-fix 12-case regression review

Reviewed all 12 results in `2026-09-26-windows-hard-regression.json`, which finished at `2026-09-26T18:45:22.134Z`. This is an intermediate runtime: it verifies the fixes included in that build, while later source-only fixes must be verified by their own subsequent run.

| Case | Verdict versus baseline | Card and source review |
|---|---|---|
| `jazz_start` | Fixed | Date is now Oct 3 only; Kadıköy, Konser, and 1200 remain. Empty is supported because the catalog has no matching event with explicit jazz/caz evidence. |
| `genre_correction` | Fixed in this runtime | Date and district are cleared while Konser/1200 remain. `Ogün Sanlısoy` (493) and `Redd Konseri` (699) both have direct rock evidence, meet the cap, and are distinct productions. |
| `group_comedy` | Pass retained | Correct Oct 4, party 3, total 1800, max 600, and Stand-up/Tiyatro state. Both cards have direct stand-up evidence. Comedy Lab correctly consolidates Bubilet 200 and Biletinial 224 as two offers for one session. |
| `group_four` | Pass retained | Correct party 4, total 1800, and derived max 450. Both cards are Oct 4 stand-up events <=450 and are distinct. |
| `group_clear_budget` | Budget fixed; party state still failed in this runtime | `maxPrice` and `totalBudget` are cleared and eligible candidates expand from 8 to 18. Date and categories remain, but `partySize=4` is also absent even though “diğer koşullar aynı” requires it to persist. Cards themselves remain eligible. A later source change reportedly fixes party preservation; this intermediate report does not verify that later change. |
| `child_age` | Fixed | `category=Tiyatro` is now present with Oct 4, party 2, total 900, and max 450. Empty remains source-supported because no eligible theatre event has explicit age-8 suitability. |
| `accessibility` | Fixed for observed behavior | Oct 3/Tiyatro/1000 and mandatory-evidence empty notice are correct; no unknown-accessibility card leaks. The catalog still has zero qualifying events with explicit wheelchair evidence. |
| `free_negated` | Fixed | Correct Oct 9, Konser, and max 800 rather than zero. Empty is supported because no eligible event has explicit jazz/caz evidence. |
| `full_reset` | Pass | Reset removes prior group, total budget, per-person cap, comedy requirement, and district. It applies Sep 27/Tiyatro and returns two eligible theatre cards. `Şahane Pazar Sahnede` and `Kürk Mantolu Madonna` each preserve two same-session provider offers. |
| `total_update` | Pass | Retains party 4, Oct 4, Stand-up/Tiyatro, and comedy intent; total changes to 3000 and derived max to 750. Comedy Lab (200) and Musti Kusti (750) satisfy the cap and have direct stand-up evidence; both expose correctly consolidated two-provider offers. |
| `exact_artist` | Fixed | Returns only `Redd Konseri` as intended. The Oct 3 session now selects the cheaper 1605 Biletinial offer and preserves both it and the 3420 Bubilet offer, resolving the baseline venue-alias loss. One card remains correct under the one-card-per-production policy. |
| `casual_alternatives` | Pass | Preserves the Redd-only intent and excludes the already shown canonical production/show/session identifiers. Empty is correct: it neither repeats the shown production nor substitutes another artist. |

Across the 12 results, every returned card satisfies its date, category, price, and source-evidence requirements, and no returned pair is a duplicate production. The sole observed failure in this intermediate artifact is `group_clear_budget` losing `partySize`; later untested source changes should not be credited to this report until their own runtime evidence is recorded.

## Final four-case state regression

Reviewed all four results in `2026-09-26-windows-final-state.json`, completed at `2026-09-26T18:48:37.882Z`. All four pass their stated expectations, and every returned card has direct comedy/stand-up evidence.

| Case | Verdict | Card and state evidence |
|---|---|---|
| `group_start` | Pass | Oct 4, party 4, total 1800, derived max 450, and Stand-up/Tiyatro are correct. Comedy Lab (200) and Kadıköy Stand-up Gecesi (300) are eligible, distinct productions; Comedy Lab retains both provider offers. |
| `clear_budget_keep_party` | Pass; intermediate failure closed | Clears `maxPrice` and `totalBudget`, retains `partySize=4`, Oct 4, and Stand-up/Tiyatro. Eligible candidates increase from 8 to 18. The two returned cards remain valid and distinct. This runtime verifies the later party-preservation fix that the 12-case intermediate report could not credit. |
| `new_total_after_waiver` | Pass | Reuses retained party 4 without clarification, sets total 3000 and derived max 750, and retains Oct 4/categories/comedy. Comedy Lab (200) and `Musti Kusti - Stand Up` (750) meet the cap and preserve their two-provider offers. |
| `venue_set_date_indifferent` | Pass | Keeps `district=Besiktas`, clears date, and applies Stand-up/max 700. `Yunus Emre Gündüz` (450.8) and `Serdar Nalçakar` (600) are both stand-up events whose source addresses explicitly say Beşiktaş. They are distinct productions and within budget. |

No new hard-constraint, source-evidence, duplicate-card, or empty-result failure appears in this four-case final runtime.

## Mustafa Boz same-session duplicate investigation

The raw catalog contains exactly two Mustafa Boz records and no additional future Mustafa Boz sessions to use as a repeated-schedule cross-check:

- Bubilet `71d73af43edf3b0ea7597ce4`: `Mustafa Boz Stand Up`, Vohu Sahne, `2026-09-26T19:00:00.000Z`, 200 TRY. Its description is title-only, but the URL also identifies `mustafa-boz-stand-up`.
- Biletinial `a9f546fe7c0b06771ea46c97`: `Mustafa Boz - Tek Kişilik Stand Up`, Vohu Sahne, the same exact timestamp, 200 TRY. Its description explicitly identifies Mustafa Boz's solo stand-up performance in Kadıköy.

These are safe to consolidate as a reviewed literal title alias, provided the existing exact session safeguards remain mandatory. The performer name, event format, exact venue, exact instant, price, and city all agree; “Tek Kişilik” is a format qualifier rather than evidence of a different named production. Two different Mustafa Boz performances cannot occupy the same Vohu Sahne session, and neither source supplies a conflicting subtitle or edition. The absence of other catalog sessions means the evidence supports this one exact pairing but does not justify a general rule that strips `Tek Kişilik` from arbitrary titles.

Recommended scope: add only the reviewed pair `Mustafa Boz Stand Up` / `Mustafa Boz - Tek Kişilik Stand Up` to the literal title aliases. Continue requiring exact canonical venue, instant, and city before offers merge. A focused test should also prove that a different time, venue, artist, or an added named subtitle remains separate.
