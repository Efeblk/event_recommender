import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeEventSessions } from '../lib/event-merge.ts';
import { diverseEvents } from '../lib/retrieval.ts';
import { uniqueEvents } from '../lib/search.ts';
import type { EventRecord } from '../lib/types.ts';

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'biletinial:1',
    title: 'Edepsiz Komedi',
    description: 'Metin Zakoğlu ile stand-up gösterisi',
    startsAt: '2026-10-10T17:00:00.000Z',
    venue: 'Cafe Theatre',
    city: 'İstanbul',
    district: 'Kadıköy',
    address: 'Adres',
    price: 500,
    currency: 'TRY',
    url: 'https://biletinial.example/1',
    imageUrl: 'https://images.example/1.jpg',
    category: 'Stand-up',
    availability: 'available',
    source: 'biletinial',
    productionKey: 'existing-source-production',
    checkedAt: '2026-09-23T09:00:00.000Z',
    ...overrides,
  };
}

await test('reviewed Kütüphanedeki Ceset titles combine offers only for the same session', () => {
  const base = event({
    title: 'Kütüphanedeki Ceset',
    venue: 'Taksim İstiklal Sahne',
    category: 'Tiyatro',
    description: 'Sude Naz Demirci uyarlaması, Funda Bayraktaroğlu oyunculuğu.',
    price: 336,
  });
  const alias = event({
    ...base,
    id: 'bubilet:ceset',
    source: 'bubilet',
    title: 'Kütüphanedeki Ceset Tiyatro Oyunu',
    url: 'https://bubilet.example/ceset',
    price: 300,
  });
  const merged = mergeEventSessions([base, alias]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].price, 300);
  assert.equal(merged[0].offers?.length, 2);
  for (const different of [
    { ...alias, startsAt: '2026-10-10T19:00:00.000Z' },
    { ...alias, venue: 'Başka Sahne' },
    { ...alias, title: 'Kütüphanedeki Ceset - Başka Uyarlama' },
  ])
    assert.equal(mergeEventSessions([base, different]).length, 2);
});

await test('reviewed Çiftler Çiftler alias preserves offers without merging different sessions or adaptations', () => {
  const first = event({
    title: 'Çiftler Çiftler',
    description: 'Çiftler Çiftler Tiyatro Oyunu, Altı Üstü Kabare.',
    category: 'Tiyatro',
    venue: 'Altı Üstü Kabare',
    startsAt: '2026-10-02T17:30:00.000Z',
    price: 850,
  });
  const second = event({
    ...first,
    id: 'bubilet:ciftler',
    source: 'bubilet',
    title: 'Çiftler Çiftler Oyunu',
    url: 'https://bubilet.example/ciftler',
    price: 900,
  });
  const merged = mergeEventSessions([first, second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].price, 850);
  assert.deepEqual(
    new Set(merged[0].offers?.map(({ url }) => url)),
    new Set([first.url, second.url]),
  );
  assert.ok(merged[0].mergedIds?.includes(first.id));
  assert.ok(merged[0].mergedIds?.includes(second.id));
  for (const other of [
    { ...second, startsAt: '2026-10-03T17:30:00.000Z' },
    { ...second, venue: 'Başka Sahne' },
    { ...second, title: 'Çiftler Çiftler - Başka Uyarlama' },
  ])
    assert.equal(mergeEventSessions([first, other]).length, 2);
});

await test('merges the screenshot category and curated venue conflict', () => {
  const result = mergeEventSessions([
    event({ category: 'Tiyatro', description: 'Metin Zakoğlu gösterisi' }),
    event({
      id: 'bubilet:9',
      source: 'bubilet',
      category: 'Stand-up',
      venue: 'Cafe Theatre Koşuyolu',
      price: 350,
      url: 'https://bubilet.example/9',
    }),
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].category, 'Stand-up');
  assert.equal(result[0].price, 350);
  assert.equal(result[0].url, 'https://bubilet.example/9');
  assert.equal(result[0].source, 'bubilet');
  assert.equal(result[0].offers?.length, 2);
  assert.ok(result[0].mergedIds?.includes('biletinial:1'));
  assert.ok(result[0].mergedIds?.includes('bubilet:9'));
  assert.equal(result[0].productionKey, 'existing-source-production');
});

await test('JJ Arena aliases retain the cheaper Redd offer without merging another venue or session', () => {
  const first = event({
    title: 'Redd Konseri',
    venue: 'JJ Arena Ataşehir',
    category: 'Konser',
    price: 1605,
  });
  const second = event({
    ...first,
    id: 'bubilet:redd',
    source: 'bubilet',
    venue: 'JJ Arena',
    price: 3420,
    url: 'https://bubilet.example/redd',
    address: 'Watergarden AVM, Ataşehir/İstanbul',
  });
  const merged = mergeEventSessions([first, second]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].price, 1605);
  assert.equal(merged[0].offers?.length, 2);
  for (const different of [
    { ...second, venue: 'Jolly Joker Kartal' },
    { ...second, startsAt: '2026-10-11T17:00:00.000Z' },
  ])
    assert.equal(mergeEventSessions([first, different]).length, 2);
});

await test('requires exact normalized title, city, venue identity and instant', () => {
  const base = event();
  const cases = [
    event({ id: 'title', title: 'Edepsiz Komedi 2' }),
    event({ id: 'city', city: 'Ankara' }),
    event({ id: 'venue', venue: 'Cafe Theatre Beşiktaş' }),
    event({ id: 'time', startsAt: '2026-10-10T17:01:00.000Z' }),
  ];
  assert.equal(mergeEventSessions([base, ...cases]).length, 5);
});

await test('normalizes Turkish accents and punctuation but not words', () => {
  const result = mergeEventSessions([
    event({ title: 'Şımarık: Gösteri!' }),
    event({ id: 'two', title: 'simarik gosteri' }),
  ]);
  assert.equal(result.length, 1);
});

await test('is independent of input order and idempotent', () => {
  const input = [event(), event({ id: 'two', source: 'bubilet', price: 400 })];
  const forward = mergeEventSessions(input);
  const reverse = mergeEventSessions([...input].reverse());
  assert.deepEqual(forward, reverse);
  assert.deepEqual(mergeEventSessions(forward), forward);
  assert.ok(forward[0].id.startsWith('session-'));
  assert.ok(forward[0].id.length <= 100);
});

await test('keeps singleton id and includes canonical session and raw ids', () => {
  const result = mergeEventSessions([event()])[0];
  assert.equal(result.id, 'biletinial:1');
  assert.ok(result.mergedIds?.includes('biletinial:1'));
  assert.ok(result.mergedIds?.some((id) => id.startsWith('session-')));
  assert.ok(result.canonicalProductionKey?.startsWith('production-'));
});

await test('does not derive a production key for generic venues', () => {
  const generic = event({ venue: 'Çeşitli Mekanlar' });
  assert.equal(
    mergeEventSessions([generic])[0].canonicalProductionKey,
    undefined,
  );
  assert.equal(
    mergeEventSessions([
      generic,
      event({ id: 'other', venue: 'Çeşitli Mekanlar' }),
    ]).length,
    2,
  );
  assert.equal(
    mergeEventSessions([
      event({ id: 'invalid-a', startsAt: 'not-a-date' }),
      event({ id: 'invalid-b', startsAt: 'not-a-date' }),
    ]).length,
    2,
  );
});

await test('does not compare prices in different currencies', () => {
  const result = mergeEventSessions([
    event({ id: 'a', currency: 'USD', price: 100, url: 'https://example/a' }),
    event({ id: 'b', currency: 'TRY', price: 1, url: 'https://example/b' }),
  ])[0];
  assert.equal(result.currency, 'USD');
  assert.equal(result.price, 100);
  assert.equal(result.url, 'https://example/a');
  assert.deepEqual(result.offers?.map((offer) => offer.currency).sort(), [
    'TRY',
    'USD',
  ]);
});

await test('keeps unknown prices and separate offers for separate sessions', () => {
  const result = mergeEventSessions([
    event({ id: 'a', price: null }),
    event({ id: 'b', source: 'bubilet', price: null }),
    event({ id: 'later', startsAt: '2026-10-11T17:00:00.000Z', price: 10 }),
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].price, null);
  assert.deepEqual(
    result.map((item) => item.offers?.length),
    [2, 1],
  );
});

await test('an available provider controls merged availability and price over an unknown representative', () => {
  const unknown = event({
    id: 'biletinial:unknown',
    availability: 'unknown',
    price: 100,
  });
  const available = event({
    id: 'biletix:available',
    source: 'biletix',
    availability: 'available',
    price: 600,
    url: 'https://biletix.example/available',
  });
  const [merged] = mergeEventSessions([unknown, available]);
  assert.equal(merged.availability, 'available');
  assert.equal(merged.price, 600);
  assert.equal(merged.url, available.url);
  assert.deepEqual(
    new Set(merged.offers?.map(({ id, availability: status, price }) => `${id}|${status}|${price}`)),
    new Set([
      'biletinial:unknown|unknown|100',
      'biletix:available|available|600',
    ]),
  );
});

await test('unavailable offer prices cannot undercut available offers and no-available groups stay unavailable', () => {
  const mixed = mergeEventSessions([
    event({ id: 'cancelled', availability: 'cancelled', price: 10 }),
    event({ id: 'sold-out', source: 'biletix', availability: 'sold_out', price: 20 }),
    event({ id: 'available-high', source: 'bubilet', availability: 'available', price: 300 }),
    event({ id: 'available-low', source: 'biletix', availability: 'available', price: 250 }),
  ])[0];
  assert.equal(mixed.availability, 'available');
  assert.equal(mixed.price, 250);
  assert.equal(mixed.offers?.length, 4);

  const noAvailable = mergeEventSessions([
    event({ id: 'unknown', availability: 'unknown', price: 500 }),
    event({ id: 'sold-out-cheap', source: 'biletix', availability: 'sold_out', price: 1 }),
    event({ id: 'cancelled-cheapest', source: 'bubilet', availability: 'cancelled', price: 0 }),
  ])[0];
  assert.equal(noAvailable.availability, 'unknown');
  assert.equal(noAvailable.price, 500);
  assert.equal(noAvailable.offers?.length, 3);
});

await test('supports every curated venue alias without fuzzy stage matching', () => {
  const aliases = [
    ['HoP Sahne', 'House of Performance - HoP'],
    ['Biletinial Torium Sahne', 'Torium Sahne'],
    ['Kartal Sanat Tiyatrosu', 'Kartal Sanat Tiyatro Salonu'],
    ['Maltepe Dragos Sahne', 'Sahne Dragos'],
    ['İnal Aydınoğlu KM', 'İnal Aydınoğlu Kültür Merkezi'],
    ['Paribu Vadi Açıkhava', 'Paribu Vadi Açık Hava'],
  ];
  for (const [left, right] of aliases)
    assert.equal(
      mergeEventSessions([
        event({ venue: left }),
        event({ id: right, venue: right }),
      ]).length,
      1,
    );
  assert.equal(
    mergeEventSessions([
      event({ venue: 'Zorlu PSM Turkcell Sahnesi' }),
      event({ id: 'other', venue: 'Zorlu PSM Platinum Sahnesi' }),
    ]).length,
    2,
  );
});

await test('does not infer stand-up from generic comedy or negated text', () => {
  const result = mergeEventSessions([
    event({ id: 'a', category: 'Tiyatro', description: 'Komedi oyunu' }),
    event({
      id: 'b',
      category: 'Stand-up',
      description: 'Bu bir stand-up değil, komedi oyunudur',
    }),
  ])[0];
  assert.equal(result.category, 'Tiyatro');
});

await test('keeps conflicting source facts attached to each ticket offer', () => {
  const merged = mergeEventSessions([
    event(),
    event({
      id: 'other',
      source: 'biletix',
      venue: 'Cafe Theatre Koşuyolu',
      category: 'Tiyatro',
      price: 672,
    }),
  ])[0];
  const offer = merged.offers!.find((item) => item.id === 'other')!;
  assert.equal(offer.category, 'Tiyatro');
  assert.equal(offer.venue, 'Cafe Theatre Koşuyolu');
  assert.equal(offer.availability, 'available');
});

await test('reviewed show aliases merge only at the same venue and session', () => {
  const first = event({ title: 'Gökhan Ünver Stand Up', venue: 'HOP Sahne' });
  const named = event({
    id: 'named',
    title: "Gökhan Ünver 'Çok Tanıdık'",
    venue: 'House of Performance - HoP',
    source: 'bubilet',
  });
  assert.equal(mergeEventSessions([first, named]).length, 1);
  assert.equal(
    mergeEventSessions([
      first,
      { ...named, startsAt: '2026-10-10T18:00:00.000Z' },
    ]).length,
    2,
  );
  assert.equal(
    mergeEventSessions([
      first,
      { ...named, title: 'Gökhan Ünver Yeni Gösteri' },
    ]).length,
    2,
  );
  assert.equal(
    mergeEventSessions([first, { ...named, venue: 'Trump Sahne' }]).length,
    2,
  );
  assert.equal(
    mergeEventSessions([
      event({ title: 'Operadaki Hayalet' }),
      event({ id: 'play', title: 'Operadaki Hayalet Tiyatro Oyunu' }),
    ]).length,
    1,
  );
});

await test('reviewed Suç ve Ceza suffix alias merges exact catalog sessions only', () => {
  const biletix = event({
    id: '98dd52290e64683e89e14c45',
    title: 'Suç Ve Ceza',
    description: 'Suç Ve Ceza, sizlerle...',
    startsAt: '2026-09-24T14:10:00.000Z',
    venue: 'Taksim İstiklal Sahne',
    district: 'BEYOĞLU',
    price: 252,
    source: 'biletix',
    url: 'https://www.biletix.com/etkinlik/5R188/ISTANBUL/tr',
  });
  const bubilet = event({
    id: '7ab5ed5f8635e313f404c0e7',
    title: 'Suç ve Ceza Oyunu',
    description: 'Suç ve Ceza',
    startsAt: '2026-09-24T14:10:00.000Z',
    venue: 'Taksim İstiklal Sahne',
    district: '',
    price: 200,
    source: 'bubilet',
    url: 'https://www.bubilet.com.tr/istanbul/etkinlik/suc-ve-ceza-',
  });

  const mergedResult = mergeEventSessions([biletix, bubilet]);
  const [merged] = mergedResult;
  assert.equal(merged.offers?.length, 2);
  assert.equal(merged.price, 200);
  assert.equal(merged.id.startsWith('session-'), true);
  assert.ok(merged.canonicalProductionKey?.startsWith('production-'));
  assert.ok(merged.canonicalShowKey?.startsWith('show-'));
  assert.ok(merged.mergedIds?.includes(biletix.id));
  assert.ok(merged.mergedIds?.includes(bubilet.id));
  assert.deepEqual(mergeEventSessions([bubilet, biletix]), mergedResult);
  assert.deepEqual(mergeEventSessions(mergedResult), mergedResult);

  assert.equal(
    mergeEventSessions([
      biletix,
      { ...bubilet, id: 'later', startsAt: '2026-09-27T15:15:00.000Z' },
    ]).length,
    2,
  );
  assert.equal(
    mergeEventSessions([
      biletix,
      { ...bubilet, id: 'other-venue', venue: 'Bakırköy Butik Sahne' },
    ]).length,
    2,
  );
  assert.equal(
    mergeEventSessions([
      biletix,
      { ...bubilet, id: 'adaptation', title: 'Suç ve Ceza: Başka Bir Oyun' },
    ]).length,
    2,
  );
});

await test('reviewed Boğaziçi open-mic titles merge only at the same venue and session', () => {
  const biletinial = event({
    id: 'bogazici-biletinial',
    title: 'Boğaziçi Komedi Kulübü: Kadıköy Açık Mikrofon Stand-up Gecesi',
    venue: 'Dunia Kadıköy',
    startsAt: '2026-09-24T17:00:00Z',
    source: 'biletinial',
  });
  const bubilet = event({
    id: 'bogazici-bubilet',
    title: 'Boğaziçi Komedi Kulübü - Kadıköy Açık Mikrofon Stand-up',
    venue: 'Dunia Kadıköy',
    startsAt: '2026-09-24T17:00:00Z',
    source: 'bubilet',
  });
  const later = event({
    ...bubilet,
    id: 'bogazici-later',
    startsAt: '2026-09-24T19:00:00Z',
  });
  const otherVenue = event({
    ...bubilet,
    id: 'bogazici-other-venue',
    venue: 'Başka Sahne',
  });
  const merged = mergeEventSessions([biletinial, bubilet, later, otherVenue]);
  assert.equal(merged.length, 3);
  assert.deepEqual(
    new Set(
      merged.find((event) => event.mergedIds?.includes(biletinial.id))
        ?.mergedIds,
    ),
    new Set([
      biletinial.id,
      bubilet.id,
      merged.find((event) => event.mergedIds?.includes(biletinial.id))!.id,
    ]),
  );
});

await test('reviewed Taksim show schedule aliases merge exact sessions and share one show identity', () => {
  const generic = 'Stand up Taksim / Beyoğlu Gecesi | İnfiniti Sahne';
  const friday = '2026-09-25T17:30:00.000Z';
  const sundayEarly = '2026-09-27T16:00:00.000Z';
  const sundayLate = '2026-09-27T17:30:00.000Z';
  const records = [
    event({ id: 'fri-generic', title: generic, startsAt: friday }),
    event({
      id: 'fri-bubilet',
      title: 'Stand Up Taksim / Beyoğlu Gecesi - Cuma 20:30',
      startsAt: friday,
      source: 'bubilet',
    }),
    event({
      id: 'fri-biletix',
      title: 'Stand Up Taksim - Beyoğlu Gecesi - Cuma 20:30',
      startsAt: friday,
      source: 'biletix',
    }),
    event({ id: 'sun-early-generic', title: generic, startsAt: sundayEarly }),
    event({
      id: 'sun-early-bubilet',
      title: 'Stand Up Taksim / Beyoğlu Gecesi - Pazar 19:00',
      startsAt: sundayEarly,
      source: 'bubilet',
    }),
    event({ id: 'sun-late-generic', title: generic, startsAt: sundayLate }),
    event({
      id: 'sun-late-bubilet',
      title: 'Stand Up Taksim / Beyoğlu Gecesi - Pazar 20:30',
      startsAt: sundayLate,
      source: 'bubilet',
    }),
    event({
      id: 'baris-duo',
      title: 'Stand up - Barış Balkır ve Zafer Erbil İkili',
      startsAt: sundayEarly,
    }),
  ].map((item) => ({ ...item, venue: 'İnfiniti Sahne' }));
  const merged = mergeEventSessions(records);
  assert.equal(merged.length, 4);
  assert.deepEqual(
    merged
      .filter((item) => item.title !== records.at(-1)!.title)
      .map((item) => item.offers?.length)
      .sort((a, b) => (a ?? 0) - (b ?? 0)),
    [2, 2, 3],
  );
  assert.equal(
    new Set(
      merged
        .filter((item) => item.title !== records.at(-1)!.title)
        .map((item) => item.canonicalShowKey),
    ).size,
    1,
  );
  assert.notEqual(
    merged.find((item) => item.title === records.at(-1)!.title)
      ?.canonicalShowKey,
    merged.find((item) => item.title !== records.at(-1)!.title)
      ?.canonicalShowKey,
  );
});

await test('reviewed Efsahne titles merge offers and retain a separate show identity', () => {
  const biletinial = event({
    id: 'efsahne-biletinial',
    title: 'STAND UP GECESİ Taksim- Pera- Beyoğlu',
    venue: 'Efsahne Beyoğlu',
    startsAt: '2026-09-25T17:30:00.000Z',
    price: 250,
    source: 'biletinial',
  });
  const bubilet = event({
    id: 'efsahne-bubilet',
    title: 'Beyoğlu- Taksim- Stand Up Gecesi',
    venue: 'Efsahne Beyoğlu',
    startsAt: '2026-09-25T17:30:00.000Z',
    price: 300,
    source: 'bubilet',
  });
  const later = event({
    ...bubilet,
    id: 'efsahne-later',
    startsAt: '2026-10-02T17:30:00.000Z',
  });
  const infiniti = event({
    id: 'infiniti',
    title: 'Stand up Taksim / Beyoğlu Gecesi | İnfiniti Sahne',
    venue: 'İnfiniti Sahne',
    startsAt: '2026-09-25T17:30:00.000Z',
  });
  const merged = mergeEventSessions([biletinial, bubilet, later, infiniti]);
  assert.equal(merged.length, 3);
  const exact = merged.find((item) => item.mergedIds?.includes(biletinial.id))!;
  const laterSession = merged.find((item) => item.id === later.id)!;
  const infinitiSession = merged.find((item) => item.id === infiniti.id)!;
  assert.equal(exact.offers?.length, 2);
  assert.equal(exact.price, 250);
  assert.equal(exact.canonicalShowKey, laterSession.canonicalShowKey);
  assert.notEqual(exact.canonicalShowKey, infinitiSession.canonicalShowKey);
});

await test('reviewed Efsahne Biletix title merges only the exact Bubilet session', () => {
  const biletix = event({
    id: '54af6e50c2cbcde862624d66',
    title: 'Stand Up Gecesi - Taksim & Beyoğlu',
    description: "Taksim Stand Up Gecesi, Efsahne Beyoğlu'nda sizlerle..",
    venue: 'Efsahne Beyoğlu',
    startsAt: '2026-10-03T16:00:00.000Z',
    price: null,
    source: 'biletix',
    url: 'https://www.biletix.com/etkinlik/5MM82/ISTANBUL/tr',
  });
  const bubilet = event({
    ...biletix,
    id: 'a67d713db54596e4818c947f',
    title: 'Beyoğlu- Taksim- Stand Up Gecesi',
    description: 'Beyoğlu- Taksim- Stand Up Gecesi',
    price: 250,
    source: 'bubilet',
    url: 'https://www.bubilet.com.tr/istanbul/etkinlik/beyoglu-taksim-stand-up-gecesi',
  });

  const merged = mergeEventSessions([biletix, bubilet]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].price, 250);
  assert.deepEqual(
    new Set(merged[0].offers?.map((offer) => offer.url)),
    new Set([biletix.url, bubilet.url]),
  );
  assert.ok(merged[0].mergedIds?.includes(biletix.id));
  assert.ok(merged[0].mergedIds?.includes(bubilet.id));

  for (const different of [
    { ...bubilet, startsAt: '2026-10-03T17:30:00.000Z' },
    { ...bubilet, venue: 'İnfiniti Sahne' },
    { ...bubilet, title: 'Beyoğlu Açık Mikrofon Stand Up Gecesi' },
  ])
    assert.equal(mergeEventSessions([biletix, different]).length, 2);
});

await test('fills a missing address only from consistent exact-session source facts', () => {
  const primary = event({ address: '' });
  const secondary = event({
    id: 'bubilet:2',
    source: 'bubilet',
    address: 'Kadıköy/İstanbul',
  });
  const filled = mergeEventSessions([primary, secondary])[0];
  assert.equal(filled.address, secondary.address);
  assert.equal(filled.description, primary.description);
  assert.equal(filled.venue, primary.venue);
  assert.equal(
    mergeEventSessions([
      primary,
      secondary,
      event({
        id: 'biletix:3',
        source: 'biletix',
        address: 'Üsküdar/İstanbul',
      }),
    ])[0].address,
    '',
  );
  assert.equal(
    mergeEventSessions([event({ address: 'Original' }), secondary])[0].address,
    'Original',
  );
});

await test('reviewed Mustafa Boz titles merge only the same venue and session', () => {
  const solo = event({
    title: 'Mustafa Boz - Tek Kişilik Stand Up',
    venue: 'Vohu Sahne',
    startsAt: '2026-09-26T19:00:00.000Z',
    price: 200,
  });
  const shorter = event({
    id: 'bubilet:mustafa',
    source: 'bubilet',
    title: 'Mustafa Boz Stand Up',
    venue: solo.venue,
    startsAt: solo.startsAt,
    price: 200,
  });
  const merged = mergeEventSessions([solo, shorter]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].offers?.length, 2);
  assert.equal(merged[0].price, 200);
  for (const distinct of [
    { ...shorter, startsAt: '2026-09-26T20:00:00.000Z' },
    { ...shorter, venue: 'Başka Sahne' },
    { ...shorter, title: 'Mustafa Boz - Yeni Gösteri Stand Up' },
  ])
    assert.equal(mergeEventSessions([solo, distinct]).length, 2);
});

await test('reviewed Ada Bar schedule titles merge only at the same performance time', () => {
  const base = event({
    title: 'Kadıköy Stand-up Gecesi',
    venue: 'Ada Bar Kadıköy',
  });
  const schedule = event({
    id: 'bubilet:ada',
    source: 'bubilet',
    title: 'Kadıköy Stand up Gecesi Cumartesi 21:45',
    venue: 'Ada Bar',
    price: 300,
  });
  const same = mergeEventSessions([base, schedule]);
  assert.equal(same.length, 1);
  assert.equal(same[0].offers?.length, 2);
  assert.equal(same[0].price, 300);
  assert.equal(
    mergeEventSessions([
      base,
      { ...schedule, startsAt: '2026-10-10T19:00:00Z' },
    ]).length,
    2,
  );
  assert.equal(
    mergeEventSessions([
      base,
      { ...schedule, title: 'Kadıköy Stand Up Gecesi Açık Mikrofon' },
    ]).length,
    2,
  );
});

await test('reviewed trailing stand-up alias merges while preserving editions and times', () => {
  const merged = mergeEventSessions([
    event({ id: 'a', title: 'Alpay Erdem - Geçenlerde Stand Up' }),
    event({
      id: 'b',
      title: 'Alpay Erdem - Geçenlerde',
      source: 'bubilet',
      url: 'https://bubilet.example/b',
    }),
    event({ id: 'c', title: 'Alpay Erdem - Başka Bir Gösteri Stand Up' }),
    event({
      id: 'd',
      title: 'Alpay Erdem - Geçenlerde',
      startsAt: '2026-10-11T17:00:00.000Z',
    }),
    event({ id: 'e', title: 'Yunus Emre Gündüz 4. Gösteri Stand-up' }),
    event({ id: 'f', title: 'Yunus Emre Gündüz 5. Gösteri Stand-up' }),
  ]);
  assert.equal(merged.length, 5);
  assert.equal(
    merged.find((e) => e.mergedIds?.includes('a'))?.offers?.length,
    2,
  );
  assert.notEqual(
    merged.find((e) => e.mergedIds?.includes('e'))?.canonicalShowKey,
    merged.find((e) => e.mergedIds?.includes('f'))?.canonicalShowKey,
  );
});

await test('does not strip unreviewed trailing stand-up labels into another title', () => {
  const plain = event({ id: 'plain', title: 'Deneysel Gösteri' });
  const standup = event({ id: 'standup', title: 'Deneysel Gösteri Stand Up' });
  assert.equal(mergeEventSessions([plain, standup]).length, 2);
});

await test('separates contradictory explicit child-only and adult-only policies', () => {
  const childOnly = event({
    id: 'child-only',
    title: 'Seramik Atölyesi',
    description: 'Yalnızca 6-9 yaş çocuklar için uygulamalı atölye çalışması.',
    category: 'Atölye',
  });
  const adultsOnly = event({
    id: 'adult-only',
    title: childOnly.title,
    description: 'Yalnızca yetişkinler için, 18+ uygulamalı atölye çalışması.',
    category: 'Atölye',
  });
  assert.equal(mergeEventSessions([childOnly, adultsOnly]).length, 2);
  const source18Plus = event({
    ...adultsOnly,
    id: 'source-18-plus',
    description: '18+ uygulamalı atölye çalışması.',
  });
  assert.equal(mergeEventSessions([childOnly, source18Plus]).length, 2);

  const general = event({
    id: 'general',
    title: 'Gece Gösterisi',
    description: 'Genel etkinlik açıklaması.',
  });
  const adultRestriction = event({
    ...general,
    id: 'adult-restriction',
    description: '18+ yaş sınırı vardır.',
    source: 'bubilet',
  });
  assert.equal(mergeEventSessions([general, adultRestriction]).length, 1);
});

await test('separates an explicit workshop from an explicit stage performance', () => {
  const workshop = event({ id: 'workshop-policy', title: 'Birlikte Üretim', description: 'Uygulamalı workshop çalışması.' });
  const performance = event({ id: 'performance-policy', title: workshop.title, description: 'Canlı sahne gösterisidir.' });
  assert.equal(mergeEventSessions([workshop, performance]).length, 2);
});

await test('separates explicitly named conflicting adaptations', () => {
  const first = event({ id: 'first-adaptation', title: 'Ortak Hikâye', description: 'Uyarlama: Ayşe Yılmaz.' });
  const second = event({ id: 'second-adaptation', title: first.title, description: 'Uyarlama: Mehmet Demir.' });
  const split = mergeEventSessions([first, second]);
  assert.equal(split.length, 2);
  assert.notEqual(split[0].canonicalProductionKey, split[1].canonicalProductionKey);
  assert.notEqual(split[0].canonicalShowKey, split[1].canonicalShowKey);
  assert.equal(uniqueEvents(split, 10).length, 2);
  assert.equal(diverseEvents(split, 10).length, 2);
  assert.deepEqual(mergeEventSessions(split), split);
});

await test('reviewed Comedy Lab and further Ada Bar schedules merge without absorbing open-mic shows', () => {
  for (const [title, alias] of [
    [
      'Kadıköy Açık Mikrofon Stand-up - Comedy Lab',
      'Kadıköy Açık Mikrofon Stand-up - Comedy Lab Istanbul',
    ],
    ['Kadıköy Stand-up Gecesi', 'Kadıköy Stand Up Gecesi Cuma 20:00'],
    ['Kadıköy Stand-up Gecesi', 'Kadıköy Stand Up Gecesi Cuma 21:45'],
    ['Kadıköy Stand-up Gecesi', 'Kadıköy Stand Up Gecesi Cumartesi 19:00'],
    ['Kadıköy Stand-up Gecesi', 'Kadıköy Stand up Gecesi Pazar 19:00'],
  ]) {
    const result = mergeEventSessions([
      event({ title }),
      event({
        id: 'b',
        title: alias,
        source: 'bubilet',
        url: 'https://bubilet.example/b',
      }),
    ]);
    assert.equal(result.length, 1, alias);
    assert.equal(result[0].offers?.length, 2);
  }
  assert.equal(
    mergeEventSessions([
      event({ title: 'Kadıköy Stand-up Gecesi' }),
      event({
        id: 'b',
        title: 'Kadıköy Stand up Gecesi Pazartesi Açık Mikrofon',
      }),
    ]).length,
    2,
  );
});

await test('fresh catalog aliases merge exact theatre, concert, and ceremony sessions', () => {
  for (const [firstTitle, secondTitle, category] of [
    ['Sesler - Salih Bademci', 'Salih Bademci - Sesler', 'Tiyatro'],
    ['Tek Hücreliler - Aşkım Kapışmak', 'Aşkım Kapışmak - Tek Hücreliler', 'Tiyatro'],
    ['Kasımpaşa Mevlevihanesi Semazen Töreni', "Kasımpaşa Mevlevihanesi'nde Semazen Töreni", 'Konser'],
    ['Aleksandrov Rus Kızılordu Korosu ve Dans Topluluğu İle Hayko Cepkin Konserleri', 'Aleksandrov Rus Kızılordu Korosu ve Dans Topluluğu İle Hayko Cepkin', 'Konser'],
  ] as const) {
    const first = event({ title: firstTitle, category });
    const second = event({ id: `other:${secondTitle}`, source: 'bubilet', title: secondTitle, category, url: `https://bubilet.example/${encodeURIComponent(secondTitle)}` });
    const merged = mergeEventSessions([first, second]);
    assert.equal(merged.length, 1, `${firstTitle} / ${secondTitle}`);
    assert.equal(merged[0].offers?.length, 2);
    assert.ok(merged[0].mergedIds?.includes(first.id));
    assert.ok(merged[0].mergedIds?.includes(second.id));
  }
});

await test('literal catalog aliases still require the exact session and venue', () => {
  const base = event({ title: 'Sesler - Salih Bademci', venue: 'Maximum Uniq Hall' });
  const alias = event({ id: 'other', source: 'bubilet', title: 'Salih Bademci - Sesler', venue: base.venue });
  assert.equal(mergeEventSessions([base, alias]).length, 1);
  assert.equal(mergeEventSessions([base, { ...alias, startsAt: '2026-10-11T17:00:00.000Z' }]).length, 2);
  assert.equal(mergeEventSessions([base, { ...alias, venue: 'Maximum Uniq Açıkhava' }]).length, 2);
});

await test('does not merge related adaptations, workshop formats, editions, or age policies', () => {
  const base = event({ title: 'Hamlet', venue: 'Atölye Sahne', category: 'Tiyatro' });
  const distinct = [
    event({ id: 'adaptation', title: 'Hamlet - Yeni Uyarlama', venue: base.venue, category: 'Tiyatro' }),
    event({ id: 'workshop', title: 'Hamlet Oyunculuk Workshopu', venue: base.venue, category: 'Tiyatro' }),
    event({ id: 'edition', title: 'Hamlet 2', venue: base.venue, category: 'Tiyatro' }),
    event({ id: 'age', title: 'Hamlet 7+ Çocuk Oyunu', venue: base.venue, category: 'Tiyatro' }),
  ];
  assert.equal(mergeEventSessions([base, ...distinct]).length, 5);
});

await test('preserves every raw offer link, price, and id for fresh aliases', () => {
  const first = event({ id: 'biletinial:berkay', title: 'Berkay Konseri', category: 'Konser', price: 900, url: 'https://biletinial.example/berkay' });
  const second = event({ id: 'bubilet:berkay', source: 'bubilet', title: 'Berkay', category: 'Konser', price: 750, url: 'https://bubilet.example/berkay' });
  const [merged] = mergeEventSessions([first, second]);
  assert.equal(merged.price, 750);
  assert.deepEqual(new Set(merged.offers?.map(({ id, url, price }) => `${id}|${url}|${price}`)), new Set([
    'biletinial:berkay|https://biletinial.example/berkay|900',
    'bubilet:berkay|https://bubilet.example/berkay|750',
  ]));
  assert.ok(merged.mergedIds?.includes(first.id));
  assert.ok(merged.mergedIds?.includes(second.id));
});

await test("reviewed frozen catalog title pairs preserve exact provider offers", () => {
  const pairs = [
    [
      "Hikayeden Adamlar 'Mahalle' - Youtube Çekimi - 3.sezon",
      "Hikayeden Adamlar - Mahalle - Youtube Çekimi",
      "Hoş geldin! Şimdi biraz gülmeye, bazen dertleşmeye geldik.",
      "Sahne Beşiktaş",
    ],
    [
      "Kadıköy Stand Up Gecesi Pazartesi Açık Mikrofon",
      "Kadıköy Stand Up Gecesi Açık Mikrofon",
      "Açık mikrofonda komedyenler şakalarını deniyor; herkesin 5 dakikası var.",
      "Ada Bar Kadıköy",
    ],
    [
      "XI. Gastromasa Istanbul Uluslararası Gastronomi Konferansı & Fuarı",
      "Gastromasa İstanbul Uluslararası Gastronomi Konferansı & Fuarı",
      "26-27 Kasım 2026 tarihlerinde Haliç Kongre Merkezi.",
      "Haliç Kongre Merkezi",
    ],
    [
      "Burak Altuni Akustik Flamenko Konser",
      "Burak Altuni Akustik Flamenko Konseri",
      "Dünya çapındaki flamenko sanatçısı Burak Altuni akustik konseri.",
      "Tiyatro Keyfi Lab – Savaş Başar Sahnesi",
    ],
    [
      "Benyunusyılmaz - Olay Yeri İnceleme Stand Up",
      "Yunus Yılmaz - Olay Yeri İnceleme Stand Up",
      "Ben Yunus Yılmaz; Olay Yeri İnceleme stand-up gösterime hoş geldin.",
      "Sancaktepe Sahnesi",
    ],
    [
      "Lumera Trio Sezen Aksu Şarkıları",
      "Lumera - Sezen Aksu Şarkıları",
      "Lumera Trio; klarnet, gitar ve çellonun uyumu.",
      "Hilltown Seyirlik Sahne",
    ],
    [
      "Celile (Nazım Hikmet'in Annesi) Oyunu",
      "Celile (Nazım Hikmet'in Annesi)",
      "Nazım Hikmet'in annesi Celile'nin hayatı, ilk kez tiyatro sahnesinde.",
      "Kadıköy Barış Manço Kültür Merkezi",
    ],
    [
      "Çocuklar İçin Yaratıcı Drama Eğitimi",
      "Çocuklar için Yaratıcı Drama Eğitim",
      "8–12 yaş arası çocuklara özel yaratıcı drama eğitimi.",
      "Taksim İstiklal Sahne",
    ],
    [
      "Güncel Gürsel Artıktay Konseri",
      "Güncel Gürsel Artıktay",
      "Güncel Gürsel Artıktay unutulmaz bir konserle sahneye çıkıyor.",
      "Blind İstanbul",
    ],
    [
      "Ölü'n Bizi Ayırana Dek",
      "Ölün Bizi Ayırana Dek",
      "Cansu ve Serdar boşanmaya karar vermiş bir çifttir.",
      "Kadıköy Eğitim Sahnesi",
    ],
  ] as const;
  for (const [leftTitle, rightTitle, description, venue] of pairs) {
    const left = event({
      id: `left:${leftTitle}`,
      title: leftTitle,
      description,
      venue,
      price: 410,
      url: `https://biletinial.com/${encodeURIComponent(leftTitle)}`,
    });
    const right = event({
      id: `right:${rightTitle}`,
      source: "bubilet",
      title: rightTitle,
      description,
      venue,
      price: 450,
      url: `https://www.bubilet.com.tr/${encodeURIComponent(rightTitle)}`,
    });
    const result = mergeEventSessions([left, right]);
    assert.equal(result.length, 1, `${leftTitle} / ${rightTitle}`);
    assert.deepEqual(
      new Set(
        result[0].offers?.map(
          ({ id, url, price, availability }) =>
            `${id}|${url}|${price}|${availability}`,
        ),
      ),
      new Set([
        `${left.id}|${left.url}|410|available`,
        `${right.id}|${right.url}|450|available`,
      ]),
    );
    assert.deepEqual(mergeEventSessions(result), result);
  }
});

await test("unverified cast and ensemble variants remain separate", () => {
  const memoir = event({
    title: "Bir Delinin Hatıra Defteri",
    description: "Bakırköy Butik Sahne etkinlik kuralları.",
    venue: "Bakırköy Butik Sahne",
  });
  const memoirSuffix = event({
    id: "memoir-suffix",
    source: "bubilet",
    title: "Bir Delinin Hatıra Defteri Oyunu",
    description: "Bir Delinin Hatıra Defteri Oyunu",
    venue: memoir.venue,
  });
  assert.equal(
    mergeEventSessions([memoir, memoirSuffix]).length,
    2,
    "the frozen pages do not identify the adaptation or cast",
  );
  const trio = event({
    title: "Bülent Evcil & Nova Trio ile Mozart Akşamı",
    category: "Konser",
    venue: "Deniz Müzesi",
  });
  const strings = event({
    id: "nova-strings",
    source: "bubilet",
    title: "Bülent Evcil & Nova Strings ile Mozart Akşamı",
    category: "Konser",
    venue: trio.venue,
  });
  assert.equal(mergeEventSessions([trio, strings]).length, 2);
});

await test('reviewed Fabrikafa workshop programmes merge only with qualified venue evidence', () => {
  const programmes = [
    ['hat', 'Pirinç Çerçeveli Cam Üzerine Hat/Kaligrafi Sanatı Atölyesi', 'Hat Sanatı Atölyesi', 'İstanbul Workshops Hat Sanatı Atölyesi'],
    ['tezhip', 'Tezhip Atölyesi', 'Tezhip Atölyesi', 'İstanbul Workshops Tezhip Atölyesi'],
    ['cini', 'Türk Çini Resim Sanatı Atölyesi', 'Çini Atölyesi', 'İstanbul Workshops Çini Atölyesi'],
    ['vitray', 'Vitray Atölyesi', 'Vitray Atölyesi', 'İstanbul Workshops Vitray Atölyesi'],
    ['parfum', 'Parfüm Tasarımı Atölyesi', 'Parfüm Atölyesi', 'İstanbul Workshops Parfüm Atölyesi'],
    ['deri', 'Deri İşçiliği Atölyesi', 'Deri İşçiliği Atölyesi', 'İstanbul Workshops Deri İşçiliği Atölyesi'],
    ['ebru', 'Ebru ile Bez Çanta Tasarım Atölyesi', 'Ebru Bez Çanta Sanat Atölyesi', 'İstanbul Workshops Ebru ile Bez Çanta Tasarım Atölyesi'],
  ] as const;
  const address = 'Aziz Mahmut Hüdayi, Gülfem Sk. No:15, 34672 Üsküdar/İstanbul';
  const records = programmes.flatMap(([name, biletinialTitle, biletixTitle, bubiletTitle], index) => {
    const startsAt = new Date(Date.UTC(2026, 8, 29, 6 + index)).toISOString();
    return [
      event({ id: `biletinial:${name}`, source: 'biletinial', title: biletinialTitle, category: 'Workshop', description: 'Uygulamalı atölye çalışması.', venue: 'Fabrikafa Make & Coffee', district: 'İstanbul Anadolu', address: '', startsAt, price: 1790, url: `https://biletinial.com/${name}`, sourceSessionIds: [`bi-${name}`] }),
      event({ id: `biletix:${name}`, source: 'biletix', title: biletixTitle, category: 'Workshop', description: 'Uygulamalı atölye çalışması.', venue: 'İstanbul Workshops - Fabrikafa Make & Coffee', district: 'ÜSKÜDAR', address: '', startsAt, price: name === 'ebru' ? null : 1790, url: `https://www.biletix.com/${name}`, sourceSessionIds: [`bx-${name}`] }),
      event({ id: `bubilet:${name}`, source: 'bubilet', title: bubiletTitle, category: 'Workshop', description: 'Uygulamalı atölye çalışması.', venue: 'İstanbul Workshops', district: '', address, startsAt, price: 1750, url: `https://www.bubilet.com.tr/${name}`, sourceSessionIds: [`bu-${name}`] }),
    ];
  });

  const merged = mergeEventSessions(records);
  assert.equal(merged.length, programmes.length);
  for (const [name] of programmes) {
    const item = merged.find((candidate) => candidate.mergedIds?.includes(`biletinial:${name}`))!;
    assert.equal(item.offers?.length, 3, name);
    assert.equal(item.price, 1750, name);
    assert.deepEqual(
      new Set(item.offers?.map((offer) => `${offer.id}|${offer.url}|${offer.price}|${offer.sourceSessionIds?.[0]}`)),
      new Set([
        `biletinial:${name}|https://biletinial.com/${name}|1790|bi-${name}`,
        `biletix:${name}|https://www.biletix.com/${name}|${name === 'ebru' ? 'null' : '1790'}|bx-${name}`,
        `bubilet:${name}|https://www.bubilet.com.tr/${name}|1750|bu-${name}`,
      ]),
      name,
    );
  }
  assert.deepEqual(mergeEventSessions(merged), merged);
  assert.deepEqual(mergeEventSessions([...records].reverse()), merged);
});

await test('Fabrikafa aliases reject mismatched programmes, sessions, locations, categories, and audiences', () => {
  const address = 'Aziz Mahmut Hüdayi, Gülfem Sk. No:15, 34672 Üsküdar/İstanbul';
  const specific = event({ id: 'specific', title: 'Tezhip Atölyesi', category: 'Workshop', description: 'Uygulamalı atölye çalışması.', venue: 'Fabrikafa Make & Coffee', district: 'İstanbul Anadolu', address: '' });
  const bare = event({ id: 'bare', source: 'bubilet', title: 'İstanbul Workshops Tezhip Atölyesi', category: 'Workshop', description: 'Uygulamalı atölye çalışması.', venue: 'İstanbul Workshops', district: '', address });
  assert.equal(mergeEventSessions([specific, bare]).length, 1);

  for (const other of [
    { ...bare, startsAt: '2026-10-10T18:00:00.000Z' },
    { ...bare, title: 'İstanbul Workshops Vitray Atölyesi' },
    { ...bare, address: '' },
    { ...bare, address: 'Başka Sokak No:15, Üsküdar/İstanbul' },
    { ...bare, district: 'Kadıköy' },
    { ...bare, venue: 'Başka Atölye', address: '' },
    { ...bare, city: 'Ankara' },
    { ...bare, category: 'Eğitim' },
  ]) assert.equal(mergeEventSessions([specific, other]).length, 2);

  const genericElsewhere = event({ ...specific, id: 'elsewhere', venue: 'Kadıköy Sanat Atölyesi', district: 'Kadıköy' });
  assert.equal(mergeEventSessions([specific, genericElsewhere]).length, 2);
  const child = event({ ...specific, id: 'child', description: 'Yalnızca 6 ile 9 yaş çocuklar için uygulamalı atölye çalışması.' });
  const adult = event({ ...bare, id: 'adult', description: 'Yalnızca yetişkinler için, 18+ uygulamalı atölye çalışması.' });
  assert.equal(mergeEventSessions([child, adult]).length, 2);
});
