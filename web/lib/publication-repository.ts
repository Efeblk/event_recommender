import type { PreparedPublicationRepository, PreparedPublicationRead, PublicationSessionStatus } from './prepared-publication-search.ts';
import { sqlLiteral as literal } from './sql-literal.ts';
export type PublicationSqlQuery = (statement: string) => Promise<string>;
const PAGE_SIZE = 1000, MAX_SESSIONS = 20000;

// Pin the active publication first, then page only through that immutable ID.
// A pointer switch cannot mix generations and no transaction spans later work.
export function createSqlPublicationRepository(query: PublicationSqlQuery, { includeVectors = false, compact = false } = {}): PreparedPublicationRepository {
  return {
    async readPublication(publicationId?: string, options: { includeVectors?: boolean } = {}): Promise<PreparedPublicationRead> {
      const vectors = options.includeVectors ?? includeVectors;
      const selector = publicationId === undefined ? 'SELECT publication_id AS id FROM biplan.active_publication WHERE singleton' : `SELECT ${literal(publicationId)}::text AS id`;
      const metadataRaw = await query(`WITH pin AS MATERIALIZED (${selector}) SELECT jsonb_build_object(
        'publicationId',p.id,'offerProjectionVersion',CASE WHEN p.manifest->>'offerProjectionVersion'='1' THEN 1 ELSE NULL END,
        'embeddingProfile',p.required_embedding_profile,
        'sessionCount',(SELECT count(*) FROM biplan.published_sessions s WHERE s.publication_id=p.id),
        'requiredSessionCount',p.required_session_count,
        'requiredOfferCount',CASE WHEN p.manifest->>'requiredOfferCount'~'^\\d+$' THEN (p.manifest->>'requiredOfferCount')::integer ELSE NULL END)::text
        FROM biplan.publications p JOIN pin ON pin.id=p.id
        WHERE p.state IN ('validated','active','superseded')
          AND (NOT (p.manifest ? 'offerProjectionVersion') OR p.manifest->>'offerProjectionVersion'='1');`);
      if (!metadataRaw) throw new Error('No readable prepared publication');
      const metadata = JSON.parse(metadataRaw) as Omit<PreparedPublicationRead, 'sessions'> & { sessionCount: number; requiredSessionCount: number; requiredOfferCount: number | null };
      if (metadata.offerProjectionVersion !== null && metadata.offerProjectionVersion !== undefined && metadata.offerProjectionVersion !== 1)
        throw new Error('Unsupported publication offer projection version');
      if (!Number.isInteger(metadata.sessionCount) || metadata.sessionCount < 0 || metadata.sessionCount > MAX_SESSIONS)
        throw new Error('Prepared publication session count exceeds supported bound');
      if (!Number.isInteger(metadata.requiredSessionCount) || metadata.requiredSessionCount !== metadata.sessionCount)
        throw new Error('Prepared publication session manifest is incomplete');
      if (metadata.offerProjectionVersion === 1 && (!Number.isInteger(metadata.requiredOfferCount) || metadata.requiredOfferCount! < 0))
        throw new Error('Prepared publication offer manifest is incomplete');
      const sessions: PreparedPublicationRead['sessions'] = [];
      let after = '';
      while (sessions.length <= MAX_SESSIONS) {
        const raw = await query(`WITH publication AS MATERIALIZED (
          SELECT p.* FROM biplan.publications p WHERE p.id=${literal(metadata.publicationId)}
            AND p.state IN ('validated','active','superseded')
            AND (NOT (p.manifest ? 'offerProjectionVersion') OR p.manifest->>'offerProjectionVersion'='1')
        ), page AS MATERIALIZED (
          SELECT s.* FROM biplan.published_sessions s JOIN publication p ON p.id=s.publication_id
          WHERE s.session_id COLLATE "C">${literal(after)} COLLATE "C" ORDER BY s.session_id COLLATE "C" LIMIT ${PAGE_SIZE}
        ), legacy_terms AS MATERIALIZED (
          SELECT o.session_id,jsonb_agg(jsonb_build_object(
            'offerId',r.offer_id,'revisionId',r.id,'provider',r.provider,'providerRecordId',r.provider_record_id,
            'sourceUrl',r.source_url,'ticketTierId',r.ticket_tier_id,'ticketTierName',r.ticket_tier_name,'currency',r.currency,
            'price',r.price::text,'priceMinor',r.price_minor::text,'feeMinor',r.fee_minor::text,'priceKind',r.price_kind,
            'availability',r.availability,'observedAt',r.observed_at,'sourceUpdatedAt',r.source_updated_at,
            'validFrom',r.valid_from,'validUntil',r.valid_until) ORDER BY r.offer_id) AS records
          FROM page s JOIN publication p ON true
          JOIN biplan.publication_offers o ON o.publication_id=p.id AND o.session_id=s.session_id
          JOIN biplan.offer_revisions r ON r.id=o.offer_revision_id
          WHERE p.manifest->>'offerProjectionVersion' IS DISTINCT FROM '1' GROUP BY o.session_id
        ) SELECT jsonb_build_object('publicationPresent',EXISTS(SELECT 1 FROM publication),'sessions',COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'sessionId',s.session_id,'productionId',s.production_id,'venueId',s.venue_id,
          'snapshot',${compact ? "(s.eligibility_snapshot-'offers') #- '{preparedSearch,documentText}'" : 's.eligibility_snapshot'},
          'document',CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('id',d.id,'text',d.document_text,
            'hash',d.document_hash,'embeddingProfile',d.embedding_profile,'vector',${vectors ? "CASE WHEN d.embedding IS NULL THEN NULL ELSE d.embedding::text::jsonb END" : 'NULL'}) END,
          'pinnedOfferTerms',CASE WHEN p.manifest->>'offerProjectionVersion'='1'
            THEN COALESCE(s.eligibility_snapshot->'offerTerms','[]'::jsonb) ELSE COALESCE(t.records,'[]'::jsonb) END
        ) ORDER BY s.session_id COLLATE "C") FROM page s JOIN publication p ON true
        LEFT JOIN biplan.search_documents d ON d.id=s.search_document_id LEFT JOIN legacy_terms t ON t.session_id=s.session_id),'[]'::jsonb))::text;`);
        const result = JSON.parse(raw) as { publicationPresent: boolean; sessions: PreparedPublicationRead['sessions'] };
        if (result.publicationPresent !== true) throw new Error('Prepared publication disappeared during read');
        const page = result.sessions;
        if (!Array.isArray(page) || page.length > PAGE_SIZE) throw new Error('Invalid prepared publication page');
        if (!page.length) break;
        for (const session of page) {
          if (typeof session.sessionId !== 'string' || session.sessionId <= after) throw new Error('Prepared publication page is not strictly ordered');
          sessions.push(session); after = session.sessionId;
        }
        if (page.length < PAGE_SIZE) break;
      }
      const terms = sessions.reduce((count, session) => count + session.pinnedOfferTerms.length, 0);
      if (sessions.length !== metadata.sessionCount ||
          (metadata.offerProjectionVersion === 1 && terms !== metadata.requiredOfferCount))
        throw new Error('Prepared publication page set is incomplete');
      const { sessionCount: _sessionCount, requiredSessionCount: _requiredSessionCount, requiredOfferCount: _requiredOfferCount, ...publication } = metadata;
      return { ...publication, sessions };
    },
    async revalidatePublication(publicationId: string, sessionIds: string[], checkedAt: string, maxAgeMs: number): Promise<PublicationSessionStatus[]> {
      if (!Array.isArray(sessionIds) || sessionIds.length > 16 || new Set(sessionIds).size !== sessionIds.length) throw new Error('Revalidation requires at most 16 distinct sessions');
      if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 30 * 86400000) throw new Error('Invalid revalidation freshness window');
      if (!Number.isFinite(Date.parse(checkedAt))) throw new Error('Invalid revalidation time');
      if (!sessionIds.length) return [];
      const ids = `ARRAY[${sessionIds.map(literal).join(',')}]::text[]`;
      return JSON.parse(await query(`SELECT COALESCE(jsonb_agg(biplan.current_publication_offer_status(
        ${literal(publicationId)},id,${literal(checkedAt)}::timestamptz,make_interval(secs=>${maxAgeMs / 1000}))), '[]'::jsonb)::text FROM unnest(${ids}) id;`));
    },
  };
}
