import { createHash } from 'node:crypto';

import type { EventOffer, EventRecord } from './types.ts';

export const CATALOG_KNOWLEDGE_SCHEMA_VERSION = 1 as const;
export const CATALOG_NORMALIZER_VERSION = 'catalog-knowledge-v2' as const;

export type KnowledgeSubjectType =
  | 'work'
  | 'production'
  | 'session'
  | 'venue'
  | 'person'
  | 'organization'
  | 'provider_offer'
  | 'promotion';

export interface KnowledgeSubject {
  type: KnowledgeSubjectType;
  id: string;
}

export interface SourceClaimInput {
  id: string;
  subject: KnowledgeSubject;
  field: string;
  value: unknown;
  sourceObservationIds: string[];
  status?: 'supported' | 'conflicting' | 'unknown' | 'stale';
  validFrom?: string | null;
  validThrough?: string | null;
}

export type EvaluationDimension =
  | 'production_reputation'
  | 'creative_team_credentials'
  | 'cultural_significance'
  | 'experience_characteristics'
  | 'comparative_value';

export interface EvaluationInput {
  id: string;
  subject: KnowledgeSubject;
  dimension: EvaluationDimension;
  status: 'complete' | 'pending' | 'unknown' | 'failed';
  /** Null means unscored. Missing evidence never becomes numeric zero. */
  score: number | null;
  components: ReadonlyArray<{ id: string; score: number; weight: number }>;
  rubricVersion: string | null;
  modelVersion: string | null;
  evidenceClaimIds: string[];
  inputHash: string;
}

export interface CatalogKnowledgeOptions {
  sourceClaims?: readonly SourceClaimInput[];
  evaluations?: readonly EvaluationInput[];
  schemaVersion?: number;
  normalizerVersion?: string;
}

export interface CatalogKnowledgeBundle {
  schemaVersion: number;
  normalizerVersion: string;
  inputProvenance: {
    kind: 'prepared_event_records';
    eventCount: number;
    inputHash: string;
  };
  productions: Array<{
    id: string;
    canonicalProductionKey: string | null;
    identityBasis: 'existing_canonical_key' | 'isolated_source_record';
    workId: null;
    personIds: [];
    organizationIds: [];
  }>;
  venues: Array<{
    id: string;
    name: string;
    city: string;
    district: string;
    address: string;
    identityBasis: 'exact_normalized_location_fields';
  }>;
  sessions: Array<{
    id: string;
    productionId: string;
    venueId: string;
    startsAt: string;
    sourceSessionIds: string[];
    attendanceTiming: EventRecord['attendanceTiming'] | null;
    availability: EventRecord['availability'];
  }>;
  providerOffers: Array<{
    id: string;
    sessionId: string;
    source: EventRecord['source'] | null;
    sourceSessionIds: string[];
    url: string;
    price: number | null;
    currency: string;
    checkedAt: string;
    availability: EventRecord['availability'];
    raw: EventOffer | EventRecord;
  }>;
  sourceObservations: Array<{
    id: string;
    subject: KnowledgeSubject;
    source: EventRecord['source'] | null;
    sourceRecordId: string;
    sourceVersion: string | null;
    observedAt: string;
    contentHash: string;
    raw: EventRecord;
  }>;
  sourceClaims: SourceClaimInput[];
  evaluations: EvaluationInput[];
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function normalized(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('tr-TR');
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}-${hash(value).slice(0, 32)}`;
}

function validateEvaluation(evaluation: EvaluationInput): EvaluationInput {
  if (evaluation.status === 'complete') {
    if (evaluation.score === null || !Number.isFinite(evaluation.score) || evaluation.score < 0 || evaluation.score > 1 ||
      !evaluation.rubricVersion?.trim() || !evaluation.modelVersion?.trim() ||
      evaluation.evidenceClaimIds.length === 0 || evaluation.components.length === 0)
      throw new Error(`Complete evaluation ${evaluation.id} requires a score, components, rubric, model, and evidence IDs.`);
    if (evaluation.components.some(({ id, score, weight }) =>
      !id.trim() || !Number.isFinite(score) || score < 0 || score > 1 ||
      !Number.isFinite(weight) || weight < 0))
      throw new Error(`Complete evaluation ${evaluation.id} has invalid normalized components.`);
  } else if (evaluation.score !== null) {
    throw new Error(`Non-complete evaluation ${evaluation.id} must not supply a score.`);
  }
  if (!/^[a-f0-9]{64}$/.test(evaluation.inputHash))
    throw new Error(`Evaluation ${evaluation.id} requires a lowercase SHA-256 input hash.`);
  return evaluation;
}

function subjectKey(subject: KnowledgeSubject): string {
  return `${subject.type}:${subject.id}`;
}

const dimensions: readonly EvaluationDimension[] = [
  'production_reputation',
  'creative_team_credentials',
  'cultural_significance',
  'experience_characteristics',
  'comparative_value',
];

/** Builds persistence-ready canonical rows without performing new identity inference or AI work. */
export function prepareCatalogKnowledge(
  events: readonly EventRecord[],
  options: CatalogKnowledgeOptions = {},
): CatalogKnowledgeBundle {
  const schemaVersion = options.schemaVersion ?? CATALOG_KNOWLEDGE_SCHEMA_VERSION;
  const normalizerVersion = options.normalizerVersion ?? CATALOG_NORMALIZER_VERSION;
  const ordered = [...events].sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(ordered.map(({ id }) => id)).size !== ordered.length)
    throw new Error('Prepared event record IDs must be unique.');

  const productions = new Map<string, CatalogKnowledgeBundle['productions'][number]>();
  const venues = new Map<string, CatalogKnowledgeBundle['venues'][number]>();
  const sessions: CatalogKnowledgeBundle['sessions'] = [];
  const providerOffers: CatalogKnowledgeBundle['providerOffers'] = [];
  const sourceObservations: CatalogKnowledgeBundle['sourceObservations'] = [];
  const productionInputs = new Map<string, EventRecord[]>();
  const offerRows = new Map<string, CatalogKnowledgeBundle['providerOffers'][number]>();

  for (const event of ordered) {
    const productionId = event.canonicalProductionKey
      ? stableId('production', ['canonical', event.canonicalProductionKey])
      : stableId('production', ['isolated', event.id]);
    productions.set(productionId, {
      id: productionId,
      canonicalProductionKey: event.canonicalProductionKey ?? null,
      identityBasis: event.canonicalProductionKey ? 'existing_canonical_key' : 'isolated_source_record',
      workId: null,
      personIds: [],
      organizationIds: [],
    });
    productionInputs.set(productionId, [...(productionInputs.get(productionId) ?? []), event]);

    const venueFields = [event.venue, event.city, event.district, event.address].map(normalized);
    const venueId = stableId('venue', venueFields);
    venues.set(venueId, {
      id: venueId,
      name: event.venue,
      city: event.city,
      district: event.district,
      address: event.address,
      identityBasis: 'exact_normalized_location_fields',
    });
    sessions.push({
      id: event.id,
      productionId,
      venueId,
      startsAt: event.startsAt,
      sourceSessionIds: [...(event.sourceSessionIds ?? [])],
      attendanceTiming: event.attendanceTiming ?? null,
      availability: event.availability,
    });

    const offers = event.offers?.length ? event.offers : [event];
    for (const offer of offers) {
      const row: CatalogKnowledgeBundle['providerOffers'][number] = {
      id: offer.id,
      sessionId: event.id,
      source: offer.source ?? event.source ?? null,
      sourceSessionIds: [...(offer.sourceSessionIds ?? event.sourceSessionIds ?? [])],
      url: offer.url,
      price: offer.price,
      currency: offer.currency,
      checkedAt: offer.checkedAt,
      availability: offer.availability,
      raw: structuredClone(offer),
      };
      const prior = offerRows.get(row.id);
      if (prior && (prior.sessionId !== row.sessionId || stableJson(prior.raw) !== stableJson(row.raw)))
        throw new Error(`Provider offer ID ${row.id} has conflicting session or raw data.`);
      if (!prior) {
        offerRows.set(row.id, row);
        providerOffers.push(row);
      }
    }

    sourceObservations.push({
      id: stableId('observation', [event.source ?? null, event.id, hash(event)]),
      subject: { type: 'session', id: event.id },
      source: event.source ?? null,
      sourceRecordId: event.id,
      sourceVersion: event.sourceVersion ?? null,
      observedAt: event.checkedAt,
      contentHash: hash(event),
      raw: structuredClone(event),
    });
  }

  const knownSubjects = new Set<string>([
    ...[...productions.values()].map(({ id }) => subjectKey({ type: 'production', id })),
    ...[...venues.values()].map(({ id }) => subjectKey({ type: 'venue', id })),
    ...sessions.map(({ id }) => subjectKey({ type: 'session', id })),
    ...providerOffers.map(({ id }) => subjectKey({ type: 'provider_offer', id })),
  ]);
  const observationIds = new Set(sourceObservations.map(({ id }) => id));
  const sourceClaims = [...(options.sourceClaims ?? [])]
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const claim of sourceClaims) {
    if (!knownSubjects.has(subjectKey(claim.subject)))
      throw new Error(`Source claim ${claim.id} references an unknown subject.`);
    if (claim.sourceObservationIds.length === 0 ||
      claim.sourceObservationIds.some(id => !observationIds.has(id)))
      throw new Error(`Source claim ${claim.id} must reference known source observations.`);
  }
  const claimIds = new Set(sourceClaims.map(({ id }) => id));
  const evaluations = options.evaluations
    ? [...options.evaluations].map(validateEvaluation).sort((left, right) => left.id.localeCompare(right.id))
    : [...productions.values()].flatMap((production) => dimensions.map((dimension) => {
      const inputHash = hash({
        productionId: production.id,
        dimension,
        normalizerVersion,
        events: productionInputs.get(production.id),
      });
      return {
        id: stableId('evaluation', [production.id, dimension, normalizerVersion, inputHash]),
        subject: { type: 'production' as const, id: production.id },
        dimension,
        status: 'pending' as const,
        score: null,
        components: [],
        rubricVersion: null,
        modelVersion: null,
        evidenceClaimIds: [],
        inputHash,
      };
    }));
  for (const evaluation of evaluations) {
    if (!knownSubjects.has(subjectKey(evaluation.subject)))
      throw new Error(`Evaluation ${evaluation.id} references an unknown subject.`);
    if (evaluation.evidenceClaimIds.some(id => !claimIds.has(id)))
      throw new Error(`Evaluation ${evaluation.id} references an unknown evidence claim.`);
  }

  return {
    schemaVersion,
    normalizerVersion,
    inputProvenance: {
      kind: 'prepared_event_records',
      eventCount: ordered.length,
      inputHash: hash({ schemaVersion, normalizerVersion, events: ordered }),
    },
    productions: [...productions.values()].sort((a, b) => a.id.localeCompare(b.id)),
    venues: [...venues.values()].sort((a, b) => a.id.localeCompare(b.id)),
    sessions,
    providerOffers: providerOffers.sort((a, b) => `${a.sessionId}:${a.id}`.localeCompare(`${b.sessionId}:${b.id}`)),
    sourceObservations,
    sourceClaims,
    evaluations,
  };
}

export type PromotionBenefit =
  | { kind: 'percentage'; percent: number; cap: number | null }
  | { kind: 'fixed'; amount: number; cap: number | null }
  | { kind: 'buy_get'; buy: number; get: number; capFreeTickets: number | null }
  | { kind: 'cashback'; percent: number; cap: number | null };

export interface PromotionPriceInput {
  unitPrice: number;
  ticketCount: number;
  qualifyingTicketCount: number | null;
  eligibility: 'eligible' | 'ineligible' | 'unknown';
  benefit: PromotionBenefit;
  /** Null means mandatory fees are unknown. */
  mandatoryFeePerTicket: number | null;
  stacking: 'not_applicable' | 'supported' | 'unsupported' | 'unknown';
}

export interface PromotionPriceEvaluation {
  status: 'verified' | 'conditional' | 'ineligible';
  baseTotal: number;
  checkoutTotal: number | null;
  discountAtCheckout: number | null;
  cashback: number | null;
  qualifyingTicketCount: number | null;
  fees: number | null;
  stacking: PromotionPriceInput['stacking'];
  usableForHardBudget: boolean;
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function capped(value: number, cap: number | null): number {
  return money(cap === null ? value : Math.min(value, cap));
}

/** Deterministic request-scoped promotion arithmetic; it does not infer eligibility or stacking. */
export function evaluatePromotionPrice(input: PromotionPriceInput): PromotionPriceEvaluation {
  const invalidCap = (cap: number | null) => cap !== null && (!Number.isFinite(cap) || cap < 0);
  const invalidBenefit = (() => {
    switch (input.benefit.kind) {
      case 'percentage':
      case 'cashback': return !Number.isFinite(input.benefit.percent) || input.benefit.percent < 0 ||
        input.benefit.percent > 100 || invalidCap(input.benefit.cap);
      case 'fixed': return !Number.isFinite(input.benefit.amount) || input.benefit.amount < 0 ||
        invalidCap(input.benefit.cap);
      case 'buy_get': return !Number.isInteger(input.benefit.buy) || input.benefit.buy < 1 ||
        !Number.isInteger(input.benefit.get) || input.benefit.get < 1 ||
        (input.benefit.capFreeTickets !== null &&
          (!Number.isInteger(input.benefit.capFreeTickets) || input.benefit.capFreeTickets < 0));
    }
  })();
  if (!Number.isFinite(input.unitPrice) || input.unitPrice < 0 ||
    (input.mandatoryFeePerTicket !== null &&
      (!Number.isFinite(input.mandatoryFeePerTicket) || input.mandatoryFeePerTicket < 0)) ||
    invalidBenefit || !Number.isInteger(input.ticketCount) || input.ticketCount < 1 ||
    (input.qualifyingTicketCount !== null &&
      (!Number.isInteger(input.qualifyingTicketCount) || input.qualifyingTicketCount < 0 ||
        input.qualifyingTicketCount > input.ticketCount)))
    throw new Error('Invalid promotion price input.');
  const baseTotal = money(input.unitPrice * input.ticketCount);
  const fees = input.mandatoryFeePerTicket === null
    ? null
    : money(input.mandatoryFeePerTicket * input.ticketCount);
  if (input.eligibility === 'ineligible') return {
    status: 'ineligible', baseTotal, checkoutTotal: fees === null ? null : money(baseTotal + fees),
    discountAtCheckout: 0, cashback: 0, qualifyingTicketCount: input.qualifyingTicketCount,
    fees, stacking: input.stacking, usableForHardBudget: fees !== null,
  };

  const count = input.qualifyingTicketCount;
  let discount: number | null = null;
  let cashback: number | null = null;
  if (count !== null) {
    const qualifyingTotal = input.unitPrice * count;
    switch (input.benefit.kind) {
      case 'percentage': discount = capped(qualifyingTotal * input.benefit.percent / 100, input.benefit.cap); break;
      case 'fixed': discount = capped(input.benefit.amount * count, input.benefit.cap); break;
      case 'buy_get': {
        const group = input.benefit.buy + input.benefit.get;
        const free = Math.floor(count / group) * input.benefit.get;
        discount = money(input.unitPrice * (input.benefit.capFreeTickets === null
          ? free : Math.min(free, input.benefit.capFreeTickets)));
        break;
      }
      case 'cashback': cashback = capped(qualifyingTotal * input.benefit.percent / 100, input.benefit.cap); discount = 0; break;
    }
  }
  const conditional = input.eligibility === 'unknown' || count === null || fees === null ||
    input.stacking === 'unknown';
  const checkoutTotal = fees === null || discount === null ? null : money(baseTotal - discount + fees);
  return {
    status: conditional ? 'conditional' : 'verified',
    baseTotal,
    checkoutTotal,
    discountAtCheckout: discount,
    cashback,
    qualifyingTicketCount: count,
    fees,
    stacking: input.stacking,
    usableForHardBudget: !conditional && checkoutTotal !== null,
  };
}
