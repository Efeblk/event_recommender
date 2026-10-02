import type { EventRecord } from '../../lib/types.ts';
import { createHash } from 'node:crypto';

export const EXPECTED_VECTOR_PROFILE = 'voyage-embedding-v1|endpoint=https://api.voyageai.com/v1/embeddings|model=voyage-4-large|dimensions=1024|input_type=document|text_profile=event-title-category-venue-description-v1';

export interface VectorSnapshot {
  profile: string;
  entries: { hash: string; vector: number[] }[];
}

export type GraphRelationType =
  | 'HAS_SESSION' | 'AT_VENUE' | 'IN_DISTRICT' | 'IN_NEIGHBORHOOD'
  | 'HAS_OFFER' | 'HAS_DOCUMENT' | 'DESCRIBES_SESSION';

export interface GraphProjection {
  programs: { id: string; title: string; category: string; canonicalProductionKey?: string }[];
  sessions: { id: string; programId: string; venueId: string; startsAt: string; localDay: string; localMinutes: number; category: string; price: number | null; currency: string; checkedAt: string; availability: EventRecord['availability']; timingKind: 'timed_session' | 'admission_window' | 'unknown' | 'unspecified'; eventJSON: string }[];
  venues: { id: string; name: string; address: string; city: string; districtId?: string; neighborhoodId?: string; neighborhoodStatus: 'source_backed' | 'unknown' }[];
  districts: { id: string; name: string }[];
  neighborhoods: { id: string; name: string }[];
  offers: { id: string; sessionId: string; source?: EventRecord['source']; url: string; price: number | null; currency: string; checkedAt: string; category: string; venue: string; availability: EventRecord['availability']; sourceSessionIds: string[]; eventJSON: string }[];
  documents: { id: string; sessionId: string; programId: string; documentHash: string; documentText: string; lexicalTokens: string[]; embeddingProfile?: string; embedding?: number[] }[];
  relations: { fromId: string; toId: string; type: GraphRelationType }[];
  summary: { programs: number; sessions: number; venues: number; districts: number; neighborhoods: number; offers: number; documents: number; embeddedDocuments: number; vectorProfile: string };
}

const neighborhoods = ['Taksim', 'Moda', 'Karakoy', 'Balat', 'Cihangir', 'Bebek', 'Ortakoy', 'Nisantasi'] as const;

function normalized(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, ' ').trim();
}

function componentId(kind: string, value: string): string {
  return `${kind}:${encodeURIComponent(normalized(value)).replace(/%20/g, '-')}`;
}

function localParts(startsAt: string): { localDay: string; localMinutes: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(startsAt));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '';
  return { localDay: `${part('year')}-${part('month')}-${part('day')}`, localMinutes: Number(part('hour')) * 60 + Number(part('minute')) };
}

function sourceNeighborhood(event: EventRecord): string | undefined {
  const evidence = normalized(`${event.venue} ${event.address}`);
  const matches = neighborhoods.filter((name) => new RegExp(`(?:^| )${normalized(name)}(?: |$)`).test(evidence));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Pure projection of already-prepared sessions. It performs no IO and no new event merging. */
export function buildGraphProjection(events: EventRecord[], vectorSnapshot: VectorSnapshot): GraphProjection {
  if (vectorSnapshot.profile !== EXPECTED_VECTOR_PROFILE) throw new Error(`Unexpected vector profile: ${vectorSnapshot.profile}`);
  const vectors = new Map<string, number[]>();
  for (const entry of vectorSnapshot.entries) {
    if (entry.vector.length !== 1024 || entry.vector.some((value) => !Number.isFinite(value)) || entry.vector.every((value) => value === 0))
      throw new Error(`Invalid vector for document ${entry.hash}`);
    const prior = vectors.get(entry.hash);
    if (prior && prior.some((value, index) => value !== entry.vector[index])) throw new Error(`Conflicting vectors for document ${entry.hash}`);
    vectors.set(entry.hash, entry.vector);
  }
  const programs = new Map<string, GraphProjection['programs'][number]>();
  const venues = new Map<string, GraphProjection['venues'][number]>();
  const districts = new Map<string, GraphProjection['districts'][number]>();
  const neighborhoodRows = new Map<string, GraphProjection['neighborhoods'][number]>();
  const sessions: GraphProjection['sessions'] = [];
  const offers: GraphProjection['offers'] = [];
  const documents: GraphProjection['documents'] = [];
  const relations: GraphProjection['relations'] = [];

  for (const event of events) {
    // Prepared session and offer IDs are durable source-verification handles.
    const sessionId = event.id;
    const programId = event.canonicalProductionKey ? `program:${event.canonicalProductionKey}` : `program:session:${event.id}`;
    const venueId = `venue:${[event.venue, event.address, event.district].map((value) => encodeURIComponent(normalized(value))).join('|')}`;
    const districtId = event.district.trim() ? componentId('district', event.district) : undefined;
    const neighborhood = sourceNeighborhood(event);
    const neighborhoodId = neighborhood ? componentId('neighborhood', neighborhood) : undefined;
    const eventJSON = JSON.stringify(event);

    if (!programs.has(programId)) programs.set(programId, {
      id: programId, title: event.title, category: event.category,
      ...(event.canonicalProductionKey ? { canonicalProductionKey: event.canonicalProductionKey } : {}),
    });
    if (districtId && !districts.has(districtId)) districts.set(districtId, { id: districtId, name: event.district });
    if (neighborhoodId && !neighborhoodRows.has(neighborhoodId)) neighborhoodRows.set(neighborhoodId, { id: neighborhoodId, name: neighborhood! });
    if (!venues.has(venueId)) venues.set(venueId, {
      id: venueId, name: event.venue, address: event.address, city: event.city,
      ...(districtId ? { districtId } : {}), ...(neighborhoodId ? { neighborhoodId } : {}),
      neighborhoodStatus: neighborhoodId ? 'source_backed' : 'unknown',
    });

    sessions.push({ id: sessionId, programId, venueId, startsAt: event.startsAt, ...localParts(event.startsAt),
      category: event.category, price: event.price, currency: event.currency, checkedAt: event.checkedAt,
      availability: event.availability, timingKind: event.attendanceTiming?.kind ?? 'unspecified', eventJSON });
    relations.push({ fromId: programId, toId: sessionId, type: 'HAS_SESSION' }, { fromId: sessionId, toId: venueId, type: 'AT_VENUE' });
    if (districtId) relations.push({ fromId: venueId, toId: districtId, type: 'IN_DISTRICT' });
    if (neighborhoodId) relations.push({ fromId: venueId, toId: neighborhoodId, type: 'IN_NEIGHBORHOOD' });

    for (const offer of event.offers ?? []) {
      const offerId = offer.id;
      offers.push({ id: offerId, sessionId, source: offer.source, url: offer.url, price: offer.price,
        currency: offer.currency, checkedAt: offer.checkedAt, category: offer.category, venue: offer.venue,
        availability: offer.availability, sourceSessionIds: [...(offer.sourceSessionIds ?? [])], eventJSON: JSON.stringify(offer) });
      relations.push({ fromId: sessionId, toId: offerId, type: 'HAS_OFFER' });
    }
    if (event.preparedSearch) {
      const prepared = event.preparedSearch;
      const actualHash = createHash('sha256').update(prepared.documentText).digest('hex');
      if (actualHash !== prepared.documentHash) throw new Error(`Search document hash mismatch for session ${event.id}`);
      const embedding = vectors.get(prepared.documentHash);
      const documentId = `document:${prepared.documentHash}`;
      documents.push({ id: documentId, sessionId, programId, documentHash: prepared.documentHash,
        documentText: prepared.documentText, lexicalTokens: [...prepared.lexicalTokens],
        ...(embedding ? { embeddingProfile: vectorSnapshot.profile, embedding: [...embedding] } : {}) });
      relations.push({ fromId: programId, toId: documentId, type: 'HAS_DOCUMENT' },
        { fromId: sessionId, toId: documentId, type: 'DESCRIBES_SESSION' });
    }
  }
  const result = { programs: [...programs.values()], sessions, venues: [...venues.values()],
    districts: [...districts.values()], neighborhoods: [...neighborhoodRows.values()], offers, documents, relations };
  return { ...result, summary: { programs: result.programs.length, sessions: sessions.length,
    venues: result.venues.length, districts: result.districts.length, neighborhoods: result.neighborhoods.length,
    offers: offers.length, documents: documents.length, embeddedDocuments: documents.filter((row) => row.embedding).length,
    vectorProfile: vectorSnapshot.profile } };
}
