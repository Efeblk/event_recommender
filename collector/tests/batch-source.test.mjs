import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { batchInputHash, ingestBatchSource, validateBatchEnvelope } from '../preparation/batch-source.mjs';
import { canonicalRequestId } from '../preparation/canonical-adapter.mjs';
import { createBatchSourceStore } from '../preparation/batch-source-store.mjs';

const sosyalFamily = JSON.parse(await readFile(new URL('./fixtures/social-sanathane-family.json', import.meta.url), 'utf8'));

const event = (id, changes = {}) => ({ id, source: 'bubilet', sourceSessionIds: [id], title: `Oyun ${id}`, description: 'Bir oyun.',
  venue: 'Sahne', district: 'Kadıköy', address: 'Moda Caddesi', city: 'İstanbul', category: 'Tiyatro',
  startsAt: '2026-10-03T17:00:00.000Z', checkedAt: '2026-09-30T10:00:00.000Z', attendanceTiming: null,
  price: 100, currency: 'TRY', availability: 'available', url: `https://www.bubilet.com.tr/istanbul/etkinlik/${id}`, imageUrl: '', ...changes });
function envelope(records, coverageChanges = {}, headerChanges = {}) {
  const value = { header: { batchId: 'batch-1', collectionRunId: 'run-1', scope: 'full', providers: ['bubilet'],
    horizonStart: '2026-09-30T00:00:00.000Z', horizonEnd: '2026-10-30T00:00:00.000Z', ...headerChanges }, records,
    collectorCoverage: { complete: true, failedPages: 0, unvisited: 0, finishedAt: '2026-09-29T11:00:00.000Z',
      inventory: [{ provider: 'bubilet', discovered: records.length, verified: records.length, retired: 0, quarantined: 0, unvisited: 0, failedPages: 0 }], ...coverageChanges } };
  value.header.inputHash = batchInputHash(value); return value;
}
function stores({ loseOnce = false, abort } = {}) {
  const items = new Map(), calls = { begin: 0, checkpoints: 0, heads: 0, headRecords: [], seal: 0, publish: 0 }; let lost = false;
  const save = async (requestId, result) => {
    if (items.has(requestId)) return { ...items.get(requestId), idempotent: true };
    items.set(requestId, result); abort?.();
    if (loseOnce && !lost) { lost = true; throw new Error('lost response'); }
    return result;
  };
  return { calls, items, canonicalStore: { findHeads: async record => { calls.heads++; calls.headRecords.push(record); return [{ sessionId: record.id,
    canonicalRevisionId: `head-${calls.heads}`, offerRevisionId: `offer-${calls.heads}` }]; } }, batchStore: {
    begin: async header => { calls.begin++; return { batchId: header.batchId, status: 'collecting', idempotent: calls.begin > 1 }; },
    checkpoints: async batchId => { calls.checkpoints++; return [...items.values()].map(receipt => ({ requestId: receipt.requestId, status: receipt.status, receipt: { ...receipt, batchId } })); },
    accept: async (batchId, payload) => save(payload.requestId, { batchId, requestId: payload.requestId, status: 'accepted', idempotent: false }),
    quarantine: async (batchId, requestId, _record, reason) => save(requestId, { batchId, requestId, status: 'quarantined', reason, idempotent: false }),
    seal: async (_batch, receipt) => { calls.seal++; return { status: items.size === receipt.recordCount && [...items.values()].every(x => x.status === 'accepted') ? 'sealed' : 'blocked' }; },
  } };
}

test('durable batch lookup uses reviewed canonical identity while the envelope remains source-exact', async () => {
  const source = sosyalFamily.sameSession[0];
  const value = envelope([source]), fake = stores();
  await ingestBatchSource(value, fake);
  assert.equal(value.records[0].title, source.title);
  assert.equal(fake.calls.headRecords[0].title, 'Sosyal Sanathane Karma Workshop');
  assert.equal(fake.calls.headRecords[0].district, 'Kadıköy');
  assert.equal(fake.calls.headRecords[0].sourceObservedPresentation.title, source.title);
});

test('validates the complete hash and coverage envelope before any database call', async () => {
  const value = envelope([event('one')]), fake = stores(); value.collectorCoverage.inventory[0].verified = 0;
  await assert.rejects(ingestBatchSource(value, fake), /coverage|hash/); assert.equal(fake.calls.begin, 0);
  const corrupt = envelope([event('one')]); corrupt.records[0].title = 'changed after hashing';
  await assert.rejects(ingestBatchSource(corrupt, fake), /hash mismatch/); assert.equal(fake.calls.begin, 0);
  assert.throws(() => validateBatchEnvelope(envelope(Array.from({ length: 20001 }, (_, i) => event(String(i))))), /20000/);
  const invalidDay = envelope([event('one')], {}, { horizonStart: '2026-02-30T00:00:00.000Z' });
  invalidDay.header.inputHash = batchInputHash(invalidDay);
  assert.throws(() => validateBatchEnvelope(invalidDay), /horizonStart/);
  const future = envelope([event('one')]); future.collectorCoverage.finishedAt = '2026-09-30T12:06:00.000Z';
  future.header.inputHash = batchInputHash(future);
  assert.throws(() => validateBatchEnvelope(future, { now: () => new Date('2026-09-30T12:00:00.000Z') }), /future collector/);
});

test('lost accept response resumes with the same request while changed CAS heads remain replay-safe', async () => {
  const value = envelope([event('one')]), fake = stores({ loseOnce: true });
  await assert.rejects(ingestBatchSource(value, fake), /lost response/);
  const result = await ingestBatchSource(value, fake);
  assert.equal(fake.calls.heads, 1); assert.equal(fake.calls.checkpoints, 2); assert.equal(fake.items.size, 1); assert.equal(result.replayed, 1);
  assert.equal(result.processed, 0); assert.equal(result.sealed, true);
});

test('durable replay receipts do not consume the bounded new-record allowance', async () => {
  const value = envelope([event('one'), event('two'), event('three')]), fake = stores();
  const first = await ingestBatchSource(value, { ...fake, limit: 1 });
  assert.equal(first.processed, 1); assert.equal(first.remaining, 2); assert.equal(fake.calls.seal, 0);
  const second = await ingestBatchSource(value, { ...fake, limit: 1 });
  assert.equal(second.replayed, 1); assert.equal(second.processed, 1); assert.equal(second.remaining, 1);
  const third = await ingestBatchSource(value, { ...fake, limit: 1 });
  assert.equal(third.replayed, 2); assert.equal(third.processed, 1); assert.equal(third.sealed, true);
  assert.equal(fake.calls.checkpoints, 3); assert.equal(fake.calls.heads, 3);
  assert.equal(fake.calls.publish, 0);
});

test('a 100-new-item invocation resumes through one checkpoint query and reaches the tail', async () => {
  const value = envelope(Array.from({ length: 101 }, (_, index) => event(`record-${index}`))), fake = stores();
  const first = await ingestBatchSource(value, { ...fake, limit: 100 });
  assert.equal(first.processed, 100); assert.equal(first.remaining, 1); assert.equal(first.sealed, false);
  const second = await ingestBatchSource(value, { ...fake, limit: 100 });
  assert.equal(second.replayed, 100); assert.equal(second.processed, 1); assert.equal(second.remaining, 0); assert.equal(second.sealed, true);
  assert.equal(fake.calls.checkpoints, 2); assert.equal(fake.calls.heads, 101);
});

test('malformed or foreign SQL checkpoint snapshots fail closed before record work', async () => {
  for (const row of [
    { requestId: 'foreign', status: 'accepted', receipt: { batchId: 'batch-1', requestId: 'foreign', status: 'accepted' } },
    { requestId: 'placeholder', status: 'accepted', receipt: { batchId: 'other', requestId: 'placeholder', status: 'accepted' } },
  ]) {
    const value = envelope([event('one')]), fake = stores();
    if (row.requestId === 'placeholder') row.requestId = row.receipt.requestId = canonicalRequestId(value.records[0]);
    fake.batchStore.checkpoints = async () => [row];
    await assert.rejects(ingestBatchSource(value, fake), /invalid batch checkpoint/);
    assert.equal(fake.calls.heads, 0); assert.equal(fake.items.size, 0);
  }
});

test('invalid normalized records are durably quarantined and block the sealed batch', async () => {
  const value = envelope([event('bad', { city: 'Ankara' })]), fake = stores();
  const result = await ingestBatchSource(value, fake);
  assert.equal(fake.calls.heads, 0); assert.equal(result.decisions[0].status, 'quarantined');
  assert.equal(result.seal.status, 'blocked');
});

test('incomplete truthful coverage is retained unchanged in the seal', async () => {
  const coverage = { complete: false, failedPages: 2, unvisited: 1, inventory: [{ provider: 'bubilet', discovered: 2,
    verified: 1, retired: 0, quarantined: 0, unvisited: 1, failedPages: 2 }] };
  const value = envelope([event('one')], coverage), fake = stores(); let sealed;
  fake.batchStore.seal = async (_batch, receipt) => { sealed = receipt; return { status: 'sealed' }; };
  await ingestBatchSource(value, fake);
  assert.deepEqual(sealed.collectorCoverage, value.collectorCoverage);
});

test('signals stop before the next record and never seal partial ingestion', async () => {
  const controller = new AbortController(), fake = stores({ abort: () => controller.abort() });
  const result = await ingestBatchSource(envelope([event('one'), event('two')]), { ...fake, signal: controller.signal });
  assert.equal(result.processed, 1); assert.equal(result.remaining, 1); assert.equal(result.interrupted, true); assert.equal(fake.calls.seal, 0);
});

test('unsafe invocation bounds fail before begin and no path switches publication pointers', async () => {
  for (const limit of [0, 101, 1.5, Number.NaN]) {
    const fake = stores(); await assert.rejects(ingestBatchSource(envelope([event('one')]), { ...fake, limit }), /between 1 and 100/);
    assert.equal(fake.calls.begin, 0);
  }
  const fake = stores(); await ingestBatchSource(envelope([]), fake);
  assert.equal(fake.calls.publish, 0); assert.equal(fake.calls.seal, 1);
});

test('checkpoint SQL uses the shared safe literal boundary', async () => {
  const statements = [], store = createBatchSourceStore(async statement => { statements.push(statement); return '[]'; });
  await store.checkpoints("batch\\path'quoted");
  assert.match(statements[0], /E'batch\\\\path''quoted'/);
  await assert.rejects(store.checkpoints('batch\0invalid'), /zero byte/i);
  assert.equal(statements.length, 1);
});
