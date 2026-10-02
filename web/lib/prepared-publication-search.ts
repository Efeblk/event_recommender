import { hybridRank } from './hybrid.ts';
import { isEligible, rankEvents, uniqueEvents, validateFilters } from './search.ts';
import { LOCATION_PROFILE, type EventRecord, type Filters, type PreparedLocation } from './types.ts';
import { bindDisplayIdentitySource } from './event-merge.ts';

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
  evidenceVersion?: number | null;
  evidenceStatus?: string | null;
  evidenceReason?: string | null;
  pageObservationId?: string | null;
  evidenceDependencyHash?: string | null;
  evidencePolicyVersion?: string | null;
  evidenceObservedAt?: string | null;
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
  offerProjectionVersion?: number | null;
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
    pinnedPageObservationId?: string | null;
    currentPageObservationId?: string | null;
    evidenceDependencyHash?: string | null;
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
/** A stored location is used only when its shape and resolver profile match. */
function preparedLocation(value: unknown): PreparedLocation | undefined {
  const location = object(value);
  if (!location || location.profile !== LOCATION_PROFILE) return undefined;
  const { district, side, precision } = location;
  const valid =
    (precision === 'district' && typeof district === 'string' && (side === 'europe' || side === 'asia')) ||
    (precision === 'side' && district === null && (side === 'europe' || side === 'asia')) ||
    (precision === 'unknown' && district === null && side === null);
  return valid ? { profile: LOCATION_PROFILE, district, side, precision } as PreparedLocation : undefined;
}

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
    evidenceVersion: row.evidenceVersion === 1 ? 1 : null,
    evidenceStatus: text(row.evidenceStatus),
    evidenceReason: text(row.evidenceReason),
    pageObservationId: text(row.pageObservationId),
    evidenceDependencyHash: text(row.evidenceDependencyHash),
    evidencePolicyVersion: text(row.evidencePolicyVersion),
    evidenceObservedAt: text(row.evidenceObservedAt),
  };
}

function authoritativeTerms(session: PreparedPublicationSession, snapshot: Record<string, unknown>, projectionVersion?: number | null) {
  if (projectionVersion === 1) {
    if (snapshot.offerTermsVersion !== 2 || !Array.isArray(snapshot.offerTerms)) return [];
    const terms = snapshot.offerTerms.map(term).filter((item): item is PreparedOfferTerm => item !== null);
    const pins = new Map(session.pinnedOfferTerms.map((item) => [`${item.offerId}\0${item.revisionId}`, term(item)]));
    const fields: Array<keyof PreparedOfferTerm> = ['offerId','revisionId','provider','providerRecordId','sourceUrl','currency','price','priceMinor','feeMinor','priceKind','availability','observedAt','validFrom','validUntil','evidenceVersion','evidenceStatus','evidenceReason','pageObservationId','evidenceDependencyHash','evidencePolicyVersion','evidenceObservedAt'];
    const keys = terms.map(item => `${item.offerId}\0${item.revisionId}`);
    const exact = terms.length === snapshot.offerTerms.length && terms.length === pins.size && new Set(keys).size === keys.length &&
      terms.every((item, index) => { const pinned = pins.get(keys[index]); return pinned && fields.every(field => (item[field] ?? null) === (pinned[field] ?? null)); });
    return exact ? session.pinnedOfferTerms.map(term).filter((item): item is PreparedOfferTerm => item !== null) : [];
  }
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

export type PreparedSelectedOffer = { offerId: string; revisionId: string; pageObservationId: string | null; evidenceDependencyHash: string | null; projected: boolean };
export function selectedPublicationOfferUsable(status: PublicationSessionStatus | undefined, selected: PreparedSelectedOffer | undefined, publicationId: string) {
  const offer = status?.offers.find(item => item.offerId === selected?.offerId);
  const exactRevision = !!selected && offer?.pinnedRevisionId === selected.revisionId && offer.currentRevisionId === selected.revisionId;
  const exactEvidence = !selected?.projected || (offer?.pinnedPageObservationId === selected.pageObservationId &&
    offer.currentPageObservationId === selected.pageObservationId && offer.evidenceDependencyHash === selected.evidenceDependencyHash);
  return status?.publicationId === publicationId && status.availabilityUsable && status.canonicalSessionUsable &&
    offer?.status === 'usable' && exactRevision && exactEvidence;
}
function project(session: PreparedPublicationSession, now: Date, maxAgeMs: number, projectionVersion?: number | null): { event: EventRecord; selectedOffer: PreparedSelectedOffer } | null {
  const snapshot = object(session.snapshot);
  if (!snapshot) return null;
  const terms = authoritativeTerms(session, snapshot, projectionVersion).filter((item) =>
    item.sourceUrl && usableTerm(item, now.getTime(), maxAgeMs) &&
    (projectionVersion !== 1 || (item.evidenceVersion === 1 && item.evidenceStatus === 'supported' && item.evidencePolicyVersion === 'provider-page-offer-v1' &&
      !!item.pageObservationId && !!item.evidenceDependencyHash?.match(/^[a-f0-9]{64}$/))));
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
  const location = preparedLocation(object(snapshot.preparedSearch)?.location);
  const prepared = session.document && text(session.document.text) && /^[a-f0-9]{64}$/i.test(session.document.hash) && lexicalTokens.length
    ? { version: 1 as const, documentText: session.document.text, documentHash: session.document.hash.toLowerCase(), lexicalTokens,
      ...(location ? { location } : {}) }
    : undefined;
  const advertisedMinor = advertisedMinorUnits(chosen);
  const advertisedPrice: EventRecord['advertisedPrice'] = chosen.currency === 'TRY' && advertisedMinor !== null &&
    (chosen.priceKind === 'starting_at' || chosen.priceKind === 'exact')
    ? { amount: advertisedMinor / 100, currency: 'TRY' as const, kind: chosen.priceKind,
      feesKnown: minor(chosen.feeMinor) !== null } : undefined;
  const event: EventRecord = {
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
  };
  bindDisplayIdentitySource(event,session);
  return { selectedOffer: { offerId: chosen.offerId, revisionId: chosen.revisionId, pageObservationId: chosen.pageObservationId ?? null,
    evidenceDependencyHash: chosen.evidenceDependencyHash ?? null, projected: projectionVersion === 1 }, event };
}

type ProjectedPublication = Array<{ event: EventRecord; selectedOffer: PreparedSelectedOffer; source: PreparedPublicationSession }>;
type ProjectionCacheEntry = { createdMs: number; untilMs: number; projected: ProjectedPublication };
const projectionCache = new WeakMap<PreparedPublicationRead, Map<number, ProjectionCacheEntry>>();

function projectPublication(publication: PreparedPublicationRead, now: Date, maxAgeMs: number): ProjectedPublication {
  return publication.sessions.flatMap((source) => {
    const result = project(source, now, maxAgeMs, publication.offerProjectionVersion);
    return result ? [{ ...result, source }] : [];
  });
}

function nextProjectionBoundary(publication: PreparedPublicationRead, nowMs: number, maxAgeMs: number) {
  let next = Number.POSITIVE_INFINITY;
  const consider = (value: number) => { if (Number.isSafeInteger(value) && value > nowMs && value < next) next = value; };
  for (const session of publication.sessions) {
    const snapshot = object(session.snapshot);
    if (!snapshot) continue;
    for (const item of authoritativeTerms(session, snapshot, publication.offerProjectionVersion)) {
      const observed = Date.parse(item.observedAt ?? '');
      const from = item.validFrom ? Date.parse(item.validFrom) : Number.NaN;
      const until = item.validUntil ? Date.parse(item.validUntil) : Number.NaN;
      consider(observed); consider(from);
      if (Number.isFinite(observed) && Number.isSafeInteger(observed + maxAgeMs)) consider(Math.floor(observed + maxAgeMs) + 1);
      if (Number.isFinite(until)) consider(Math.floor(until) + 1);
    }
  }
  return next;
}

function filterProjectedCandidates(projected: ProjectedPublication, inputFilters: Filters, now: Date, cloneEvents = false) {
  const filters = validateFilters(inputFilters);
  const selectedOffers = new Map<string, string>();
  const selectedOfferChecks = new Map<string, PreparedSelectedOffer>();
  const sources = cloneEvents ? new Map<string, PreparedPublicationSession>() : null;
  const events = projected.map(({ event, selectedOffer, source }) => {
    sources?.set(event.id, source);
    selectedOffers.set(event.id, selectedOffer.offerId);
    selectedOfferChecks.set(event.id, { ...selectedOffer });
    return event;
  });
  const budgetExcludedUnknownPrice = events.filter(event => event.price === null &&
    (filters.maxPrice !== null || filters.totalBudget !== undefined) &&
    isEligible(event, { ...filters, maxPrice: null, totalBudget: undefined }, now)).length;
  const eligible = events.filter((event) => {
    if (!isEligible(event, filters, now)) return false;
    if (filters.totalBudget !== undefined && filters.partySize !== undefined) {
      if (event.price === null) return false;
      const total = event.price * filters.partySize;
      if (filters.maxPriceExclusive ? total >= filters.totalBudget : total > filters.totalBudget) return false;
    }
    return true;
  });
  const returned = cloneEvents ? eligible.map(event => {
    const cloned: EventRecord = { ...event,
      ...(event.advertisedPrice ? { advertisedPrice: { ...event.advertisedPrice } } : {}),
      ...(event.sourceSessionIds ? { sourceSessionIds: [...event.sourceSessionIds] } : {}),
      ...(event.mergedIds ? { mergedIds: [...event.mergedIds] } : {}),
      ...(event.offers ? { offers: structuredClone(event.offers) } : {}),
      ...(event.attendanceTiming ? { attendanceTiming: structuredClone(event.attendanceTiming) } : {}),
      ...(event.preparedSearch ? { preparedSearch: { ...event.preparedSearch, lexicalTokens: [...event.preparedSearch.lexicalTokens] } } : {}),
    };
    bindDisplayIdentitySource(cloned, sources!.get(event.id)!);
    return cloned;
  }) : eligible;
  return { events: returned, selectedOffers, selectedOfferChecks, budgetExcludedUnknownPrice };
}

/** PostgreSQL-only immutable projection cache. All request filters and final current-head validation remain uncached. */
export function prepareCachedPublicationCandidates(publication: PreparedPublicationRead, inputFilters: Filters, now: Date, maxAgeMs = 72 * 3600000) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0)
    return preparePublicationCandidates(publication, inputFilters, now, maxAgeMs);
  let byAge = projectionCache.get(publication);
  if (!byAge) { byAge = new Map(); projectionCache.set(publication, byAge); }
  let entry = byAge.get(maxAgeMs);
  if (!entry || nowMs < entry.createdMs || nowMs >= entry.untilMs) {
    entry = { createdMs: nowMs, untilMs: nextProjectionBoundary(publication, nowMs, maxAgeMs),
      projected: projectPublication(publication, now, maxAgeMs) };
    byAge.set(maxAgeMs, entry);
  }
  return filterProjectedCandidates(entry.projected, inputFilters, now, true);
}

export function preparePublicationCandidates(publication: PreparedPublicationRead, inputFilters: Filters, now: Date, maxAgeMs = 72 * 3600000) {
  return filterProjectedCandidates(projectPublication(publication, now, maxAgeMs), inputFilters, now);
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
  const { events: eligible, selectedOfferChecks } = preparePublicationCandidates(publication, filters, now, maxAgeMs);
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
    const valid = selectedPublicationOfferUsable(status, selectedOfferChecks.get(event.id), publication.publicationId);
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
