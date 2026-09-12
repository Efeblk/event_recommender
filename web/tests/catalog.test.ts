import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceOf, validateImport } from '../lib/catalog.ts';
import { parseEvents } from '../lib/source.ts';
import { uniqueEvents, isEligible } from '../lib/search.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';
const now = new Date('2026-09-09T09:00:00Z');
const event: EventRecord = {
  id: 'one',
  title: 'Bir konser',
  description: '',
  venue: 'Sahne',
  startsAt: '2026-09-12T18:00:00.000Z',
  checkedAt: now.toISOString(),
  city: 'İstanbul',
  district: '',
  address: '',
  price: 500,
  currency: 'TRY',
  url: 'https://www.bubilet.com.tr/istanbul/etkinlik/test',
  imageUrl: '',
  category: 'Konser',
  availability: 'available',
  source: 'bubilet',
};
const envelope = (e: EventRecord) => ({
  schemaVersion: 1,
  pages: [{ url: e.url, events: [e] }],
});
await test('import accepts verified source fields but strips arbitrary metadata', () => {
  const result = validateImport(
    envelope({ ...event, surprise: 'untrusted' } as EventRecord),
    now,
  );
  assert.equal(result[0].events[0].title, 'Bir konser');
  assert.equal('surprise' in result[0].events[0], false);
});
await test('import rejects foreign sources, duplicate IDs, empty pages and stale dates', () => {
  assert.equal(
    sourceOf('https://www.bubilet.com.tr:8443/istanbul/etkinlik/test'),
    null,
  );
  for (const change of [
    { checkedAt: '2026-09-01T09:00:00.000Z' },
    { checkedAt: '2026-09-10T09:00:00.000Z' },
    { startsAt: '2026-09-12T18:00:00' },
    { url: 'https://evil.example/event' },
    { source: 'biletix' },
    { price: 99999 },
    { price: -1 },
    { city: 'Ankara' },
  ])
    assert.throws(() =>
      validateImport(envelope({ ...event, ...change } as EventRecord), now),
    );
  assert.throws(() =>
    validateImport(
      { schemaVersion: 1, pages: [{ url: event.url, events: [] }] },
      now,
    ),
  );
  assert.throws(() =>
    validateImport(
      { schemaVersion: 1, pages: [{ url: event.url, events: [event, event] }] },
      now,
    ),
  );
});
await test('unknown offer availability remains unknown and ineligible', async () => {
  const node = {
    '@type': 'Event',
    name: event.title,
    startDate: event.startsAt,
    location: { name: event.venue, address: { addressLocality: 'İstanbul' } },
    offers: { price: 500, priceCurrency: 'TRY' },
  };
  const [parsed] = await parseEvents(
    `<script type="application/ld+json">${JSON.stringify(node)}</script>`,
    event.url,
    'Konser',
    now,
  );
  assert.equal(parsed.availability, 'unknown');
  assert.equal(isEligible(parsed, emptyFilters, now), false);
});
await test('exact cross-source production matches appear once in recommendations', () => {
  const first = { ...event, productionKey: 'same' },
    other = {
      ...event,
      id: 'two',
      url: 'https://www.biletix.com/etkinlik/ABC/ISTANBUL/tr',
      productionKey: 'same',
    };
  assert.equal(uniqueEvents([first, other]).length, 1);
  assert.equal(
    uniqueEvents([first, { ...other, productionKey: 'different' }]).length,
    2,
  );
});
