# Voyage retrieval with Jev ranking

The recommendation pipeline uses `voyage-4-large` at 1,024 dimensions by default. Voyage embeds event text as `document` and the current request with bounded relevant user history as `query`. Jev receives the original request and candidate facts, never vectors.

1. Interpret clear constraints and find all eligible sessions using stable database pagination. There is no total 1,000-session cutoff.
2. Merge cross-provider sessions, then apply exact local time/district constraints, exclusions and mandatory source-evidence checks. General humour preferences do not force the Stand-up category.
3. Rank every eligible session by semantic cosine similarity and keyword BM25, then combine their ranks using reciprocal rank fusion (constant 60). Only then choose the best session per production. Zero-keyword matches receive no arbitrary lexical boost.
4. Send the best 16 productions to Jev and show up to five supported results. Jev receives verified constraints, source-evidence checks and Istanbul-local timestamps. Score 2 may leave optional preferences unknown, never mandatory requirements. The provisional acceptance threshold remains 2; 16 is an initial setting that needs recall evaluation.

## Configuration and indexing

Put `VOYAGE_API_KEY` in ignored `web/.dev.vars`, alongside the existing `TYPESAFE_API_KEY`. Restart the local server after changing settings. Optional server-side settings are `VOYAGE_MODEL` (`voyage-4-large`, `voyage-4`, `voyage-4-lite`) and `VOYAGE_DIMENSIONS` (`256`, `512`, `1024`, `2048`). Legacy `EMBEDDING_*` keys do not enable this path. No local model server or GPU is required.

From the repository root with Node 22.13+:

```sh
# Coverage inspection only; zero provider requests.
npm run embeddings:index --prefix web -- --origin http://127.0.0.1:3001 --allow-loopback-http

# Explicitly build missing vectors; consumes the server's Voyage allowance.
npm run embeddings:index --prefix web -- --origin http://127.0.0.1:3001 --allow-loopback-http --live --max-batches 100

# Pace batches for free trials or other lower-rate Voyage tiers.
npm run embeddings:index --prefix web -- --origin http://127.0.0.1:3001 --allow-loopback-http --live --max-batches 100 --interval-ms 60000

# Optional indexing after local collection/import.
npm run local:refresh --prefix web -- --collect --index
```

The script reads the local sync token only for a loopback destination. Remote use requires `BIPLAN_URL` and `SYNC_TOKEN`; the Voyage key stays on the server. GET `/api/admin/embeddings` reports eligible sessions, unique documents, indexed documents and pending documents. POST indexes at most 32 pending documents under a lease. Both require the sync token. The driver stops on failure without automatic retries and has a bounded batch count. `--interval-ms` accepts 0–60000 milliseconds and waits only between successful batches; use pacing that fits the [Voyage API rate limits](https://www.mongodb.com/docs/voyageai/api-reference/overview/) for the account tier. Scheduled collection can opt in through the `INDEX_EMBEDDINGS=true` GitHub environment variable; indexing occurs after the canonical collection checkpoint is saved.

Document vectors live in a separate D1 table, keyed by the provider/model/dimension/text-profile identity and a SHA-256 content hash. Identical event text shares vectors across sessions. Title, category, venue and description are embedded; price, date, availability and checked-at timestamps stay structured. Freshness-only updates do not trigger re-embedding. Changed text or model settings create cache misses; incompatible vectors are never silently reused. Obsolete cached content is not retrieved but currently remains stored; cache pruning is future maintenance.

## Failures and limits

No Voyage key means keyword retrieval. An empty index avoids a wasted query call and visibly reports keyword fallback. Partial indexes allow keyword discovery of new events. Voyage failure falls back to keywords while keeping Jev available; Jev failure returns clearly identified deterministic results. Neither failure relaxes hard constraints. A normal search makes at most one Voyage query call and one Jev ranking call, with no automatic retries. Index creation is separate and never happens in a public search.

`AI_DAILY_LIMIT` limits AI-enabled recommendation requests when either provider is configured, including attempts that ultimately need no provider call. It is not an exact billable-call or dollar limit. Authenticated document indexing is separate from that counter and bounded by the indexing driver's batch limit.

Tests cover mocked embedding transport, semantic candidates beyond the old shortlist, missing-index/outage behavior, exact-name keyword coverage, duplicate productions, all-catalog pagination and cache validity. The previous 12-case saved-score Jev replay remains a keyword-path regression test; it does not validate Voyage quality. Evaluate real Turkish mood requests, negation and follow-ups on held-out catalog labels, compare shortlist recall at 16/32, and measure Worker latency before public release. No embedding model or dimension setting is declared quality-optimal from mock tests.

## Mandatory evidence and language limits

Exact budget, date, district and clock constraints are deterministic and apply before ranking. English and Turkish parsing supports common phrasing, including inflected party sizes and explicit category alternatives. A group budget without a total/per-person basis requests clarification. This is a supported parser, not unrestricted natural-language understanding.

Recognized genres, activities and explicit verification requirements are checked against source facts before either AI or fallback ranking. Missing jazz evidence cannot pass a jazz request just because the event is a concert. A generic family-friendly description does not prove absence of swearing and sexual humour. Ordinary child-show exclusions reject positive child-audience evidence; they do not require an adult-only certificate. Unknown mandatory facts produce an evidence-specific empty notice. The bilingual evidence taxonomy is intentionally bounded, and unsupported concepts still depend on Jev's relevance judgment; this does not establish universal constraint coverage.

The original hard-prompt evaluation remains an immutable baseline in `hard-prompt-evaluation.md`. Follow-up evaluation reports must be kept separate. Old saved Jev scores cannot validate changes to the scoring rubric.
