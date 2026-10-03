# Duplicate-card and database-flow audit — October 2, 2026

The reported duplicate could not be reproduced on the deployed service. This audit found a reproducible display-deduplication defect and two supported alias gaps in the frozen local catalog; it does not establish which caused the reported observation. Base revision: `4b2cdce`; fixes are local working-tree changes. No catalog rows, cloud resources or deployments were changed.

## Findings and fixes

- `diverseEvents` preferred an unversioned, persisted `canonicalShowKey` over current alias rules. Deploying updated rules while retaining an older prepared snapshot could therefore leave duplicate cards. It now uses current conservative display identity first, retaining the saved-key/production fallback for generic titles. Identity computation caches immutable event objects and still checks all identity inputs for mutation. This changes card selection, not database identities or offer facts.
- Literal aliases cover `Son Lux` / `%100 Müzik Sunar: Son Lux` and `Bahçeşehir Kültür Sanat Merkezi` / `Bahçeşehir Kültür Merkezi`. Regression fixtures retain the original provider IDs and cover the full observed families. Session merging still requires the same time, supported title and venue; offers remain separate within the merged session.
- The migration replay verifier failed on Windows because its migration-012 fixture retained CRLF while PostgreSQL returned LF. Normalizing that fixture fixes the check. No runtime migration definitions changed.

The fixture is [reviewed-merge-families.json](../../web/tests/fixtures/reviewed-merge-families.json): 3 Son Lux provider records and 19 records across 9 Bahçeşehir performances. Titles/venues/addresses are frozen database projections, not verbatim provider responses. The exact read-only query, result, publication ID and observation times are preserved under ignored `web/work/db-merge-audit/`; disposable migration receipts are under `web/work/catalog-foundation/migration-replay-verification-*.json`.

## Validation and limits

Web tests pass (729), as do TypeScript and lint. The final test-only numeric-sort correction was checked with the affected merge/retrieval suites (86 tests) and lint; unchanged runtime checks were reused. Collector tests pass (218). All five disposable PostgreSQL migration-replay groups pass, covering fresh installation, pending-only upgrades, invalid history, function drift and frozen-import replay; the temporary database and roles were removed. No provider or inference calls were made. The attempted staging service inventory read was denied for the active cloud account, so current deployed state was not verified.

## Separate follow-ups

- `Dönüşüm` and `Dönüşüm Tiyatro Oyunu` have matching schedules, but that alone does not establish the same adaptation/cast. No alias was added.
- Durable PostgreSQL canonicalization uses stricter title/venue matching than the prepared snapshot merger. This fix does not reconcile existing PostgreSQL production IDs or introduce alias-aware canonical acceptance.
- Static inspection also found that canonical JavaScript preflight omits current revision payload/session aliases that SQL acceptance considers (`canonical-store.mjs` versus migration 005). That ingestion compatibility issue is separate from the reproduced display bug and remains unfixed.
