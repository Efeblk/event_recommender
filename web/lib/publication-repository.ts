import type { PreparedPublicationRepository, PreparedPublicationRead, PublicationSessionStatus } from './prepared-publication-search.ts';
import { sqlLiteral as literal } from './sql-literal.ts';
export type PublicationSqlQuery = (statement: string) => Promise<string>;


// One statement pins the pointer and reads immutable
// rows; no transaction is held over ranking or a later provider call.
export function createSqlPublicationRepository(query: PublicationSqlQuery, { includeVectors = false, compact = false } = {}): PreparedPublicationRepository {
  return {
    async readPublication(publicationId?: string, options: { includeVectors?: boolean } = {}): Promise<PreparedPublicationRead> {
      const vectors = options.includeVectors ?? includeVectors;
      const selector = publicationId === undefined
        ? 'SELECT publication_id AS id FROM biplan.active_publication WHERE singleton'
        : `SELECT ${literal(publicationId)}::text AS id`;
      const raw = await query(`WITH pin AS MATERIALIZED (${selector}), publication AS MATERIALIZED (
        SELECT p.* FROM biplan.publications p JOIN pin ON pin.id=p.id
        WHERE p.state IN ('validated','active','superseded')
          AND (NOT (p.manifest ? 'offerProjectionVersion') OR p.manifest->>'offerProjectionVersion'='1')
      ), terms AS MATERIALIZED (
        SELECT o.session_id,jsonb_agg(CASE WHEN p.manifest->>'offerProjectionVersion'='1' THEN projected.record ELSE jsonb_build_object(
          'offerId',r.offer_id,'revisionId',r.id,'provider',r.provider,
          'providerRecordId',r.provider_record_id,'sourceUrl',r.source_url,'ticketTierId',r.ticket_tier_id,
          'ticketTierName',r.ticket_tier_name,'currency',r.currency,
          'price',r.price::text,'priceMinor',r.price_minor::text,'feeMinor',r.fee_minor::text,
          'priceKind',r.price_kind,'availability',r.availability,'observedAt',r.observed_at,
          'sourceUpdatedAt',r.source_updated_at,'validFrom',r.valid_from,'validUntil',r.valid_until
        ) END ORDER BY r.offer_id) FILTER (WHERE p.manifest->>'offerProjectionVersion' IS DISTINCT FROM '1' OR projected.record IS NOT NULL) AS records
        FROM biplan.publication_offers o JOIN publication p ON p.id=o.publication_id
        JOIN biplan.offer_revisions r ON r.id=o.offer_revision_id
        LEFT JOIN LATERAL (SELECT biplan.publication_offer_term(p.id,r.offer_id) AS record
          WHERE p.manifest->>'offerProjectionVersion'='1') projected ON true
        GROUP BY o.session_id
      ) SELECT jsonb_build_object('publicationId',p.id,'offerProjectionVersion',
        CASE WHEN p.manifest->>'offerProjectionVersion'='1' THEN 1 ELSE NULL END,'embeddingProfile',p.required_embedding_profile,
        'sessions',COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'sessionId',s.session_id,'productionId',s.production_id,'venueId',s.venue_id,
          'snapshot',${compact ? "(s.eligibility_snapshot-'offers') #- '{preparedSearch,documentText}'" : 's.eligibility_snapshot'},
          'document',CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id',d.id,'text',d.document_text,'hash',d.document_hash,
            'embeddingProfile',d.embedding_profile,'vector',${vectors ? "CASE WHEN d.embedding IS NULL THEN NULL ELSE d.embedding::text::jsonb END" : 'NULL'}) END,
          'pinnedOfferTerms',COALESCE(t.records,'[]'::jsonb)
          ) ORDER BY s.session_id)
          FROM biplan.published_sessions s LEFT JOIN biplan.search_documents d ON d.id=s.search_document_id
          LEFT JOIN terms t ON t.session_id=s.session_id
          WHERE s.publication_id=p.id),'[]'::jsonb))::text FROM publication p;`);
      if (!raw) throw new Error('No readable prepared publication');
      const parsed = JSON.parse(raw) as PreparedPublicationRead;
      if (parsed.offerProjectionVersion !== null && parsed.offerProjectionVersion !== undefined && parsed.offerProjectionVersion !== 1)
        throw new Error('Unsupported publication offer projection version');
      return parsed;
    },
    async revalidatePublication(publicationId: string, sessionIds: string[], checkedAt: string, maxAgeMs: number): Promise<PublicationSessionStatus[]> {
      if (!Array.isArray(sessionIds) || sessionIds.length > 16 || new Set(sessionIds).size !== sessionIds.length)
        throw new Error('Revalidation requires at most 16 distinct sessions');
      if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 30 * 86400000)
        throw new Error('Invalid revalidation freshness window');
      if (!Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid revalidation time');
      if (!sessionIds.length) return [];
      const ids = `ARRAY[${sessionIds.map(literal).join(',')}]::text[]`;
      return JSON.parse(await query(`SELECT COALESCE(jsonb_agg(biplan.current_publication_offer_status(
        ${literal(publicationId)},id,${literal(checkedAt)}::timestamptz,
        make_interval(secs=>${maxAgeMs / 1000}))), '[]'::jsonb)::text FROM unnest(${ids}) id;`));
    },
  };
}
