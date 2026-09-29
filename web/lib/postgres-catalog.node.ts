import { createPostgresClient } from './postgres-client.node.ts';
import { createSqlPublicationRepository } from './publication-repository.ts';
import { preparePublicationCandidates, type PreparedPublicationRead } from './prepared-publication-search.ts';
import { voyageCacheKey, type VoyageConfig } from './voyage.ts';
import type { EventRecord, Filters } from './types.ts';
import type { CatalogStatus } from './storage-contract.ts';
import type { PinnedRecommendationCatalog } from './recommend.ts';
import { readPostgresPreparedCatalogReadiness } from './postgres-readiness.node.ts';
import { sqlLiteral as literal } from './sql-literal.ts';

export function createPostgresCatalog(env: Record<string, string | undefined>) {
  const client = createPostgresClient(env);
  const repository = createSqlPublicationRepository(client.queryText, { compact: true });
  // Immutable generation cache; in-flight requests retain their captured object
  // when the active generation changes. Never cache current-head validation.
  let cachedId: string | undefined;
  let cached: Promise<PreparedPublicationRead> | undefined;
  const activeId = async () => {
    const id = await client.queryText(`SELECT a.publication_id FROM biplan.active_publication a
      JOIN biplan.publications p ON p.id=a.publication_id
      WHERE a.singleton AND p.state IN ('active','validated','superseded');`);
    if (!id) throw new Error('No active PostgreSQL publication');
    return id;
  };
  const read = (id: string) => {
    if (cachedId !== id || !cached) {
      cachedId = id;
      const pending = repository.readPublication(id);
      cached = pending.catch(error => { if (cachedId === id) cached = undefined; throw error; });
    }
    return cached;
  };
  const vectorsFor = async (publicationId: string, events: EventRecord[], config: VoyageConfig) => {
    if (config.dimensions !== 1024 || !events.length) return new Map<string, number[]>();
    if (events.length > 20000) throw new Error('Eligible vector set exceeds supported catalog bound');
    const ids = `ARRAY[${events.map(e => literal(e.id)).join(',')}]::text[]`;
    const profile = voyageCacheKey(config);
    const rows: Array<{ id: string; vector: number[] }> = JSON.parse(await client.queryText(`SELECT COALESCE(jsonb_agg(
      jsonb_build_object('id',s.session_id,'vector',d.embedding::text::jsonb)),'[]'::jsonb)::text
      FROM biplan.published_sessions s JOIN biplan.search_documents d ON d.id=s.search_document_id
      WHERE s.publication_id=${literal(publicationId)} AND s.session_id=ANY(${ids})
        AND d.embedding_profile=${literal(profile)} AND d.embedding IS NOT NULL;`));
    return new Map(rows.filter(r => r.vector.length === 1024 && r.vector.every(Number.isFinite) && r.vector.some(v=>v!==0)).map(r=>[r.id,r.vector]));
  };
  const denseEligible = (publicationId: string, events: EventRecord[], config: VoyageConfig) => {
    if (events.length > 20000 || new Set(events.map(e=>e.id)).size !== events.length)
      throw new Error('Invalid eligible vector set');
    const ids = `ARRAY[${events.map(e=>literal(e.id)).join(',')}]::text[]`;
    return `SELECT s.session_id,d.embedding FROM biplan.published_sessions s
      JOIN biplan.search_documents d ON d.id=s.search_document_id
      WHERE s.publication_id=${literal(publicationId)} AND s.session_id=ANY(${ids})
        AND d.embedding_profile=${literal(voyageCacheKey(config))} AND d.embedding IS NOT NULL`;
  };
  return {
    close: client.close,
    health: async () => { await activeId(); },
    readiness: () => readPostgresPreparedCatalogReadiness(client.queryText),
    async pin(now: Date): Promise<PinnedRecommendationCatalog> {
      const publicationId = await activeId();
      // Pin metadata before interpreting any catalog-dependent input. Loading
      // immutable records can wait until a search is actually needed.
      let selectedOffers = new Map<string, string>();
      let budgetExcludedUnknownPrice = 0;
      return {
        publicationId,
        candidates: async (filters: Filters) => {
          const projected = preparePublicationCandidates(await read(publicationId), filters, now);
          selectedOffers = projected.selectedOffers;
          budgetExcludedUnknownPrice = projected.budgetExcludedUnknownPrice;
          return projected.events;
        },
        vectors: (events, config) => vectorsFor(publicationId, events, config),
        dense: {
          coverage: async (events,config) => config.dimensions !== 1024 || !events.length ? 0
            : Number(await client.queryText(`SELECT count(*) FROM (${denseEligible(publicationId,events,config)}) eligible;`)),
          rank: async (events,config,queryVector) => {
            if (config.dimensions !== 1024 || queryVector.length !== 1024 || !queryVector.every(Number.isFinite) || !queryVector.some(v=>v!==0))
              throw new Error('Invalid exact dense query vector');
            if (!events.length) return [];
            // A materialized eligible set guarantees exact ranking after hard
            // filters, regardless of any ANN index added to the document table.
            return JSON.parse(await client.queryText(`WITH eligible AS MATERIALIZED (${denseEligible(publicationId,events,config)}),
              ranked AS (SELECT session_id,embedding <=> ${literal(`[${queryVector.join(',')}]`)}::vector(1024) distance FROM eligible)
              SELECT COALESCE(jsonb_agg(session_id ORDER BY distance,session_id),'[]'::jsonb)::text FROM ranked;`));
          },
        },
        emptyResultNotice: () => budgetExcludedUnknownPrice > 0
          ? 'Diğer koşullarına uyan etkinlikler var; ancak toplam bilet ücretleri doğrulanmadığı için bütçene uyduklarını garanti edemiyoruz. Bütçe sınırını kaldırarak fiyat bilgilerini inceleyebilirsin.' : undefined,
        async finalize(events: EventRecord[]) {
          if (!events.length) return [];
          const statuses = await repository.revalidatePublication(publicationId,events.map(e=>e.id),new Date().toISOString(),72*3600000);
          const bySession = new Map(statuses.map(s=>[s.sessionId,s]));
          return events.filter(e => {
            const status=bySession.get(e.id), chosen=selectedOffers.get(e.id);
            return status?.publicationId===publicationId && status.availabilityUsable && status.canonicalSessionUsable &&
              status.offers.some(o=>o.offerId===chosen && o.status==='usable' && o.currentRevisionId===o.pinnedRevisionId);
          });
        },
      };
    },
    async catalogStatus(now = new Date()): Promise<CatalogStatus> {
      const id=await activeId();
      const stats: { stored:number; eligible:number; last:string|null; oldest:string|null } = JSON.parse(await client.queryText(`
        WITH offers AS MATERIALIZED (SELECT p.session_id,max(r.observed_at) last,min(r.observed_at) oldest,
          bool_or(r.availability IN ('available','limited') AND r.observed_at<=${literal(now.toISOString())}::timestamptz
          AND r.observed_at>=${literal(now.toISOString())}::timestamptz-interval '72 hours'
          AND (r.valid_from IS NULL OR r.valid_from<=${literal(now.toISOString())}::timestamptz)
          AND (r.valid_until IS NULL OR r.valid_until>=${literal(now.toISOString())}::timestamptz)) usable
          FROM biplan.publication_offers p JOIN biplan.offer_revisions r ON r.id=p.offer_revision_id
          JOIN biplan.offer_identities i ON i.id=r.offer_id AND i.current_revision_id=r.id
          WHERE p.publication_id=${literal(id)} GROUP BY p.session_id)
        SELECT jsonb_build_object('stored',count(*),'eligible',count(*) FILTER (WHERE c.status='scheduled'
          AND c.starts_at>=${literal(now.toISOString())}::timestamptz AND COALESCE(o.usable,false)),
          'last',max(o.last),'oldest',min(o.oldest))::text
          FROM biplan.published_sessions s JOIN biplan.sessions c ON c.id=s.session_id
          LEFT JOIN offers o ON o.session_id=s.session_id WHERE s.publication_id=${literal(id)};`));
      return {status:stats.eligible?'ready':stats.stored?'stale':'empty',stored:stats.stored,eligible:stats.eligible,
        lastCheckedAt:stats.last,oldestCheckedAt:stats.oldest,expiresAt:stats.last?new Date(Date.parse(stats.last)+72*3600000).toISOString():null};
    },
  };
}
