import { createHash } from 'node:crypto';

import type { EventOffer, EventRecord } from './types.ts';

const VENUE_ALIASES = [
  ['Cafe Theatre', 'Cafe Theatre Koşuyolu'],
  ['Ada Bar Kadıköy', 'Ada Bar'],
  ['HoP Sahne', 'House of Performance - HoP'],
  ['Biletinial Torium Sahne', 'Torium Sahne'],
  ['Kartal Sanat Tiyatrosu', 'Kartal Sanat Tiyatro Salonu'],
  ['Maltepe Dragos Sahne', 'Sahne Dragos'],
  [
    'Watergarden Performans Merkezi Duru Tiyatro [Ataşehir]',
    'Duru Tiyatro Watergarden Performans Merkezi',
  ],
  ['İnal Aydınoğlu KM', 'İnal Aydınoğlu Kültür Merkezi'],
  [
    'Lütfi Kırdar Anadolu Auditorium',
    'İstanbul Lütfi Kirdar Anadolu Oditoryum Salonu',
  ],
  ['Paribu Vadi Açıkhava', 'Paribu Vadi Açık Hava'],
  ['Jolly Joker Kartal', 'Jolly Joker Kartal İstMarina'],
  // Matching Redd, Can Bonomo, Kalben and Gökhan Türkmen schedules;
  // the short-name source address is Watergarden AVM, Ataşehir.
  ['JJ Arena', 'JJ Arena Ataşehir'],
  ['AKM Türk Telekom Opera Salonu', 'Türk Telekom Opera Salonu'],
  ['Mall Of İstanbul Biletinial Moi Sahne', 'Mall of İstanbul MOİ Sahne'],
] as const;

// Reviewed against matching source schedules and descriptions (September 2026).
// These are literal show aliases, never a general performer/suffix heuristic.
const TITLE_ALIASES = [
  [
    'Kadıköy Açık Mikrofon Stand-up - Comedy Lab',
    'Kadıköy Açık Mikrofon Stand-up - Comedy Lab Istanbul',
  ],
  ['STAND UP GECESİ Taksim- Pera- Beyoğlu', 'Beyoğlu- Taksim- Stand Up Gecesi'],
  [
    'Stand up Taksim / Beyoğlu Gecesi | İnfiniti Sahne',
    'Stand Up Taksim / Beyoğlu Gecesi - Cuma 20:30',
    'Stand Up Taksim - Beyoğlu Gecesi - Cuma 20:30',
    'Stand Up Taksim / Beyoğlu Gecesi - Cuma 22:30',
    'Stand Up Taksim - Beyoğlu Gecesi - Cuma 22:30',
    'Stand Up Taksim / Beyoğlu Gecesi - Cumartesi 19:00',
    'Stand Up Taksim / Beyoğlu Gecesi - Cumartesi 20:30',
    'Stand Up Taksim / Beyoğlu Gecesi - Pazar 19:00',
    'Stand Up Taksim / Beyoğlu Gecesi - Pazar 20:30',
  ],
  [
    'Boğaziçi Komedi Kulübü: Kadıköy Açık Mikrofon Stand-up Gecesi',
    'Boğaziçi Komedi Kulübü - Kadıköy Açık Mikrofon Stand-up',
  ],
  ['Gökhan Ünver Stand Up', "Gökhan Ünver 'Çok Tanıdık'"],
  // Both providers list the same solo show at Vohu Sahne, Sep 26 at 22:00.
  ['Mustafa Boz - Tek Kişilik Stand Up', 'Mustafa Boz Stand Up'],
  ['Operadaki Hayalet', 'Operadaki Hayalet Tiyatro Oyunu'],
  // Same Taksim İstiklal Sahne schedules; Biletix/Biletinial descriptions
  // explicitly name the longer Bubilet title (September 2026 snapshot).
  ['Kütüphanedeki Ceset', 'Kütüphanedeki Ceset Tiyatro Oyunu'],
  ['Suç ve Ceza', 'Suç ve Ceza Oyunu'],
  [
    'Kadıköy Stand-up Gecesi',
    'Kadıköy Stand Up Gecesi Cuma 20:00',
    'Kadıköy Stand Up Gecesi Cuma 21:45',
    'Kadıköy Stand Up Gecesi Cumartesi 19:00',
    'Kadıköy Stand up Gecesi Pazar 19:00',
    'Kadıköy Stand Up Gecesi Çarşamba 20:30',
    'Kadıköy Stand up Gecesi Cumartesi 21:45',
  ],
] as const;

const GENERIC_VENUES = new Set([
  '',
  'istanbul',
  'cesitli mekanlar',
  'cesitli yerler',
  'mekan belli degil',
  'online',
]);

function normalize(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const venueAliases = new Map<string, string>();
for (const aliases of VENUE_ALIASES) {
  const canonical = normalize(aliases[0]);
  for (const alias of aliases) venueAliases.set(normalize(alias), canonical);
}
const titleAliases = new Map<string, string>();
for (const aliases of TITLE_ALIASES) {
  for (const alias of aliases)
    titleAliases.set(normalize(alias), normalize(aliases[0]));
}

/** Exact or explicitly reviewed show-title identity; never merges event facts. */
export function canonicalShowTitle(title: string): string {
  const normalized = normalize(title);
  const canonical = titleAliases.get(normalized) ?? normalized;
  // A trailing format label is not a show subtitle. Retain the complete named
  // remainder, including edition numbers; never reduce a title to a performer.
  const withoutFormat = canonical.replace(/\s+stand\s*up$/, '');
  return withoutFormat !== canonical && withoutFormat.split(' ').length >= 2
    ? withoutFormat
    : canonical;
}

function venueKey(venue: string): string {
  const normalized = normalize(venue);
  return venueAliases.get(normalized) ?? normalized;
}

function hash(kind: 'session' | 'production' | 'show', value: string): string {
  return `${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

function parsedInstant(startsAt: string): string | null {
  const timestamp = Date.parse(startsAt);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function identity(event: EventRecord): {
  title: string;
  city: string;
  venue: string;
  instant: string | null;
} {
  return {
    title: canonicalShowTitle(event.title),
    city: normalize(event.city),
    venue: venueKey(event.venue),
    instant: parsedInstant(event.startsAt),
  };
}

function eventOrder(a: EventRecord, b: EventRecord): number {
  return (
    (a.source ?? '').localeCompare(b.source ?? '') ||
    a.url.localeCompare(b.url) ||
    a.id.localeCompare(b.id)
  );
}

function hasPositiveStandupEvidence(event: EventRecord): boolean {
  const text = normalize(`${event.title} ${event.description}`);
  const pattern = /\bstand ?up\b/g;
  for (const match of text.matchAll(pattern)) {
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

function offersOf(event: EventRecord): EventOffer[] {
  if (event.offers?.length) return event.offers.map((offer) => ({ ...offer }));
  return [
    {
      id: event.id,
      source: event.source,
      url: event.url,
      price: event.price,
      currency: event.currency,
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

function selectRepresentative(events: EventRecord[]): EventRecord {
  const hasStandup = events.some(hasPositiveStandupEvidence);
  const evidencedAndCategorized = hasStandup
    ? events.filter(
        (event) =>
          event.category === 'Stand-up' && hasPositiveStandupEvidence(event),
      )
    : [];
  const categorizedStandup = hasStandup
    ? events.filter((event) => event.category === 'Stand-up')
    : [];
  const evidencedStandup = hasStandup
    ? events.filter(hasPositiveStandupEvidence)
    : [];
  return [
    ...(evidencedAndCategorized.length
      ? evidencedAndCategorized
      : categorizedStandup.length
        ? categorizedStandup
        : evidencedStandup.length
          ? evidencedStandup
          : events),
  ].sort(eventOrder)[0];
}

function selectOffer(
  offers: EventOffer[],
  representative: EventRecord,
): EventOffer {
  const preferred =
    offers.find((offer) => offer.id === representative.id) ??
    offers.find(
      (offer) =>
        offer.url === representative.url &&
        offer.currency === representative.currency &&
        offer.source === representative.source,
    ) ??
    offers.find((offer) => offer.currency === representative.currency) ??
    offers[0];
  const comparable = offers.filter(
    (offer) => offer.currency === preferred.currency && offer.price !== null,
  );
  return (
    comparable.sort(
      (a, b) => a.price! - b.price! || a.id.localeCompare(b.id),
    )[0] ?? preferred
  );
}

/** Conservatively combines listings that describe the exact same performance. */
export function mergeEventSessions(events: EventRecord[]): EventRecord[] {
  const groups = new Map<string, EventRecord[]>();
  for (const event of events) {
    const value = identity(event);
    // Invalid dates cannot establish equality. The raw id keeps these isolated.
    const hasSpecificVenue =
      value.venue.length > 0 && !GENERIC_VENUES.has(value.venue);
    const key =
      value.instant && value.title && value.city && hasSpecificVenue
        ? [value.title, value.city, value.venue, value.instant].join('\u001f')
        : `isolated\u001f${event.id}`;
    const group = groups.get(key);
    if (group) group.push(event);
    else groups.set(key, [event]);
  }

  return [...groups.entries()]
    .map(([key, members]) => {
      const ordered = [...members].sort(eventOrder);
      const representative = selectRepresentative(ordered);
      // A provider may omit the address even when another offer for this exact
      // session supplies it. Fill only an unambiguous missing address; never
      // replace conflicting source facts or embedding document fields.
      const addresses = new Map(
        ordered
          .filter((event) => event.address.trim())
          .map((event) => [normalize(event.address), event.address]),
      );
      const address =
        representative.address ||
        (addresses.size === 1 ? [...addresses.values()][0] : '');
      const offers = uniqueOffers(ordered);
      const offer = selectOffer(offers, representative);
      const value = identity(representative);
      const sessionId = hash('session', key);
      const rawIds = new Set<string>([sessionId]);
      for (const member of ordered) {
        rawIds.add(member.id);
        for (const id of member.mergedIds ?? []) rawIds.add(id);
      }
      const canonicalProductionKey =
        value.title &&
        value.city &&
        value.venue &&
        !GENERIC_VENUES.has(value.venue)
          ? hash(
              'production',
              [value.title, value.city, value.venue].join('\u001f'),
            )
          : undefined;
      const showIdentity = displayShowIdentity(representative);
      const canonicalShowKey = showIdentity
        ? hash('show', showIdentity)
        : undefined;
      return {
        ...representative,
        address,
        id: members.length === 1 ? representative.id : sessionId,
        source: offer.source,
        url: offer.url,
        price: offer.price,
        currency: offer.currency,
        checkedAt: offer.checkedAt,
        offers,
        mergedIds: [...rawIds].sort(),
        ...(canonicalProductionKey ? { canonicalProductionKey } : {}),
        ...(canonicalShowKey ? { canonicalShowKey } : {}),
      };
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || eventOrder(a, b));
}

const GENERIC_SHOW_TITLES = new Set([
  'etkinlik',
  'konser',
  'tiyatro',
  'stand up',
  'komedi',
  'acik mikrofon',
  'open mic',
]);

/** Stable display identity for clear show titles; generic listings stay distinct. */
export function displayShowIdentity(event: EventRecord): string | undefined {
  const title = canonicalShowTitle(event.title);
  if (!title || GENERIC_SHOW_TITLES.has(title)) return undefined;
  return [normalize(event.city), event.category, title].join('\u001f');
}
