import test from 'node:test';
import assert from 'node:assert/strict';
import {
  recommend,
  validateInput,
  type RecommendInput,
} from '../lib/recommend.ts';
import {
  emptyFilters,
  type Category,
  type EventRecord,
  type Filters,
  type Message,
} from '../lib/types.ts';

const now = new Date('2026-09-27T19:40:00Z');
const saturday = '2026-10-03';
const make = (
  id: string,
  category: Category,
  description: string,
  price = 350,
): EventRecord => ({
  id,
  title: id,
  description,
  category,
  price,
  currency: 'TRY',
  startsAt: `${saturday}T17:30:00Z`,
  checkedAt: now.toISOString(),
  venue: `Sahne ${id}`,
  city: 'İstanbul',
  district: 'Kadıköy',
  address: '',
  availability: 'available',
  url: `https://example.test/${encodeURIComponent(id)}`,
  imageUrl: '',
});
const catalog = [
  make('Akustik Konser', 'Konser', 'Akustik gitar konseri.'),
  make('Rock Gecesi', 'Konser', 'Rock konseri.', 600),
  make(
    'Birlikte Tiyatro',
    'Tiyatro',
    'İlişkiler üzerine bir komedi oyunu. Konser bileti yüzünden tartışan bir çiftin hikâyesi.',
    450,
  ),
  make('Komedi Akşamı', 'Stand-up', 'Yetişkinler için stand-up gösterisi.'),
  {
    ...make('Başka Gün', 'Tiyatro', 'Yetişkinler için tiyatro oyunu.'),
    startsAt: '2026-10-02T17:30:00Z',
  },
];

async function run(input: RecommendInput, ai = true) {
  const modelCandidates: EventRecord[][] = [];
  const result = await recommend(input, {
    now,
    config: ai ? { apiKey: 'test-only', model: 'jev-test' } : null,
    // Return all rows so both storage and pre-AI admission are exercised.
    candidates: async () => catalog,
    rank: async (_config, _input, events) => {
      modelCandidates.push(events);
      return {
        model: 'jev-test',
        usage: { inputTokens: 0, outputTokens: 0 },
        ranked: events.map((event) => ({
          event,
          score: 2.9,
          confidence: 0.9,
          probabilities: [0, 0, 0.1, 0.9] as const,
          supportProbability: 1,
        })),
      };
    },
  });
  return { result, modelCandidates };
}

const nonConcertQueries = [
  'bu cumartesi sevgilimle gidebileceğim konser dışı etkinlik',
  'Bu cumartesi sevgilimle konserler dışında bir şey yapalım',
  'Cumartesi konser dışındaki etkinlikleri göster',
  'Cumartesi konser istemiyoruz, başka bir etkinlik olsun',
  'Bu cumartesi konserlere gitmek istemiyoruz',
  'Bu cumartesi konser olmasın lütfen',
  'BU CUMARTESİ KONSER DIŞINDA BİR ETKİNLİK',
  'bu cumartesi konser haric bir etkinlik oner',
  'this Saturday, no concerts please',
  'this Saturday, anything except concerts',
];

await test('multiple category exclusions in one sentence retain the positive alternative', async () => {
  for (const message of [
    'Bu cumartesi konser istemiyorum, tiyatro istemiyoruz, stand-up olsun',
    'Bu cumartesi konser veya tiyatro istemiyoruz, stand-up olsun',
    'This Saturday, no concerts and no theatre, stand-up please',
  ]) {
    const { result } = await run(validateInput({ message }));
    assert.equal(result.status, 'results', message);
    assert.equal(result.filters.category, 'Stand-up', message);
    assert.equal(result.filters.dateFrom, saturday, message);
    assert.deepEqual(
      new Set(result.filters.excludedCategories),
      new Set(['Konser', 'Tiyatro']),
      message,
    );
    assert.deepEqual(
      result.recommendations.map(({ event }) => event.id),
      ['Komedi Akşamı'],
      message,
    );
  }
});

await test('ordinary non-concert phrasings produce the same dated intent before AI and fallback', async () => {
  for (const message of nonConcertQueries) {
    for (const ai of [true, false]) {
      const { result, modelCandidates } = await run(
        validateInput({ message }),
        ai,
      );
      assert.equal(result.status, 'results', message);
      assert.equal(result.filters.dateFrom, saturday, message);
      assert.equal(result.filters.dateTo, saturday, message);
      assert.equal(result.filters.category, null, message);
      assert.deepEqual(result.filters.excludedCategories, ['Konser'], message);
      assert.equal(result.totalCandidates, 2, message);
      // An incidental concert mention in a play's synopsis is not its format.
      assert.deepEqual(
        new Set(result.recommendations.map(({ event }) => event.id)),
        new Set(['Birlikte Tiyatro', 'Komedi Akşamı']),
        message,
      );
      assert.equal(modelCandidates.length, ai ? 1 : 0, message);
      for (const candidate of modelCandidates.flat())
        assert.notEqual(candidate.category, 'Konser', message);
    }
  }
});

await test('natural category corrections select the requested alternative without losing Saturday', async () => {
  for (const message of [
    'Cumartesi konser değil tiyatro olsun',
    'Cumartesi konser yerine tiyatroya gidelim',
    'this Saturday, we do not want concerts; theatre instead',
    "this Saturday, we don't want concerts; theatre instead",
  ]) {
    const { result } = await run(validateInput({ message }));
    assert.equal(result.status, 'results', message);
    assert.equal(result.filters.category, 'Tiyatro', message);
    assert.equal(result.filters.dateFrom, saturday, message);
    assert.ok(result.filters.excludedCategories?.includes('Konser'), message);
    assert.deepEqual(
      result.recommendations.map(({ event }) => event.id),
      ['Birlikte Tiyatro'],
      message,
    );
  }
});

await test('category wording is not negated by unrelated outside or rejection phrases', async () => {
  for (const message of [
    'Bu cumartesi sıra dışı konser öner',
    'Bu cumartesi konser mekân dışı olsun',
    'Bu cumartesi konser istiyorum, tiyatro istemiyoruz',
  ]) {
    const { result } = await run(validateInput({ message }));
    assert.equal(result.status, 'results', message);
    assert.equal(result.filters.category, 'Konser', message);
    assert.ok(!result.filters.excludedCategories?.includes('Konser'), message);
    assert.ok(
      result.recommendations.every(({ event }) => event.category === 'Konser'),
      message,
    );
  }
});

await test('latest same-turn category correction controls both filters and retrieval', async () => {
  for (const [message, category] of [
    ['Bu cumartesi konser istemiyorum ama aslında konser olsun', 'Konser'],
    ['Bu cumartesi konser olsun ama vazgeçtim konser istemiyoruz', null],
  ] as const) {
    const { result } = await run(validateInput({ message }));
    assert.equal(result.status, 'results', message);
    assert.equal(result.filters.category, category, message);
    if (category)
      assert.ok(
        result.recommendations.every(
          ({ event }) => event.category === category,
        ),
      );
    else
      assert.ok(
        result.recommendations.every(
          ({ event }) => event.category !== 'Konser',
        ),
      );
  }
});

await test('budget changes and alternatives retain a natural exclusion and date', async () => {
  let filters: Filters = emptyFilters;
  const history: Message[] = [];
  let lastIds: string[] = [];
  for (const message of [
    'Bu cumartesi sevgilimle konserler dışında bir etkinlik',
    'Kişi başı 500 TL altında olsun',
    'Başka seçenekler',
  ]) {
    const { result } = await run(
      validateInput({
        message,
        filters,
        history,
        excludeIds: message === 'Başka seçenekler' ? lastIds.slice(0, 1) : [],
      }),
    );
    assert.equal(result.status, 'results', message);
    assert.equal(result.filters.dateFrom, saturday, message);
    assert.deepEqual(result.filters.excludedCategories, ['Konser'], message);
    assert.ok(
      result.recommendations.every(({ event }) => event.category !== 'Konser'),
      message,
    );
    if (history.length) {
      assert.equal(result.filters.maxPrice, 500, message);
      assert.equal(result.filters.maxPriceExclusive, true, message);
      assert.ok(
        result.recommendations.every(
          ({ event }) => event.price !== null && event.price < 500,
        ),
        message,
      );
    }
    if (message === 'Başka seçenekler')
      assert.ok(
        result.recommendations.every(({ event }) => event.id !== lastIds[0]),
      );
    lastIds = result.recommendations.map(({ event }) => event.id);
    filters = result.filters;
    history.push({ role: 'user', content: message });
  }
});

await test('a positive follow-up correction stays corrected when asking for alternatives', async () => {
  let filters: Filters = emptyFilters;
  const history: Message[] = [];
  for (const message of [
    'Bu cumartesi konser istemiyoruz',
    'Aslında konser olsun',
    'Başka bir şey öner',
  ]) {
    const { result } = await run(validateInput({ message, filters, history }));
    assert.equal(result.status, 'results', message);
    assert.equal(result.filters.dateFrom, saturday, message);
    if (history.length) {
      assert.equal(result.filters.category, 'Konser', message);
      assert.ok(
        !result.filters.excludedCategories?.includes('Konser'),
        message,
      );
      assert.ok(
        result.recommendations.every(
          ({ event }) => event.category === 'Konser',
        ),
        message,
      );
    } else {
      assert.equal(result.filters.category, null, message);
      assert.deepEqual(result.filters.excludedCategories, ['Konser'], message);
    }
    filters = result.filters;
    history.push({ role: 'user', content: message });
  }
});
