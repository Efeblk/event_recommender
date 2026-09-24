import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeEventSessions } from '../lib/event-merge.ts';
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
