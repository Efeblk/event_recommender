import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { mergeEventSessions } from '../lib/event-merge.ts';
import {
  buildSearchCatalog,
  searchCatalogCandidates,
} from '../lib/materialized-catalog.ts';
import { isEligible } from '../lib/search.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';
import { voyageDocumentText } from '../lib/voyage.ts';

const publishedAt = new Date('2026-09-29T12:00:00.000Z');
const expiry = Date.parse('2026-09-30T12:00:00.000Z');
function event(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'biletinial:1',
    title: 'Ortak Oyun',
    description: 'Bir tiyatro gösterisi.',
    startsAt: '2026-10-02T17:00:00.000Z',
    venue: 'Örnek Sahne',
    city: 'İstanbul',
    district: 'Kadıköy',
    address: 'Örnek adres',
    price: 500,
    currency: 'TRY',
    url: 'https://biletinial.example/1',
    imageUrl: '',
    category: 'Tiyatro',
    availability: 'available',
    source: 'biletinial',
    checkedAt: '2026-09-27T12:00:00.000Z',
    ...overrides,
  };
}
function later(overrides: Partial<EventRecord> = {}): EventRecord {
  return event({
    id: 'bubilet:2',
    source: 'bubilet',
    url: 'https://bubilet.example/2',
    checkedAt: publishedAt.toISOString(),
    ...overrides,
  });
}
function expected(events: EventRecord[], at: Date) {
  return sourceRecords(
    mergeEventSessions(
      events.filter((entry) => isEligible(entry, emptyFilters, at)),
    ),
  );
}
function sourceRecords(events: EventRecord[]) {
  return events.map((entry) => {
    const event = { ...entry };
    delete event.preparedSearch;
    delete event.canonicalProductionKey;
    delete event.canonicalShowKey;
    delete event.mergedIds;
    // Phase 2 intentionally replaces legacy derived identity IDs. Compare the
    // projected source facts and offers here; identity invariants have their
    // own frozen held-out suite.
    event.id =
      event.offers
        ?.map(({ id }) => id)
        .sort()
        .join('|') || event.id;
    return event;
  });
}

await test('preparation marks unclassified admission times unknown without changing embedding input', () => {
  const raw = event({ category: 'Müze', title: 'Müze girişi' });
  const prepared = searchCatalogCandidates(
    buildSearchCatalog([raw], publishedAt),
    emptyFilters,
    publishedAt,
  )[0];
  assert.deepEqual(prepared.attendanceTiming, {
    kind: 'unknown',
    evidence: 'insufficient_source_evidence',
  });
  assert.equal(prepared.preparedSearch?.documentText, voyageDocumentText(raw));
  assert.equal(raw.attendanceTiming, undefined);
});

await test('materialized offers expire individually at the exact inclusive freshness boundary', () => {
  const old = event({ price: 100 });
  const fresh = later({ price: 600 });
  const raw = [old, fresh];
  const original = structuredClone(raw);
  const snapshot = buildSearchCatalog(raw, publishedAt);
  for (const instant of [
    publishedAt.getTime(),
    expiry - 1,
    expiry,
    expiry + 1,
  ]) {
    const at = new Date(instant);
    assert.deepEqual(
      sourceRecords(searchCatalogCandidates(snapshot, emptyFilters, at)),
      expected(raw, at),
    );
  }
  const atBoundary = searchCatalogCandidates(
    snapshot,
    emptyFilters,
    new Date(expiry),
  );
  assert.equal(atBoundary[0].offers?.length, 2);
  assert.equal(atBoundary[0].price, 100);
  const after = searchCatalogCandidates(
    snapshot,
    emptyFilters,
    new Date(expiry + 1),
  );
  assert.deepEqual(
    after[0].offers?.map(({ id }) => id),
    [fresh.id],
  );
  assert.equal(after[0].price, 600);
  assert.equal(after[0].url, fresh.url);
  assert.deepEqual(
    searchCatalogCandidates(
      snapshot,
      { ...emptyFilters, maxPrice: 200 },
      new Date(expiry + 1),
    ),
    [],
  );
  assert.deepEqual(
    raw,
    original,
    'publication must preserve raw checkpoint records',
  );
});

await test('expiry recombines previously conflicting policy groups within the full identity family', () => {
  const adult = event({ description: 'Yalnızca yetişkinler için.' });
  const child = later({ description: 'Sadece çocuklar için.' });
  const unspecified = later({
    id: 'biletix:3',
    source: 'biletinial',
    url: 'https://biletix.example/3',
  });
  const raw = [adult, child, unspecified];
  const snapshot = buildSearchCatalog(raw, publishedAt);
  const initial = searchCatalogCandidates(snapshot, emptyFilters, publishedAt);
  assert.equal(initial.length, 3);
  assert.deepEqual(
    new Set(initial.map(({ id }) => id)),
    new Set(raw.map(({ id }) => id)),
  );
  const after = searchCatalogCandidates(
    snapshot,
    emptyFilters,
    new Date(expiry + 1),
  );
  assert.equal(after.length, 1);
  assert.deepEqual(
    new Set(after[0].offers?.map(({ id }) => id)),
    new Set([child.id, unspecified.id]),
  );
  assert.deepEqual(sourceRecords(after), expected(raw, new Date(expiry + 1)));
});

await test('publication preserves distinct sessions and expires started performances', () => {
  const raw = [event(), later({ startsAt: '2026-10-02T19:00:00.000Z' })];
  const snapshot = buildSearchCatalog(raw, publishedAt);
  const cards = searchCatalogCandidates(snapshot, emptyFilters, publishedAt);
  assert.equal(cards.length, 2);
  assert.deepEqual(
    new Set(cards.map(({ startsAt }) => startsAt)),
    new Set(raw.map(({ startsAt }) => startsAt)),
  );
  const near = event({
    checkedAt: publishedAt.toISOString(),
    startsAt: '2026-09-29T13:00:00.000Z',
  });
  const shortSnapshot = buildSearchCatalog([near], publishedAt);
  assert.equal(
    searchCatalogCandidates(
      shortSnapshot,
      emptyFilters,
      new Date(near.startsAt),
    ).length,
    1,
  );
  assert.deepEqual(
    searchCatalogCandidates(
      shortSnapshot,
      emptyFilters,
      new Date(Date.parse(near.startsAt) + 1),
    ),
    [],
  );
});

await test('active representative keeps exact embedding document text as offers expire', () => {
  const old = event({ description: 'İlk kaynağın açıklaması.' });
  const fresh = later({ description: 'İkinci kaynağın açıklaması.' });
  const snapshot = buildSearchCatalog([old, fresh], publishedAt);
  const initial = searchCatalogCandidates(
    snapshot,
    emptyFilters,
    publishedAt,
  )[0];
  assert.equal(voyageDocumentText(initial), voyageDocumentText(old));
  assert.equal(initial.preparedSearch?.documentText, voyageDocumentText(old));
  assert.equal(
    initial.preparedSearch?.documentHash,
    createHash('sha256').update(voyageDocumentText(old)).digest('hex'),
  );
  const after = searchCatalogCandidates(
    snapshot,
    emptyFilters,
    new Date(expiry + 1),
  )[0];
  assert.equal(voyageDocumentText(after), voyageDocumentText(fresh));
  assert.equal(after.preparedSearch?.documentText, voyageDocumentText(fresh));
  assert.equal(
    after.preparedSearch?.documentHash,
    createHash('sha256').update(voyageDocumentText(fresh)).digest('hex'),
  );
  assert.notEqual(voyageDocumentText(initial), voyageDocumentText(after));
});

await test('publication merges concert suffix aliases without rewriting cached document text', () => {
  const plain = event({
    title: 'Halil Sezai',
    category: 'Konser',
    venue: 'Dorock XL',
    description: 'Kaynak A açıklaması.',
  });
  const suffixed = later({
    title: 'Halil Sezai Konseri',
    category: 'Konser',
    venue: 'Dorock XL Kadıköy',
    description: 'Kaynak B açıklaması.',
  });
  const snapshot = buildSearchCatalog([plain, suffixed], publishedAt);
  const cards = searchCatalogCandidates(snapshot, emptyFilters, publishedAt);
  assert.equal(cards.length, 1);
  assert.deepEqual(
    new Set(cards[0].offers?.map(({ id }) => id)),
    new Set([plain.id, suffixed.id]),
  );
  assert.equal(
    cards[0].preparedSearch?.documentText,
    voyageDocumentText(plain),
  );
  assert.equal(
    cards[0].preparedSearch?.documentHash,
    createHash('sha256').update(voyageDocumentText(plain)).digest('hex'),
  );
});

await test('publication merges basic venue spelling without a venue alias', () => {
  const biletix = event({
    id: '008ade89067cc8ac265d9c80',
    source: 'biletix',
    title: 'Serkan Dilik ile Stand-up Show',
    category: 'Stand-up',
    venue: 'Milena Pub & Bistro',
    district: 'BEYOĞLU',
    address: '',
  });
  const bubilet = later({
    id: '2b6b093070e797e77dd41e27',
    source: 'bubilet',
    title: 'Serkan Dilik ile Stand-up Show',
    category: 'Stand-up',
    venue: 'Milena Pub&Bistro',
    district: '',
    address: 'Kuloğlu, Sadri Alışık Sk. No:24/A, 34443 Beyoğlu/İstanbul',
  });
  const cards = searchCatalogCandidates(
    buildSearchCatalog([biletix, bubilet], publishedAt),
    emptyFilters,
    publishedAt,
  );
  assert.equal(cards.length, 1);
  assert.deepEqual(
    new Set(cards[0].offers?.map(({ id }) => id)),
    new Set([biletix.id, bubilet.id]),
  );
});

await test('selected offer provenance follows the source used for public price and URL', () => {
  const representative = event({
    id: 'representative',
    price: 500,
    sourceSessionIds: ['representative-session'],
    sourceCategory: 'provider-theatre',
    sourceVersion: 'representative-version',
    extraction: 'representative-extractor',
  });
  const cheapest = later({
    id: 'cheapest',
    price: 200,
    sourceSessionIds: ['cheapest-session'],
    sourceCategory: 'provider-stage',
    sourceVersion: 'cheapest-version',
    extraction: 'cheapest-extractor',
  });
  const [card] = searchCatalogCandidates(
    buildSearchCatalog([representative, cheapest], publishedAt),
    emptyFilters,
    publishedAt,
  );
  assert.equal(card.source, cheapest.source);
  assert.equal(card.url, cheapest.url);
  assert.equal(card.price, cheapest.price);
  assert.deepEqual(card.sourceSessionIds, cheapest.sourceSessionIds);
  assert.equal(card.sourceCategory, cheapest.sourceCategory);
  assert.equal(card.sourceVersion, cheapest.sourceVersion);
  assert.equal(card.extraction, cheapest.extraction);
});

await test('provider listing evidence maps full listing IDs back to compatibility event IDs', () => {
  const fullA = 'a'.repeat(64);
  const fullB = 'b'.repeat(64);
  const first = {
    ...event({ id: fullA.slice(0, 24) }),
    providerListing: {
      listingId: fullA,
      provider: 'biletinial',
      providerSessionIds: ['a'],
      url: 'https://biletinial.example/1',
      title: 'Ortak Oyun',
      description: '',
      category: 'Tiyatro',
      startsAt: '2026-10-02T17:00:00.000Z',
      city: 'İstanbul',
      venue: {
        name: 'Örnek Sahne',
        district: 'Kadıköy',
        geo: { lat: 40.99, lon: 29.03 },
      },
    },
  } as unknown as EventRecord;
  const second = {
    ...later({ id: fullB.slice(0, 24) }),
    providerListing: {
      listingId: fullB,
      provider: 'bubilet',
      providerSessionIds: ['b'],
      url: 'https://bubilet.example/2',
      title: 'Ortak Oyun Tiyatro Oyunu',
      description: '',
      category: 'Tiyatro',
      startsAt: '2026-10-02T17:00:00.000Z',
      city: 'İstanbul',
      venue: {
        name: 'Örnek Sahne',
        district: 'Kadıköy',
        geo: { lat: 40.9901, lon: 29.0301 },
      },
    },
  } as unknown as EventRecord;
  const cards = searchCatalogCandidates(
    buildSearchCatalog([first, second], publishedAt),
    emptyFilters,
    publishedAt,
  );
  assert.equal(cards.length, 1);
  assert.deepEqual(
    new Set(cards[0].offers?.map(({ id }) => id)),
    new Set([first.id, second.id]),
  );
  assert.equal(cards[0].providerListing, undefined);
});

await test('publication keeps exact-time same-title events at different resolved venues separate', () => {
  const jj = event({
    id: 'bfaaf535d4276e32b5faed27',
    source: 'biletinial',
    title: 'Cem Adrian',
    category: 'Konser',
    venue: 'JJ Arena Ataşehir',
    district: 'İstanbul Anadolu',
  });
  const ykb = later({
    id: '571eb4388743a46c1171de3c',
    source: 'bubilet',
    title: 'Cem Adrian Konseri',
    category: 'Konser',
    venue: 'Yahya Kemal Beyatlı Gösteri Merkezi',
    district: '',
    address:
      'Halkalı Merkez, Aytaç Mevkii, Fatih Cd., 34295 Küçükçekmece/İstanbul',
  });
  const cards = searchCatalogCandidates(
    buildSearchCatalog([jj, ykb], publishedAt),
    emptyFilters,
    publishedAt,
  );
  assert.equal(cards.length, 2);
  assert.ok(cards.every((card) => card.offers?.length === 1));
});

await test('publication never puts two offers from one provider on a card', () => {
  const first = event({ id: 'provider-a', source: 'biletix' });
  const bridge = later({ id: 'provider-b', source: 'bubilet' });
  const repeated = event({
    id: 'provider-c',
    source: 'biletix',
    url: 'https://biletix.example/c',
  });
  const cards = searchCatalogCandidates(
    buildSearchCatalog([first, bridge, repeated], publishedAt),
    emptyFilters,
    publishedAt,
  );
  assert.equal(cards.length, 2);
  for (const card of cards) {
    const providers = card.offers?.map(({ source }) => source) ?? [];
    assert.equal(new Set(providers).size, providers.length);
  }
});

await test('stand-up evidence still selects the stand-up representative', () => {
  const misc = event({
    id: 'misc',
    source: 'biletinial',
    title: 'Ortak Gösteri',
    description: 'Canlı stand up gösterisi.',
    category: 'Diğer',
  });
  const standup = later({
    id: 'standup',
    source: 'bubilet',
    title: 'Ortak Gösteri',
    description: 'Canlı stand up gösterisi.',
    category: 'Stand-up',
  });
  const [card] = searchCatalogCandidates(
    buildSearchCatalog([misc, standup], publishedAt),
    emptyFilters,
    publishedAt,
  );
  assert.equal(card.category, 'Stand-up');
  assert.equal(card.id.startsWith('session-'), true);
});

await test('preparation repairs an explicit standalone stand-up programme retained under provider theatre', () => {
  const raw = event({
    id: '05228453b7825732516d760d',
    title: "Tuz Biber 6'lı",
    description:
      "Tuz Biber 6'lı Stand Up Gösterisi TuzBiber’in en iyi komedyenlerinin 15’er dakika sahne aldığı TuzBiber 6’lı şovu; JJ Pub Kanyon’da!",
    sourceCategory: 'tiyatro',
    category: 'Tiyatro',
  });
  const snapshot = buildSearchCatalog([raw], publishedAt);
  const standup = searchCatalogCandidates(
    snapshot,
    { ...emptyFilters, category: 'Stand-up' },
    publishedAt,
  );
  assert.equal(standup.length, 1);
  assert.equal(standup[0].category, 'Stand-up');
  assert.deepEqual(
    searchCatalogCandidates(
      snapshot,
      { ...emptyFilters, category: 'Tiyatro' },
      publishedAt,
    ),
    [],
  );
});

await test('preparation repairs an explicitly guided multi-stop programme retained under provider exhibition', () => {
  const raw = event({
    id: 'ca408fe5e6629129c4e70c2b',
    title: "Katedralde Noel Şarkıları ile İstanbul'da Noel",
    description: "Program boyunca farklı cemaatlere ait kiliseleri ziyaret edecek, yapıların tarihini Antonina'nın uzman rehberlerinden dinleyeceğiz. Tur boyunca özel araçla ulaşım sağlanır. Günün sonunda özel Noel Şarkıları Konseri'ne katılacağız.",
    sourceCategory: 'Sergi',
    category: 'Sergi',
  });
  const snapshot = buildSearchCatalog([raw], publishedAt);
  const tours = searchCatalogCandidates(snapshot, { ...emptyFilters, category: 'Gezi' }, publishedAt);
  assert.equal(tours.length, 1);
  assert.equal(tours[0].category, 'Gezi');
  assert.deepEqual(searchCatalogCandidates(snapshot, { ...emptyFilters, category: 'Sergi' }, publishedAt), []);
});

await test('preparation excludes the retained Tuz Biber session that uses its explicit door time', () => {
  const raw = event({
    id: '05228453b7825732516d760d',
    title: "Tuz Biber 6'lı",
    description:
      "Tuz Biber 6'lı Stand Up Gösterisi; JJ Pub Kanyon'da! Kapı Açılış Saati: 20:00 Etkinlik Başlangıç Saati: 20:30",
    startsAt: '2026-10-05T17:00:00.000Z',
    source: 'biletinial',
    sourceCategory: 'tiyatro',
    category: 'Tiyatro',
  });
  const snapshot = buildSearchCatalog([raw], publishedAt);
  assert.deepEqual(
    searchCatalogCandidates(snapshot, emptyFilters, publishedAt),
    [],
  );
  assert.deepEqual(snapshot.sourceStatus, [
    {
      startsAt: raw.startsAt,
      checkedAt: raw.checkedAt,
      availability: raw.availability,
    },
  ]);
});

await test('preparation excludes every proven Duman session source when one identifies the shared clock as doors', () => {
  const startsAt = '2026-11-28T18:00:00.000Z';
  const biletix = event({
    id: '0358b5ae3f20c887fe482616',
    title: 'Duman',
    description:
      'Duman, 28 Kasım akşamı JJ Arena Ataşehir sahnesinde sizlerle! Kapı Açılış saati 21:00, etkinlik başlangıç: 22:00',
    startsAt,
    venue: 'JJ Arena Ataşehir',
    source: 'biletix',
    url: 'https://www.biletix.com/etkinlik/5TX82/ISTANBUL/tr',
    sourceCategory: 'Rock',
    category: 'Konser',
  });
  const biletinial = event({
    id: '0430d73663a0e9bdb2268b9f',
    title: 'Duman Konseri',
    description:
      'Duman Konseri Etkinlik genelinde geçerli olan kurallara ek olarak, seanslara özgü ek düzenlemeler de yapılmıştır.',
    startsAt,
    venue: 'JJ Arena Ataşehir',
    source: 'biletinial',
    url: 'https://biletinial.com/tr-tr/muzik/duman-jj',
    sourceCategory: 'muzik',
    category: 'Konser',
  });
  const bubilet = event({
    id: '889c16ac85fc66eb3968cb05',
    title: 'Duman',
    description: 'Duman',
    startsAt,
    venue: 'JJ Arena',
    source: 'bubilet',
    url: 'https://www.bubilet.com.tr/istanbul/etkinlik/duman--',
    sourceCategory: 'Konser',
    category: 'Konser',
  });
  const unrelated = event({ id: 'unrelated-session' });
  const snapshot = buildSearchCatalog(
    [biletix, biletinial, bubilet, unrelated],
    publishedAt,
  );
  assert.deepEqual(
    searchCatalogCandidates(snapshot, emptyFilters, publishedAt).map(
      ({id}) => id,
    ),
    [unrelated.id],
  );
  assert.equal(snapshot.sourceStatus.length, 4);
});

await test('preparation excludes the retained Çilekeş offer whose same-date venue text says sold out', () => {
  const description =
    "Çilekeş Konseri ÇİLEKEŞ’TEN İZMİR VE ANKARA’YA İKİ YENİ KONSER Türkiye alternatif rock sahnesinin en özgün ve öncü gruplarından Çilekeş’in, ‘Y.O.K’ albümünün 21. yılına özel olarak yıllar sonra yeniden sahnelere döneceğini duyurmasının ardından 10 Ekim'de KüçükÇiftlik Park’ta gerçekleşecek İstanbul konserinin biletleri kısa sürede tükendi. Yoğun ilgi üzerine grup şimdi de İzmir ve Ankara konserlerini açıklıyor.";
  const raw = event({
    id: 'ab93fbf448a3d369d94bd3b3',
    title: 'Çilekeş',
    description,
    startsAt: '2026-10-10T19:00:00.000Z',
    venue: 'KüçükÇiftlik Park',
    city: 'İstanbul',
    district: 'İstanbul Avrupa',
    price: 2950,
    source: 'biletinial',
    url: 'https://biletinial.com/tr-tr/muzik/cilekes',
    sourceCategory: 'muzik',
    category: 'Konser',
  });
  const unrelated = event({id: 'unrelated-after-sold-out-conflict'});
  const snapshot = buildSearchCatalog([raw, unrelated], publishedAt);
  assert.deepEqual(
    searchCatalogCandidates(snapshot, emptyFilters, publishedAt).map(({id}) => id),
    [unrelated.id],
  );
  assert.equal(snapshot.sourceStatus.length, 2);

  const otherDate = buildSearchCatalog(
    [{...raw, id: 'later-cilekes', startsAt: '2026-11-10T19:00:00.000Z'}],
    publishedAt,
  );
  assert.equal(searchCatalogCandidates(otherDate, emptyFilters, publishedAt).length, 1);
  const otherVenue = buildSearchCatalog(
    [{...raw, id: 'other-venue-cilekes', venue: 'Başka Sahne'}],
    publishedAt,
  );
  assert.equal(searchCatalogCandidates(otherVenue, emptyFilters, publishedAt).length, 1);
});

await test('future clock-skewed source activates when it enters the five-minute allowance', () => {
  const future = event({ checkedAt: '2026-09-29T12:06:00.000Z' });
  const snapshot = buildSearchCatalog([future], publishedAt);
  assert.deepEqual(
    searchCatalogCandidates(snapshot, emptyFilters, publishedAt),
    [],
  );
  const activation = new Date('2026-09-29T12:01:00.000Z');
  assert.deepEqual(
    sourceRecords(searchCatalogCandidates(snapshot, emptyFilters, activation)),
    expected([future], activation),
  );
  assert.equal(
    searchCatalogCandidates(snapshot, emptyFilters, activation).length,
    1,
  );
});

await test('materialized catalog fails closed for requests before its publication time', () => {
  const snapshot = buildSearchCatalog([event()], publishedAt);
  assert.throws(() =>
    searchCatalogCandidates(
      snapshot,
      emptyFilters,
      new Date(publishedAt.getTime() - 1),
    ),
  );
});
