import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { buildGraphProjection, EXPECTED_VECTOR_PROFILE } from '../experiments/graph/model.ts';
import type { EventRecord } from '../lib/types.ts';

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  const documentText = 'Title: Same Show\nVenue: Stage One';
  return { id: 'raw-1', title: 'Same Show', description: 'Description', startsAt: '2026-10-02T17:00:00.000Z',
    venue: 'Stage One', city: 'Istanbul', district: 'Beyoglu', address: 'Taksim Meydani 1', price: 100,
    currency: 'TRY', url: 'https://example.test/1', imageUrl: '', category: 'Tiyatro', availability: 'available',
    source: 'biletix', checkedAt: '2026-09-29T10:00:00.000Z', canonicalProductionKey: 'production-supported',
    preparedSearch: { version: 1, documentText, documentHash: createHash('sha256').update(documentText).digest('hex'), lexicalTokens: ['same', 'show'] },
    offers: [{ id: 'offer-1', source: 'biletix', url: 'https://example.test/1', price: 100, currency: 'TRY',
      checkedAt: '2026-09-29T10:00:00.000Z', category: 'Tiyatro', venue: 'Stage One', availability: 'available', sourceSessionIds: ['abc'] }],
    ...overrides };
}

await test('same-title sessions stay distinct and conservatively identify venues', () => {
  const graph = buildGraphProjection([event(), event({ id: 'raw-2', startsAt: '2026-10-03T18:00:00.000Z', venue: 'Stage Two', address: 'Other address', canonicalProductionKey: undefined })], { profile: EXPECTED_VECTOR_PROFILE, entries: [] });
  assert.equal(graph.sessions.length, 2);
  assert.equal(graph.venues.length, 2);
  assert.equal(graph.programs.length, 2);
  assert.notEqual(graph.sessions[0].programId, graph.sessions[1].programId);
  assert.deepEqual({ day: graph.sessions[0].localDay, minutes: graph.sessions[0].localMinutes }, { day: '2026-10-02', minutes: 20 * 60 });
});

await test('all exact offers and their source evidence survive projection', () => {
  const second = { ...event().offers![0], id: 'offer-2', source: 'bubilet' as const, url: 'https://example.test/2', price: 125, sourceSessionIds: ['xyz'] };
  const source = event({ offers: [event().offers![0], second] });
  const graph = buildGraphProjection([source], { profile: EXPECTED_VECTOR_PROFILE, entries: [] });
  assert.deepEqual(graph.offers.map(({ id, url, price, sourceSessionIds }) => ({ id, url, price, sourceSessionIds })), [
    { id: 'offer-1', url: 'https://example.test/1', price: 100, sourceSessionIds: ['abc'] },
    { id: 'offer-2', url: 'https://example.test/2', price: 125, sourceSessionIds: ['xyz'] },
  ]);
  assert.deepEqual(JSON.parse(graph.offers[1].eventJSON), second);
});

await test('cached embedding attaches to its exact document hash and profile', () => {
  const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 0.125 : 0);
  const hash = event().preparedSearch!.documentHash;
  const graph = buildGraphProjection([event()], { profile: EXPECTED_VECTOR_PROFILE, entries: [{ hash, vector }] });
  assert.equal(graph.documents[0].documentHash, hash);
  assert.equal(graph.documents[0].embeddingProfile, EXPECTED_VECTOR_PROFILE);
  assert.deepEqual(graph.documents[0].embedding, vector);
  assert.equal(graph.documents[0].documentText.includes('Venue: Stage One'), true);
  assert.equal(graph.relations.some((row) => row.type === 'DESCRIBES_SESSION' && row.toId === `document:${hash}`), true);
});

await test('Taksim enrichment requires venue or address evidence and conflicts remain unknown', () => {
  const graph = buildGraphProjection([
    event({ id: 'direct', address: 'Taksim Meydani 1' }),
    event({ id: 'district-only', venue: 'Stage B', address: 'Unrelated address', district: 'Taksim' }),
    event({ id: 'moda-kadikoy', venue: 'Moda Sahnesi', address: 'Caferaga, Kadikoy', district: 'Kadikoy' }),
    event({ id: 'conflict', venue: 'Moda Sahnesi', address: 'Taksim Meydani 2' }),
  ], { profile: EXPECTED_VECTOR_PROFILE, entries: [] });
  const venues = Object.fromEntries(graph.sessions.map((session) => [session.id, graph.venues.find((venue) => venue.id === session.venueId)!]));
  assert.equal(venues.direct.neighborhoodStatus, 'source_backed');
  assert.equal(graph.neighborhoods.find((row) => row.id === venues.direct.neighborhoodId)?.name, 'Taksim');
  assert.equal(venues['district-only'].neighborhoodStatus, 'unknown');
  assert.equal(graph.neighborhoods.find((row) => row.id === venues['moda-kadikoy'].neighborhoodId)?.name, 'Moda');
  assert.equal(venues.conflict.neighborhoodStatus, 'unknown');
});

await test('invalid vector provenance is rejected before reuse', () => {
  const source = event();
  const hash = source.preparedSearch!.documentHash;
  const vector = Array.from({ length: 1024 }, (_, index) => index === 0 ? 1 : 0);
  assert.throws(() => buildGraphProjection([source], { profile: 'wrong', entries: [] }), /Unexpected vector profile/);
  assert.throws(() => buildGraphProjection([source], { profile: EXPECTED_VECTOR_PROFILE, entries: [{ hash, vector: [1, 2] }] }), /Invalid vector/);
  assert.throws(() => buildGraphProjection([source], { profile: EXPECTED_VECTOR_PROFILE, entries: [{ hash, vector }, { hash, vector: vector.map((value, index) => index === 0 ? value + 1 : value) }] }), /Conflicting vectors/);
  assert.throws(() => buildGraphProjection([event({ preparedSearch: { ...source.preparedSearch!, documentHash: 'bad' } })], { profile: EXPECTED_VECTOR_PROFILE, entries: [] }), /hash mismatch/);
});
