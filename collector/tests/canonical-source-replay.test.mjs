import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalRecordsFrom, replayCanonicalRecords } from '../preparation/run-canonical-source.mjs';

const record = id => ({ id, source: 'bubilet', sourceSessionIds: [id], title: `Oyun ${id}`, description: 'Dostluk üzerine bir oyun.',
  venue: 'Sahne', district: 'Kadıköy', address: 'Moda Caddesi', city: 'İstanbul', category: 'Tiyatro',
  startsAt: '2026-10-03T17:00:00.000Z', checkedAt: '2026-09-30T10:00:00.000Z', attendanceTiming: null,
  price: 19.99, currency: 'TRY', availability: 'available', url: `https://www.bubilet.com.tr/istanbul/etkinlik/${id}`, imageUrl: '' });

function memoryStore(overrides = {}) {
  const calls = { heads: [], accepts: [] };
  return { calls, findHeads: async value => { calls.heads.push(value.id); return []; },
    accept: async payload => { calls.accepts.push(payload.requestId); return { status: 'accepted', revisionId: `revision-${payload.record.id}` }; }, ...overrides };
}

test('bounded replay checkpoints every new decision and skips prior decisions without database calls', async () => {
  const records = [record('one'), record('two'), record('three')], store = memoryStore(), checkpoints = [];
  const first = await replayCanonicalRecords(records, { store, limit: 1, checkpoint: receipt => checkpoints.push(receipt) });
  assert.equal(first.processed, 1); assert.equal(first.remaining, 2); assert.equal(checkpoints.length, 1);
  const secondStore = memoryStore();
  const second = await replayCanonicalRecords(records, { store: secondStore, receipt: first.receipt, limit: 1 });
  assert.equal(second.replayed, 1); assert.equal(second.processed, 1); assert.equal(second.remaining, 1);
  assert.deepEqual(secondStore.calls.heads, ['two']);
});

test('crash after database commit but before checkpoint replays the same deterministic request', async () => {
  const records = [record('lost-response')], accepted = [];
  const store = memoryStore({ accept: async payload => { accepted.push(payload.requestId); return { status: 'accepted', idempotent: accepted.length > 1 }; } });
  await assert.rejects(replayCanonicalRecords(records, { store, checkpoint: async () => { throw new Error('disk unavailable'); } }), /disk unavailable/);
  const replay = await replayCanonicalRecords(records, { store });
  assert.equal(accepted.length, 2); assert.equal(new Set(accepted).size, 1);
  assert.equal(replay.decisions[0].idempotent, true);
});

test('an abort between records preserves the checkpoint and leaves new records remaining', async () => {
  const controller = new AbortController(), store = memoryStore();
  const result = await replayCanonicalRecords([record('one'), record('two')], {
    store, signal: controller.signal, checkpoint: async () => controller.abort(),
  });
  assert.equal(result.processed, 1); assert.equal(result.remaining, 1); assert.equal(result.interrupted, true);
  assert.deepEqual(store.calls.heads, ['one']);
});

test('receipt provenance permits exact replay and rejects changed input or adapter metadata', async () => {
  const records = [record('one')];
  const first = await replayCanonicalRecords(records, { store: memoryStore() });
  const exactStore = memoryStore();
  const exact = await replayCanonicalRecords(records, { store: exactStore, receipt: first.receipt });
  assert.equal(exact.replayed, 1); assert.deepEqual(exactStore.calls.heads, []);
  await assert.rejects(replayCanonicalRecords([{ ...records[0], title: 'Changed' }], { store: memoryStore(), receipt: first.receipt }), /incompatible/);
  await assert.rejects(replayCanonicalRecords(records, { store: memoryStore(), receipt: { ...first.receipt, adapterVersion: 'future' } }), /incompatible/);
});

test('malformed reports are rejected rather than silently treated as empty pages', () => {
  assert.deepEqual(canonicalRecordsFrom([record('one')]).length, 1);
  assert.deepEqual(canonicalRecordsFrom({ pages: [{ events: [record('one')] }, { events: [record('two')] }] }).length, 2);
  assert.throws(() => canonicalRecordsFrom({ pages: [{}] }), /events array/);
  assert.throws(() => canonicalRecordsFrom({ pages: 'bad' }), /EventRecord/);
});

test('unsafe replay limits fail before any database access', async () => {
  for (const limit of [0, 101, 1.5, Number.NaN]) {
    const store = memoryStore();
    await assert.rejects(replayCanonicalRecords([record('one')], { store, limit }), /between 1 and 100/);
    assert.deepEqual(store.calls.heads, []);
  }
});

test('quarantined and database-held decisions retain the original normalized evidence', async () => {
  const invalid = { ...record('bad'), city: 'Ankara' };
  const quarantined = await replayCanonicalRecords([invalid], { store: memoryStore() });
  assert.deepEqual(quarantined.decisions[0].sourceRecord, invalid);
  const heldRecord = record('held');
  const held = await replayCanonicalRecords([heldRecord], { store: memoryStore({ accept: async () => ({ status: 'held', reason: 'head_changed' }) }) });
  assert.deepEqual(held.decisions[0].sourceRecord, heldRecord);
});
