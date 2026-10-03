# Workshop offer identity follow-up — 2026-09-28

The live confirmation after PR 19 exposed another duplicate, despite passing all hard-constraint and source checks. At `2026-09-28T19:18:37Z`, deployed source `2a7a60e040098fecb42bca17add9d7b2c9f48be6` returned seven cards and 17 offers for the original Turkish partner/workshop/soonest request. All 17 offers matched pinned source HTML. The response nevertheless contained only six distinct activities: the Mozaik Lamba workshop at Bağımsız Sanat Vakfı appeared once under Bubilet's organizer-prefixed title and once as a merged Biletix/Biletinial card. Its response hash is `b11a0d1a527ef5bd54c1fcc722c93b698289723c21f1d489a72b0343d6341cce`.

The request took 15,424 ms; this single observation is not a latency benchmark. Desktop and mobile replay rendered all seven cards and 17 links without layout or console errors, but neither that nor HTTP 200 establishes semantic distinctness. The original response and failed semantic review remain unchanged.

An exhaustive offline scan of the same 13,418-record checkpoint found 16 records, nine distinct titles and nine source URLs beginning with `İstanbul Workshops`. Seven program families were already covered by the Fabrikafa correction. Both remaining families have matching descriptions, program details, reservation contacts and aligned sessions across all three providers:

| Reviewed identity | Literal title variants | Source evidence |
| --- | --- | --- |
| Mozaik Lamba at Bağımsız Sanat Vakfı | `İstanbul Workshops Mozaik Lamba Atölyesi`; `Mozaik Lamba Atölyesi` | 29 September, 06:00 UTC, TRY 1,400; Hobyar, Ankara Cd. No;3, Fatih |
| Single-session Seramik at Atölye Sahi | `İstanbul Workshops Seramik Atölyesi (Tek Seans Workshop)`; `Seramik Atölyesi ( Tek Seans Workshop )`; `Seramik Atölyesi` | 30 September, 14:00 UTC, TRY 1,500; Aziz Mahmut Hüdayi Caddesi, Gülfem Sk. No:17A, Üsküdar |

The TRY 6,000 `Seramik Atölyesi (Aylık Kurs)` is a different program at the same venue and exact instant. It must remain separate. Price alone does not establish program identity.

The correction scopes literal aliases to these reviewed venues, Istanbul and compatible districts. Organizer-prefixed records require their known full address; contradictory nonempty locations reject the identity. The generic `Seramik Atölyesi` title additionally requires explicit single-session evidence in its description and rejects a conflicting monthly-course description. Exact session time, compatible audience policies and all original offers remain required. Other venues, unknown locations and different programs do not inherit these aliases. There is no global organizer-prefix removal. Existing Fabrikafa canonical identities remain stable.

The prefix review, including six provider URLs, raw IDs and pinned body hashes, has SHA-256 `04f395f670fe96c688a49f9f7e21cbd0075961c7c2cbc9d855c5e0da4491c785`. The 17-offer source audit is `d8ceb80f6fc4a70bd3888a6f2653c68754dcb8eb4838a05aae44683d847bc7b7`; the failed UI semantic review is `6b9df9578da0c2fd307092fff0ff233380352b629dce73b5f6d4493deadd3a25`. Full evidence remains in ignored `web/work/workshop-input-20260928/` directories.

The full-catalog audit at the unchanged checkpoint timestamp produces 7,901 eligible sessions from all 10,107 eligible offers, and 11,171 stored sessions from all 13,418 offers. Offer fields, raw IDs, idempotence, reverse-order behavior and retired/quarantined-source exclusion pass. Strict snapshot equality still fails solely for the same two previously documented stale, ineligible future records. This audit has SHA-256 `18188490f37116795e0f5c7eac0badc7c81718f043061fe815242ea47ae27ebd`; its timestamp is historical and its counts are not a claim about a later live request.

The original 12-slot evaluation ledger and first one-slot addendum remain exhausted and immutable. One final, separately recorded application request is reserved to check this correction, with no retries and the same $0.011904 list-price ceiling. The combined 14-slot ceiling is $0.166656, excluding document indexing and earlier evaluation batches; it is not an actual bill. Exact revision, CI, deployment and final confirmation results are recorded in the follow-up pull request rather than retroactively changing the failed response.

Collection was restored at `2026-09-28T19:17:50Z` on compatible merged code, with the original `2026-09-30T00:50:27.846Z` deadline unchanged. This identity-only follow-up requires no collection pause or catalog reimport. The unresolved sources, partial semantic index and other [public-release gates](launch-checklist.md) remain separate from this fix.
