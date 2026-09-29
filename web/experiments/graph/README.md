# Local graph + vector experiment

Run from `web/` with Node 22 and Docker Desktop's Linux engine:

```powershell
npm run graph:start
npm run graph:load
npm run graph:demo
```

Demo: <http://127.0.0.1:4175>. Database browser: <http://127.0.0.1:17474>. Run `npm run graph:benchmark` for the frozen comparison. `docker stop biplan-graph-prototype` stops the database; Ctrl+C stops a demo started in your terminal.

The default input files are the ignored prepared artifacts `work/event-preparation-20260929/search-after.json` and `vectors.json`. Other local artifacts can be selected with `GRAPH_CATALOG_PATH`, `GRAPH_VECTORS_PATH`, and `GRAPH_SNAPSHOT_AT`. No catalog downloads or provider calls happen automatically. The database refuses to replace a different frozen snapshot.

This dedicated container binds only to loopback, uses a separate Docker volume, and has a 2 GiB memory / two-CPU limit. Authentication is disabled for this isolated local experiment. The official Community image is pinned to digest `sha256:5eb12ad77fa46ab73e23df9ea1f43f5c0f2a79523435577648e046be042b9b93`; the running version was verified as **5.26.31**. This configuration is not a cloud deployment.

## Model and search

```text
Program → HAS_SESSION → Session → AT_VENUE → Venue
                          │                    ├→ District
                          │                    └→ Neighborhood
                          ├→ Offer
                          └→ SearchDocument [exact cached embedding]
```

Publication uses the existing prepared session identities and canonical production keys. It performs no new event merging or request-time identity reconstruction. Performer, organizer and arbitrary topic relationships are not guessed from titles.

Existing embeddings contain venue text, so they belong to exact SearchDocuments rather than venue-independent programs. Reuse validates the Voyage profile, document SHA-256, dimensions, finite/nonzero vectors and conflicting cache entries. Shared document hashes reuse a single node; each session keeps its document relationship.

Search runs parameterized Cypher over all eligible sessions before vector scoring. District evidence is prepared using the application's existing conflict-aware rules; mandatory source requirements use the existing checker. Exact cosine is computed inside Neo4j over every eligible cached document. BM25, reciprocal rank fusion and the existing distinct shortlist behavior are reused. Sessions without embeddings remain eligible for lexical retrieval. A vector index exists for diagnostic ANN comparison; global top-16 ANN followed by filters is never used as the search path.

The demo consumes structured requests. It does **not** run new human-input interpretation or Jev's final relevance judgment. Its vector probe reuses an event's cached document vector, not an embedding of the typed query. This proves retrieval mechanics and numerical compatibility, not human semantic relevance.

## September 29 evidence

Frozen snapshot: `2026-09-29T11:47:23.732Z`, catalog hash `ee8fe72bcd0dce4578144426f215e3636dfc49f292c9f7741669f53e1700e7b5`, vector hash `f1b7c91fe60a0534551e5037206450dfde2f3f745065a9fe2c9655ae6dc92824`.

- 7,719 sessions; all 10,024 offers; 3,294 programs; 801 conservatively identified venues.
- 3,459 unique search documents; 3,436 have cached vectors, covering 7,693 sessions. Missing vectors remain visible to lexical retrieval.
- Eight comparison cases: zero missing/extra eligible IDs and identical ordered shortlists. Maximum mapped cosine error was below `3.5e-7`.
- Source audit: all immutable event fields and every offer matched for 105 distinct returned cards. Existing show-identity labels were unique within each shortlist. The explicitly asserted Tuğkan/Halil families preserved all five expected raw offer IDs across exactly two sessions. This is not a complete independent audit of every possible title/adaptation family.
- 593 web tests, TypeScript and lint passed. Desktop and 375-pixel mobile UI checks passed without page errors or horizontal overflow; screenshots were reviewed. Integrated browser automation was unavailable, so headless Playwright was used.
- No Jev, Voyage, cloud provisioning or deployment calls. Public preview and GCP resources remain unchanged.

Warm medians from three local sequential repeats, including graph HTTP calls and application ranking:

| Case | Current in-memory search | Graph experiment |
|---|---:|---:|
| Full eligible catalog | 193 ms | 356 ms |
| Saturday, Kadıköy, under 1000, no concerts | 158 ms | 23 ms |
| Optional workshop, exclude concert/theatre | 391 ms | 430 ms |
| Workshop lexical search | 172 ms | 47 ms |

This is a small local diagnostic, not a capacity benchmark or a comparison with relational/vector databases. The graph is faster on some selective filters and slower on broad exact vector retrieval. It does not establish a universal performance winner.

Neighborhood edges are conservative **source mentions** in venue/address text, with conflicting mentions left unknown. They are not geocoded boundaries. In this frozen catalog, source-mention queries returned 146 Taksim, 216 Moda, 22 Karaköy and two Balat sessions. This enrichment can also be used in a relational database; graph storage alone does not create better location evidence. The production interpreter still treats exact neighborhood constraints as unsupported.

Raw receipts, benchmark, source audit and UI artifacts are in ignored `work/graph-20260929/`. The initial load receipt is preserved separately from the final reviewed projection. Code remains in the working tree; no exact-revision CI or deployment is claimed.

References: [Neo4j vector indexes](https://neo4j.com/docs/cypher-manual/5/indexes/semantic-indexes/vector-indexes/), [vector functions](https://neo4j.com/docs/cypher-manual/5/functions/vector/), [parameterized Query API](https://neo4j.com/docs/query-api/current/query/).
