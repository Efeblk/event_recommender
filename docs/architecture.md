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

## Operations

Cloud Run serves the private staging application. Cloud Storage stores snapshots.
Firestore stores coordination data. Secret Manager stores runtime credentials.
Artifact Registry stores container images.

`/api/health` checks the application. `/api/ready` checks catalog and checkpoint
readiness. A successful health check does not prove catalog readiness.

Use [GCP deployment](gcp-deployment.md) and [GCP collection](gcp-collector.md).
The [archive](archive/) preserves earlier plans and evidence. Archived documents
do not define current scope. Phase 0 still has to remove the Cloudflare runtime
and freeze the unused PostgreSQL workflow steps.
