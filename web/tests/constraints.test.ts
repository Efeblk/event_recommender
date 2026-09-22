import test from 'node:test';
import assert from 'node:assert/strict';
import {
  interpretConstraints,
  isEligible,
  parseFilters,
  validateFilters,
} from '../lib/search.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';

const now = new Date('2026-09-07T09:00:00Z');
const event: EventRecord = {
  id: 'concert',
  title: 'Akustik Akşam',
  description: 'Akustik konser',
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
  url: 'https://example.test/concert',
};

await test('explicit category negation becomes a durable hard exclusion', () => {
  const first = interpretConstraints('Konser istemiyorum', emptyFilters, now);
  assert.deepEqual(first, {
    filters: { ...emptyFilters, excludedCategories: ['Konser'] },
    issue: null,
  });
  const followup = interpretConstraints('Bütçem 700 TL', first.filters, now);
  assert.deepEqual(followup.filters.excludedCategories, ['Konser']);
  assert.equal(isEligible(event, followup.filters, now), false);
});

await test('hariç works and positive category after negation is not lost', () => {
  assert.deepEqual(
    parseFilters('Konser hariç', emptyFilters, now).excludedCategories,
    ['Konser'],
  );
  assert.deepEqual(parseFilters('Tiyatro değil konser', emptyFilters, now), {
    ...emptyFilters,
    category: 'Konser',
    excludedCategories: ['Tiyatro'],
  });
});

await test('category reset clears exclusions and explicit choice overrides its own exclusion', () => {
  const old = { ...emptyFilters, excludedCategories: ['Konser' as const] };
  assert.deepEqual(parseFilters('her kategori olur', old, now), emptyFilters);
  assert.deepEqual(parseFilters('konser istiyorum', old, now), {
    ...emptyFilters,
    category: 'Konser',
  });
});

await test('group totals are converted to per-person budget only with party size', () => {
  assert.deepEqual(
    interpretConstraints('İki kişi toplam 800 TL', emptyFilters, now),
    { filters: { ...emptyFilters, maxPrice: 400 }, issue: null },
  );
  assert.equal(
    interpretConstraints('Toplam bütçem 800 TL', emptyFilters, now).issue,
    'budget_ambiguous',
  );
  assert.deepEqual(
    interpretConstraints(
      'Toplam bütçem 800 TL',
      { ...emptyFilters, maxPrice: 500 },
      now,
    ).filters,
    { ...emptyFilters, maxPrice: 500 },
  );
  assert.equal(
    interpretConstraints('Kişi başı 800 TL', emptyFilters, now).filters
      .maxPrice,
    800,
  );
});

await test('negated genres do not exclude their entire category', () => {
  assert.deepEqual(
    interpretConstraints('Rock istemiyorum', emptyFilters, now).filters,
    emptyFilters,
  );
  assert.deepEqual(
    interpretConstraints('Rock istemiyorum, caz olsun', emptyFilters, now)
      .filters,
    { ...emptyFilters, category: 'Konser' },
  );
});

await test('contextual adult stage plays map to theatre without broadening generic oyun', () => {
  for (const message of [
    'Yetişkinlere uygun ciddi bir oyun olsun',
    'Dramatik bir oyun arıyorum',
    'Sahnede ciddi oyun izlemek istiyorum',
  ])
    assert.equal(parseFilters(message, emptyFilters, now).category, 'Tiyatro');

  for (const message of [
    'Oyun havası dinlemek istiyorum',
    'Oyun müzikleri gecesi',
    'Arkadaşlarla kutu oyunu oynayalım',
    'Yetişkinlere uygun kutu oyunu oynayalım',
    'Ciddi bir masa oyunu arıyorum',
    'Bir oyun olsun',
  ])
    assert.equal(parseFilters(message, emptyFilters, now).category, null);
});

await test('negated contextual plays do not become positive theatre intent', () => {
  assert.deepEqual(
    parseFilters('Ciddi bir oyun değil, konser istiyorum', emptyFilters, now),
    { ...emptyFilters, category: 'Konser' },
  );
  assert.deepEqual(
    parseFilters(
      'Ciddi bir oyun değil, konser istiyorum',
      { ...emptyFilters, category: 'Tiyatro' },
      now,
    ),
    { ...emptyFilters, category: 'Konser' },
  );
});

await test('a current contextual theatre request supersedes an older concert category', () => {
  const previous = { ...emptyFilters, category: 'Konser' as const };
  assert.equal(
    parseFilters('Yetişkinlere yönelik dramatik bir oyun', previous, now)
      .category,
    'Tiyatro',
  );
});

await test('shared category synonyms consistently switch an existing theatre filter', () => {
  const previous = { ...emptyFilters, category: 'Tiyatro' as const };
  for (const message of [
    'Techno istiyorum',
    'Elektronik olsun',
    'Biraz gülelim',
    'Gülecek bir şey olsun',
  ]) {
    const expected = /gül/i.test(message) ? 'Stand-up' : 'Konser';
    assert.equal(parseFilters(message, previous, now).category, expected);
  }
  assert.deepEqual(
    parseFilters('Elektronik müzik değil, akustik olsun', previous, now),
    { ...emptyFilters, category: 'Konser' },
  );
});

await test('standalone compound genre and child-show rejections do not become category intent', () => {
  assert.deepEqual(
    parseFilters('Elektronik müzik istemiyorum', emptyFilters, now),
    emptyFilters,
  );
  assert.deepEqual(
    parseFilters(
      'Elektronik müzik istemiyorum',
      { ...emptyFilters, category: 'Tiyatro' },
      now,
    ),
    { ...emptyFilters, category: 'Tiyatro' },
  );
  assert.deepEqual(
    parseFilters('Çocuk tiyatrosu istemiyorum', emptyFilters, now),
    emptyFilters,
  );
});

await test('budget syntax uncertainty and invalid values preserve prior filters', () => {
  const previous = { ...emptyFilters, maxPrice: 300 };
  for (const message of [
    'iki kişi 800 TL',
    'toplam bütçem800',
    'kişi başı 200000 TL',
    '-5 TL',
    'bütçem -5',
  ]) {
    const result = interpretConstraints(message, previous, now);
    assert.equal(result.issue, 'budget_ambiguous');
    assert.deepEqual(result.filters, previous);
  }
  assert.deepEqual(interpretConstraints('kişi başı 800 ₺', emptyFilters, now), {
    filters: { ...emptyFilters, maxPrice: 800 },
    issue: null,
  });
});

await test('multiple monetary constraints are not silently guessed', () => {
  assert.equal(
    interpretConstraints('500 TL ile 800 TL arası', emptyFilters, now).issue,
    'budget_ambiguous',
  );
});

await test('salient unsupported dates request clarification', () => {
  assert.equal(
    interpretConstraints('Ayın ortasında konser', emptyFilters, now).issue,
    'date_ambiguous',
  );
  assert.equal(
    interpretConstraints('2026-02-30 konser', emptyFilters, now).issue,
    'date_ambiguous',
  );
  assert.equal(
    interpretConstraints('yarın konser', emptyFilters, now).issue,
    null,
  );
});

await test('ambiguous date forms preserve the previous exact date', () => {
  const previous = {
    ...emptyFilters,
    dateFrom: '2026-09-12',
    dateTo: '2026-09-12',
  };
  for (const message of [
    'gelecek hafta cuma',
    'cuma değil cumartesi',
    '12.09.2026',
    '12 Eylül konser',
  ]) {
    const result = interpretConstraints(message, previous, now);
    assert.equal(result.issue, 'date_ambiguous');
    assert.deepEqual(result.filters, previous);
  }
  assert.equal(
    interpretConstraints('sakin bir akşam', emptyFilters, now).issue,
    null,
  );
});

await test('unsupported city is detected unless it is explicitly negated', () => {
  assert.equal(
    interpretConstraints("Ankara'da tiyatro", emptyFilters, now).issue,
    'unsupported_location',
  );
  assert.equal(
    interpretConstraints('Ankara değil İstanbul konser', emptyFilters, now)
      .issue,
    null,
  );
  for (const message of [
    "Diyarbakır'da konser",
    'Çanakkale tiyatro',
    'Muğla etkinlikleri',
    'Şanlıurfa stand-up',
  ])
    assert.equal(
      interpretConstraints(message, emptyFilters, now).issue,
      'unsupported_location',
    );
  assert.equal(
    interpretConstraints(
      "Ankara'yı istemiyorum, İstanbul olsun",
      emptyFilters,
      now,
    ).issue,
    null,
  );
  assert.equal(
    interpretConstraints('Van Gogh sergisi', emptyFilters, now).issue,
    null,
  );
});

await test('filter validation deduplicates exclusions and removes contradictions', () => {
  assert.deepEqual(
    validateFilters({
      ...emptyFilters,
      category: 'Konser',
      excludedCategories: ['Konser', 'Tiyatro', 'Tiyatro'],
    }),
    { ...emptyFilters, category: 'Konser', excludedCategories: ['Tiyatro'] },
  );
  assert.throws(() =>
    validateFilters({ ...emptyFilters, excludedCategories: ['Sinema'] }),
  );
});
