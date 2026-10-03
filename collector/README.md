# Bi' Plan collector

The collector fetches public Istanbul listings from Biletinial, Bubilet and Biletix.
It runs separately from the Node HTTP service. It does not call TypeSafe.
Use [the product plan](../docs/product-plan-v1.md) for scope.
Use [the GCP collector runbook](../docs/gcp-collector.md) for scheduled operations.

## Run locally

Use Node from `web/.nvmrc`. Node >=22.13 is required.

```sh
npm ci
npm run collect -- --max-details 2000 --max-http 6000 --max-minutes 40
```

Use `--discover-only` to inspect listing coverage without publishing sessions.
Use `--snapshot PATH` to select the input and output checkpoint.
The default local snapshot is `../web/data/events.json`.
The GCP workflow uses `state/events.json`.

Each run has limits for detail pages, HTTP requests, time and raw storage.
The GCP workflow allows 2,000 detail pages, 6,000 HTTP requests and 40 minutes.
It allows at most 20 pagination requests per listing.
Coverage cursors and unfinished URLs continue in later runs.
A bounded run does not prove complete provider coverage.

## Evidence and validation

The collector records verified, retired, failed, quarantined and unvisited pages separately.
It retains original observation times for records carried from earlier runs.
Failed pages do not become fresh because a later run tried them.
Verified empty pages carry a retirement time. Older imports cannot restore removed sessions.
A partially invalid page does not publish a partial session list.
Unknown availability and unknown prices remain explicit.

`output/report.json` records the collection result.
`state/coverage.json` records the coverage backlog.
`state/events.json` is the workflow's local checkpoint.
Raw provider pages stay in ignored local storage or an explicitly configured private mirror.
The workflow excludes `state/raw/` from public artifacts. It keeps JSON reports.
PostgreSQL preparation is frozen. Its workflow step is removed.
The code in `db/`, `jobs/` and `preparation/` remains for later work.

## Import and checkpoint

The configured server needs a catalog store before import can succeed.
The local Node preview uses explicit GCP settings. It has no automatic local database.

```sh
npm run checkpoint:restore -- --output state/events.json --fallback ../web/data/events.json
npm run publish -- --checkpoint --snapshot state/events.json
```

Remote use requires `BIPLAN_URL` and the application's `SYNC_TOKEN`.
Private Cloud Run also requires its HTTP identity token.
The workflow sets those credentials securely. Never print or commit them.

Publication imports verified pages in bounded batches through `/api/admin/import`.
It publishes a complete checkpoint through `/api/admin/collection` after all batches succeed.
It reads the checkpoint back and updates the local snapshot.
An import failure prevents the checkpoint call. There is no automatic publication retry.
HTTPS is required for remote destinations.
`--allow-loopback-http` permits HTTP only for a loopback destination.

Optional Voyage indexing has its own approved budget and bounded window.
Collection alone does not prove complete vector coverage.
Phase 2 of the product plan adds an hourly readiness monitor and seven days of observation.

## Tests

```sh
npm test
```

Tests use saved fixtures. They do not fetch providers or make paid calls.
The opt-in PostgreSQL integration test remains disabled unless explicitly selected.
[Historical collector instructions](https://github.com/Efeblk/event_recommender/blob/bad42d030850e92bfb4e3cdc2f3dc92dcde155ca/collector/README.md)
describe the removed Cloudflare workflow. Saved reports retain their original results.
