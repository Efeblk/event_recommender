# Catalog coverage status — 2026-09-28

This document records the implementation and bounded discovery evidence available on 2026-09-28. It is not a production-completeness claim. A provider is complete only when its listing inventory is exhausted, every discovered detail URL has a current successful extraction or verified retirement, and the durable coverage report has no remaining backlog or unresolved failures. Quarantined and failed pages remain accounted for but prevent a complete-coverage claim.

## Implemented coverage model

- The catalog vocabulary now contains 15 categories, including `Workshop` and the retained fallback `Diğer`. Unknown provider formats remain in the catalog as `Diğer`; ingestion no longer rejects an event merely because its format is outside the former concert, theatre, and stand-up set.
- Category normalization uses provider taxonomy as the base and narrowly scoped title/program evidence as an override. Atelier mentions in a biography or venue name are not sufficient workshop evidence.
- Provider provenance can retain the raw source category, extraction version, extraction method, and source session identifiers. Bubilet breadcrumb selection ignores the event-self crumb and uses the deepest recognized provider-format crumb.
- Session extraction remains conservative. Unknown sale state or price stays unknown, conditional and combined tickets do not become ordinary available offers, and incomplete calendar/session coverage quarantines the page instead of deleting previously collected sessions.
- Discovery and detail refresh are separate durable stages. Known URLs survive bounded runs, failures and quarantines remain distinct, and later runs resume the backlog rather than treating a request limit as exhaustion.

## Bounded discovery evidence

| Provider | Observed discovery evidence | Current conclusion |
| --- | --- | --- |
| Bubilet | The public Istanbul taxonomy exposed 176 numeric/tag entries. A bounded full-tag union exhausted with 1,215 distinct canonical detail URLs. | Listing discovery was exhausted for that observed taxonomy. Detail freshness and quarantine backlog still determine catalog completeness. |
| Biletix | The unfiltered Istanbul search exhausted with 1,634 distinct canonical detail URLs across all returned formats. | Listing discovery was exhausted for that observed search result. Detail freshness and quarantine backlog still determine catalog completeness. |
| Biletinial | Dynamic header categories, category pagination, kids pages, cinema session expansion, and JSON-LD detail extraction are implemented. | The all-route discovery verification was still pending when this note was prepared. No complete URL or event count is asserted here. |

The two confirmed discovery inventories contain 2,849 distinct provider URLs in total. This is a URL inventory, not an event/session count: one production URL may contain multiple future sessions, and the same session may be offered by multiple providers.

## Historical catalog and merge reference

The pre-change frozen merge audit used 5,412 raw catalog rows. Its duplicate review identified 61 duplicate records associated with 49 session identities. These numbers describe that frozen input only. They are not current production totals and must not be reused as evidence that the expanded provider crawl is complete.

The merge contract requires supported title identity plus the same venue and exact session instant. Provider offers retain their own URLs, prices, raw identifiers, and availability. Different venues, times, adaptations, and generic titles remain separate.

## Refresh limits and remaining proof

Collection is deliberately bounded by HTTP, detail, page, and elapsed-time budgets. Reaching one of those limits leaves a durable backlog and does not mark the provider complete. Stale carried records, freshly verified records, failed pages, and quarantined pages remain distinguishable. Consequently, current availability and price coverage cannot be inferred from the discovery URL totals.

Before release, record a fresh durable run showing, per provider:

- exhausted listing discovery and its content hashes;
- discovered, attempted, verified, failed, quarantined, stale, retired, and unvisited URL counts;
- retained session and available-session counts after conservative merging;
- source-grounded category distribution, including `Workshop` and `Diğer`;
- a reviewed sample of every returned card for the target Turkish and English queries.

## Query evidence

The original exact Turkish request on the deployed preview returned an unsupported/empty outcome before the catalog and category changes. A later local exact-query attempt reached the expanded 15-category interpreter but its single proposal request timed out at eight seconds; no retry was made, so that run is transport evidence rather than a semantic failure. A separate English success was reported during the same evaluation effort, but its exact runtime revision and returned-card evidence must be inserted from the preserved run record before it is cited as release evidence.

The preserved run paths, exact revisions, request counts, response artifacts, and card-by-card source review should be added here after the evaluation owner confirms them. Until then, this document makes no claim that the original exact request succeeds on the deployed preview or that all three providers are fully fresh.
