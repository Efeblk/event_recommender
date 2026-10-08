import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_EVENT_PRICE,
  MAX_IMPORT_TRANSIT_GRACE_MS,
  publicEventRecord,
  sourceOf,
  validateImport,
} from '../lib/catalog.ts';
import { parseEvents } from '../lib/source.ts';
import { uniqueEvents, isEligible } from '../lib/search.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';
import { expectedProviderListingId } from '../../contracts/listing.ts';
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
await test('import preserves validated retained venue evidence and rejects listing/event disagreement', () => {
  const rawDescription = `<p>${'A'.repeat(5100)}</p>`;
  const attendanceTiming = {
    kind: 'timed_session' as const,
    evidence: 'provider_sessions_and_source_text' as const,
  };
  const listing: NonNullable<EventRecord['providerListing']> = {
    contractVersion: 'provider-listing.v1', listingId: 'a'.repeat(64), provider: 'bubilet', providerSessionIds: ['123'],
    url: event.url, title: ' Bir <b>konser</b> ', description: rawDescription, category: 'MÃ¼zik', startsAt: event.startsAt,
    timezoneEvidence: { kind: 'explicit_offset', sourceValue: event.startsAt },
    venue: { name: '<b>Sahne</b>', providerVenueId: 'venue-1', district: '<i>KadÄ±kÃ¶y</i>', address: ' Moda   Cd. 1 ', geo: { lat: 41, lon: 29 } },
    tiers: [{ price: 500, currency: 'TRY', availability: 'available' }], availability: 'available', observedAt: event.checkedAt,
    extractorVersion: 'bubilet-provider-listing.v1', rawObjectRef: { sha256: 'b'.repeat(64), key: `bodies/${'b'.repeat(64)}.bin`, bytes: 100 },
    attendanceTiming,
  };
  listing.listingId = expectedProviderListingId(listing);
  const record: EventRecord = {
    ...event,
    id: listing.listingId.slice(0, 24),
    description: 'A'.repeat(5000),
    district: 'KadÄ±kÃ¶y',
    address: 'Moda Cd. 1',
    sourceSessionIds: ['123'],
    sourceCategory: 'MÃ¼zik',
    sourceVersion: 'provider-listing.v1',
    extraction: listing.extractorVersion,
    attendanceTiming,
    providerListing: listing,
  };
  assert.deepEqual(validateImport(envelope(record), now)[0].events[0].providerListing?.venue.geo, { lat: 41, lon: 29 });
  assert.throws(() => validateImport(envelope({ ...record, providerListing: { ...listing, startsAt: '2026-09-13T18:00:00.000Z' } }), now), /does not match/);
  assert.throws(() => validateImport(envelope({ ...record, providerListing: { ...listing, rawObjectRef: { ...listing.rawObjectRef, key: '../foreign' } } }), now), /raw object/);

  for (const change of [
    { description: 'different' },
    { category: 'Tiyatro' },
    { district: 'BeÅŸiktaÅŸ' },
    { address: 'different' },
    { city: 'Ankara' },
    { sourceSessionIds: ['456'] },
    { attendanceTiming: { kind: 'unknown', evidence: 'insufficient_source_evidence' } },
  ] as Partial<EventRecord>[])
    assert.throws(
      () => validateImport(envelope({ ...record, ...change }), now),
      /does not match/,
    );

  const richerVenueEvidence = {
    ...listing,
    venue: {
      ...listing.venue,
      providerVenueId: 'venue-2',
      geo: { lat: 41.0001, lon: 29.0001 },
    },
  };
  assert.equal(
    validateImport(
      envelope({ ...record, providerListing: richerVenueEvidence }),
      now,
    )[0].events[0].providerListing?.venue.providerVenueId,
    'venue-2',
  );

  const publicRecord = publicEventRecord({
    ...record,
    preparedSearch: {
      version: 1,
      documentText: 'private prepared document',
      documentHash: 'c'.repeat(64),
      lexicalTokens: ['private'],
    },
  });
  assert.equal(publicRecord.providerListing, undefined);
  assert.equal(publicRecord.preparedSearch, undefined);
  assert.equal(JSON.stringify(publicRecord).includes(listing.rawObjectRef.key), false);
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
    { startsAt: new Date(now.getTime() + 731 * 86400000).toISOString() },
    { url: 'https://evil.example/event' },
    { source: 'biletix' },
    { price: MAX_EVENT_PRICE + 1 },
    { price: Number.POSITIVE_INFINITY },
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
await test('import accepts only fresh explicit source retirements', () => {
  const retirement = { url: event.url, events: [], retiredAt: now.toISOString() };
  assert.deepEqual(validateImport({ schemaVersion: 1, pages: [retirement] }, now), [retirement]);
  for (const retiredAt of [undefined, '', 'invalid', '2026-09-01T09:00:00.000Z', '2026-09-10T09:00:00.000Z'])
    assert.throws(() => validateImport({ schemaVersion: 1, pages: [{ ...retirement, retiredAt }] }, now));
  assert.throws(() => validateImport({ schemaVersion: 1, pages: [{ ...retirement, events: [event] }] }, now));
});
await test('import preserves validated admission semantics and rejects malformed bounds', () => {
  const attendanceTiming = { kind: 'admission_window' as const, evidence: 'provider_flexible_window' as const,
    validFrom: '2026-09-01T07:00:00.000Z', validThrough: '2026-09-30T14:00:00.000Z' };
  const imported = validateImport(envelope({ ...event, attendanceTiming }), now)[0].events[0];
  assert.deepEqual(imported.attendanceTiming, attendanceTiming);
  assert.throws(() => validateImport(envelope({ ...event, attendanceTiming: {
    ...attendanceTiming, validThrough: '2026-08-01T07:00:00.000Z',
  } }), now));
});
await test('import accepts legitimate high TRY prices within safe cent representation', () => {
  assert.equal(validateImport(envelope({ ...event, title: 'Global Marketing Summit', price: 59400 }), now)[0].events[0].price, 59400);
  assert.equal(validateImport(envelope({ ...event, price: MAX_EVENT_PRICE }), now)[0].events[0].price, MAX_EVENT_PRICE);
});
await test('import grace retains an atomic page crossing the start boundary while queries stay strict', () => {
  const justStarted = {
    ...event,
    id: 'just-started',
    startsAt: new Date(now.getTime() - MAX_IMPORT_TRANSIT_GRACE_MS).toISOString(),
  };
  const future = {
    ...event,
    id: 'future',
    startsAt: new Date(now.getTime() + 3600000).toISOString(),
  };
  const imported = validateImport({
    schemaVersion: 1,
    pages: [{ url: event.url, events: [justStarted, future] }],
  }, now);
  assert.deepEqual(imported[0].events.map(({ id }) => id), ['just-started', 'future']);
  assert.equal(isEligible(imported[0].events[0], emptyFilters, now), false);
  assert.equal(isEligible(imported[0].events[1], emptyFilters, now), true);
  assert.throws(() => validateImport(envelope({
    ...event,
    startsAt: new Date(now.getTime() - MAX_IMPORT_TRANSIT_GRACE_MS - 1).toISOString(),
  }), now), /Invalid event freshness/);
});
await test('import retains an atomic 314-session page within bounded page and envelope limits', () => {
  const sessions = Array.from({ length: 314 }, (_, index) => ({
    ...event,
    id: `session-${index}`,
    startsAt: new Date(Date.parse(event.startsAt) + index * 60000).toISOString(),
  }));
  const [page] = validateImport({ schemaVersion: 1, pages: [{ url: event.url, events: sessions }] }, now);
  assert.equal(page.events.length, 314);
  assert.deepEqual(page.events.map(item => item.id), sessions.map(item => item.id));

  const oversized = Array.from({ length: 1001 }, (_, index) => ({ ...event, id: `oversized-${index}` }));
  assert.throws(() => validateImport({ schemaVersion: 1, pages: [{ url: event.url, events: oversized }] }, now), /Invalid source page/);

  const pages = Array.from({ length: 3 }, (_, pageIndex) => {
    const url = `https://www.bubilet.com.tr/istanbul/etkinlik/envelope-${pageIndex}`;
    return {
      url,
      events: Array.from({ length: 667 }, (_, eventIndex) => ({
        ...event,
        id: `envelope-${pageIndex}-${eventIndex}`,
        url,
      })),
    };
  });
  assert.throws(() => validateImport({ schemaVersion: 1, pages }, now), /Invalid event/);
});
await test('import accepts only fresh, exclusive source-evidence quarantines', () => {
  const quarantine = { url: event.url, events: [], quarantinedAt: now.toISOString(), quarantineReason: 'session_time_conflict' };
  assert.deepEqual(validateImport({ schemaVersion: 1, pages: [quarantine] }, now), [quarantine]);
  const availability = { ...quarantine, quarantineReason: 'session_availability_conflict' };
  assert.deepEqual(validateImport({ schemaVersion: 1, pages: [availability] }, now), [availability]);
  const venue = { ...quarantine, quarantineReason: 'venue_conflict' };
  assert.deepEqual(validateImport({ schemaVersion: 1, pages: [venue] }, now), [venue]);
  for (const change of [
    { quarantineReason: 'other' },
    { quarantinedAt: undefined },
    { quarantinedAt: 'invalid' },
    { retiredAt: now.toISOString() },
    { events: [event] },
  ]) assert.throws(() => validateImport({ schemaVersion: 1, pages: [{ ...quarantine, ...change }] }, now));
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
await test('JSON-LD preserves high safe TRY prices and rejects unsafe numeric prices', async () => {
  const parsePrice = async (price: unknown) => {
    const node = {
      '@type': 'Event',
      name: event.title,
      startDate: event.startsAt,
      location: { name: event.venue, address: { addressLocality: 'istanbul' } },
      offers: {
        price,
        priceCurrency: 'TRY',
        availability: 'https://schema.org/InStock',
      },
    };
    return (await parseEvents(
      `<script type="application/ld+json">${JSON.stringify(node)}</script>`,
      event.url,
      'Konser',
      now,
    ))[0];
  };
  assert.equal((await parsePrice(150000.25)).price, 150000.25);
  assert.equal((await parsePrice(Number.MAX_SAFE_INTEGER / 100)).price, Number.MAX_SAFE_INTEGER / 100);
  assert.equal((await parsePrice('Infinity')).price, null);
  assert.equal((await parsePrice(Number.MAX_SAFE_INTEGER / 100 + 1)).price, null);
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
