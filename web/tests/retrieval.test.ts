import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fallbackEvents,
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
