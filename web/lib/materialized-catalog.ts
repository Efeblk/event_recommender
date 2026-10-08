import { resolveEventRecordIdentity } from '../../collector/identity/index.ts';
import {
  normalizeIdentityText,
  normalizeTitleKey,
} from '../../collector/normalize/identity.ts';
import { isEligible } from './search.ts';
import {
  emptyFilters,
  type AttendanceTiming,
  type EventOffer,
  type EventRecord,
  type Filters,
} from './types.ts';
import { createHash } from 'node:crypto';
import { voyageDocumentText } from './voyage.ts';
import { prepareLexicalDocumentTokens } from './hybrid.ts';
import { prepareEventLocation } from './istanbul-location.ts';
import { categoryForEvent } from './event-format.ts';
import {
  hasExplicitDoorTimeStartConflict,
  sourceTimeIsDoorsOnly,
} from '../../contracts/timing.ts';
import {
  hasExplicitSameEventSoldOutConflict,
  hasExplicitSameEventVenueConflict,
} from '../../contracts/source-evidence.ts';

export interface SearchCatalog {
  schemaVersion: 1;
  materializedAt: string;
  sourceStatus: Pick<EventRecord, 'startsAt' | 'checkedAt' | 'availability'>[];
  groups: { versions: { from: number; events: EventRecord[] }[] }[];
}

function eventOrder(a: EventRecord, b: EventRecord): number {
  return (
    (a.source ?? '').localeCompare(b.source ?? '') ||
    a.url.localeCompare(b.url) ||
    a.id.localeCompare(b.id)
  );
}

function normalizedEvidence(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hasPositiveStandupEvidence(event: EventRecord): boolean {
  const text = normalizedEvidence(`${event.title} ${event.description}`);
  for (const match of text.matchAll(/\bstand ?up\b/g)) {
    const before = text.slice(Math.max(0, match.index! - 16), match.index!);
    const after = text.slice(
      match.index! + match[0].length,
      match.index! + match[0].length + 18,
    );
    if (
      !/\b(ne|degil|olmayan)\s*$/.test(before) &&
      !/^\s*(degil|degildir|olmayan)\b/.test(after)
    )
      return true;
  }
  return false;
}

function representativeOf(events: EventRecord[]): EventRecord {
  const hasStandup = events.some(hasPositiveStandupEvidence);
  const candidates = hasStandup
    ? events.filter(
        (event) =>
          event.category === 'Stand-up' && hasPositiveStandupEvidence(event),
      )
    : [];
  const categorized = hasStandup
    ? events.filter((event) => event.category === 'Stand-up')
    : [];
  const evidenced = hasStandup ? events.filter(hasPositiveStandupEvidence) : [];
  return [
    ...(candidates.length
      ? candidates
      : categorized.length
        ? categorized
        : evidenced.length
          ? evidenced
          : events),
  ].sort(eventOrder)[0];
}

function offersOf(event: EventRecord): EventOffer[] {
  if (event.offers?.length) return event.offers.map((offer) => ({ ...offer }));
  return [
    {
      id: event.id,
      source: event.source,
      url: event.url,
      price: event.price,
      currency: event.currency,
      ...(event.sourceSessionIds
        ? { sourceSessionIds: [...event.sourceSessionIds] }
        : {}),
      checkedAt: event.checkedAt,
      category: event.category,
      venue: event.venue,
      availability: event.availability,
    },
  ];
}

function uniqueOffers(events: EventRecord[]): EventOffer[] {
  const byId = new Map<string, EventOffer>();
  for (const event of events)
    for (const offer of offersOf(event)) {
      const current = byId.get(offer.id);
      if (
        !current ||
        offer.checkedAt > current.checkedAt ||
        (offer.checkedAt === current.checkedAt &&
          JSON.stringify(offer) < JSON.stringify(current))
      )
        byId.set(offer.id, offer);
    }
  return [...byId.values()].sort(
    (a, b) =>
      a.currency.localeCompare(b.currency) ||
      Number(a.price === null) - Number(b.price === null) ||
      (a.price ?? 0) - (b.price ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

function selectedOffer(
  offers: EventOffer[],
  representative: EventRecord,
): EventOffer {
  const selectable = offers.some((offer) => offer.availability === 'available')
    ? offers.filter((offer) => offer.availability === 'available')
    : offers;
  const preferred =
    selectable.find((offer) => offer.id === representative.id) ??
    selectable.find(
      (offer) =>
        offer.url === representative.url &&
        offer.currency === representative.currency &&
        offer.source === representative.source,
    ) ??
    selectable.find((offer) => offer.currency === representative.currency) ??
    selectable[0];
  const comparable = selectable.filter(
    (offer) =>
      offer.availability === preferred.availability &&
      offer.currency === preferred.currency &&
      offer.price !== null,
  );
  return (
    comparable.sort(
      (a, b) => a.price! - b.price! || a.id.localeCompare(b.id),
    )[0] ?? preferred
  );
}

function attendanceOf(events: EventRecord[]): AttendanceTiming | undefined {
  const explicit = events
    .map(({ attendanceTiming }) => attendanceTiming)
    .filter((value): value is AttendanceTiming => value !== undefined);
  if (!explicit.length)
    return events.some((event) => sourceTimeIsDoorsOnly(event.description))
      ? { kind: 'unknown', evidence: 'insufficient_source_evidence' }
      : undefined;
  const first = JSON.stringify(explicit[0]);
  return explicit.every((value) => JSON.stringify(value) === first)
    ? explicit[0]
    : { kind: 'unknown', evidence: 'insufficient_source_evidence' };
}

/** Projection compatibility only: the identity module has already fixed membership. */
function canonicalHash(kind: 'production' | 'show', value: unknown): string {
  return `${kind}-${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32)}`;
}

function projectResolvedSession(
  events: EventRecord[],
  sessionId: string,
  venueId: string,
): EventRecord {
  const ordered = [...events].sort(eventOrder);
  const representative = representativeOf(ordered);
  const addresses = new Map(
    ordered
      .filter((event) => event.address.trim())
      .map((event) => [normalizedEvidence(event.address), event.address]),
  );
  const offers = uniqueOffers(ordered);
  const offer = selectedOffer(offers, representative);
  const selectedSource = ordered.find(
    (event) =>
      event.id === offer.id &&
      event.source === offer.source &&
      event.url === offer.url,
  );
  const attendanceTiming = attendanceOf(ordered);
  const title = normalizeTitleKey(
    representative.title,
    representative.category,
  );
  const city = normalizeIdentityText(representative.city);
  const canonicalProductionKey = canonicalHash('production', [
    city,
    venueId,
    title.key,
  ]);
  const canonicalShowKey = canonicalHash('show', [
    city,
    title.category,
    title.key,
  ]);
  const mergedIds = new Set<string>([sessionId]);
  for (const event of ordered) {
    mergedIds.add(event.id);
    for (const id of event.mergedIds ?? []) mergedIds.add(id);
  }
  const {
    providerListing: _providerListing,
    sourceSessionIds: _representativeSessionIds,
    sourceCategory: _representativeSourceCategory,
    sourceVersion: _representativeSourceVersion,
    extraction: _representativeExtraction,
    ...publicRepresentative
  } = representative;
  return {
    ...publicRepresentative,
    address:
      representative.address ||
      (addresses.size === 1 ? [...addresses.values()][0] : ''),
    id:
      events.length === 1
        ? representative.id
        : `session-${sessionId.slice(0, 32)}`,
    source: offer.source,
    url: offer.url,
    price: offer.price,
    currency: offer.currency,
    availability: offer.availability,
    checkedAt: offer.checkedAt,
    ...(offer.sourceSessionIds
      ? { sourceSessionIds: [...offer.sourceSessionIds] }
      : {}),
    ...(selectedSource?.sourceCategory !== undefined
      ? { sourceCategory: selectedSource.sourceCategory }
      : {}),
    ...(selectedSource?.sourceVersion !== undefined
      ? { sourceVersion: selectedSource.sourceVersion }
      : {}),
    ...(selectedSource?.extraction !== undefined
      ? { extraction: selectedSource.extraction }
      : {}),
    offers,
    mergedIds: [...mergedIds].sort(),
    ...(attendanceTiming ? { attendanceTiming } : {}),
    canonicalProductionKey,
    canonicalShowKey,
  };
}

function identityFamilies(events: EventRecord[]): EventRecord[][] {
  const resolution = resolveEventRecordIdentity(events);
  const parent = new Map(events.map((event) => [event.id, event.id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    while (parent.get(id) !== id) {
      const next = parent.get(id)!;
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const union = (left: string, right: string) => {
    const a = find(left);
    const b = find(right);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  };
  for (const session of resolution.sessions)
    for (let index = 1; index < session.listingIds.length; index++)
      union(session.listingIds[0], session.listingIds[index]);
  for (const decision of resolution.decisions)
    if (
      decision.rule === 'policy-conflict' ||
      decision.rule.startsWith('graph-')
    )
      union(decision.listingIds[0], decision.listingIds[1]);
  const groups = new Map<string, EventRecord[]>();
  for (const event of events) {
    const root = find(event.id);
    const group = groups.get(root);
    if (group) group.push(event);
    else groups.set(root, [event]);
  }
  return [...groups.values()];
}

function ambiguousSourceEvidenceIds(events: EventRecord[]): Set<string> {
  const explicitConflicts = new Set(
    events
      .filter((event) =>
        hasExplicitDoorTimeStartConflict({
          description: event.description,
          startsAt: event.startsAt,
        }) ||
        hasExplicitSameEventSoldOutConflict(event) ||
        hasExplicitSameEventVenueConflict(event),
      )
      .map((event) => event.id),
  );
  if (!explicitConflicts.size) return explicitConflicts;
  const ambiguous = new Set(explicitConflicts);
  for (const session of resolveEventRecordIdentity(events).sessions)
    if (session.listingIds.some((id) => explicitConflicts.has(id)))
      for (const id of session.listingIds) ambiguous.add(id);
  return ambiguous;
}

/** Publication-time work only. Prepare every change in source eligibility so
 * requests never need to reconstruct identities or retain an expired offer. */
export function buildSearchCatalog(
  events: EventRecord[],
  at: Date,
): SearchCatalog {
  const eligible: EventRecord[] = [];
  const ambiguousEvidence = ambiguousSourceEvidenceIds(events);
  let projectionBytes = 0;
  for (const sourceEvent of events) {
    // Retained checkpoints can predate collector quarantine. When one source
    // proves a session time or availability conflict, sibling offers cannot
    // resolve that contradiction. Preserve every raw source record.
    if (ambiguousEvidence.has(sourceEvent.id)) continue;
    const verifiedCategory = categoryForEvent(
      sourceEvent.sourceCategory ?? sourceEvent.category,
      sourceEvent.title,
      sourceEvent.description,
    );
    // Correct retained records only when their own program evidence identifies
    // one of the narrowly verified formats supported by event-format.
    const event =
      ['Stand-up', 'Gezi'].includes(verifiedCategory) && sourceEvent.category !== verifiedCategory
        ? { ...sourceEvent, category: verifiedCategory }
        : sourceEvent;
    const checked = Date.parse(event.checkedAt);
    const activation = Math.max(at.getTime(), checked - 300000);
    if (
      !Number.isFinite(activation) ||
      !isEligible(event, emptyFilters, new Date(activation))
    )
      continue;
    eligible.push(event);
  }
  const groups = identityFamilies(eligible).map((members) => {
    const boundaries = new Set([at.getTime()]);
    for (const member of members) {
      const checked = Date.parse(member.checkedAt);
      for (const boundary of [
        checked - 300000,
        checked + 72 * 3600000 + 1,
        Date.parse(member.startsAt) + 1,
      ])
        if (boundary > at.getTime()) boundaries.add(boundary);
    }
    const versions: SearchCatalog['groups'][number]['versions'] = [];
    let previous = '';
    for (const from of [...boundaries].sort((a, b) => a - b)) {
      const active = members.filter((event) =>
        isEligible(event, emptyFilters, new Date(from)),
      );
      const resolution = resolveEventRecordIdentity(active);
      const byId = new Map(active.map((event) => [event.id, event]));
      const merged = resolution.sessions
        .map((session) =>
          projectResolvedSession(
            session.listingIds.map((id) => byId.get(id)!),
            session.id,
            session.venueId,
          ),
        )
        .map((event) => {
          const documentText = voyageDocumentText(event);
          return {
            ...event,
            ...(!event.attendanceTiming &&
            ['Müze', 'Sergi'].includes(event.category)
              ? {
                  attendanceTiming: {
                    kind: 'unknown' as const,
                    evidence: 'insufficient_source_evidence' as const,
                  },
                }
              : {}),
            preparedSearch: {
              version: 1 as const,
              documentText,
              documentHash: createHash('sha256')
                .update(documentText)
                .digest('hex'),
              lexicalTokens: prepareLexicalDocumentTokens(event),
              location: prepareEventLocation(event),
            },
          };
        });
      const serialized = JSON.stringify(merged);
      if (serialized !== previous) {
        projectionBytes += new TextEncoder().encode(serialized).byteLength + 64;
        if (projectionBytes > 128 * 1024 * 1024)
          throw new Error('Search catalog exceeds limit');
        versions.push({ from, events: merged });
      }
      previous = serialized;
    }
    return { versions };
  });
  return {
    schemaVersion: 1,
    materializedAt: at.toISOString(),
    groups,
    sourceStatus: events.map(({ startsAt, checkedAt, availability }) => ({
      startsAt,
      checkedAt,
      availability,
    })),
  };
}

/** Select precomputed sessions; hard filters remain request-specific. */
export function searchCatalogCandidates(
  catalog: SearchCatalog,
  filters: Filters,
  at: Date,
): EventRecord[] {
  const time = at.getTime();
  if (!Number.isFinite(time) || time < Date.parse(catalog.materializedAt))
    throw new Error('Search catalog predates requested time');
  return catalog.groups
    .flatMap(({ versions }) => {
      let selected: EventRecord[] = [];
      for (const version of versions) {
        if (version.from > time) break;
        selected = version.events;
      }
      return selected.filter((event) => isEligible(event, filters, at));
    })
    .sort(
      (a, b) =>
        a.startsAt.localeCompare(b.startsAt) ||
        (a.source ?? '').localeCompare(b.source ?? '') ||
        a.url.localeCompare(b.url) ||
        a.id.localeCompare(b.id),
    );
}
