import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attachCollectionCycle, bindCollectionListingConfig, collectionCycleEvidence, collectionCycleInventory,
  collectionCycleInventoryComplete, collectionCycleReceipt, collectionListingConfigHash,
  recordCollectionCycleObservation, validateCollectionScope,
} from '../collection-scope.mjs';
import { fairCoverageOrder, normalizeCoverage } from '../coverage.mjs';

const listingConfigHash = collectionListingConfigHash({ schemaVersion: 1, geography: 'Istanbul',
  providers: ['biletinial', 'bubilet'], listings: [
    { provider: 'bubilet', url: 'https://www.bubilet.com.tr/istanbul', category: 'all' },
    { provider: 'biletinial', url: 'https://biletinial.com/tr-tr/muzik/istanbul', category: 'Konser' },
  ] });
const cycle = { schemaVersion: 2, collectionRunId: 'cycle-2026-10-01', scope: 'full', providers: ['biletinial', 'bubilet'],
  horizonStart: '2026-10-01T00:00:00.000Z', horizonEnd: '2026-12-31T23:59:59.999Z', startedAt: '2026-10-01T00:00:00.000Z',
  scopeEvidence: { geography: 'Istanbul', listingConfigHash } };
const checkpoint = () => ({ schemaVersion: 1, updatedAt: '2026-09-30T00:00:00.000Z', entries: [{ url: 'https://example.test/1', source: 'bubilet',
  lastAttemptAt: '2026-09-30T00:00:00.000Z', lastSuccessAt: '2026-09-30T00:00:00.000Z', attempts: 4,
  eventsCheckpointAt: '2026-09-30T00:00:00.000Z', events: [{ id: 'old' }], cycleObservation: { cycleId: 'old-cycle', attemptedAt: '2026-09-30T00:00:00.000Z', status: 'verified' } }], listings: {} });

test('unchanged scope resumes without rebasing clocks or checkpoint evidence', () => {
  const state = checkpoint(); state.cycle = structuredClone(cycle); const before = structuredClone(state);
  const result = attachCollectionCycle(state, structuredClone(cycle));
  assert.equal(result.mode, 'resume'); assert.equal(result.state, state); assert.deepEqual(state, before);
});

test('an explicit-cycle checkpoint cannot silently resume in legacy mode', () => {
  const state = checkpoint(); state.cycle = structuredClone(cycle); const before = structuredClone(state);
  assert.throws(() => attachCollectionCycle(state, null), /scope is required/);
  assert.deepEqual(state, before);
});

test('normalization preserves an explicit cycle and cycle-aware order revisits retired inventory', () => {
  const state = checkpoint(); state.cycle = structuredClone(cycle);
  state.entries[0].retiredAt = '2026-09-30T00:00:00.000Z';
  const normalized = normalizeCoverage(state);
  assert.deepEqual(normalized.cycle, cycle);
  assert.equal(fairCoverageOrder(normalized, ['bubilet'], '2026-10-01T00:00:00.000Z', 7 * 86400000).length, 0);
  assert.deepEqual(fairCoverageOrder(normalized, ['bubilet'], '2026-10-01T00:00:00.000Z', 7 * 86400000, cycle.collectionRunId)
    .map(entry => entry.url), ['https://example.test/1']);
});

test('a changed scope with the same cycle id is rejected without state writes', () => {
  const state = checkpoint(); state.cycle = structuredClone(cycle); const before = structuredClone(state);
  assert.throws(() => attachCollectionCycle(state, { ...cycle, horizonEnd: '2027-01-01T00:00:00.000Z' }), /changed during resume/);
  assert.deepEqual(state, before);
});

test('new cycles require explicit begin and clear only per-cycle visitation', () => {
  const legacy = checkpoint(), before = structuredClone(legacy);
  assert.throws(() => attachCollectionCycle(legacy, cycle), /explicit cycle begin/); assert.deepEqual(legacy, before);
  const begun = attachCollectionCycle(legacy, cycle, { begin: true });
  assert.equal(begun.mode, 'begin'); assert.notEqual(begun.state, legacy);
  assert.equal(begun.state.entries[0].cycleObservation, undefined);
  for (const field of ['lastAttemptAt', 'lastSuccessAt', 'attempts', 'eventsCheckpointAt', 'events'])
    assert.deepEqual(begun.state.entries[0][field], legacy.entries[0][field]);
});

test('legacy checkpoints remain unknown scope and cannot be relabeled full', () => {
  const legacy = checkpoint(); assert.deepEqual(attachCollectionCycle(legacy, null), { state: legacy, cycle: null, mode: 'legacy' });
  assert.throws(() => validateCollectionScope({ ...cycle, scope: 'legacy_incremental' }), /horizon must remain unknown/);
  const unknown = validateCollectionScope({ ...cycle, scope: 'legacy_incremental', horizonStart: null, horizonEnd: null });
  assert.equal(unknown.scope, 'legacy_incremental'); assert.equal(unknown.horizonStart, null);
});

test('cycle observations do not rewrite source observation clocks', () => {
  const state = attachCollectionCycle(checkpoint(), cycle, { begin: true }).state;
  const before = structuredClone(state.entries[0]);
  recordCollectionCycleObservation(state, state.entries[0].url, { attemptedAt: '2026-10-01T00:10:00.000Z', status: 'failed' });
  assert.deepEqual({ ...state.entries[0], cycleObservation: undefined }, { ...before, cycleObservation: undefined });
  assert.deepEqual(state.entries[0].cycleObservation, { cycleId: cycle.collectionRunId, attemptedAt: '2026-10-01T00:10:00.000Z', status: 'failed' });
});

test('time-budget and partial coverage never claim a full cycle', () => {
  const sourceCoverage = { biletinial: { complete: true }, bubilet: { complete: true } };
  const bounded = collectionCycleReceipt(cycle, { sourceCoverage, inventoryHash: 'a'.repeat(64), inventoryComplete: true, finishedAt: '2026-10-01T00:40:00.000Z', stoppedBy: 'time_budget' });
  assert.equal(bounded.complete, false); assert.equal(bounded.stoppedBy, 'time_budget');
  const partial = collectionCycleReceipt(cycle, { sourceCoverage: { ...sourceCoverage, bubilet: { complete: false } }, inventoryHash: 'a'.repeat(64), inventoryComplete: true, finishedAt: '2026-10-01T00:40:00.000Z' });
  assert.equal(partial.complete, false);
  const carried = collectionCycleReceipt(cycle, { sourceCoverage, inventoryHash: 'a'.repeat(64), inventoryComplete: false, finishedAt: '2026-10-01T00:40:00.000Z' });
  assert.equal(carried.complete, false);
  const complete = collectionCycleReceipt(cycle, { sourceCoverage, inventoryHash: 'a'.repeat(64), inventoryComplete: true, finishedAt: '2026-10-01T00:40:00.000Z' });
  assert.equal(complete.complete, true);
});

test('carried records do not satisfy current-cycle inventory coverage', () => {
  const state = attachCollectionCycle(checkpoint(), cycle, { begin: true }).state;
  assert.equal(collectionCycleInventoryComplete(state, cycle), false);
  recordCollectionCycleObservation(state, state.entries[0].url, { attemptedAt: '2026-10-01T00:10:00.000Z', status: 'verified' });
  assert.equal(collectionCycleInventoryComplete(state, cycle), false);
  Object.assign(state.entries[0], { events: [{ id: 'one' }], eventsCheckpointAt: '2026-10-01T00:10:00.000Z',
    eventsCheckpointUrl: state.entries[0].url, eventsCheckpointSource: state.entries[0].source,
    eventsCheckpointStatus: 'active', eventsCheckpointContentHash: 'a'.repeat(64), eventsCheckpointParserVersion: '5' });
  assert.equal(collectionCycleInventoryComplete(state, cycle), true);
  recordCollectionCycleObservation(state, state.entries[0].url, { attemptedAt: '2026-10-01T00:11:00.000Z', status: 'failed' });
  assert.equal(collectionCycleInventoryComplete(state, cycle), false);
});

test('collection inventory retains retired and unresolved original URLs with metric-equivalent counts', () => {
  const state = attachCollectionCycle(checkpoint(), cycle, { begin: true }).state;
  state.entries.push(
    { url: 'https://biletinial.com/event/z', source: 'biletinial', attempts: 1, retiredAt: '2026-09-29T00:00:00.000Z' },
    { url: 'https://bubilet.com.tr/event/a?source=original', source: 'bubilet', attempts: 0, failure: 'timeout' },
    { url: 'https://bubilet.com.tr/event/a?source=original', source: 'bubilet', attempts: 2 },
    { url: 'https://www.biletix.com/event/x', source: 'biletix', attempts: 1 },
  );
  const inventory = collectionCycleInventory(state, cycle);
  assert.deepEqual(inventory, [
    { provider: 'biletinial', url: 'https://biletinial.com/event/z' },
    { provider: 'bubilet', url: 'https://bubilet.com.tr/event/a?source=original' },
    { provider: 'bubilet', url: 'https://example.test/1' },
  ]);
  const discovered = Object.fromEntries(cycle.providers.map(provider => [provider,
    new Set(state.entries.filter(entry => entry.source === provider).map(entry => entry.url)).size]));
  assert.equal(inventory.length, Object.values(discovered).reduce((sum, count) => sum + count, 0));
});

test('declared listing evidence is bound to the selected resolved listing seeds', () => {
  const resolved = new Map([
    ['biletinial', [['/tr-tr/muzik/istanbul', 'Konser']]],
    ['bubilet', [['/istanbul', null]]],
  ]);
  const configs = { biletinial: { origin: 'https://biletinial.com' }, bubilet: { origin: 'https://www.bubilet.com.tr' } };
  const actualHash = collectionListingConfigHash({ schemaVersion: 1, geography: 'Istanbul',
    providers: cycle.providers, listings: [
      { provider: 'biletinial', url: 'https://biletinial.com/tr-tr/muzik/istanbul', category: 'Konser' },
      { provider: 'bubilet', url: 'https://www.bubilet.com.tr/istanbul', category: null },
    ] });
  const bound = { ...cycle, scopeEvidence: { ...cycle.scopeEvidence, listingConfigHash: actualHash } };
  assert.equal(bindCollectionListingConfig(bound, resolved, configs), actualHash);
  assert.throws(() => bindCollectionListingConfig(cycle, resolved, configs), /does not match/);
  assert.throws(() => bindCollectionListingConfig(bound, new Map([['bubilet', resolved.get('bubilet')]]), configs), /Missing resolved/);
});

test('listing configuration hashing distinguishes null categories and is order invariant', () => {
  const input = { schemaVersion: 1, geography: 'Istanbul', providers: ['bubilet'], listings: [
    { provider: 'bubilet', url: 'https://www.bubilet.com.tr/istanbul', category: null },
    { provider: 'bubilet', url: 'https://www.bubilet.com.tr/istanbul', category: 'Konser' },
  ] };
  assert.equal(collectionListingConfigHash(input), collectionListingConfigHash({ ...input, listings: [...input.listings].reverse() }));
  assert.throws(() => collectionListingConfigHash({ ...input, listings: [input.listings[0], { ...input.listings[0] }] }), /Duplicate/);
});

test('same-cycle durable page evidence survives publication advancement across resumptions', () => {
  const state = attachCollectionCycle(checkpoint(), cycle, { begin: true }).state;
  const first = state.entries[0];
  first.events = [{ id: 'a', checkedAt: '2026-10-01T00:10:00.000Z' }];
  first.eventsCheckpointAt = '2026-10-01T00:10:00.000Z'; first.eventsCheckpointUrl = first.url;
  first.eventsCheckpointSource = first.source; first.eventsCheckpointStatus = 'active';
  first.eventsCheckpointContentHash = 'a'.repeat(64); first.eventsCheckpointParserVersion = '5';
  recordCollectionCycleObservation(state, first.url, { attemptedAt: first.eventsCheckpointAt, status: 'verified' });
  state.entries.push({ url: 'https://biletinial.com/event/b', source: 'biletinial', attempts: 1, events: [],
    eventsCheckpointAt: '2026-10-01T00:20:00.000Z', eventsCheckpointUrl: 'https://biletinial.com/event/b',
    eventsCheckpointSource: 'biletinial', eventsCheckpointStatus: 'retired',
    eventsCheckpointContentHash: 'b'.repeat(64), eventsCheckpointParserVersion: '4',
    cycleObservation: { cycleId: cycle.collectionRunId, attemptedAt: '2026-10-01T00:20:00.000Z', status: 'retired' } });
  const evidence = collectionCycleEvidence(state, cycle, [{ source: 'biletinial', url: 'https://biletinial.com/event/b', events: [] }]);
  assert.deepEqual(evidence.counts, { known: 2, terminal: 2, verified: 1, retired: 1, failed: 0, quarantined: 0, missingCheckpoint: 0 });
  assert.deepEqual(evidence.countsByProvider, {
    biletinial: { known: 1, terminal: 1, verified: 0, retired: 1, failed: 0, quarantined: 0, missingCheckpoint: 0 },
    bubilet: { known: 1, terminal: 1, verified: 1, retired: 0, failed: 0, quarantined: 0, missingCheckpoint: 0 },
  });
  assert.deepEqual(evidence.pages.map(page => [page.provider, page.url, page.status]), [
    ['biletinial', 'https://biletinial.com/event/b', 'retired'], ['bubilet', 'https://example.test/1', 'verified'],
  ]);
  assert.equal(evidence.carriedRecordCount, 1);
});

test('failed and incomplete same-cycle checkpoints remain explicit and cannot become evidence pages', () => {
  const state = attachCollectionCycle(checkpoint(), cycle, { begin: true }).state;
  recordCollectionCycleObservation(state, state.entries[0].url, { attemptedAt: '2026-10-01T00:10:00.000Z', status: 'verified' });
  state.entries.push({ url: 'https://biletinial.com/event/failed', source: 'biletinial', attempts: 1,
    cycleObservation: { cycleId: cycle.collectionRunId, attemptedAt: '2026-10-01T00:11:00.000Z', status: 'failed' } });
  const evidence = collectionCycleEvidence(state, cycle);
  assert.deepEqual(evidence.pages, []);
  assert.deepEqual(evidence.counts, { known: 2, terminal: 1, verified: 1, retired: 0, failed: 1, quarantined: 0, missingCheckpoint: 1 });
  assert.equal(evidence.carriedRecordCount, 0);
});

test('quarantined response checkpoints replay as zero-record evidence while ordinary failures do not', () => {
  const state = attachCollectionCycle(checkpoint(), cycle, { begin: true }).state;
  const entry = state.entries[0];
  Object.assign(entry, { events: [], eventsCheckpointAt: '2026-10-01T00:10:00.000Z', eventsCheckpointUrl: entry.url,
    eventsCheckpointSource: entry.source, eventsCheckpointStatus: 'quarantined',
    eventsCheckpointContentHash: 'c'.repeat(64), eventsCheckpointParserVersion: '5' });
  recordCollectionCycleObservation(state, entry.url, { attemptedAt: entry.eventsCheckpointAt, status: 'quarantined' });
  state.entries.push({ url: 'https://biletinial.com/event/failed', source: 'biletinial', attempts: 1,
    cycleObservation: { cycleId: cycle.collectionRunId, attemptedAt: '2026-10-01T00:11:00.000Z', status: 'failed' } });
  const evidence = collectionCycleEvidence(state, cycle);
  assert.deepEqual(evidence.pages.map(page => ({ status: page.status, events: page.events })), [{ status: 'quarantined', events: [] }]);
  assert.deepEqual(evidence.counts, { known: 2, terminal: 0, verified: 0, retired: 0, failed: 1, quarantined: 1, missingCheckpoint: 0 });
  for (const field of Object.keys(evidence.counts))
    assert.equal(evidence.counts[field], Object.values(evidence.countsByProvider).reduce((sum, provider) => sum + provider[field], 0));
  assert.equal(collectionCycleInventoryComplete(state, cycle), false);
});
