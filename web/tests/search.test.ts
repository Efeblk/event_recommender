import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  cosine,
  isEligible,
  normalize,
  parseFilters,
  rankEvents,
  todayInIstanbul,
  uniqueEvents,
  validateFilters,
} from '../lib/search.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';
const now = new Date('2026-09-07T09:00:00Z');
export const event: EventRecord = {
  id: 'one',
  title: 'Akustik Akşam',
  description: 'Küçük sahnede akustik gitar konseri',
  startsAt: '2026-09-12T18:00:00Z',
  checkedAt: now.toISOString(),
  venue: 'Test Sahne',
  city: 'İstanbul',
  district: 'Kadıköy',
  address: '',
  price: 500,
  currency: 'TRY',
  category: 'Konser',
  availability: 'available',
  imageUrl: '',
  url: 'https://biletinial.com/tr-tr/muzik/test',
};
await test('Istanbul date rolls over before UTC', () =>
  assert.equal(
    todayInIstanbul(new Date('2026-09-07T22:00:00Z')),
    '2026-09-08',
  ));
await test('weekend and localized currency are exact', () =>
  assert.deepEqual(
    parseFilters('Bu hafta sonu 1.500 TL altında tiyatro', emptyFilters, now),
    {
      dateFrom: '2026-09-12',
      dateTo: '2026-09-13',
      maxPrice: 1500,
      category: 'Tiyatro',
    },
  ));
await test('follow-up preserves previous date and category', () => {
  const old = parseFilters('Cumartesi konser', emptyFilters, now);
  assert.deepEqual(parseFilters('Bütçeyi 800 TL yapalım', old, now), {
    ...old,
    maxPrice: 800,
  });
});
await test('Sunday weekend means remaining Sunday, not yesterday', () => {
  const f = parseFilters(
    'hafta sonu',
    emptyFilters,
    new Date('2026-09-13T10:00:00Z'),
  );
  assert.equal(f.dateFrom, '2026-09-13');
  assert.equal(f.dateTo, '2026-09-13');
});
await test('budget removal and category removal are explicit', () =>
  assert.deepEqual(
    parseFilters(
      'Tarih sınırını kaldır, bütçe sınırını kaldır, her kategoriden',
      {
        dateFrom: '2026-09-12',
        dateTo: '2026-09-13',
        maxPrice: 500,
        category: 'Konser',
      },
      now,
    ),
    emptyFilters,
  ));
await test('free is a real zero budget', () =>
  assert.equal(parseFilters('ücretsiz konser', emptyFilters, now).maxPrice, 0));
await test('filters reject impossible dates and inverted ranges', () => {
  assert.throws(() =>
    validateFilters({ ...emptyFilters, dateFrom: '2026-02-30' }),
  );
  assert.throws(() =>
    validateFilters({
      ...emptyFilters,
      dateFrom: '2026-09-13',
      dateTo: '2026-09-12',
    }),
  );
  assert.throws(() => validateFilters({ ...emptyFilters, maxPrice: -1 }));
});
await test('event hard constraints reject stale, past, cancelled and sold-out data', () => {
  assert.equal(isEligible(event, emptyFilters, now), true);
  for (const bad of [
    { startsAt: '2026-09-06T20:00:00Z' },
    { checkedAt: '2026-09-01T10:00:00Z' },
    { availability: 'sold_out' },
    { availability: 'cancelled' },
    { city: 'Ankara' },
  ])
    assert.equal(
      isEligible({ ...event, ...bad } as EventRecord, emptyFilters, now),
      false,
    );
});
await test('unknown price never passes a budget; free events do', () => {
  assert.equal(
    isEligible(
      { ...event, price: null },
      { ...emptyFilters, maxPrice: 1000 },
      now,
    ),
    false,
  );
  assert.equal(
    isEligible({ ...event, price: 0 }, { ...emptyFilters, maxPrice: 0 }, now),
    true,
  );
  assert.equal(
    isEligible({ ...event, price: 1 }, { ...emptyFilters, maxPrice: 0 }, now),
    false,
  );
});
await test('date filters use Istanbul calendar day for late-night sessions', () =>
  assert.equal(
    isEligible(
      { ...event, startsAt: '2026-09-12T22:30:00Z' },
      { ...emptyFilters, dateFrom: '2026-09-13', dateTo: '2026-09-13' },
      now,
    ),
    true,
  ));
await test('semantic score can find description without exact query word', () => {
  const jazz = {
    ...event,
    id: 'jazz',
    title: 'Caz Gecesi',
    description: 'Saksafon ve piyano',
  };
  assert.equal(
    rankEvents(
      [event, jazz],
      'romantik',
      [1, 0],
      new Map([
        ['one', [0, 1]],
        ['jazz', [1, 0]],
      ]),
    )[0].id,
    'jazz',
  );
});
await test('zero and incompatible vectors are safe', () => {
  assert.equal(cosine([0, 0], [0, 0]), 0);
  assert.equal(cosine([1], [1, 2]), 0);
  assert.equal(cosine([1, 0], [1, 0]), 1);
});
await test('same production at different sessions appears once', () =>
  assert.equal(
    uniqueEvents([
      event,
      { ...event, id: 'two', startsAt: '2026-09-13T18:00:00Z' },
    ]).length,
    1,
  ));
await test('Turkish text normalization and calendar arithmetic', () => {
  assert.equal(normalize('İSTANBUL Şişli'), 'istanbul sisli');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
