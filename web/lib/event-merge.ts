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
  [
    'STAND UP GECESİ Taksim- Pera- Beyoğlu',
    'Beyoğlu- Taksim- Stand Up Gecesi',
    'Stand Up Gecesi - Taksim & Beyoğlu',
    'Beyoğlu- Taksim- Pera Stand Up Gecesi',
  ],
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
  // Biletinial/Bubilet list the same Altı Üstü Kabare show and matching
  // October 2–3, 2026 sessions; preserve both offers on each matched session.
  ['Çiftler Çiftler', 'Çiftler Çiftler Oyunu'],
  // Exact same-session provider spellings observed in the September 28, 2026
  // staging checkpoint. Keep these literal: suffix/reordering heuristics can
  // incorrectly combine adaptations, editions, workshops, or age variants.
  ['Sesler - Salih Bademci', 'Salih Bademci - Sesler'],
  ['Tek Hücreliler - Aşkım Kapışmak', 'Aşkım Kapışmak - Tek Hücreliler'],
  ['Memleket Kumaşı – Sunay Akın', 'Sunay Akın - Memleket Kumaşı'],
  [
    'Aleksandrov Rus Kızılordu Korosu ve Dans Topluluğu İle Hayko Cepkin Konserleri',
    'Aleksandrov Rus Kızılordu Korosu ve Dans Topluluğu İle Hayko Cepkin',
  ],
  ['Bir İdam Mahkumunun Son Günü', 'Bir İdam Mahkumunun Son Günü Oyunu'],
  [
    'Kasımpaşa Mevlevihanesi Semazen Töreni',
    "Kasımpaşa Mevlevihanesi'nde Semazen Töreni",
  ],
  [
    "Ölü'n Bizi Ayırana Dek",
    'Ölün Bizi Ayırana Dek',
    'Ölü’n Bizi Ayırana Dek',
    "Ölü'n Bizi Ayırana Dek Oyunu",
  ],
  ['Mahşer-i Cümbüş', 'Mahşer-i Cümbüş Oyunu'],
  ['Haybeden Gerçeküstü Aşk', 'Haybeden Gerçeküstü Aşk Oyunu'],
  ['Aşk Hikayen Düşmüş', 'Aşk Hikayen Düşmüş Oyunu'],
  ['Bi Şaka Stand up Programı', 'Bi Şaka Stand Up'],
  [
    'Fırat Tanış ile Gelin Tanış Olalım',
    'Fırat Tanış ile Gelin Tanış Olalım Oyunu',
  ],
  ['Anna Karenina', 'Anna Karenina Tiyatro Oyunu'],
  ['Berkay Konseri', 'Berkay'],
  ['Ozbi Konseri', 'Ozbi'],
  ['Kolpa', 'Kolpa Konseri'],
  ['Duman Konseri', 'Duman'],
  ['Simge', 'Simge Konseri'],
  ['Mavi', 'Mavi Konseri'],
  ['Jakuzi', 'Jakuzi Konseri'],
  ['Malleus', 'Malleus Oyunu'],
  ['Ahududu', 'Ahududu Oyunu'],
  // Both frozen providers list the same Sep 25 Sahne Beşiktaş recording.
  ['Alpay Erdem - Geçenlerde', 'Alpay Erdem - Geçenlerde Stand Up'],
  [
    'Kadıköy Stand-up Gecesi',
    'Kadıköy Stand Up Gecesi Cuma 20:00',
    'Kadıköy Stand Up Gecesi Cuma 21:45',
    'Kadıköy Stand Up Gecesi Cumartesi 19:00',
    'Kadıköy Stand up Gecesi Pazar 19:00',
    'Kadıköy Stand Up Gecesi Çarşamba 20:30',
    'Kadıköy Stand up Gecesi Cumartesi 21:45',
  ],
  [
    'Kadıköy Stand Up Gecesi Açık Mikrofon',
    'Kadıköy Stand Up Gecesi Pazartesi Açık Mikrofon',
    'Kadıköy Stand Up Gecesi Salı Açık Mikrofon',
  ],
  [
    "Hikayeden Adamlar 'Mahalle' - Youtube Çekimi - 3.sezon",
    'Hikayeden Adamlar - Mahalle - Youtube Çekimi',
  ],
  [
    'XI. Gastromasa Istanbul Uluslararası Gastronomi Konferansı & Fuarı',
    'Gastromasa İstanbul Uluslararası Gastronomi Konferansı & Fuarı',
  ],
  [
    'Burak Altuni Akustik Flamenko Konser',
    'Burak Altuni Akustik Flamenko Konseri',
  ],
  [
    'Benyunusyılmaz - Olay Yeri İnceleme Stand Up',
    'Yunus Yılmaz - Olay Yeri İnceleme Stand Up',
  ],
  ['Lumera Trio Sezen Aksu Şarkıları', 'Lumera - Sezen Aksu Şarkıları'],
  [
    "Celile (Nazım Hikmet'in Annesi) Oyunu",
    "Celile (Nazım Hikmet'in Annesi)",
  ],
  [
    'Çocuklar İçin Yaratıcı Drama Eğitimi',
    'Çocuklar için Yaratıcı Drama Eğitim',
  ],
  ['Güncel Gürsel Artıktay Konseri', 'Güncel Gürsel Artıktay'],
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

// Source-reviewed September 2026 identity. These broad workshop titles are
// aliases only at the verified Fabrikafa/İstanbul Workshops location.
const FABRIKAFA_PROGRAMS = [
  ['hat', 'İstanbul Workshops Hat Sanatı Atölyesi', 'Hat Sanatı Atölyesi', 'Pirinç Çerçeveli Cam Üzerine Hat/Kaligrafi Sanatı Atölyesi'],
  ['tezhip', 'İstanbul Workshops Tezhip Atölyesi', 'Tezhip Atölyesi'],
  ['cini', 'İstanbul Workshops Çini Atölyesi', 'Çini Atölyesi', 'Türk Çini Resim Sanatı Atölyesi'],
  ['vitray', 'İstanbul Workshops Vitray Atölyesi', 'Vitray Atölyesi'],
  ['parfum', 'İstanbul Workshops Parfüm Atölyesi', 'Parfüm Atölyesi', 'Parfüm Tasarımı Atölyesi'],
  ['deri', 'İstanbul Workshops Deri İşçiliği Atölyesi', 'Deri İşçiliği Atölyesi'],
  ['ebru', 'İstanbul Workshops Ebru ile Bez Çanta Tasarım Atölyesi', 'Ebru Bez Çanta Sanat Atölyesi', 'Ebru ile Bez Çanta Tasarım Atölyesi'],
] as const;
const fabrikafaPrograms = new Map<string, string>();
for (const [program, ...titles] of FABRIKAFA_PROGRAMS)
  for (const title of titles) fabrikafaPrograms.set(normalize(title), program);
const FABRIKAFA_ADDRESS = normalize('Aziz Mahmut Hüdayi, Gülfem Sk. No:15, 34672 Üsküdar/İstanbul');
const FABRIKAFA_BARE_VENUE = normalize('İstanbul Workshops');
const FABRIKAFA_NAMED_VENUES = new Set([
  normalize('İstanbul Workshops - Fabrikafa Make & Coffee'),
  normalize('Fabrikafa Make & Coffee'),
]);
const FABRIKAFA_DISTRICTS = new Set(['', normalize('Üsküdar'), normalize('İstanbul Anadolu')]);
const FABRIKAFA_VENUE_KEY = 'reviewed:fabrikafa-make-and-coffee';

const REVIEWED_WORKSHOP_VENUES = [
  {
    key: 'reviewed:bagimsiz-sanat-vakfi',
    program: 'mozaik-lamba',
    venue: normalize('Bağımsız Sanat Vakfı'),
    address: normalize('Hobyar, Ankara Cd. No;3, 34110 Fatih/İstanbul'),
    districts: new Set(['', normalize('Fatih'), normalize('İstanbul Avrupa')]),
    prefixedTitle: normalize('İstanbul Workshops Mozaik Lamba Atölyesi'),
    genericTitle: undefined,
    titles: new Set([
      normalize('İstanbul Workshops Mozaik Lamba Atölyesi'),
      normalize('Mozaik Lamba Atölyesi'),
    ]),
  },
  {
    key: 'reviewed:atolye-sahi',
    program: 'seramik-tek-seans',
    venue: normalize('Atölye Sahi'),
    address: normalize('Aziz Mahmut Hüdayi Caddesi, Gülfem Sk. No:17A, 34762 Üsküdar/İstanbul'),
    districts: new Set(['', normalize('Üsküdar'), normalize('İstanbul Anadolu')]),
    prefixedTitle: normalize('İstanbul Workshops Seramik Atölyesi (Tek Seans Workshop)'),
    genericTitle: normalize('Seramik Atölyesi'),
    titles: new Set([
      normalize('İstanbul Workshops Seramik Atölyesi (Tek Seans Workshop)'),
      normalize('Seramik Atölyesi ( Tek Seans Workshop )'),
      normalize('Seramik Atölyesi'),
    ]),
  },
] as const;

function fabrikafaProgram(event: EventRecord): string | undefined {
  if (event.category !== 'Workshop' || normalize(event.city) !== 'istanbul')
    return undefined;
  const program = fabrikafaPrograms.get(normalize(event.title));
  if (!program) return undefined;
  const venue = normalize(event.venue);
  const address = normalize(event.address);
  const district = normalize(event.district);
  if (!FABRIKAFA_DISTRICTS.has(district)) return undefined;
  if (venue === FABRIKAFA_BARE_VENUE)
    return address === FABRIKAFA_ADDRESS ? program : undefined;
  if (!FABRIKAFA_NAMED_VENUES.has(venue)) return undefined;
  return !address || address === FABRIKAFA_ADDRESS ? program : undefined;
}

function reviewedWorkshopIdentity(event: EventRecord): { title: string; venue: string } | undefined {
  const fabrikafa = fabrikafaProgram(event);
  if (fabrikafa)
    return {
      title: `reviewed:fabrikafa-program:${fabrikafa}`,
      venue: FABRIKAFA_VENUE_KEY,
    };
  if (event.category !== 'Workshop' || normalize(event.city) !== 'istanbul')
    return undefined;
  const title = normalize(event.title);
  const venue = normalize(event.venue);
  const address = normalize(event.address);
  const district = normalize(event.district);
  for (const reviewed of REVIEWED_WORKSHOP_VENUES) {
    if (
      venue !== reviewed.venue ||
      !reviewed.titles.has(title) ||
      !reviewed.districts.has(district) ||
      (address && address !== reviewed.address) ||
      (title === reviewed.prefixedTitle && address !== reviewed.address) ||
      (reviewed.genericTitle === title &&
        (!/\bseramik workshop tek oturumluk deneyim\b/.test(normalize(event.description)) ||
          /\baylik kurs\b/.test(normalize(event.description))))
    ) continue;
    return {
      title: `${reviewed.key}:program:${reviewed.program}`,
      venue: reviewed.key,
    };
  }
  return undefined;
}

function identityTitle(event: EventRecord): string {
  return reviewedWorkshopIdentity(event)?.title ?? canonicalShowTitle(event.title);
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
  return titleAliases.get(normalized) ?? normalized;
}

type StrongPolicy =
  | 'child-only'
  | 'adult-only'
  | 'workshop'
  | 'performance'
  | `adaptation:${string}`;

function strongPolicies(event: EventRecord): Set<StrongPolicy> {
  const raw = `${event.title} ${event.description}`
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i');
  const text = normalize(`${event.title} ${event.description}`);
  const title = normalize(event.title);
  const result = new Set<StrongPolicy>();
  const childRange = [...text.matchAll(/\b(\d{1,2})\s+(?:ile\s+)?(\d{1,2})\s*yas\b/g)]
    .some((match) => Number(match[2]) <= 17);
  if (
    childRange ||
    /\b(?:yalnizca|sadece)\s+cocuklar\s+icin\b/.test(text) ||
    /\bcocuklara\s+ozel\b/.test(text)
  ) result.add('child-only');
  if (
    /\b18\s*\+/.test(raw) ||
    /\b18\s*yas\s+alti\s+(?:giremez|kabul edilmez)\b/.test(text) ||
    /\b(?:yalnizca|sadece)\s+yetiskinler\s+icin\b/.test(text) ||
    /\byetiskinlere\s+ozel\b/.test(text)
  ) result.add('adult-only');
  if (
    /\b(?:atolye|workshop)(?:si|u)?\b/.test(title) ||
    /\buygulamali\b[^.!?\n]{0,32}\b(?:atolye|workshop)\s+calismasi\b/.test(text)
  )
    result.add('workshop');
  if (
    /\b(?:tiyatro\s+oyunu|canli\s+konser)\b/.test(title) ||
    /\bcanli\s+sahne\s+gosterisidir\b/.test(text)
  )
    result.add('performance');
  const adaptation = /\buyarlama\s*:\s*([^.;\n]{1,60})/.exec(raw)?.[1]?.trim();
  if (adaptation) result.add(`adaptation:${adaptation}`);
  return result;
}

function conflictingPolicyDimension(members: EventRecord[]):
  | ['audience', StrongPolicy, StrongPolicy]
  | ['format', StrongPolicy, StrongPolicy]
  | null {
  const policies = members.map(strongPolicies);
  if (policies.some((set) => set.has('child-only')) && policies.some((set) => set.has('adult-only')))
    return ['audience', 'child-only', 'adult-only'];
  if (policies.some((set) => set.has('workshop')) && policies.some((set) => set.has('performance')))
    return ['format', 'workshop', 'performance'];
  const adaptations = [...new Set(policies.flatMap((set) => [...set].filter((value) => value.startsWith('adaptation:'))))];
  if (adaptations.length > 1) return ['format', adaptations[0], adaptations[1]];
  return null;
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
  const reviewed = reviewedWorkshopIdentity(event);
  return {
    title: reviewed?.title ?? canonicalShowTitle(event.title),
    city: normalize(event.city),
    venue: reviewed?.venue ?? venueKey(event.venue),
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
      ...(event.sourceSessionIds ? { sourceSessionIds: [...event.sourceSessionIds] } : {}),
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
  // A merged card is purchasable when at least one provider explicitly says
  // this exact session is available. Unknown, sold-out, and cancelled prices
  // remain visible in `offers`, but never undercut an available card price.
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

/** Conservatively combines listings that describe the exact same performance. */
export function mergeEventSessions(events: EventRecord[]): EventRecord[] {
  const candidateGroups = new Map<string, EventRecord[]>();
  for (const event of events) {
    const value = identity(event);
    // Invalid dates cannot establish equality. The raw id keeps these isolated.
    const hasSpecificVenue =
      value.venue.length > 0 && !GENERIC_VENUES.has(value.venue);
    const key =
      value.instant && value.title && value.city && hasSpecificVenue
        ? [value.title, value.city, value.venue, value.instant].join('\u001f')
        : `isolated\u001f${event.id}`;
    const group = candidateGroups.get(key);
    if (group) group.push(event);
    else candidateGroups.set(key, [event]);
  }

  const groups = new Map<string, EventRecord[]>();
  for (const [key, members] of candidateGroups) {
    const conflict = conflictingPolicyDimension(members);
    for (const member of members) {
      const policies = strongPolicies(member);
      const policy = conflict
        ? policies.has(conflict[1])
          ? conflict[1]
          : policies.has(conflict[2])
            ? conflict[2]
            : `unspecified-${member.id}`
        : 'compatible';
      const guardedKey = conflict ? `${key}\u001f${conflict[0]}:${policy}` : key;
      const guarded = groups.get(guardedKey);
      if (guarded) guarded.push(member);
      else groups.set(guardedKey, [member]);
    }
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
              [
                value.title,
                value.city,
                value.venue,
                [...strongPolicies(representative)].sort().join('|'),
              ].join('\u001f'),
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
        availability: offer.availability,
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
  const title = identityTitle(event);
  if (!title || GENERIC_SHOW_TITLES.has(title)) return undefined;
  const policy = [...strongPolicies(event)].sort().join('|');
  return [normalize(event.city), event.category, title, policy].join('\u001f');
}
