# Prepared search publication

GCP collection checkpoints preserve raw provider records for recovery and auditing. They are not the search index.

Before a search generation becomes visible, publication prepares canonical sessions, source offers, production/show IDs, lexical tokens, exact Voyage document text and hashes. It also prepares the changes needed when individual offers expire, including cases where conflicting policy groups can recombine. Search selects the appropriate prepared version and applies user-specific constraints; it does not merge provider listings.

With Voyage configured, the new generation stays pending while the bounded indexing job reuses cached vectors and embeds missing documents. This includes future representative variants that can become active as offers expire. Activation verifies coverage for the exact embedding profile and atomically switches the searchable generation. Until activation, searches keep using the previous compatible generation, subject to its normal freshness rules. An initial deployment without a ready generation remains unavailable; it does not silently expose a partial index.

Raw checkpoint publication and searchable-generation activation are separate operations. The collection job can preserve progress even when embedding limits stop indexing. Existing call limits, pacing and authorization windows still apply; pending data does not authorize extra provider calls. Both normal and audited index paths attempt activation after saving vectors, or immediately when all vectors are already cached.

The recommendation API omits internal preprocessing metadata from event cards. Cloudflare remains the legacy fallback and retains its existing publication behavior.

## Migration

Deploy only after preparing the staged generation and confirming its vector coverage. A legacy checkpoint can be materialized by explicitly republishing the same collection report; ordinary search requests never perform migration or merging. Keep the prior application revision available until the prepared generation is ready. Do not expand the embedding budget or recreate unchanged vectors to perform this migration.

## Local evidence

The September 29 replay used the frozen 13,418-record catalog and the original request's time and filters. Moving merging out of requests reduced the locally measured catalog preparation/filter stage from roughly four seconds to 118–161 milliseconds. The prepared snapshot was 48,443,806 bytes; preparation took about 5.4 seconds at publication time. Event/source records and embedding text matched the prior merge flow at the reference time and 24/48/72 hours later. This is not a Cloud Run end-to-end latency claim. Saved diagnostics are under `web/work/latency-*` and `web/work/materialized-catalog-benchmark-20260929.*`; no AI calls were used for those measurements.

The final local batch passed 544 web checks, type checking, lint, GCP configuration validation, the Node build and compiled startup smoke. No CI or deployment was triggered. These working-tree changes have not yet been deployed or measured end to end on Cloud Run.

The subsequent connected-flow check exposed and fixed cached-only indexing skipping activation, bootstrap omitting activation, and readiness mixing a new raw checkpoint with an older active search generation. Readiness now reports pending collection separately, pins its checkpoint to active search, and compares raw source counts consistently rather than comparing merged sessions with provider offers. Both indexing CLIs make one activation POST when no document embeddings are missing; that path performs no Voyage call.

The connected test exercises gated publication, cached-vector reuse, the actual audited embedding adapter/parser with a controlled response, activation, prepared-vector retrieval, query embedding and the actual Jev ranking adapter/parser with a controlled response. It checks threshold rejection and a zero-document-call replay. Input interpretation is stubbed, so this does not establish live NLP quality or provider latency. The follow-up final batch passed all 545 web checks plus type checking, lint and compiled Node smoke; evidence is in `web/work/prepared-flow-*.log`. No live AI requests, CI runs or deployment were made.
