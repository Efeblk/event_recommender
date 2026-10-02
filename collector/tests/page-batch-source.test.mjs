import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalRequestId } from '../preparation/canonical-adapter.mjs';
import { collectorPageReceiptFromReport, pageBatchInputHash } from '../preparation/collector-page-receipt.mjs';
import { ingestPageBatchSource, validatePageBatchEnvelope } from '../preparation/page-batch-source.mjs';
import { createPageBatchSourceStore } from '../preparation/page-batch-source-store.mjs';

const now = new Date('2026-09-30T12:00:00.000Z');
const event = (id, url = `https://www.bubilet.com.tr/istanbul/etkinlik/${id}`) => ({ id, source: 'bubilet', sourceSessionIds: [id], title: id,
  description: 'Oyun', venue: 'Sahne', district: 'Kadıköy', address: 'Adres', city: 'İstanbul', category: 'Tiyatro',
  startsAt: '2026-10-03T17:00:00.000Z', checkedAt: '2026-09-29T09:19:30.000Z', price: 100, currency: 'TRY',
  availability: 'available', url, imageUrl: '' });
function report() {
  const activeUrl = 'https://www.bubilet.com.tr/istanbul/etkinlik/multi', retiredUrl = 'https://www.bubilet.com.tr/istanbul/etkinlik/retired';
  return { schemaVersion: 1, startedAt: '2026-09-29T09:00:00.000Z', finishedAt: '2026-09-29T09:40:00.000Z',
    pages: [{ source: 'bubilet', url: activeUrl, checkedAt: '2026-09-29T09:20:00.000Z', contentHash: 'a'.repeat(64), parserVersion: '5',
      events: [event('session-a', activeUrl), event('session-b', activeUrl)] },
    { source: 'bubilet', url: retiredUrl, checkedAt: '2026-09-28T08:00:00.000Z', retiredAt: '2026-09-28T08:00:00.000Z',
      contentHash: 'b'.repeat(64), parserVersion: '5', events: [], recoveredFromCoverage: true }],
    listings: [{ source: 'bubilet', url: 'https://www.bubilet.com.tr/istanbul/etkinlikler', completion: 'exhausted' }],
    failures: [{ source: 'bubilet', url: activeUrl, reason: 'later_timeout', attempts: 1 }], quarantined: [],
    summary: { blocked: null, carried: 6189, quarantined: 0, complete: false,
      runBudget: { maxMinutes: 40, stoppedBy: 'time_budget' }, detailBudget: { remainingBacklog: 221 },
      sourceCoverage: { bubilet: { discovered: 10, attempted: 2, verified: 1, retired: 1, quarantined: 0,
        unattemptedThisRun: 8, unvisited: 0, stale: 3, failure: 1, complete: false } } } };
}
function adapted() { return collectorPageReceiptFromReport(report(), { batchId: 'batch-v2', collectionRunId: 'cycle-v2' }); }
function cycleEvidence(value) {
  const pages = value.pages.map(page => ({ provider: page.source, url: page.url, attemptedAt: page.checkedAt,
    status: page.retiredAt ? 'retired' : 'verified', eventsCheckpointAt: page.checkedAt, contentHash: page.contentHash,
    parserVersion: page.parserVersion, events: structuredClone(page.events) }));
  const counts = { known: pages.length, terminal: pages.length, verified: pages.filter(page => page.status === 'verified').length,
    retired: pages.filter(page => page.status === 'retired').length, failed: 0, quarantined: 0, missingCheckpoint: 0 };
  return { schemaVersion: 1, collectionRunId: value.summary.collectionCycle.collectionRunId, pages,
    counts, countsByProvider: { bubilet: { ...counts } }, carriedRecordCount: 0 };
}
function stores({ abort } = {}) {
  const pages = new Map(), records = new Map(), calls = { checkpoint: 0, heads: 0, seal: 0 };
  return { calls, pages, records, canonicalStore: { findHeads: async () => { calls.heads++; return []; } }, store: {
    beginV2: async header => ({ batchId: header.batchId, status: 'collecting', idempotent: pages.size + records.size > 0 }),
    checkpoints: async () => { calls.checkpoint++; return { pages: [...pages.values()].map(receipt => ({ pageId: receipt.pageId, status: receipt.status, receipt,
      payload: receipt.payload })),
      records: [...records.values()].map(receipt => ({ requestId: receipt.requestId, status: receipt.status, receipt })) }; },
    recordPage: async (batchId, page) => { const receipt = { batchId, pageId: page.pageId, status: 'accepted', idempotent: false, payload: page }; pages.set(page.pageId, receipt); abort?.(); return receipt; },
    accept: async (batchId, payload) => { const receipt = { batchId, requestId: payload.requestId, status: 'accepted', idempotent: false }; records.set(payload.requestId, receipt); return receipt; },
    quarantine: async (batchId, requestId, _record, reason) => { const receipt = { batchId, requestId, status: 'quarantined', reason, idempotent: false }; records.set(requestId, receipt); return receipt; },
    sealV2: async (_batchId, seal) => { calls.seal++; return { status: records.size === seal.recordCount ? 'sealed' : 'blocked', idempotent: false }; },
  } };
}

test('legacy adapter preserves multi-session and empty retired page observations separately', () => {
  const envelope = adapted(); assert.equal(envelope.pages.length, 2); assert.equal(envelope.records.length, 2);
  assert.equal(envelope.pages[0].records.length, 2); assert.equal(envelope.pages[1].status, 'retired'); assert.deepEqual(envelope.pages[1].records, []);
  assert.equal(envelope.pages[1].origin, 'recovered'); assert.equal(envelope.pages[1].observedAt, '2026-09-28T08:00:00.000Z');
  assert.equal(envelope.header.scope, 'legacy_incremental'); assert.equal(envelope.header.horizonStart, null);
  assert.equal(envelope.collectorCoverage.complete, false); assert.equal(envelope.collectorCoverage.records.carried, 6189);
  validatePageBatchEnvelope(envelope, { now: () => now });
});

test('exhausted listings do not turn a bounded legacy detail run into complete coverage', () => {
  const envelope = adapted();
  assert.equal(envelope.collectorCoverage.discovery.exhausted, true);
  assert.equal(envelope.collectorCoverage.complete, false);
  assert.deepEqual(envelope.collectorCoverage.legacyEvidence.runBudget, { maxMinutes: 40, stoppedBy: 'time_budget' });
  assert.deepEqual(envelope.collectorCoverage.legacyEvidence.detailBudget, { remainingBacklog: 221 });
  assert.equal(envelope.collectorCoverage.freshness.oldestResolvedAt, null);
});

test('declared cycle scope is preserved while complete coverage still requires explicit URL inventory', () => {
  const value = report(); value.summary.collectionCycle = { schemaVersion: 2, collectionRunId: 'declared-cycle', scope: 'full',
    providers: ['bubilet'], horizonStart: '2026-09-29T00:00:00.000Z', horizonEnd: '2026-10-29T00:00:00.000Z',
    startedAt: value.startedAt, scopeEvidence: { geography: 'Istanbul', listingConfigHash: 'c'.repeat(64) } };
  value.summary.complete = true; value.failures = []; delete value.pages[1].recoveredFromCoverage;
  value.pages[1].checkedAt = value.pages[1].retiredAt = '2026-09-29T09:30:00.000Z';
  const incomplete = collectorPageReceiptFromReport(value, { batchId: 'declared' });
  assert.equal(incomplete.header.scope, 'full'); assert.equal(incomplete.header.horizonStart, '2026-09-29T00:00:00.000Z');
  assert.equal(incomplete.collectorCoverage.complete, false); assert.equal(incomplete.collectorCoverage.discovery.inventoryHash, null);
  validatePageBatchEnvelope(incomplete, { now: () => now });
  value.summary.collectionInventory = [{ provider: 'bubilet', url: value.pages[0].url }, { provider: 'bubilet', url: value.pages[1].url }];
  Object.assign(value.summary.sourceCoverage.bubilet, { discovered: 2, attempted: 2, verified: 1, retired: 1,
    quarantined: 0, unattemptedThisRun: 0, unvisited: 0, stale: 0, failure: 0 });
  value.summary.carried = 0;
  value.summary.runBudget.stoppedBy = null;
  value.summary.collectionCycleEvidence = cycleEvidence(value);
  const complete = collectorPageReceiptFromReport(value, { batchId: 'declared-complete' });
  assert.equal(complete.collectorCoverage.complete, true); assert.match(complete.collectorCoverage.discovery.inventoryHash, /^[0-9a-f]{64}$/);
  validatePageBatchEnvelope(complete, { now: () => new Date('2026-09-29T10:00:00.000Z') });
  value.summary.collectionCycle.scope = 'incremental';
  const incremental = collectorPageReceiptFromReport(value, { batchId: 'declared-incremental' });
  assert.equal(incremental.header.scope, 'incremental'); assert.equal(incremental.collectorCoverage.complete, false);
});

test('a full cycle replays durable pages omitted after an intermediate snapshot advance', () => {
  const value = report(); value.failures = []; value.pages[1].checkedAt = value.pages[1].retiredAt = '2026-09-29T09:30:00.000Z';
  delete value.pages[1].recoveredFromCoverage;
  value.summary.collectionCycle = { schemaVersion: 2, collectionRunId: 'two-invocations', scope: 'full',
    providers: ['bubilet'], horizonStart: '2026-09-29T00:00:00.000Z', horizonEnd: '2026-10-29T00:00:00.000Z',
    startedAt: value.startedAt, scopeEvidence: { geography: 'Istanbul', listingConfigHash: 'c'.repeat(64) } };
  value.summary.collectionInventory = value.pages.map(page => ({ provider: page.source, url: page.url }));
  value.summary.collectionCycleEvidence = cycleEvidence(value);
  value.summary.collectionCycleEvidence.carriedRecordCount = 2;
  value.pages = [value.pages[1]]; // A was published after invocation one, so only B is in this invocation report.
  Object.assign(value.summary, { complete: true, carried: 2 });
  value.summary.runBudget.stoppedBy = null;
  Object.assign(value.summary.sourceCoverage.bubilet, { discovered: 2, attempted: 1, verified: 0, retired: 1,
    quarantined: 0, unattemptedThisRun: 1, unvisited: 0, stale: 0, failure: 0, complete: true });
  const envelope = collectorPageReceiptFromReport(value, { batchId: 'resumed-full' });
  assert.equal(envelope.collectorCoverage.complete, true); assert.equal(envelope.pages.length, 2); assert.equal(envelope.records.length, 2);
  assert.deepEqual(envelope.collectorCoverage.inventory[0], { provider: 'bubilet', known: 2, attemptedThisRun: 2,
    verifiedThisRun: 1, retiredThisRun: 1, failedThisRun: 0, quarantinedThisRun: 0, unattemptedThisRun: 0,
    neverVisited: 0, stale: 0, outstandingFailures: 0 });
  assert.equal(envelope.collectorCoverage.records.carried, 0);
  validatePageBatchEnvelope(envelope, { now: () => new Date('2026-09-29T10:00:00.000Z') });
  value.summary.collectionCycleEvidence.counts.missingCheckpoint = 1;
  value.summary.collectionCycleEvidence.countsByProvider.bubilet.missingCheckpoint = 1;
  value.summary.complete = false;
  assert.throws(() => collectorPageReceiptFromReport(value, { batchId: 'resumed-incomplete' }), /missing a required checkpoint/);
  value.summary.collectionCycleEvidence.counts.missingCheckpoint = 0;
  value.summary.collectionCycleEvidence.countsByProvider.bubilet.missingCheckpoint = 0; value.summary.complete = true;
  value.summary.runBudget.stoppedBy = 'time_budget';
  assert.equal(collectorPageReceiptFromReport(value, { batchId: 'resumed-budget-stop' }).collectorCoverage.complete, false);
});

test('partial cycle metrics count durable pages across invocations without inventing the unvisited page', async () => {
  const value = report(); value.failures = []; delete value.pages[1].recoveredFromCoverage;
  value.pages[1].checkedAt = value.pages[1].retiredAt = '2026-09-29T09:30:00.000Z';
  value.summary.collectionCycle = { schemaVersion: 2, collectionRunId: 'partial-cycle', scope: 'full', providers: ['bubilet'],
    horizonStart: '2026-09-29T00:00:00.000Z', horizonEnd: '2026-10-29T00:00:00.000Z', startedAt: value.startedAt,
    scopeEvidence: { geography: 'Istanbul', listingConfigHash: 'c'.repeat(64) } };
  const missingUrl = 'https://www.bubilet.com.tr/istanbul/etkinlik/unvisited';
  value.summary.collectionInventory = [...value.pages.map(page => ({ provider: page.source, url: page.url })), { provider: 'bubilet', url: missingUrl }];
  value.summary.collectionCycleEvidence = cycleEvidence(value);
  value.summary.collectionCycleEvidence.counts.known = 3;
  value.summary.collectionCycleEvidence.countsByProvider.bubilet.known = 3;
  value.summary.collectionCycleEvidence.carriedRecordCount = 2;
  value.pages = [value.pages[1]]; value.summary.carried = 2; value.summary.complete = false;
  Object.assign(value.summary.sourceCoverage.bubilet, { discovered: 3, attempted: 1, verified: 0, retired: 1,
    quarantined: 0, unattemptedThisRun: 2, unvisited: 1, stale: 0, failure: 0, complete: false });
  const envelope = collectorPageReceiptFromReport(value, { batchId: 'partial-resume' });
  assert.equal(envelope.collectorCoverage.complete, false); assert.equal(envelope.pages.length, 2);
  assert.deepEqual(envelope.collectorCoverage.inventory[0], { provider: 'bubilet', known: 3, attemptedThisRun: 2,
    verifiedThisRun: 1, retiredThisRun: 1, failedThisRun: 0, quarantinedThisRun: 0, unattemptedThisRun: 1,
    neverVisited: 1, stale: 0, outstandingFailures: 0 });
  validatePageBatchEnvelope(envelope, { now: () => new Date('2026-09-29T10:00:00.000Z') });
  const fake = stores(); const result = await ingestPageBatchSource(envelope, { ...fake, limit: 100, now: () => now });
  assert.equal(result.remaining, 0); assert.equal(result.sealed, true); assert.equal(fake.pages.size, 2);
  assert.equal([...fake.pages.values()].some(receipt => receipt.payload.url === missingUrl), false);
});

test('overlapping failure evidence does not replace a verified page or invent a failed observation clock', () => {
  const envelope = adapted();
  assert.equal(envelope.pages.filter(page => page.status === 'failed').length, 0);
  assert.equal(envelope.pages[0].status, 'verified');
  assert.equal(envelope.collectorCoverage.inventory[0].failedThisRun, 1);
  assert.deepEqual(envelope.collectorCoverage.legacyEvidence.failures[0], report().failures[0]);
});

test('input hash binds page evidence, records, scope and coverage', () => {
  for (const mutate of [
    value => { value.pages[0].observedAt = '2026-09-29T09:21:00.000Z'; },
    value => { value.records[0].title = 'Changed'; },
    value => { value.header.scope = 'incremental'; },
    value => { value.collectorCoverage.inventory[0].stale++; },
  ]) {
    const envelope = adapted(); mutate(envelope);
    assert.notEqual(pageBatchInputHash(envelope), envelope.header.inputHash);
    assert.throws(() => validatePageBatchEnvelope(envelope, { now: () => now }), /hash|horizon|inventory|observation time|page record reference/);
  }
});

test('interruption checkpoints a page and resume skips it without record lookup', async () => {
  const controller = new AbortController(), fake = stores({ abort: () => controller.abort() }), envelope = adapted();
  const first = await ingestPageBatchSource(envelope, { ...fake, signal: controller.signal, now: () => now });
  assert.equal(first.processed, 1); assert.equal(first.interrupted, true); assert.equal(fake.calls.heads, 0); assert.equal(fake.calls.seal, 0);
  const resumed = await ingestPageBatchSource(envelope, { ...fake, limit: 100, now: () => now });
  assert.equal(resumed.replayed, 1); assert.equal(resumed.remaining, 0); assert.equal(resumed.sealed, true);
  assert.equal(fake.calls.checkpoint, 2); assert.equal(fake.calls.heads, 2);
});

test('durable record checkpoints skip changed identity lookup and invalid snapshots fail closed', async () => {
  const envelope = adapted(), fake = stores(); await ingestPageBatchSource(envelope, { ...fake, limit: 100, now: () => now });
  const heads = fake.calls.heads; await ingestPageBatchSource(envelope, { ...fake, limit: 100, now: () => now }); assert.equal(fake.calls.heads, heads);
  fake.store.checkpoints = async () => ({ pages: [], records: [{ requestId: canonicalRequestId(envelope.records[0]), status: 'accepted',
    receipt: { batchId: 'other', requestId: canonicalRequestId(envelope.records[0]), status: 'accepted', idempotent: false } }] });
  await assert.rejects(ingestPageBatchSource(envelope, { ...fake, now: () => now }), /checkpoint snapshot/);
});

test('validation and bounds fail before mutation, and ingestion never publishes', async () => {
  const envelope = adapted(), fake = stores(); envelope.records.pop(); envelope.header.inputHash = pageBatchInputHash(envelope);
  assert.throws(() => validatePageBatchEnvelope(envelope, { now: () => now }), /page record reference|exactly one/);
  for (const limit of [0, 101, 1.5]) await assert.rejects(ingestPageBatchSource(adapted(), { ...fake, limit, now: () => now }), /between 1 and 100/);
  assert.equal(fake.pages.size, 0); assert.equal('publish' in fake.store, false);
});

test('checkpoint query is one bounded safe-literal read', async () => {
  const statements = [], store = createPageBatchSourceStore(async statement => { statements.push(statement); return '{"pages":[],"records":[]}'; });
  assert.deepEqual(await store.checkpoints("batch\\path'quoted"), { pages: [], records: [] });
  assert.equal(statements.length, 1); assert.match(statements[0], /LIMIT 20001/); assert.match(statements[0], /E'batch\\\\path''quoted'/);
  await assert.rejects(store.checkpoints('batch\0invalid'), /zero byte/i); assert.equal(statements.length, 1);
});
