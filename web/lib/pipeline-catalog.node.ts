import { createCatalogReader } from './catalog-reader.ts';
import { createPostgresClient } from './postgres-client.node.ts';
import type {
  PublishedCatalogV1,
  PublishedSessionV1,
  SelectedPublishedOfferV1,
} from '../../contracts/publication.ts';
import type { EventRecord, Filters, PreparedLocation } from './types.ts';
import type { PinnedRecommendationCatalog } from './recommend.ts';
import type { CatalogStatus } from './storage-contract.ts';
import { emptyFilters } from './types.ts';
import { isEligible, validateFilters } from './search.ts';
import { voyageCacheKey } from './voyage.ts';

/** Fresh current-head state for one immutable publication. A session is usable
 * only while every canonical member still points at its published revision. */
export const PIPELINE_CURRENT_STATUS_SQL = `WITH canonical_sessions AS (
  SELECT ps.session_id
  FROM biplan_pipeline.publication_sessions ps
  WHERE ps.publication_id=$1
    AND EXISTS (
      SELECT 1 FROM biplan_pipeline.session_listings required
      WHERE required.session_revision_id=ps.session_revision_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM biplan_pipeline.session_listings sl
      JOIN biplan_pipeline.listings member ON member.revision_id=sl.listing_revision_id
      LEFT JOIN biplan_pipeline.listing_heads head ON head.listing_id=member.listing_id
      WHERE sl.session_revision_id=ps.session_revision_id
        AND (head.revision_id IS DISTINCT FROM member.revision_id OR COALESCE(head.withheld,true))
    )
), current_offers AS (
  SELECT po.session_id,o.revision_id,o.availability,o.observed_at,l.starts_at
  FROM biplan_pipeline.publication_offers po
  JOIN canonical_sessions cs ON cs.session_id=po.session_id
  JOIN biplan_pipeline.offers o ON o.revision_id=po.offer_revision_id
  JOIN biplan_pipeline.listings l ON l.revision_id=o.listing_revision_id
  WHERE po.publication_id=$1
), usable_sessions AS (
  SELECT DISTINCT candidate.session_id
  FROM current_offers candidate
  WHERE candidate.availability='available'
    AND candidate.starts_at >= $2::timestamptz
    AND candidate.observed_at <= $2::timestamptz
    AND candidate.observed_at >= $2::timestamptz-interval '72 hours'
    AND EXISTS (
      SELECT 1 FROM biplan_pipeline.offer_tiers tier
      WHERE tier.offer_revision_id=candidate.revision_id AND tier.availability='available'
    )
)
SELECT (SELECT count(*)::int FROM usable_sessions) eligible,
  (SELECT COALESCE(array_agg(session_id ORDER BY session_id),'{}'::text[]) FROM usable_sessions) usable_session_ids,
  min(observed_at) oldest, max(observed_at) latest
FROM current_offers`;

function checkedIso(value: unknown): string | null {
  const timestamp =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

/** Project only prepared identity and pinned offers. Aggregate starting prices
 * with unknown checkout fees never become verified hard-budget prices. */
export function projectPipelineSession(
  session: PublishedSessionV1,
  now: Date,
): { event: EventRecord; selection: SelectedPublishedOfferV1 } | null {
  const offers = session.offers.filter(
    (offer) =>
      offer.availability === 'available' &&
      Date.parse(offer.observedAt) <= now.getTime() &&
      Date.parse(offer.observedAt) >= now.getTime() - 72 * 3600000,
  );
  const choices = offers
    .flatMap((offer) =>
      offer.tiers
        .filter((tier) => tier.availability === 'available')
        .map((tier) => ({ offer, tier })),
    )
    .sort(
      (a, b) =>
        Number(a.tier.currency !== 'TRY') - Number(b.tier.currency !== 'TRY') ||
        Number(a.tier.price === null) - Number(b.tier.price === null) ||
        (a.tier.price ?? Infinity) - (b.tier.price ?? Infinity) ||
        a.offer.id.localeCompare(b.offer.id),
    );
  const chosen = choices[0];
  if (!chosen) return null;
  const { offer, tier } = chosen;
  const document = session.document;
  const location = document.location as PreparedLocation | null;
  const event: EventRecord = {
    id: session.id,
    title: session.title,
    description: session.description,
    category: session.category,
    startsAt: session.startsAt,
    city: session.city,
    venue: session.venue.name,
    district: session.venue.district ?? '',
    address: session.venue.address ?? '',
    imageUrl: session.imageUrl ?? '',
    source: offer.provider,
    url: offer.url,
    price: null,
    currency: '',
    availability: 'available',
    checkedAt: offer.observedAt,
    productionKey: session.productionId,
    canonicalProductionKey: session.productionId,
    canonicalShowKey: session.productionId,
    ...(tier.price !== null && tier.currency === 'TRY'
      ? {
          advertisedPrice: {
            amount: tier.price,
            currency: 'TRY',
            kind: 'starting_at',
            feesKnown: false,
          },
        }
      : {}),
    ...(session.attendanceTiming
      ? {
          attendanceTiming:
            session.attendanceTiming as EventRecord['attendanceTiming'],
        }
      : {}),
    offers: session.offers.map((item) => ({
      id: item.id,
      source: item.provider,
      url: item.url,
      price: null,
      currency: '',
      checkedAt: item.observedAt,
      category: session.category,
      venue: session.venue.name,
      availability: item.availability as EventRecord['availability'],
    })),
    preparedSearch: {
      version: 1,
      documentText: document.text,
      documentHash: document.hash,
      lexicalTokens: document.lexicalTokens,
      ...(location?.profile === 'istanbul-location-v1' ? { location } : {}),
    },
  };
  return {
    event,
    selection: {
      sessionId: session.id,
      offerId: offer.id,
      offerRevisionId: offer.revisionId,
    },
  };
}

export function createPipelineCatalog(env: Record<string, string | undefined>) {
  const client = createPostgresClient(env);
  const reader = createCatalogReader((sql, values) =>
    client.pool.query(sql, values),
  );
  let cachedId: string | undefined,
    cached: Promise<PublishedCatalogV1> | undefined;
  function read(id: string) {
    if (cachedId !== id || !cached) {
      cachedId = id;
      cached = reader.read(id).catch((error) => {
        if (cachedId === id) cached = undefined;
        throw error;
      });
    }
    return cached;
  }
  const project = async (id: string, now: Date) =>
    (await read(id)).sessions.flatMap((session) => {
      const projected = projectPipelineSession(session, now);
      return projected && isEligible(projected.event, emptyFilters, now)
        ? [projected]
        : [];
    });
  async function currentState(id: string, now: Date) {
    const result = await client.pool.query(PIPELINE_CURRENT_STATUS_SQL, [
      id,
      now.toISOString(),
    ]);
    const eligible = Number(result.rows[0]?.eligible);
    if (!Number.isSafeInteger(eligible) || eligible < 0)
      throw new Error('Invalid pipeline current status');
    const sessionIds = result.rows[0]?.usable_session_ids;
    if (
      !Array.isArray(sessionIds) ||
      sessionIds.length !== eligible ||
      sessionIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(sessionIds).size !== sessionIds.length
    )
      throw new Error('Invalid pipeline usable session set');
    return {
      eligible,
      sessionIds: sessionIds as string[],
      oldestCheckedAt: checkedIso(result.rows[0]?.oldest),
      lastCheckedAt: checkedIso(result.rows[0]?.latest),
    };
  }
  async function catalogStatus(id: string, now: Date): Promise<CatalogStatus> {
    const catalog = await read(id);
    const current = await currentState(id, now);
    if (current.eligible > catalog.sessions.length)
      throw new Error('Pipeline current status exceeds verified publication');
    return {
      status: current.eligible
        ? 'ready'
        : catalog.sessions.length
          ? 'stale'
          : 'empty',
      stored: catalog.sessions.length,
      eligible: current.eligible,
      oldestCheckedAt: current.oldestCheckedAt,
      lastCheckedAt: current.lastCheckedAt,
      expiresAt: current.lastCheckedAt
        ? new Date(
            Date.parse(current.lastCheckedAt) + 72 * 3600000,
          ).toISOString()
        : null,
    };
  }
  return {
    close: client.close,
    health: async () => {
      await reader.pin();
    },
    readiness: async () => {
      const publicationId = await reader.pin();
      const catalog = await catalogStatus(publicationId, new Date());
      return {
        backend: 'pipeline' as const,
        ready: catalog.status === 'ready',
        publicationId,
        reasons:
          catalog.status === 'ready' ? [] : [`catalog_${catalog.status}`],
        catalog,
      };
    },
    catalogStatus: async (now = new Date()) =>
      catalogStatus(await reader.pin(), now),
    async pin(now: Date): Promise<PinnedRecommendationCatalog> {
      const publicationId = await reader.pin();
      let selections = new Map<string, SelectedPublishedOfferV1>();
      let excludedUnknownPrice = 0;
      let currentlyUsableSessionIds: Set<string> | undefined;
      return {
        publicationId,
        availability: async () => {
          // This is deliberately fresh for every request; only immutable
          // publication content is cached.
          const current = await currentState(publicationId, now);
          currentlyUsableSessionIds = new Set(current.sessionIds);
          return current.eligible > 0;
        },
        catalogStatus: () => catalogStatus(publicationId, now),
        candidates: async (input: Filters) => {
          if (!currentlyUsableSessionIds)
            throw new Error('Pipeline availability gate was not checked');
          const filters = validateFilters(input);
          const projected = (await project(publicationId, now)).filter(
            ({ event }) => currentlyUsableSessionIds!.has(event.id),
          );
          selections = new Map(
            projected.map((item) => [item.event.id, item.selection]),
          );
          excludedUnknownPrice =
            filters.maxPrice === null
              ? 0
              : projected.filter((item) =>
                  isEligible(item.event, { ...filters, maxPrice: null }, now),
                ).length;
          return projected
            .map((item) => item.event)
            .filter((event) => isEligible(event, filters, now));
        },
        vectors: async (events, config) => {
          const byId = new Map(
            (await read(publicationId)).sessions.map((session) => [
              session.id,
              session.document,
            ]),
          );
          const profile = voyageCacheKey(config);
          return new Map(
            events.flatMap((event) => {
              const doc = byId.get(event.id);
              return doc?.embeddingProfile === profile &&
                doc.vector?.length === config.dimensions &&
                doc.vector.every(Number.isFinite)
                ? [[event.id, doc.vector] as const]
                : [];
            }),
          );
        },
        emptyResultNotice: () =>
          excludedUnknownPrice > 0
            ? 'Diğer koşullarına uyan etkinlikler var; ancak toplam bilet ücretleri doğrulanmadığı için bütçene uyduklarını garanti edemiyoruz. Bütçe sınırını kaldırarak fiyat bilgilerini inceleyebilirsin.'
            : undefined,
        finalize: async (events) => {
          const selected = events.flatMap((event) =>
            selections.has(event.id) ? [selections.get(event.id)!] : [],
          );
          const statuses = await reader.revalidate(
            publicationId,
            selected,
            new Date().toISOString(),
          );
          const usable = new Set(
            statuses
              .filter((status) => status.usable)
              .map((status) => status.sessionId),
          );
          return events.filter((event) => usable.has(event.id));
        },
      };
    },
  };
}
