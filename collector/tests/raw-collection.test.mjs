import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRawCollectionManifest } from '../raw/collection.mjs';
const startedAt = '2026-10-02T10:00:00.000Z';
const ref = { sha256: 'a'.repeat(64), key: `bodies/${'a'.repeat(64)}.bin`, bytes: 10 };
const inventory = [
  { provider: 'biletix', url: 'https://www.biletix.com/etkinlik/ONE/ISTANBUL/tr', category: 'Konser' },
  { provider: 'bubilet', url: 'https://www.bubilet.com.tr/istanbul/etkinlik/two' },
  { provider: 'biletinial', url: 'https://biletinial.com/tr-tr/tiyatro/three' },
];
test('raw handoff preserves fresh provenance and does not promote zero records or historical inventory', () => {
  const receipts = new Map([
    [inventory[0].url, { status: 'verified', observedAt: startedAt, rawObjectRef: ref,
      supplementaryRawObservations: [{ url: 'https://www.biletix.com/data', fetchedAt: '2026-10-02T09:59:00Z', rawObjectRef: ref }] }],
    [inventory[1].url, { status: 'quarantined', observedAt: startedAt, rawObjectRef: ref }],
    ['https://www.biletix.com/historical', { status: 'verified', observedAt: startedAt, rawObjectRef: ref }],
  ]);
  const input = { startedAt, collectorRevision: 'offline-fixture', inventory, receipts };
  const result = buildRawCollectionManifest(input);
  assert.equal(result.scope, 'partial');
  assert.equal(result.horizon, null);
  assert.deepEqual(Object.fromEntries(result.pages.map(page => [page.url, page.status])), {
    [inventory[2].url]: 'unvisited', [inventory[0].url]: 'verified', [inventory[1].url]: 'quarantined',
  });
  assert.equal(result.pages.find(page => page.status === 'verified').supplementaryRawObservations[0].fetchedAt, '2026-10-02T09:59:00Z');
  assert.equal(result.inventory.length, 3);
  assert.equal(result.id, buildRawCollectionManifest({ ...input, inventory: [...inventory].reverse() }).id);
});
test('raw handoff rejects a successful page without retained bytes', () => {
  assert.throws(() => buildRawCollectionManifest({ startedAt, collectorRevision: 'offline', inventory,
    receipts: new Map([[inventory[0].url, { status: 'verified', observedAt: startedAt }]]) }), /missing its body/);
});
