import test from 'node:test';
import assert from 'node:assert/strict';
import {
  jsonLd,
  listingUrls,
  parseEvents,
  safeSourceUrl,
} from '../lib/source.ts';
const now = new Date('2026-09-07T09:00:00Z'),
  url = 'https://biletinial.com/tr-tr/muzik/test';
const source = {
  '@type': 'MusicEvent',
  name: 'Konser',
  startDate: '2026-09-12T21:00:00+03:00',
  location: { name: 'Sahne', address: { addressLocality: 'İstanbul Avrupa' } },
  offers: {
    price: 750,
    priceCurrency: 'TRY',
    availability: 'https://schema.org/InStock',
  },
};
const html = (value: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
await test('JSON-LD traverses graph and arrays, ignores broken blocks', () =>
  assert.equal(
    jsonLd(
      html({ '@graph': [source] }) +
        '<script type="application/ld+json">oops</script>',
    ).filter((e) => e.name === 'Konser').length,
    1,
  ));
await test('safe listing allows only supported source event links', () => {
  assert.equal(safeSourceUrl('https://evil.test/tr-tr/muzik/event'), null);
  assert.equal(safeSourceUrl('javascript:alert(1)'), null);
  assert.equal(safeSourceUrl('http://biletinial.com/tr-tr/muzik/event'), null);
  assert.deepEqual(
    listingUrls(
      html({
        itemListElement: [{ url }, { url }, { url: 'https://evil.test' }],
      }),
    ),
    [url],
  );
});
await test('source extraction normalizes time, stable IDs and per-session offers', async () => {
  const [e] = await parseEvents(html(source), url, 'Konser', now);
  assert.equal(e.startsAt, '2026-09-12T18:00:00.000Z');
  assert.equal(e.price, 750);
  assert.equal(e.city, 'İstanbul');
  assert.equal(e.checkedAt, now.toISOString());
  const [again] = await parseEvents(html(source), url, 'Konser', now);
  assert.equal(e.id, again.id);
});
await test('out-of-city and unknown dates are never inferred', async () => {
  for (const patch of [
    { location: { name: 'Sahne', address: { addressLocality: 'Ankara' } } },
    { startDate: 'Eylül 12' },
    { startDate: '2026-09-12T21:00:00' },
    { startDate: '2026-02-30T21:00:00+03:00' },
    { startDate: '2025-09-12T21:00:00+03:00' },
  ])
    assert.equal(
      (await parseEvents(html({ ...source, ...patch }), url, 'Konser', now))
        .length,
      0,
    );
});
await test('missing price stays null, zero is genuinely free', async () => {
  for (const [price, expected] of [
    [undefined, null],
    [null, null],
    ['', null],
    [0, 0],
    [-5, null],
  ]) {
    const [e] = await parseEvents(
      html({ ...source, offers: { ...source.offers, price } }),
      url,
      'Konser',
      now,
    );
    assert.equal(e.price, expected);
  }
});
await test('sold out and cancellation are preserved for removal from results', async () => {
  const [e] = await parseEvents(
    html({
      ...source,
      offers: { ...source.offers, availability: 'https://schema.org/SoldOut' },
    }),
    url,
    'Konser',
    now,
  );
  assert.equal(e.availability, 'sold_out');
  const [c] = await parseEvents(
    html({ ...source, eventStatus: 'https://schema.org/EventCancelled' }),
    url,
    'Konser',
    now,
  );
  assert.equal(c.availability, 'cancelled');
});
await test('stand-up listed under theatre is classified as stand-up', async () => {
  const [e] = await parseEvents(
    html({ ...source, name: 'Bir Stand Up' }),
    url,
    'Tiyatro',
    now,
  );
  assert.equal(e.category, 'Stand-up');
});
