# Bi' Plan v1 architecture

The [product plan](product-plan-v1.md) defines the scope and acceptance checks.
This file describes the current snapshot system. PostgreSQL is outside v1.

## Data flow

Collect → local checkpoint → import → identity + published checkpoint → search.

The shared identity code lives in `collector/identity/`. The GCP store uses it
when publication prepares the search catalog. The collector's local checkpoint
holds source records before that preparation.

1. `.github/workflows/gcp-collector.yml` restores the private catalog checkpoint
   and the coverage backlog. It runs `collector/run.mjs` for Biletinial, Bubilet
   and Biletix. Each run has page, HTTP request and time limits. Later runs
   continue unfinished work.
2. The collector validates source records. `collector/pipeline.mjs` reconciles
   records and marks exact production identities. Failed, quarantined, retired
   and unvisited pages have separate states.
3. The collector saves `collector/state/events.json` as a local checkpoint.
   It saves the coverage backlog and JSON reports separately. Failed pages
   retain their original check times. A later run does not make old evidence fresh.
4. `collector/publish.mjs` sends verified source pages to `/api/admin/import`.
   It then calls `/api/admin/collection` to publish a complete checkpoint.
   It reads the checkpoint back to verify publication.
5. `web/lib/store.gcp.ts` writes immutable snapshots to private Cloud Storage.
   `web/lib/materialized-catalog.ts` uses `collector/identity/resolve.ts` to
   prepare matching sessions. A merge requires supported title identity,
   matching session time and matching venue. Provider IDs, prices and links remain.
   Firestore holds source heads, the active catalog pointer, leases and request
   limits. A lease prevents concurrent writers from replacing newer data.
   Publication changes the pointer only after the complete snapshot exists.
6. The Cloud Run Node service loads the published catalog for search.
   `web/lib/store.node.ts` selects the snapshot store by default.
   `CATALOG_BACKEND=postgres` and `CATALOG_BACKEND=pipeline` are opt-in paths.
   They are outside v1. The deployed staging workflow uses snapshots.

## Request flow

`web/app/api/recommend/route.ts` runs `web/lib/recommend.ts`.

- `web/parser/` and `web/lib/span-interpreter.ts` interpret Turkish and English
  requests with the `span-v2` interpreter. Follow-ups retain the request state.
- Code resolves exact dates in Europe/Istanbul. `web/lib/plan-evidence.ts`
  checks hard constraints against catalog evidence.
- `web/lib/hybrid.ts` combines BM25 word matching and Voyage vector matching.
  Retrieval uses the full eligible catalog before the shortlist.
- The shortlist contains at most 16 distinct candidates. `web/lib/jev.ts`
  asks TypeSafe Jev whether those candidates support the request.
- Code applies mandatory checks and removes duplicate results before display.
  Cards use recorded titles, times, venues, prices and provider links.
- Missing vectors retain word matching. Provider failures use an explicit
  fallback. Unknown prices or policies do not satisfy a hard constraint.

Search consumes the prepared catalog. It does not collect provider pages or
enrich the full catalog.
The catalog remains searchable when the vector index is incomplete.
Semantic coverage requires cached vectors for each current document.
Optional Voyage indexing needs a separate approved budget and bounded window.

## Phase 1 golden replay

`web/fixtures/golden-v1.json` defines 40 requests, their expected plans and a
fixed Istanbul reference time. Two corrections carry the actual previous result
state. The user must review the fixture before the first scored run.

The catalog manifest pins collection run `37181072133`, its source-record file,
byte count and SHA-256. The large file stays outside Git. A verified private GCS
copy preserves it after the GitHub artifact expires. From the repository root,
restore the file with `gh run download 37181072133 -n
gcp-event-data-staging-37181072133 -D web/work/phase-one/artifact`. After artifact
expiry, use `gcloud storage cp` with the manifest's `privateArchive` URI and
`web/work/phase-one/artifact/collector/state/events.json` as the destination.

From `web/`, run `npm run test:golden -- --prepare`. This validates the frozen
bytes, prepares identities with the production code, estimates all current and
future document versions, and writes a request review page. It makes no network
calls. Repeated preparation needs a new `--output work/phase-one/<name>.json`.

For a scored replay, provide a GCS vector export with `schemaVersion: 1`, the
exact Voyage `profile`, `dimensions: 1024` and `entries: [{ hash, vector }]`.
The runner requires vectors for every eligible frozen session. Run
`npm run test:golden -- --vectors work/phase-one/vectors.json`. This mode is
offline. Cache misses fail; they cannot become passing fallback results.

After the user approves the phase budget, a first live run can add `--live
--budget work/phase-one/budget.json`. That local file records `scope: "phase-1"`,
`jevCapUsd`, `voyageCapUsd`, `approvedBy` and `approvedAt`. A null Voyage cap
records explicit approval of unrestricted Voyage use. Keys come from `TYPESAFE_API_KEY` and
`VOYAGE_API_KEY`. The runner reserves each attempt before the call, retains failed
reservations, settles successful calls from reported usage, stops new live calls
after a provider failure, and does not retry.
Live query and document jobs share a 21-second Voyage pacer and the phase ledger
lock. A diagnostic baseline may use `--allow-partial-vectors`; its recorded
coverage prevents it from passing the frozen quality gate. The final run requires
full coverage. Live cases also have a minimum 13-second interval.
After inspecting a failed attempt and correcting its cause, an explicit
`--reviewed-retry work/phase-one/<recovery>.json` can identify one failed cache
`key`, a nonempty `reason` and a unique `attemptId`. The recovery has a separate
reservation. The original failed reservation stays charged. Repeating that
recovery cannot make another paid call if its response is missing.
All cache directories share `web/work/phase-one/budget-ledger.jsonl`. Account for
indexing and staging reservations in that same phase budget before those calls.

Raw parser, query-embedding and Jev responses are cached by request context,
catalog hash, reference time and exact provider body. They are replayed through
the current production code; the final recommendation list is never cached.
Changing constraints, prompts, candidates or models invalidates the relevant
response. The output preserves top-10 cards, canonical and source IDs, full
results, elapsed time, cache hits, errors and expected-constraint audits.

Labels in `web/fixtures/golden-v1-labels.json` start pending. Bind them to the
fixture, catalog and `resultSha256` printed by the runner. Preserve the first
labelled run's `runSha256` as evidence. Label every returned card in rank order,
review each empty result against all saved hard-match IDs, and review each list
for semantic duplicates. Record at least 10 user-reviewed request IDs. A changed
result invalidates labels; an unchanged cached replay can reuse them.
Exit 0 means frozen quality passed; exit 1 means a runner/provider failure; exit 2
means labels or quality checks remain incomplete. Local elapsed times do not
establish the separate staging p95 requirement, so the runner never declares
Phase 1 complete.

## Operations

Cloud Run serves the private staging application. Cloud Storage stores snapshots.
Firestore stores coordination data. Secret Manager stores runtime credentials.
Artifact Registry stores container images.

`/api/health` checks the application. `/api/ready` checks catalog and checkpoint
readiness. A successful health check does not prove catalog readiness.

Use [GCP deployment](gcp-deployment.md) and [GCP collection](gcp-collector.md).
The [archive](archive/) preserves earlier plans and evidence. Archived documents
do not define current scope. Cloudflare runtime files and workflows are removed.
PostgreSQL code stays in its current folders. Its preparation step and dedicated
CI job are removed. The Node snapshot path remains the v1 runtime.
