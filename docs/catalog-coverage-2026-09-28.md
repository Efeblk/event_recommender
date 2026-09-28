# Catalog coverage evidence — 2026-09-28

This document records implemented behavior and evidence captured on 2026-09-28. Historical and interim observations are separate from final publication proof. Catalog coverage is complete only when listing discovery is exhausted, every known URL has fresh verified sessions or a verified retirement, and no failures, quarantines, stale pages or unvisited URLs remain. A request or time limit leaves a durable backlog and is never reported as complete.

## Implemented behavior

The catalog accepts 15 formats: `Konser`, `Tiyatro`, `Stand-up`, `Workshop`, `Sergi`, `Festival`, `Spor`, `Sinema`, `Söyleşi`, `Dans`, `Gösteri`, `Eğitim`, `Gezi`, `Müze`, and `Diğer`. Provider taxonomy remains as source metadata. Narrow title/program evidence may correct an obviously mislabeled format; incidental words in biographies or venue names cannot.

Collection discovers the full inventory exposed by the three existing providers instead of taking fixed samples of 100 new and 1,000 known URLs. Bubilet traverses its observed Istanbul tag taxonomy, Biletix exhausts Istanbul result pages, and Biletinial expands its current header sections and paginated routes. Every discovered URL enters a durable backlog. Bounded runs rotate across unvisited and stale sources, preserve successful checkpoints, carry failures without freshening them, and report the remainder explicitly. HTTP, detail, discovery-page, and elapsed-time limits pace a run without discarding queued work.

Offers merge only when session instant and venue match and title identity has source support. Different sessions, venues, adaptations, workshop/performance formats, and conflicting audience policies remain separate. Merged records retain every provider URL, price, availability, raw event ID, and source session ID. Top-level availability and price come from an available offer; unknown, sold-out, or cancelled offers cannot become the cheapest available representative.

Pages with JSON-LD/display session-time conflicts can be published as empty quarantine watermarks with reason `session_time_conflict`. Quarantine is distinct from verified retirement and ordinary collection failure. It removes conflicting source offers from the next checkpoint, blocks older or equal imports from reviving them, and lets strictly newer verified data reactivate the source. Other-provider offers remain. Reverification of 33 candidate pages identified 19 durable quarantines. All 19 were subsequently confirmed by direct Firestore head readback: quarantine kind, zero events, exact URL, timestamp and stored-object hash matched the published evidence.

The measured catalog outgrew two old ingestion limits. Atomic source pages now accept up to 1,000 sessions, including the observed 314-session cinema page. Publisher envelopes remain bounded to 2,000 events, three pages and 3.5 MB, with additional D1 query-budget batching. Checkpoints and their readers accept up to 32 MiB and 20,000 records. These are resource bounds: oversized pages fail visibly rather than being truncated.

A real Biletix conference priced at 59,400 TRY exposed the previous arbitrary 50,000 TRY catalog ceiling. Source parsing and import validation now accept finite, nonnegative prices within the safe numeric currency bound (`Number.MAX_SAFE_INTEGER / 100`); Biletix integer minor units must be safe integers. Regression tests also cover prices above the former 100,000 TRY parser ceiling. An offline check of all 170 active, null-price, non-cinema Biletix/Biletinial checkpoint pages found exact saved HTML for every page and no further price hidden by that ceiling. User budget constraints still apply independently; collecting an expensive event does not make it eligible for a 2,000 TRY request.

The first final-publication attempt stopped at import request 389: a session started in the 166 ms between request preparation and the response. The first 388 batches had succeeded, but no checkpoint was advanced. An offline replay preserves the exact failed batch and validates the timing failure. Import validation now allows a 60-second transit grace; query eligibility still excludes started sessions immediately. Boundary tests cover mixed started/future sessions, the exact grace limit, older sessions, and the unchanged future-date horizon. Recovery uses the successful-batch manifest and retains original collection timestamps rather than repeating the full upload or claiming a fresh collection.

The cinema date endpoint now uses its canonical localized route. Forty-four provider pages with an explicit main-page “event occurred” marker were retired after reverification; “coming soon” or missing schedules are not retirement evidence. Cinema auxiliary API response bodies were not archived by the collector, so saved top-level HTML cannot fully replay those sessions. The observed endpoint responses and normalized collection output are retained, and this evidence limitation remains explicit.

## Discovery and merge evidence

The observed Bubilet Istanbul taxonomy contained 176 tag entries and produced 1,215 canonical detail URLs. The observed Biletix Istanbul search exhausted at 1,634 canonical detail URLs. These are page inventories, not session counts: a page can contain several sessions and the same session can appear at several providers. Biletinial discovery includes dynamic header categories, pagination, kids routes, cinema expansion, and JSON-LD details. Durable coverage state is the authority for whether every current route has been processed.

The frozen merge reference contained 7,428 raw records and produced 6,088 canonical records after reviewed literal aliases, 31 fewer than the preceding audit. It contained 1,143 multi-record groups and 2,483 raw records in those groups, with at most three providers per group. Exact-instant, raw-ID, offer-field, second-pass idempotence, and input-order checks had zero failures. These frozen counts are not current publication totals. Near-title candidates without source evidence remain separate.

For historical context, the pre-expansion frozen catalog contained 5,412 raw rows. That figure does not establish present freshness or completeness.

The fresh discovery-only capture ran from `2026-09-28T17:24:36.808Z` to `17:28:47.119Z`. All 16 listing routes exhausted successfully. Subsequent bounded detail refreshes resolved the three newly listed URLs and the high-price event. Against that fixed inventory:

| Provider | Advertised URLs | Verified active | Verified retired | Quarantined | Other failed | Unattempted |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Biletinial | 1,289 | 1,226 | 44 | 19 | 0 | 0 |
| Bubilet | 1,214 | 1,210 | 4 | 0 | 0 | 0 |
| Biletix | 1,640 | 1,630 | 2 | 0 | 8 | 0 |
| Total | 4,143 | 4,066 | 50 | 19 | 8 | 0 |

These counts describe the captured inventory, not a permanent guarantee about changing provider listings or every event in Istanbul. Fifty URLs were still advertised despite verified retirement. The eight Biletix failures comprise five records beyond the two-year collection horizon (including test/product-like records) and three unsupported redirects: the provider homepage, a gift-card route and an external campaign. They are not relabeled as successful collection. The separate historical-only coverage contains 185 failed URLs, 63 conclusively retired URLs, and four last-verified URLs no longer advertised.

Every currently advertised URL has been attempted. At the frozen coverage reference `2026-09-28T17:43:03.150Z`, no current URL was unvisited, missing from coverage, or stale beyond 72 hours. All 14 Biletinial routes and the Bubilet/Biletix inventory routes exhausted, with zero incomplete listing routes. Recent failure or quarantine is still unresolved coverage, even when its attempt timestamp is recent.

The prepublication stage-4 snapshot contains 13,210 raw session offers and 14 observed formats; no `Gezi` record was fabricated. Before the later Fabrikafa alias correction, it merged into 11,029 sessions, or 7,966 sessions at that audit's eligibility timestamp. Every raw ID occurred exactly once, every offer retained its source facts, and repeated/reversed-input merges agreed. These are historical local counts; the readback section below records the published inventory.

## Interim live query evidence

These preserved, card-audited preview responses demonstrate interim query behavior. They do not replace final publication readback.

| Case | Runtime | Result | Verified behavior |
| --- | --- | ---: | --- |
| Original Turkish: partner, ≤2,000 TRY/person, no concert/theatre, workshop optional, soonest | `e60cd83adf8223b2497e6e448e63e95486168855` | 5 cards | Per-person ceiling, partner, exclusions, optional workshop, chronological source-backed cards |
| Turkish Saturday partner, no concert | `3dac91a4a7ffdf0d60c9146339767fe45326b1f6` | 15 cards | Exact Saturday, partner, concert exclusion, chronological order |
| English workshop, ≤2,000 TRY/person, no concert/theatre | `3dac91a4a7ffdf0d60c9146339767fe45326b1f6` | 12 cards | Workshop, per-person ceiling, both exclusions, partner, chronological order |
| Turkish two-person total 2,000 TRY workshop | `3dac91a4a7ffdf0d60c9146339767fe45326b1f6` | 8 cards | Total 2,000, party two, derived 1,000/person, workshop and exclusions |
| Turkish ambiguous 1,000 TRY budget with partner | `a184739c33d1155af97ef1d50398b5ac0563ea86` | Clarification | Specific total/per-person question, prior state unchanged and original message retained |
| Follow-up “Bütçe toplam.” | `a184739c33d1155af97ef1d50398b5ac0563ea86` | 13 cards | Total 1,000, party two, derived 500/person; no invented date, category or ordering constraint |

All original-query, English and explicit-total offers passed saved raw-source review. The Saturday response passed catalog-level constraints, but six of its 18 offers could not be reproduced exactly from later source pages. Investigation found changed schedules and conflicting source times; these URLs were queued for fresh collection. The original Saturday response is retained as limited evidence, not a full source-verification pass.

The ambiguity follow-up passed all 13-card/15-offer catalog checks. Eleven offers have saved provider-body hash evidence; four carried offers lack that original hash. An initial follow-up audit incorrectly required chronological ordering although neither user message requested it. The original contract and failed audit remain preserved alongside the corrected contract, passing audit and erratum; application ranking was not changed to satisfy that mistaken expectation.

An offline gap review initially selected older HTML copies for four quarantined URLs and incorrectly reported clean replays. Requiring the exact checkpoint content hash reproduced session-time conflicts for all 19 quarantines. The original Markdown review and its recorded machine-artifact hash remain, but that machine JSON was accidentally overwritten during correction; its original bytes are unavailable. The versioned correction and erratum disclose this evidence limitation. No page was reactivated based on the mistaken result.

Original recommendation failures remain immutable. The first public exact request was empty before catalog expansion. A later local exact attempt timed out at the deployed eight-second interpreter deadline without retry; that is transport evidence, not evidence of no matching events. The first ambiguous-budget response returned generic `constraint_ambiguous`; the deterministic `budget_ambiguous` and total/person follow-up fix came later. Those original responses were not rewritten.

## Vector reuse and bounded cost

The earlier zero-vector diagnosis used legacy `embeddingText` instead of the production `voyageDocumentText` hash. The corrected audit found 641 matching eligible sessions across 249 cached documents, 2,291 matching merged sessions, and 3,049 matching raw cloud sessions in the preserved 1,718-entry cache. This was a frozen cache subset, not the current GCP index. Cache keys are content hashes and contain no canonical or event ID. Remaining misses reflect absent or changed documents, not a demonstrated runtime key defect.

After publication, four bounded Voyage document calls used 8,191 observed tokens and added 22 indexed documents while reusing existing vectors. At the pre-Fabrikafa-correction checkpoint, 1,971 of 3,596 documents were indexed and 1,625 remained pending. The run stopped at its four-call allocation, without retries or extending the existing 28-call window; four window calls remained reserved for later collection. The observed new tokens have a list-price value of approximately $0.000983, before any account allowance. Account free-token balance and actual billing were not established. This remains partial semantic coverage, with lexical retrieval available for unindexed events.

The live evaluation was capped at 12 application-equivalent slots. Each reserved at most three Jev calls of 64,000 input tokens and one Voyage call of 32,000 tokens. At Jev's [$0.042/M input tokens](https://docs.typesafe.ai/models) and Voyage 4 Large's [$0.12/M input tokens](https://docs.voyageai.com/docs/pricing):

`3 × 64,000 / 1,000,000 × $0.042 + 32,000 / 1,000,000 × $0.12 = $0.011904/slot`

The original 12-slot maximum is **$0.142848**. All 12 slots were consumed and their ledger remains unchanged. A separate one-slot addendum is allocated only to verify the confirmed Fabrikafa duplicate defect after the code correction, with the same $0.011904 ceiling and no retries. The combined 13-slot ceiling is $0.154752, separate from document indexing. These are list-price ceilings, not actual bills. The cost erratum corrects metadata without rewriting historical ledger entries.

## Verification status

At the publication and seven-card live audit, the deployed implementation was `af3b981e44516334624f83bafb68a903cd1ef735`. Its web suite passed **528/528** and collector suite **118/118**; typecheck and lint passed. Input-contract, frozen release cases, Jev replay, deployment/GCP configuration, Node build/smoke, Cloudflare build/smoke and Linux image smoke all passed. Browser checks passed **39**, with **1 skipped**. The browser suite mocks AI providers. Cloudflare smoke coverage exercises distinct retirement/quarantine metadata, source-only removal, stale/equal replay rejection, and newer verified reactivation. These checks are historical evidence for that exact revision; the final patch's exact CI, deployment and post-correction live evidence are recorded in [PR 19](https://github.com/Efeblk/event_recommender/pull/19).

All seven checks passed on this exact revision: [Bi Plan CI](https://github.com/Efeblk/event_recommender/actions/runs/36463589417) and [legacy Python CI](https://github.com/Efeblk/event_recommender/actions/runs/36463589477). Local check provenance records documentation edits and an unrelated temporary offline-audit helper; neither changed runtime source. The Linux image was built from an archive of the exact committed revision. That temporary helper was subsequently moved into ignored evidence storage.

Private staging `biplan-staging-00013-qs9` and temporary preview `biplan-preview-20260927-00013-6jk` ran the same immutable image digest `sha256:d81ac45579c49f716670e3755c01a6cae88fbacae83f9ea2be37cd81a95ac1a7` for those checks. Both reported the expected revision and readiness. Private IAM, minimum zero/maximum one instance, and the daily AI limit of 100 were preserved. Only the authorized temporary preview keeps visitor throttles disabled and uses `jev-v1` input interpretation.

## Final publication and readback

After the first 388 successful import batches, recovery sent 603 batches successfully with no skipped events. The final checkpoint POST then exceeded the old 60-second client timeout. Read-only reconciliation proved that GCP had committed it at `2026-09-28T18:34:29.811Z`, 80.666 seconds after request start. Two authorized readbacks matched the same checkpoint hash and collection report. No checkpoint POST was retried, and no successful import batches were repeated wholesale. The failure journal and a separately identified read-only recovery receipt remain preserved.

Collector commit `d16a1f666c2e9d21f9d4f07b95e20873433aad56` gives only checkpoint saves a 240-second deadline, below the existing 300-second Cloud Run timeout and synchronization lease. Imports remain at 60 seconds, readback at 30 seconds, and health at 15 seconds. **119/119** collector tests pass, including controlled in-flight abort evidence that no automatic retry, readback or local snapshot replacement follows an ambiguous timeout. This collector-only change leaves the deployed `web/` tree identical to `af3b981`.

The published checkpoint contains **13,418 raw records**. Before the Fabrikafa correction, at its saved timestamp, **10,107 eligible offers merged into 7,955 sessions**, including 1,713 sessions with multiple offers. Across all stored records, including historical and unavailable data, 13,418 offers merged into 11,225 sessions. Every raw ID appeared exactly once; offer fields, source session IDs, session instants and prices were preserved. Repeated and reversed-input merges agreed. No currently active offer remained for a retired or quarantined source URL. The alias correction changes canonical grouping, not the stored raw inventory.

An independent audit of the corrected merge against that same checkpoint and timestamp produces **7,906 eligible sessions from all 10,107 eligible offers**, including 1,749 sessions with multiple offers. Across all stored data it produces 11,176 sessions and preserves all 13,418 offers. The 89 Fabrikafa offers become 40 exact program/session groups, with no residual split for the same reviewed program and instant. Raw-ID, offer-field, quarantine, repeated-merge and reversed-input checks all pass. The separate heuristic list still contains 271 possible near-title pairs for review; these are neither established duplicates nor authority to merge unsupported identities.

No current record from the final local collection is missing or changed in GCP. Two additional future records remain in storage from old failed refreshes; both are older than 72 hours and are excluded by query eligibility. The strict snapshot-equality audit therefore remains `pass: false`, with the discrepancy explicitly reviewed. The eligible inventories match exactly. Other differences are expired records: 222 additional stored records, 16 omitted records, and three changed records. These are not described as current inventory losses.

The checkpoint's inherited `sourceCoverage` summary describes its collection ancestry; it is not the final current-listing census. The 4,143-URL table and frozen coverage statistics above are the authority for that census. Neither represents a guarantee about every event in Istanbul or future changes on provider websites.

| Evidence | SHA-256 |
| --- | --- |
| Original final publication report | `b6788d573d1e750ef3380222999d5c481592c8d46ddfdd59d0af7fa01241c87f` |
| Resume publication report | `d27b49ecf6afd182214aef141b5d0a5ddec63f3df78417edbac07f06002d14a8` |
| Published checkpoint response | `dd73ed63892e5d42e1ac212ed964dbee912aec45673b2b738f77dede8ea9823c` |
| Event-array readback, compact `JSON.stringify` bytes | `4f3bcbf9554fc0ae3f47cb6fe8a1b83c3ac1db22fab088efc43697c858ceaf6c` |
| Event-array readback file bytes, including trailing newline | `84dd61fea1042aee514d6e63ce5eafa0c2c83d7a6d729ca25d1d16504be09e8f` |
| Pre-Fabrikafa-correction full merge audit | `80f9716713165c516bf0e6c65c2515edfa63fba82d2d96c6aa0f83796ebc8793` |
| Corrected full merge audit, same checkpoint and timestamp | `fe6e80f3d58559806f6ed47c058f739b917b76ede580f2a1ea54a892622146b4` |
| Snapshot-difference review | `4963e1d623eef4b1bbd85ca28a69c05c81389fbad9b1a21e0295a2e30e3241bd` |
| Direct quarantine-head readback | `5a4046ff13481db8f94d2d0849760a37f6269e10c248eb625a0d663c8cd686f5` |

Full artifacts remain under ignored `web/work/workshop-input-20260928/`; this document preserves the identifying hashes and outcomes without committing credentials or provider response archives.

## Final query and remaining release gates

The original Turkish request on `af3b981` returned seven cards and eight offers in 14,177 ms. Hard constraints and all eight offers passed exact saved-source review, but semantic review then confirmed three duplicate pairs: Hat, Tezhip and Çini workshops. That response remains a distinctness failure, not seven verified distinct recommendations. A desktop/mobile replay of its exact response used deployed assets, made no additional AI calls, and found no rendering errors or horizontal overflow. Integrated browser automation was unavailable, so the UI check used headless Playwright. The single observed latency is not a performance benchmark.

The correction uses source-reviewed identities for seven programs at Fabrikafa Make & Coffee: Hat, Tezhip, Çini, Vitray, Parfüm, Deri and Ebru. The review covers 89 raw records, 21 provider URLs, matching program descriptions and repeated aligned sessions. Bare `İstanbul Workshops` requires the verified full Üsküdar address; the two explicit Fabrikafa venue names reject contradictory nonempty addresses or districts. Generic titles at other venues, different programs, different sessions and conflicting audience policies remain separate. All offers and raw IDs remain, including Biletix's unknown Ebru price. Both session identity and display identity use this scoped evidence. Tests cover all seven families, location/time/category/audience counterexamples, order independence and idempotence.

The source review SHA-256 is `e35d415ab066f5089d1eeabed45d70b302276309dc19874674c49351b259b48d`; its full source fixture is `93deb7e81a3235184a3ec4bf6377ac5de3fcfe4039b62b7f6d3032c6e582135f`. The original seven-card response hash is `8f25ace367d2f799b2adc6f190576cae2c7ef6cf789880be7c2dd22b2ea13821`. Final runtime and post-correction query evidence belong to the exact revision recorded in PR 19; this earlier response is never relabeled as a pass.

Scheduled GCP collection was temporarily paused at `2026-09-28T17:53:48Z` because the old default-branch collector could not safely handle the enlarged catalog. The restoration record in PR 19 must identify the compatible merged revision, read back the enabled variable and retain the existing `2026-09-30T00:50:27.846Z` expiry. Independent monitoring was not changed. This maintenance interval cannot count as uninterrupted collection evidence.

This is staging evidence for further testing, not public production qualification. Remaining gates include complete embedding coverage, the unresolved source inventory, at least 48 hours of unattended collection/monitoring for the compatible collector, and capacity/recovery qualification with the enlarged catalog. The 81-second checkpoint and Storage SDK listener warnings are measured limitations to investigate during that qualification; explicit application stream cleanup was present, and the warnings alone do not establish an application memory leak. The temporary preview's visitor-throttle bypass must be removed before public production launch.
