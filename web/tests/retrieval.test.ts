import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diverseEvents,
  fallbackEvents,
  isAlternativesRequest,
  searchContext,
  shortlistEvents,
} from '../lib/retrieval.ts';
import type { EventRecord, Message } from '../lib/types.ts';

const base: EventRecord = {
  id: 'base',
  title: 'Etkinlik',
  description: '',
  startsAt: '2026-09-26T17:00:00Z',
  checkedAt: '2026-09-22T09:00:00Z',
  venue: 'Sahne',
  city: 'İstanbul',
  district: '',
  address: '',
  price: 500,
  currency: 'TRY',
  url: 'https://example.test/base',
  imageUrl: '',
  category: 'Konser',
  availability: 'available',
};
const make = (id: string, patch: Partial<EventRecord> = {}): EventRecord => ({
  ...base,
  id,
  url: `https://example.test/${id}`,
  ...patch,
});

await test('display diversity suppresses the same recognized show across venues without fuzzy title merging', () => {
  const events = [
    make('edepsiz-one', { title: 'Edepsiz', venue: 'Sahne Bir' }),
    make('edepsiz-two', { title: 'Edepsiz', venue: 'Sahne İki' }),
    make('yunus-one', { title: 'Yunus', venue: 'Sahne Bir' }),
    make('yunus-two', {
      title: 'Yunus: Başka Bir Gösteri',
      venue: 'Sahne İki',
    }),
    make('yunus-three', { title: 'Yunus 3', venue: 'Sahne Üç' }),
  ];
  assert.deepEqual(
    diverseEvents(events).map(({ id }) => id),
    ['edepsiz-one', 'yunus-one', 'yunus-two', 'yunus-three'],
  );
  assert.equal(events[0].venue, 'Sahne Bir');
  assert.equal(events[1].venue, 'Sahne İki');
});

await test('lexical shortlist fills from distinct shows beyond repeated top-ranked titles', () => {
  const repeated = Array.from({ length: 20 }, (_, index) =>
    make(`repeat-${index}`, {
      title: 'Edepsiz',
      venue: `Sahne ${index}`,
      description: 'Özgün komedi',
    }),
  );
  const distinct = Array.from({ length: 5 }, (_, index) =>
    make(`distinct-${index}`, {
      title: `Farklı Gösteri ${index}`,
      description: '',
    }),
  );
  const result = shortlistEvents(
    [...repeated, ...distinct],
    'Özgün komedi',
    [],
    5,
  );
  assert.equal(result.length, 5);
  assert.equal(result[0].id, 'repeat-0');
  assert.equal(new Set(result.map(({ title }) => title)).size, 5);
});

await test('generic titles remain distinct productions and alternatives wording is shared', () => {
  const generic = [
    make('open-mic-one', { title: 'Open Mic', venue: 'Sahne Bir' }),
    make('open-mic-two', { title: 'Open Mic', venue: 'Sahne İki' }),
  ];
  assert.deepEqual(
    diverseEvents(generic).map(({ id }) => id),
    ['open-mic-one', 'open-mic-two'],
  );
  assert.equal(isAlternativesRequest('Bana başka seçenekler göster'), true);
  assert.equal(isAlternativesRequest('Diğer etkinlikleri bul'), true);
  assert.equal(isAlternativesRequest('Alternatif öneri var mı?'), true);
  assert.equal(isAlternativesRequest('Başka bir semtte konser'), false);
  assert.equal(isAlternativesRequest('Show me alternatives'), true);
  assert.equal(
    isAlternativesRequest('More options under the same budget'),
    true,
  );
});

await test('soft-negated rock cannot crowd alternatives out of the Jev shortlist', () => {
  const rejected = Array.from({ length: 20 }, (_, index) =>
    make(`rock-${index}`, {
      title: `Rock Gecesi ${index}`,
      description: 'Elektro gitarla yüksek sesli rock konseri',
    }),
  );
  const acoustic = make('acoustic', {
    title: 'Akustik Üçlü',
    description: 'Akustik gitar ve kontrbasla sakin bir performans',
  });
  const events = [...rejected, acoustic];
  assert.deepEqual(
    shortlistEvents(events, 'Rock istemiyorum, sakin olsun', [], 16).map(
      ({ id }) => id,
    ),
    ['acoustic'],
  );
  assert.deepEqual(
    fallbackEvents(events, 'Rock istemiyorum, sakin olsun', []).map(
      ({ id }) => id,
    ),
    ['acoustic'],
  );
});

await test('semantic calm-mood shortlist reserves diverse sourced formats without claiming quietness', () => {
  const nightlife = Array.from({ length: 20 }, (_, index) =>
    make(`nightlife-${index}`, {
      title: `Gece Eğlencesi ${index}`,
      description: 'Enerjik sahne gösterisi',
    }),
  );
  const acoustic = make('calm-acoustic', {
    title: 'Akustik Üçlü',
    description: 'Akustik gitar ve kontrbas performansı',
  });
  const strings = make('calm-strings', {
    title: 'Üç Viyolonsel',
    description: 'Üç viyolonsel için hazırlanmış konser programı',
  });
  const candle = make('calm-candle', {
    title: 'Mum Işığında Konser',
    description: 'Binlerce mum ışığında canlı müzik programı',
  });
  const events = [...nightlife, acoustic, strings, candle];
  const semantic = {
    queryVector: [1, 0],
    vectors: new Map(
      events.map((event, index) => [
        event.id,
        index < nightlife.length ? [1, 0] : [0, 1],
      ]),
    ),
  };
  const result = shortlistEvents(
    events,
    'Çok yoruldum, sakin ama sıkıcı olmayan bir akşam istiyorum',
    [],
    16,
    semantic,
  );
  const ids = new Set(result.map(({ id }) => id));
  assert.equal(result.length, 16);
  assert.equal(ids.has(acoustic.id), true);
  assert.equal(ids.has(strings.id), true);
  assert.equal(ids.has(candle.id), true);
  assert.equal(strings.description.includes('sakin'), false);
});

await test('calm-format coverage does not activate for a rejected calm mood', () => {
  const ordinary = Array.from({ length: 16 }, (_, index) =>
    make(`ordinary-${index}`, { title: `Etkinlik ${index}` }),
  );
  const acoustic = make('unwanted-acoustic', {
    description: 'Akustik gitar performansı',
  });
  const events = [...ordinary, acoustic];
  const semantic = {
    queryVector: [1, 0],
    vectors: new Map(
      events.map((event) => [
        event.id,
        event.id === acoustic.id ? [0, 1] : [1, 0],
      ]),
    ),
  };
  assert.equal(
    shortlistEvents(
      events,
      'Sakin bir şey istemiyorum, enerjik olsun',
      [],
      16,
      semantic,
    ).some(({ id }) => id === acoustic.id),
    false,
  );
});

await test('calm mood uses reset-aware history and supports English phrasing', () => {
  const ordinary = Array.from({ length: 16 }, (_, index) =>
    make(`reset-ordinary-${index}`, { title: `Etkinlik ${index}` }),
  );
  const acoustic = make('reset-acoustic', {
    description: 'Akustik gitar performansı',
  });
  const events = [...ordinary, acoustic];
  const semantic = {
    queryVector: [1, 0],
    vectors: new Map(
      events.map((event) => [
        event.id,
        event.id === acoustic.id ? [0, 1] : [1, 0],
      ]),
    ),
  };
  assert.equal(
    shortlistEvents(
      events,
      'I am tired and want a relaxed evening',
      [],
      16,
      semantic,
    ).some(({ id }) => id === acoustic.id),
    true,
  );
  assert.equal(
    shortlistEvents(
      events,
      'Her kategori olur',
      [{ role: 'user', content: 'Sakin bir akşam istiyorum' }],
      16,
      semantic,
    ).some(({ id }) => id === acoustic.id),
    false,
  );
  assert.equal(
    shortlistEvents(
      events,
      'I do not want a calm evening',
      [],
      16,
      semantic,
    ).some(({ id }) => id === acoustic.id),
    false,
  );
});

await test('negated or incidental instruments are not calm-format evidence', () => {
  const ordinary = Array.from({ length: 16 }, (_, index) =>
    make(`format-ordinary-${index}`, { title: `Etkinlik ${index}` }),
  );
  const negatedAcoustic = make('negated-acoustic-format', {
    description: 'Akustik değil, elektronik ve yüksek tempolu performans',
  });
  const biography = make('violin-biography', {
    description: 'Sanatçı çocukluğunda keman eğitimi aldı; enerjik rock repertuvarıyla sahnede.',
  });
  const energeticStrings = make('energetic-rock-violin', {
    description: 'Enerjik rock konserinde keman performansı ve heavy metal eserleri',
  });
  const events = [
    ...ordinary,
    negatedAcoustic,
    biography,
    energeticStrings,
  ];
  const semantic = {
    queryVector: [1, 0],
    vectors: new Map(
      events.map((event) => [
        event.id,
        event.id.startsWith('format-ordinary') ? [1, 0] : [0, 1],
      ]),
    ),
  };
  const ids = new Set(
    shortlistEvents(events, 'Sakin bir akşam istiyorum', [], 16, semantic).map(
      ({ id }) => id,
    ),
  );
  assert.equal(ids.has(negatedAcoustic.id), false);
  assert.equal(ids.has(biography.id), false);
  assert.equal(ids.has(energeticStrings.id), false);
});

await test('child-show negation excludes only events with explicit child evidence', () => {
  const children = Array.from({ length: 20 }, (_, index) =>
    make(`child-${index}`, {
      title: `Çocuk Oyunu ${index}`,
      description: 'Çocuklar için kukla tiyatrosu',
      category: 'Tiyatro',
    }),
  );
  const adult = make('adult', {
    title: 'Son Mektup',
    description: 'Yetişkinlere yönelik ciddi bir oyun',
    category: 'Tiyatro',
  });
  assert.deepEqual(
    shortlistEvents(
      [...children, adult],
      'Çocuk oyunu istemiyorum, ciddi bir oyun olsun',
      [],
    ).map(({ id }) => id),
    ['adult'],
  );
});

await test('adult-play intent gates shortlist and fallback to theatre and handles child inflections', () => {
  const child = make('child-inflected', {
    category: 'Tiyatro',
    description: '4–8 yaş çocuklar ve aileleri için kukla tiyatrosu.',
  });
  const adult = make('adult-drama', {
    category: 'Tiyatro',
    description: 'Yetişkinlere yönelik ciddi ve dramatik sahne yapımı.',
  });
  const unrelated = [
    make('rock', { description: 'Rock konseri' }),
    make('comedy', { category: 'Stand-up', description: 'Komedi gösterisi' }),
  ];
  const message =
    'Çocuk oyunu istemiyorum, yetişkinlere uygun ciddi bir oyun olsun.';
  for (const retrieve of [shortlistEvents, fallbackEvents])
    assert.deepEqual(
      retrieve([child, ...unrelated, adult], message, []).map(({ id }) => id),
      ['adult-drama'],
    );
});

await test('child exclusion requires positive audience evidence and ignores negated source claims', () => {
  const titleOnly = make('title-only', {
    title: 'Çocuk Adlı Yetişkin Oyunu',
    category: 'Tiyatro',
    description: 'Yetişkin izleyicilere yönelik dramatik yapım.',
  });
  const venueOnly = make('venue-only', {
    venue: 'Çocuk Sanat Merkezi',
    category: 'Tiyatro',
    description: 'Yetişkinlere uygun ciddi oyun.',
  });
  const negated = make('negated-child', {
    category: 'Tiyatro',
    description: 'Çocuk oyunu değildir; yetişkinlere yönelik bir dramdır.',
  });
  const ids = fallbackEvents(
    [titleOnly, venueOnly, negated],
    'Çocuk oyunu istemiyorum, dramatik bir oyun olsun',
    [],
  ).map(({ id }) => id);
  assert.deepEqual(
    new Set(ids),
    new Set(['title-only', 'venue-only', 'negated-child']),
  );
});

await test('contextual theatre switch clears older concert history but alternatives retain it', () => {
  const history: Message[] = [{ role: 'user', content: 'Rock konseri olsun' }];
  const switched = searchContext(
    'Bunun yerine yetişkinlere uygun ciddi bir oyun olsun',
    history,
  );
  assert.equal(switched.category, 'Tiyatro');
  assert.equal(switched.reset, true);
  assert.deepEqual(switched.history, []);

  const alternatives = searchContext('Başka alternatifler göster', [
    { role: 'user', content: 'Dramatik bir oyun istiyorum' },
  ]);
  assert.equal(alternatives.reset, false);
  assert.equal(alternatives.category, 'Tiyatro');
  assert.equal(alternatives.query.includes('Dramatik bir oyun'), true);
});

await test('category rejection does not resurrect the same category from history', () => {
  const context = searchContext('Konser istemiyorum', [
    { role: 'user', content: 'Rock konseri istiyorum' },
  ]);
  assert.equal(context.category, null);
  assert.deepEqual(
    fallbackEvents(
      [make('concert'), make('theatre', { category: 'Tiyatro' })],
      'Konser istemiyorum',
      [{ role: 'user', content: 'Rock konseri istiyorum' }],
    ).map(({ id }) => id),
    ['theatre'],
  );
});

await test('alternatives after a history reset cannot resurrect earlier intent', () => {
  const context = searchContext('Başka seçenekler', [
    { role: 'user', content: 'Rock konseri istiyorum' },
    { role: 'user', content: 'Her kategori olur' },
  ]);
  assert.equal(context.category, null);
  assert.deepEqual(context.history, []);
  assert.equal(context.query.includes('rock'), false);
});

await test('negated contextual play followed by concert has only concert intent', () => {
  const context = searchContext('Ciddi bir oyun değil, konser istiyorum', [
    { role: 'user', content: 'Dramatik bir tiyatro oyunu istiyorum' },
  ]);
  assert.equal(context.category, 'Konser');
  assert.equal(context.reset, true);
  assert.deepEqual(context.history, []);
});

await test('retrieval category agrees with filter synonyms when switching from theatre', () => {
  const history: Message[] = [
    { role: 'user', content: 'Dramatik tiyatro istiyorum' },
  ];
  for (const [message, category] of [
    ['Techno istiyorum', 'Konser'],
    ['Elektronik olsun', 'Konser'],
  ] as const) {
    const context = searchContext(message, history);
    assert.equal(context.category, category);
    assert.equal(context.reset, true);
    assert.deepEqual(context.history, []);
  }
});

await test('electronic-music rejection stays narrower than the concert category', () => {
  const acoustic = make('acoustic-after-electronic', {
    description: 'Akustik gitarla canlı müzik',
  });
  const electronic = make('electronic-rejected', {
    description: 'Elektronik müzik ve techno',
  });
  const message = 'Elektronik müzik değil, akustik olsun';
  const context = searchContext(message, []);
  assert.equal(context.category, 'Konser');
  assert.deepEqual(context.rejectedTerms, ['elektronik muzik']);
  assert.deepEqual(
    fallbackEvents([electronic, acoustic], message, []).map(({ id }) => id),
    ['acoustic-after-electronic'],
  );
});

await test('explicit category reset clears stale history and preserves category coverage', () => {
  const history: Message[] = [
    { role: 'user', content: 'Rock konserleri göster' },
  ];
  const events = [
    ...Array.from({ length: 20 }, (_, index) =>
      make(`concert-${index}`, { title: `Rock Konseri ${index}` }),
    ),
    make('theatre', { category: 'Tiyatro', title: 'Dramatik Oyun' }),
    make('comedy', { category: 'Stand-up', title: 'Stand-up Gecesi' }),
  ];
  const context = searchContext('Her kategori olur', history);
  assert.equal(context.reset, true);
  assert.deepEqual(context.history, []);
  const categories = new Set(
    shortlistEvents(events, 'Her kategori olur', history).map(
      ({ category }) => category,
    ),
  );
  assert.deepEqual(categories, new Set(['Konser', 'Tiyatro', 'Stand-up']));
});

await test('an explicit category switch drops conflicting hidden history', () => {
  const history: Message[] = [
    { role: 'user', content: 'Yüksek sesli rock konseri istiyorum' },
    { role: 'user', content: 'Aynı koşullarda başka etkinlikler bul' },
    { role: 'assistant', content: 'Bu içerik sıralamaya girmemeli' },
  ];
  const context = searchContext('Bunun yerine tiyatro olsun', history);
  assert.equal(context.reset, true);
  assert.deepEqual(context.history, []);
  assert.equal(context.query.includes('rock'), false);
});

await test('a current positive preference overrides an older soft rejection', () => {
  const history: Message[] = [{ role: 'user', content: 'Rock istemiyorum' }];
  const context = searchContext('Şimdi rock olsun', history);
  assert.deepEqual(context.rejectedTerms, []);
  assert.deepEqual(
    fallbackEvents(
      [make('rock', { description: 'Rock konseri' })],
      'Şimdi rock olsun',
      history,
    ).map(({ id }) => id),
    ['rock'],
  );
});

await test('all explicitly contradicted candidates yield an empty safe fallback', () => {
  const rock = make('rock', { description: 'Rock konseri' });
  assert.deepEqual(fallbackEvents([rock], 'Rock istemiyorum', []), []);
  assert.deepEqual(shortlistEvents([rock], 'Rock istemiyorum', []), []);
});

await test('a source term explicitly negated by the source is not treated as evidence', () => {
  const drama = make('drama', {
    category: 'Tiyatro',
    description: 'Aile ilişkilerini ele alan dramatik oyun. Komedi değildir.',
  });
  assert.deepEqual(
    shortlistEvents(
      [drama],
      'Komedi değil, aile ilişkileri üzerine dramatik tiyatro',
      [],
    ).map(({ id }) => id),
    ['drama'],
  );
});

await test('a negated long phrase does not broaden to its nested category word', () => {
  const acoustic = make('acoustic', {
    description: 'Akustik gitarla canlı müzik performansı',
  });
  const electronic = make('electronic', {
    description: 'Elektronik müzik ve techno DJ seti',
  });
  const context = searchContext(
    'Elektronik müzik değil, akustik gitar istiyorum',
    [],
  );
  assert.deepEqual(context.rejectedTerms, ['elektronik muzik']);
  assert.deepEqual(
    shortlistEvents(
      [electronic, acoustic],
      'Elektronik müzik değil, akustik gitar istiyorum',
      [],
    ).map(({ id }) => id),
    ['acoustic'],
  );
});

await test('a humour preference searches across categories unless the user already chose one', () => {
  assert.equal(searchContext('Biraz gülelim', []).category, null);
  assert.equal(searchContext('Komedi istiyorum', []).category, null);
  assert.equal(
    searchContext('Biraz gülelim', [
      { role: 'user', content: 'Tiyatro istiyorum' },
    ]).category,
    'Tiyatro',
  );
});

await test('ranks every session before selecting the best representative of a production', () => {
  const early = make('early', {
    productionKey: 'same',
    description: 'Genel program',
    startsAt: '2026-09-26T16:00:00Z',
  });
  const late = make('late', {
    productionKey: 'same',
    description: 'Doğaçlama deneysel özgün gösteri',
    startsAt: '2026-09-26T19:00:00Z',
  });
  assert.deepEqual(
    shortlistEvents([early, late], 'Doğaçlama deneysel özgün gösteri', []).map(
      (e) => e.id,
    ),
    ['late'],
  );
});

await test('casual alternatives wording excludes earlier suggestions without mistaking a district change', () => {
  for (const message of [
    'bunları beğenmedim, başka var mı?',
    'Başka?',
    'Anything else?',
    'Something else please',
  ]) {
    assert.equal(isAlternativesRequest(message), true, message);
  }
  assert.equal(isAlternativesRequest('Başka bir semtte konser'), false);
  assert.equal(isAlternativesRequest('Başka bir gün olsun'), false);
});

await test('full reset clears older intent but retains new preferences in that turn for follow-ups', () => {
  const history = [
    {
      role: 'user' as const,
      content: 'Pazar tiyatro veya stand-up, biraz gülelim.',
    },
  ];
  const reset =
    'Baştan başlayalım, önceki şartları unut. Cuma bir caz konseri istiyorum.';
  assert.deepEqual(searchContext(reset, history).history, []);
  const next = searchContext('Başka var mı?', [
    ...history,
    { role: 'user', content: reset },
  ]);
  assert.equal(next.query.includes('Pazar tiyatro'), false);
  assert.equal(next.query.includes('caz konseri'), true);
  assert.equal(next.category, 'Konser');
});

await test('positive inflected category clears stale category rejection without clearing genre exclusions', () => {
  const context = searchContext('Konserde olabilir aslında', [
    { role: 'user', content: 'Konser istemiyorum' },
  ]);
  assert.equal(context.category, 'Konser');
  assert.equal(context.rejectedTerms.includes('konser'), false);
  const genre = searchContext('Konser olabilir', [
    { role: 'user', content: 'Rock istemiyorum' },
  ]);
  assert.equal(genre.rejectedTerms.includes('rock'), true);
});
