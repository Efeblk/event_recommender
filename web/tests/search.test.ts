import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  cosine,
  isEligible,
  normalize,
  parseFilters,
  interpretConstraints,
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
      maxPriceExclusive: true,
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
await test('natural category exclusions do not become positive category filters', () => {
  for (const message of [
    'Cumartesi partnerimle konser olmayan bir etkinlik istiyorum',
    'Cumartesi sevgilimle konser olmayan etkinliklere gidelim',
  ]) {
    const filters = parseFilters(message, emptyFilters, now);
    assert.equal(filters.category, null, message);
    assert.deepEqual(filters.excludedCategories, ['Konser'], message);
  }
  const alternatives = parseFilters(
    'konser veya tiyatro olmasın, workshop olabilir, en yakın tarih',
    emptyFilters,
    now,
  );
  assert.equal(alternatives.category, null);
  assert.equal(alternatives.categories, undefined);
  assert.deepEqual(alternatives.excludedCategories, ['Konser', 'Tiyatro']);
  assert.equal(
    parseFilters('konser olan bir etkinlik', emptyFilters, now).category,
    'Konser',
  );
});
await test('soonest wording orders elsewhere without requiring an exact date', () => {
  for (const message of [
    'en yakın tarih',
    'en erken tarih',
    'soonest date',
    'earliest event',
  ])
    assert.equal(interpretConstraints(message, emptyFilters, now).issue, null);
  assert.equal(
    interpretConstraints(
      'en yakın tarih ama gelecek ayın son günlerinde',
      emptyFilters,
      now,
    ).issue,
    'date_ambiguous',
  );
});
await test('Turkish postfix clock bounds preserve inclusive and strict wording', () => {
  for (const message of ['21:00 ve sonrasında', 'saat 21.00 ve sonrasında']) {
    const filters = parseFilters(message, emptyFilters, now);
    assert.equal(filters.startTimeFrom, '21:00', message);
    assert.equal(filters.startTimeFromExclusive, false, message);
  }
  for (const message of ['21:00 sonrası', 'saat 21.00 sonrasında']) {
    const filters = parseFilters(message, emptyFilters, now);
    assert.equal(filters.startTimeFrom, '21:00', message);
    assert.equal(filters.startTimeFromExclusive, true, message);
  }
});
await test('clock constraints require explicit timed-session evidence', () => {
  const filters = { ...emptyFilters, startTimeFrom: '21:00' };
  const lateEvent = { ...event, startsAt: '2026-09-12T18:00:00Z' };
  assert.equal(isEligible(lateEvent, filters, now), false);
  assert.equal(
    isEligible(
      {
        ...lateEvent,
        attendanceTiming: {
          kind: 'timed_session',
          evidence: 'provider_sessions_and_source_text',
        },
      },
      filters,
      now,
    ),
    true,
  );
  assert.equal(
    isEligible(
      {
        ...lateEvent,
        attendanceTiming: {
          kind: 'admission_window',
          evidence: 'provider_flexible_window',
          validFrom: '2026-09-12T18:00:00Z',
          validThrough: '2026-09-12T21:00:00Z',
        },
      },
      filters,
      now,
    ),
    false,
  );
  assert.equal(
    isEligible(
      {
        ...lateEvent,
        attendanceTiming: {
          kind: 'unknown',
          evidence: 'insufficient_source_evidence',
        },
      },
      filters,
      now,
    ),
    false,
  );
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
await test('strict and inclusive budget wording preserve the stated boundary', () => {
  for (const message of [
    '1000 TL altı konser',
    "1000 TL'den az konser",
    "1000 TL'den daha az konser",
    "1000 TL'nin altı konser",
    "1000 TL'nin altında konser",
    'concert under 1000 TRY',
    'concert under ₺1000',
    'concert below 1000 TRY',
    'concert below ₺1000',
    'concert less than 1000 TRY',
    'concert less than ₺1000',
  ]) {
    const filters = parseFilters(message, emptyFilters, now);
    assert.equal(filters.maxPrice, 1000, message);
    assert.equal(filters.maxPriceExclusive, true, message);
  }
  for (const message of [
    'En fazla 1000 TL konser',
    '1000 TL bütçeyle konser',
    'concert up to 1000 TRY',
    'concert at most 1000 TRY',
    '1000 TL ve altı konser',
  ]) {
    const filters = parseFilters(message, emptyFilters, now);
    assert.equal(filters.maxPrice, 1000, message);
    assert.equal(filters.maxPriceExclusive, undefined, message);
  }
  for (const message of [
    'not under 1000 TRY',
    'no less than ₺1000',
    "1000 TL'nin altında değil",
  ]) {
    const filters = parseFilters(message, emptyFilters, now);
    assert.equal(filters.maxPrice, null, message);
    assert.equal(filters.maxPriceExclusive, undefined, message);
  }
});
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
  assert.throws(() =>
    validateFilters({ ...emptyFilters, maxPriceExclusive: true }),
  );
  assert.throws(() =>
    validateFilters({ ...emptyFilters, maxPrice: 1000, maxPriceExclusive: 1 }),
  );
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
await test('explicit workshop and talk evidence cannot pass as a concert', () => {
  for (const mismatch of [
    {
      title: 'Çizgi Roman Atölyesi',
      description: 'Bu atölyede çocuklar hikâyelerini görselleştirir.',
    },
    {
      title: 'Miles: Bir Caz İkonunun Anatomisi',
      description:
        'Bu keyifli söyleşi Miles Davis’i ele alıyor. Moderatör ve panelistler katılıyor.',
    },
    {
      title: 'Seramik Deneyimi',
      description: 'Bu atölyede çocuklar kil ile üretir.',
    },
  ])
    for (const filters of [
      emptyFilters,
      { ...emptyFilters, category: 'Konser' as const },
    ])
      assert.equal(isEligible({ ...event, ...mismatch }, filters, now), false);
  assert.equal(
    isEligible(
      {
        ...event,
        title: 'Yaz Konseri',
        description: 'Canlı performans Harbiye sahnesinde gerçekleşir.',
      },
      { ...emptyFilters, category: 'Konser' },
      now,
    ),
    true,
  );
  assert.equal(
    isEligible(
      {
        ...event,
        title: 'Atölye Konseri',
        description: 'Canlı konser, yeni besteleri seyirciyle buluşturuyor.',
      },
      emptyFilters,
      now,
    ),
    true,
  );
  assert.equal(
    isEligible(
      {
        ...event,
        title: 'Konser Atölyesi',
        description:
          'Bu atölyede katılımcılar temel ritim tekniklerini öğrenir.',
      },
      emptyFilters,
      now,
    ),
    false,
  );
  assert.equal(
    isEligible(
      {
        ...event,
        category: 'Tiyatro',
        title: 'Ayrılık Çeşmesi',
        description:
          'Ayrılık Çeşmesi Tiyatro Oyunu, bir yazarlık atölyesinin üretimlerindendir.',
      },
      { ...emptyFilters, category: 'Tiyatro' },
      now,
    ),
    true,
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
await test('strict budgets exclude an event exactly at the boundary', () => {
  assert.equal(
    isEligible(
      { ...event, price: 1000 },
      { ...emptyFilters, maxPrice: 1000, maxPriceExclusive: true },
      now,
    ),
    false,
  );
  assert.equal(
    isEligible(
      { ...event, price: 999 },
      { ...emptyFilters, maxPrice: 1000, maxPriceExclusive: true },
      now,
    ),
    true,
  );
  assert.equal(
    isEligible(
      { ...event, price: 1000 },
      { ...emptyFilters, maxPrice: 1000 },
      now,
    ),
    true,
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
