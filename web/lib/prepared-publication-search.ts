import { hybridRank } from './hybrid.ts';
import { isEligible, rankEvents, uniqueEvents, validateFilters } from './search.ts';
import type { EventRecord, Filters } from './types.ts';

export type PreparedSearchMode = 'lexical' | 'hybrid';

export interface PreparedOfferTerm {
  offerId: string;
  revisionId: string;
  provider?: string | null;
  providerRecordId?: string | null;
  sourceUrl?: string | null;
  currency?: string | null;
  price?: string | null;
  priceMinor?: string | null;
  feeMinor?: string | null;
  priceKind?: string | null;
  availability?: string | null;
  observedAt?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
}

export interface PreparedPublicationSession {
  sessionId: string;
  productionId: string;
  venueId: string | null;
  snapshot: unknown;
  document: null | {
    id: string;
    text: string;
    hash: string;
    embeddingProfile: string | null;
    vector: number[] | null;
  };
  /** Exact immutable publication pins, used to hydrate legacy snapshots. */
  pinnedOfferTerms: PreparedOfferTerm[];
}

export interface PreparedPublicationRead {
  publicationId: string;
  embeddingProfile?: string | null;
  sessions: PreparedPublicationSession[];
}

export interface PublicationSessionStatus {
  publicationId: string;
  sessionId: string;
  availabilityUsable: boolean;
  verifiedTotalEligible: boolean;
  canonicalSessionUsable: boolean;
  reasons: string[];
  offers: Array<{
    offerId: string;
    pinnedRevisionId: string | null;
    currentRevisionId: string | null;
    status: string;
    reasons: string[];
  }>;
}

export interface PreparedPublicationRepository {
  /** With no ID, pins the active publication as part of this read. */
  readPublication(
    publicationId?: string,
    options?: { includeVectors?: boolean },
  ): Promise<PreparedPublicationRead>;
  revalidatePublication(
    publicationId: string,
    sessionIds: string[],
    checkedAt: string,
    maxAgeMs: number,
  ): Promise<PublicationSessionStatus[]>;
}

export interface PreparedPublicationSearchInput {
  query: string;
  filters: Filters;
  mode: PreparedSearchMode;
  publicationId?: string;
  queryVector?: number[] | null;
  queryEmbeddingProfile?: string;
  now?: Date;
  maxAgeMs?: number;
  shortlistLimit?: number;
}

export interface PreparedPublicationSearchResult {
  publicationId: string;
  mode: PreparedSearchMode;
  events: EventRecord[];
  considered: number;
  eligible: number;
  shortlisted: number;
  excludedAtRevalidation: Array<{ sessionId: string; reasons: string[] }>;
  /** True when current-state failures removed shortlisted cards; callers must not claim catalog absence. */
  revalidationWithheld: boolean;
  elapsedMs: number;
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value : null;
const stringArray = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function safeUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    const provider = /(^|\.)(?:(?:biletinial|biletix)\.com|bubilet\.com\.tr)$/i.test(url.hostname);
    return url.protocol === 'https:' && !url.username && !url.password && provider ? url.href : null;
  } catch {
    return null;
  }
}

function safeImageUrl(value: unknown): string | null {
  const candidate = text(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function term(value: unknown): PreparedOfferTerm | null {
  const row = object(value);
  const offerId = text(row?.offerId);
  const revisionId = text(row?.revisionId);
  if (!row || !offerId || !revisionId) return null;
  return {
    offerId,
    revisionId,
    provider: text(row.provider),
    providerRecordId: text(row.providerRecordId),
    sourceUrl: safeUrl(row.sourceUrl),
    currency: text(row.currency),
    price: text(row.price),
    priceMinor: text(row.priceMinor),
    feeMinor: text(row.feeMinor),
    priceKind: text(row.priceKind),
    availability: text(row.availability),
    observedAt: text(row.observedAt),
    validFrom: text(row.validFrom),
    validUntil: text(row.validUntil),
  };
}

function authoritativeTerms(session: PreparedPublicationSession, snapshot: Record<string, unknown>) {
  if ('offerTermsVersion' in snapshot && snapshot.offerTermsVersion !== 1) return [];
  if (snapshot.offerTermsVersion === 1) {
    if (!Array.isArray(snapshot.offerTerms)) return [];
    const terms = snapshot.offerTerms.map(term).filter((item): item is PreparedOfferTerm => item !== null);
    const pins = new Map(session.pinnedOfferTerms.map((item) => [`${item.offerId}\0${item.revisionId}`, term(item)]));
    const fields: Array<keyof PreparedOfferTerm> = ['offerId', 'revisionId', 'provider', 'providerRecordId', 'sourceUrl', 'currency', 'price', 'priceMinor', 'feeMinor', 'priceKind', 'availability', 'observedAt', 'validFrom', 'validUntil'];
    const keys = terms.map((item) => `${item.offerId}\0${item.revisionId}`);
    const exact = terms.length === snapshot.offerTerms.length && terms.length === pins.size && new Set(keys).size === keys.length && terms.every((item, index) => {
      const pinned = pins.get(keys[index]);
      return pinned && fields.every((field) => (item[field] ?? null) === (pinned[field] ?? null));
    });
    return exact ? session.pinnedOfferTerms.map(term).filter((item): item is PreparedOfferTerm => item !== null) : [];
  }
  // Legacy `offers` is arbitrary source JSON. Exact revision joins are the only
  // typed authority available for a historical publication.
  return session.pinnedOfferTerms.map(term).filter((item): item is PreparedOfferTerm => item !== null);
}

function minor(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function advertisedMinorUnits(item: PreparedOfferTerm): number | null {
  const price = minor(item.priceMinor);
  if (item.currency !== 'TRY' || price === null || !['exact','starting_at'].includes(item.priceKind ?? '')) return null;
  if (item.price !== null && item.price !== undefined) {
    if (!/^\d+(?:\.\d{1,2})?$/.test(item.price)) return null;
    const [major, fraction = ''] = item.price.split('.');
    const fromMajor = Number(major) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(fromMajor) || fromMajor !== price) return null;
  }
  return price;
}

function exactTotal(item: PreparedOfferTerm): number | null {
  const price = advertisedMinorUnits(item), fee = minor(item.feeMinor);
  return item.priceKind === 'exact' && price !== null && fee !== null && price <= Number.MAX_SAFE_INTEGER - fee
    ? price + fee : null;
}

function usableTerm(item: PreparedOfferTerm, nowMs: number, maxAgeMs: number) {
  const observed = Date.parse(item.observedAt ?? '');
  const from = item.validFrom ? Date.parse(item.validFrom) : null;
  const until = item.validUntil ? Date.parse(item.validUntil) : null;
  return (
    (item.availability === 'available' || item.availability === 'limited') &&
    Number.isFinite(observed) && observed <= nowMs && observed >= nowMs - maxAgeMs &&
    (from === null || (Number.isFinite(from) && from <= nowMs)) &&
    (until === null || (Number.isFinite(until) && until >= nowMs))
  );
}

function project(session: PreparedPublicationSession, now: Date, maxAgeMs: number): { event: EventRecord; selectedOfferId: string } | null {
  const snapshot = object(session.snapshot);
  if (!snapshot) return null;
  const terms = authoritativeTerms(session, snapshot).filter((item) => item.sourceUrl && usableTerm(item, now.getTime(), maxAgeMs));
  if (!terms.length) return null;
  const exactTotals = terms.flatMap((item) => {
    const total = exactTotal(item);
    return total === null ? [] : [{ item, minor: total }];
  }).sort((a, b) => a.minor - b.minor);
  const advertised = terms.flatMap(item => {
    const amount = advertisedMinorUnits(item);
    return amount === null ? [] : [{ item, amount }];
  }).sort((a,b)=>a.amount-b.amount);
  const chosen = exactTotals[0]?.item ?? advertised[0]?.item ?? terms[0];
  const totalMinor = exactTotals[0]?.minor ?? null;
  const startsAt = text(snapshot.startsAt);
  const title = text(snapshot.title);
  const checkedAt = chosen.observedAt;
  const url = safeUrl(chosen.sourceUrl);
  if (!startsAt || !title || !checkedAt || !url || !Number.isFinite(Date.parse(startsAt))) return null;
  const lexicalTokens = stringArray(object(snapshot.preparedSearch)?.lexicalTokens);
  const prepared = session.document && text(session.document.text) && /^[a-f0-9]{64}$/i.test(session.document.hash) && lexicalTokens.length
    ? { version: 1 as const, documentText: session.document.text, documentHash: session.document.hash.toLowerCase(), lexicalTokens }
    : undefined;
  const advertisedMinor = advertisedMinorUnits(chosen);
  const advertisedPrice: EventRecord['advertisedPrice'] = chosen.currency === 'TRY' && advertisedMinor !== null &&
    (chosen.priceKind === 'starting_at' || chosen.priceKind === 'exact')
    ? { amount: advertisedMinor / 100, currency: 'TRY' as const, kind: chosen.priceKind,
      feesKnown: minor(chosen.feeMinor) !== null } : undefined;
  return { selectedOfferId: chosen.offerId, event: {
    id: session.sessionId,
    title,
    description: text(snapshot.description) ?? session.document?.text ?? '',
    startsAt,
    venue: text(snapshot.venue) ?? '',
    city: text(snapshot.city) ?? 'İstanbul',
    district: text(snapshot.district) ?? '',
    address: text(snapshot.address) ?? '',
    price: totalMinor === null ? null : totalMinor / 100,
    currency: totalMinor === null ? '' : 'TRY',
    ...(advertisedPrice ? { advertisedPrice } : {}),
    ...(chosen.provider === 'bubilet' || chosen.provider === 'biletinial' || chosen.provider === 'biletix' ? { source: chosen.provider } : {}),
    url,
    imageUrl: safeImageUrl(snapshot.imageUrl) ?? '',
    category: text(snapshot.category) ?? 'Diğer',
    availability: 'available',
    attendanceTiming: object(snapshot.attendanceTiming) as EventRecord['attendanceTiming'],
    sourceSessionIds: stringArray(snapshot.sourceSessionIds),
    productionKey: session.productionId,
    canonicalProductionKey: session.productionId,
    preparedSearch: prepared,
    checkedAt,
  } };
}

export function preparePublicationCandidates(publication: PreparedPublicationRead, inputFilters: Filters, now: Date, maxAgeMs = 72 * 3600000) {
  const filters = validateFilters(inputFilters);
  const selectedOffers = new Map<string, string>();
  const projected = publication.sessions.flatMap((session) => {
    const result = project(session, now, maxAgeMs);
    if (result) selectedOffers.set(result.event.id, result.selectedOfferId);
    return result ? [result.event] : [];
  });
  const budgetExcludedUnknownPrice = projected.filter(event => event.price === null &&
    (filters.maxPrice !== null || filters.totalBudget !== undefined) &&
    isEligible(event, { ...filters, maxPrice: null, totalBudget: undefined }, now)).length;
  const events = projected.filter((event) => {
    if (!isEligible(event, filters, now)) return false;
    if (filters.totalBudget !== undefined && filters.partySize !== undefined) {
      if (event.price === null) return false;
      const total = event.price * filters.partySize;
      if (filters.maxPriceExclusive ? total >= filters.totalBudget : total > filters.totalBudget) return false;
    }
    return true;
  });
  return { events, selectedOffers, budgetExcludedUnknownPrice };
}

export async function searchPreparedPublication(
  repository: PreparedPublicationRepository,
  input: PreparedPublicationSearchInput,
): Promise<PreparedPublicationSearchResult> {
  const started = performance.now();
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid search time');
  const maxAgeMs = input.maxAgeMs ?? 72 * 60 * 60 * 1000;
  const limit = Math.min(16, Math.max(1, Math.trunc(input.shortlistLimit ?? 16)));
  if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('Invalid freshness window');
  const requestedHybrid = input.mode === 'hybrid' && !!input.queryVector?.length;
  const filters = validateFilters(input.filters);
  const publication = await repository.readPublication(input.publicationId, {
    includeVectors: requestedHybrid,
  });
  const { events: eligible, selectedOffers } = preparePublicationCandidates(publication, filters, now, maxAgeMs);
  const vectors = new Map(publication.sessions.flatMap((session) => {
    const document = session.document;
    if (!document || document.embeddingProfile !== publication.embeddingProfile || document.vector?.length !== 1024 || !document.vector.every(Number.isFinite) || !document.vector.some((value) => value !== 0)) return [];
    return [[session.sessionId, document.vector] as const];
  }));
  const useHybrid = !!(
    requestedHybrid &&
    publication.embeddingProfile &&
    input.queryEmbeddingProfile === publication.embeddingProfile &&
    input.queryVector!.length === 1024 &&
    input.queryVector!.every(Number.isFinite) &&
    input.queryVector!.some((value) => value !== 0)
  );
  const ranked = useHybrid
    ? hybridRank(eligible, input.query, { queryVector: input.queryVector!, vectors })
    : rankEvents(eligible, input.query);
  const shortlist = uniqueEvents(ranked, limit);
  const statuses = shortlist.length
    ? await repository.revalidatePublication(publication.publicationId, shortlist.map((event) => event.id), now.toISOString(), maxAgeMs)
    : [];
  const statusBySession = new Map(statuses.map((status) => [status.sessionId, status]));
  const excludedAtRevalidation: Array<{ sessionId: string; reasons: string[] }> = [];
  const events = shortlist.filter((event) => {
    const status = statusBySession.get(event.id);
    const selectedOfferId = selectedOffers.get(event.id);
    const selectedStatus = status?.offers.find((offer) => offer.offerId === selectedOfferId);
    const valid = status?.publicationId === publication.publicationId && status.availabilityUsable && status.canonicalSessionUsable && selectedStatus?.status === 'usable';
    if (!valid) excludedAtRevalidation.push({ sessionId: event.id, reasons: status?.reasons ?? ['missing_revalidation'] });
    return valid;
  });
  return {
    publicationId: publication.publicationId,
    mode: useHybrid ? 'hybrid' : 'lexical',
    events,
    considered: publication.sessions.length,
    eligible: eligible.length,
    shortlisted: shortlist.length,
    excludedAtRevalidation,
    revalidationWithheld: excludedAtRevalidation.length > 0,
    elapsedMs: performance.now() - started,
  };
}
