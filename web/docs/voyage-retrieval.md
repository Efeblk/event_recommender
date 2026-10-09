# Voyage retrieval with Jev ranking

The recommendation pipeline uses `voyage-4-large` at 1,024 dimensions by
default. Voyage embeds event text as `document` and the current message as
`query`. Each request is independent. Jev receives the current message and
candidate facts, never vectors.

1. The field reader builds a plan from the current message. Code retrieves the
   full eligible catalog before it makes a shortlist. There is no total
   1,000-session cutoff.
2. Search reads the prepared cross-provider sessions from the published
   snapshot. It applies exact local time, place, budget, category, exclusion
   and mandatory source-evidence checks.
3. Code ranks every remaining eligible session with keyword BM25 and available
   Voyage vectors. It combines the ranks with reciprocal rank fusion using
   constant 60. Missing vectors retain keyword discovery.
4. Code sends at most 16 distinct candidates to Jev. `selectJevEvents` accepts
   only canonical shortlist candidates with valid four-level probabilities.
   The sum of level 2 and level 3 probabilities must be at least
   `MIN_JEV_SUPPORT_PROBABILITY`, which is `0.7`.
5. A plan with an explicit mood preference also requires the separate program
   fit probability to be at least `0.7`. Other requests do not require that
   extra judgment. The numeric Jev score orders admitted candidates. It does
   not decide admission by itself.
6. The application returns every distinct shortlisted event that passes these
   checks. The result count is from zero through 16. There is no five-result
   cap.

## Configuration and indexing

Put `VOYAGE_API_KEY` in ignored `web/.dev.vars`, alongside the existing `TYPESAFE_API_KEY`. Restart the local server after changing settings. Optional server-side settings are `VOYAGE_MODEL` (`voyage-4-large`, `voyage-4`, `voyage-4-lite`) and `VOYAGE_DIMENSIONS` (`256`, `512`, `1024`, `2048`). Legacy `EMBEDDING_*` keys do not enable this path. No local model server or GPU is required.

Use the Node version in `web/.nvmrc`. From the repository root:

```sh
# Coverage inspection only; zero provider requests.
npm run embeddings:index --prefix web -- --origin http://127.0.0.1:3001 --allow-loopback-http

# Collect and import without indexing.
npm run local:refresh --prefix web -- --collect

# Explicit local indexing after budget approval. Set limits from the approved
# budget and the inspected pending count.
npm run embeddings:index --prefix web -- --origin http://127.0.0.1:3001 --allow-loopback-http --live --max-batches <count> --max-total-tokens <tokens>
```

Local refresh imports every validated batch, advances the collection checkpoint,
reads the canonical catalog back from the local Node service, and atomically replaces
`web/data/events.json` with that readback. The publication step replaces this
snapshot only after verified readback; any failed import, checkpoint save, or
readback makes the command fail. With `--collect`, collection first writes its
own validated snapshot before publication starts.

The script reads the local sync token only for a loopback destination.
Remote use targets the private Cloud Run service. It requires `BIPLAN_URL`,
`SYNC_TOKEN`, `SERVERLESS_ID_TOKEN` and all bounded live-run arguments required
by `scripts/index-embeddings.mjs`. The Voyage key stays on the server. Use the
[GCP collector runbook](../../docs/gcp-collector.md) for staging indexing.
GET `/api/admin/embeddings` reports eligible sessions and vector coverage.
POST indexes at most 32 pending documents under a lease. Both require the sync token.
The driver stops on failure without automatic retries. It has a bounded batch count.
`--interval-ms` accepts 0–60000 milliseconds between successful batches.
Use pacing that fits the [Voyage API rate limits](https://www.mongodb.com/docs/voyageai/api-reference/overview/).
Scheduled GCP indexing requires `GCP_STAGING_INDEXING_ENABLED=true` and a separate
approved window and call budget.
Indexing runs after the catalog checkpoint is published.

Document vectors live in a private Cloud Storage snapshot, keyed by the provider/model/dimension/text-profile identity and a SHA-256 content hash. Identical event text shares vectors across sessions. Title, category, venue and description are embedded; price, date, availability and checked-at timestamps stay structured. Freshness-only updates do not trigger re-embedding. Changed text or model settings create cache misses; incompatible vectors are never silently reused. Obsolete cached content is not retrieved but currently remains stored; cache pruning is future maintenance.

## Failures and limits

No Voyage key means keyword retrieval. An empty index avoids a wasted query call
and reports keyword fallback. Partial indexes allow keyword discovery of new
events. Voyage failure falls back to keywords while keeping Jev available. Jev
failure returns identified deterministic results when the parsed plan does not
need program-fit judgment. When the field reader produced a plan with an
explicit mood preference, a ranking failure returns no unverified cards. This
guard does not apply to the keyless path. Without `TYPESAFE_API_KEY`, the route
uses the rules interpreter and explicit deterministic fallback, including when
the request text contains a mood. Neither failure relaxes hard constraints.
With the field reader and Jev configured, a normal search can make one parser
Jev call and one ranking Jev call. It makes at most one Voyage query call.
These calls have no automatic retries. Index creation is separate from search.

`AI_DAILY_LIMIT` limits AI-enabled recommendation requests when either provider is configured, including attempts that ultimately need no provider call. It is not an exact billable-call or dollar limit. Authenticated document indexing is separate from that counter and bounded by the indexing driver's batch limit.

Tests cover mocked embedding transport, semantic candidates beyond the old
shortlist, missing-index and outage behavior, exact-name keyword coverage,
duplicate productions, full-catalog retrieval and cache validity. The 12-case
saved-score Jev replay remains a keyword-path regression test. It does not
validate Voyage quality. The Phase 1 golden set supplies the current fixed
quality check. No embedding model or dimension setting is declared
quality-optimal from mock tests.

## Mandatory evidence and language limits

Exact budget, date, district and clock constraints are deterministic and apply before ranking. English and Turkish parsing supports common phrasing, including inflected party sizes and explicit category alternatives. A group budget without a total/per-person basis requests clarification. This is a supported parser, not unrestricted natural-language understanding.

Recognized genres, activities and explicit verification requirements are checked against source facts before either AI or fallback ranking. Missing jazz evidence cannot pass a jazz request just because the event is a concert. A generic family-friendly description does not prove absence of swearing and sexual humour. Ordinary child-show exclusions reject positive child-audience evidence; they do not require an adult-only certificate. Unknown mandatory facts produce an evidence-specific empty notice. The bilingual evidence taxonomy is intentionally bounded, and unsupported concepts still depend on Jev's relevance judgment; this does not establish universal constraint coverage.

The original hard-prompt evaluation remains an immutable baseline in `hard-prompt-evaluation.md`. Follow-up evaluation reports must be kept separate. Old saved Jev scores cannot validate changes to the scoring rubric.
