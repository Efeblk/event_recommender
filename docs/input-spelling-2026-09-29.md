# Typo-tolerant input extraction

Implemented on the working tree based on `4d5adca98eac8b481cb089d0f5d65b99e6cfb44c`. This change has not been deployed or verified by exact-revision CI.

The existing pre-parsed interpreter remains the architecture: code discovers source spans, Jev selects their roles, code builds validated filters, and the existing complete-plan audit checks the result. Spelling suggestions are supplied in the same two bounded requests; no extra AI stage was added. Original text and numeric digits are preserved.

`web/lib/input-spelling.ts` finds bounded approximate readings for known districts, weekdays, categories, companions/count words, and negations. Selected suggestions can supply exact district/date/party candidates. Quoted literals are protected. Date candidates preserve next-week qualification; numeric tokens cannot be salvaged into smaller party counts. Budget interpretation distinguishes a preferred amount from an explicit permitted maximum. Workshop exclusions do not automatically exclude related education categories.

## Evidence

- `web/fixtures/input-spelling-v1.json`: 13 frozen independent human-input cases, reference time September 29, 2026, 12:00 Istanbul.
- Local final checks: 585 web tests pass, TypeScript and lint pass, diff whitespace check passes.
- Actual Jev evaluation: 13 distinct cases have a passing latest observation. The initial 12-case run passed 10; workshop exclusion and dropped Taksim constraint were corrected. A subsequently added complex optional-workshop case first failed locally at the request-size boundary, then passed after prompt compression. The failed captures remain unchanged.
- The severe input `bu cmrtesi kadkoyde sevgilmle konsr olmasn kişi başı 1000tl altı` resolved to October 3, Kadıköy, two attendees, partner context, a strict per-person 1000 TL ceiling and concert exclusion.
- The optional-workshop case retained workshop as a preference, excluded concert/theatre, set a 2000 TL per-person ceiling and soonest ordering without inventing a date window.
- Actual evaluation consumed 30 Jev provider requests and 223,562 reported input tokens: approximately **USD 0.00939** at USD 0.042/million input tokens, before any credits. No Voyage or hosting deployment calls were made for this evaluation. Token pricing: <https://docs.typesafe.ai/models>.

Raw captures and logs: ignored `web/work/input-spelling-20260929/`; final web check log `web/work/input-spelling-tests-final.log`. The original cumulative budget and ledger remain in `web/work/prepared-live-20260929/`, with spelling evaluation slots 29–46. Slot 44 was preserved even though it made no provider call. Extensions remain within the existing cumulative USD 1 AI ceiling; neither documents nor scheduled authorization windows were extended.

## Limits

This is interpreter evidence, not a deployed end-to-end recommendation or capacity benchmark. The cases ran across several working-tree revisions; raw captures contain dirty-source fingerprints. The database, collection, merging and embedding publication architecture remain unchanged.

Spelling recovery uses a small vocabulary. Arbitrary artists, venues, neighborhoods and misspelled months are not comprehensively supported. Exact neighborhood filtering remains unsupported: the tested Taksim request now returns an explicit unsupported constraint instead of losing its location or substituting all of Beyoğlu. Alternative districts, preferred-budget scoring and arbitrary entity resolution need further schema work. Typed selections and the same-model audit do not guarantee semantic correctness on every human input.

Pattern reference: <https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook>.
