import assert from 'node:assert/strict';
import test from 'node:test';
import { addCoverageEntries, checkpointCoverageEvents, coverageBySource, fairCoverageOrder, normalizeCoverage, recordCoverageAttempt, recoverCoverageEvents, verifyCompletePage } from '../coverage.mjs';

test('durable coverage retains every discovered URL without sampling', () => {
  const state = normalizeCoverage(null);
  addCoverageEntries(state, Array.from({ length: 1500 }, (_, index) => ({ url: `https://example/${index}`, source: index % 2 ? 'bubilet' : 'biletix' })), '2026-09-28T00:00:00.000Z');
  assert.equal(state.entries.length, 1500);
});

test('fair order rotates sources and prioritizes unvisited then oldest attempts', () => {
  const state = normalizeCoverage(null);
  addCoverageEntries(state, [
    { url: 'https://a/new', source: 'a' }, { url: 'https://a/old', source: 'a' },
    { url: 'https://b/new', source: 'b' }, { url: 'https://b/old', source: 'b' },
  ]);
  recordCoverageAttempt(state, 'https://a/old', { success: true }, '2026-09-01T00:00:00.000Z');
  recordCoverageAttempt(state, 'https://b/old', { success: true }, '2026-09-02T00:00:00.000Z');
  assert.deepEqual(fairCoverageOrder(state, ['a', 'b']).map(({ url }) => url), ['https://a/new', 'https://b/new', 'https://a/old', 'https://b/old']);
});

test('newly discovered sparse-source URLs lead a large previously attempted backlog', () => {
  const state = normalizeCoverage(null);
  addCoverageEntries(state, Array.from({ length: 2000 }, (_, index) => ({ url: `https://known/${index}`, source: 'large' })));
  for (const entry of state.entries) recordCoverageAttempt(state, entry.url, { success: true }, '2026-09-20T00:00:00.000Z');
  addCoverageEntries(state, [{ url: 'https://sparse/new-workshop', source: 'sparse' }], '2026-09-28T00:00:00.000Z');
  const first = fairCoverageOrder(state, ['large', 'sparse']).slice(0, 2);
  assert.deepEqual(first.map(({ source }) => source), ['large', 'sparse']);
  assert.equal(first[1].url, 'https://sparse/new-workshop');
});

test('coverage is complete only after exhausted listing, visits, and failures clear', () => {
  const state = normalizeCoverage(null);
  addCoverageEntries(state, [{ url: 'https://a/1', source: 'a' }, { url: 'https://a/2', source: 'a' }]);
  recordCoverageAttempt(state, 'https://a/1', { success: true });
  recordCoverageAttempt(state, 'https://a/2', { success: false, failure: 'http_500' });
  const runStartedAt = new Date(Date.now() - 1000).toISOString();
  assert.deepEqual(coverageBySource(state, ['a'], ['https://a/1', 'https://a/2'], ['https://a/1'], [], { a: true }, runStartedAt).a, { discovered: 2, attempted: 2, verified: 1, quarantined: 0, unvisited: 0, stale: 1, unattemptedThisRun: 0, failure: 1, retired: 0, complete: false });
  recordCoverageAttempt(state, 'https://a/2', { success: true });
  assert.equal(coverageBySource(state, ['a'], [], [], [], { a: true }, runStartedAt).a.complete, true);
  assert.equal(coverageBySource(state, ['a'], [], [], [], { a: false }, runStartedAt).a.complete, false);
});

test('successful page events survive queue purges and later failures', () => {
  const state = normalizeCoverage(null);
  addCoverageEntries(state, [{ url: 'https://a/1', source: 'a' }]);
  recordCoverageAttempt(state, 'https://a/1', { success: true });
  checkpointCoverageEvents(state, 'https://a/1', [{ id: 'session-1', checkedAt: '2026-09-28T00:00:00.000Z' }]);
  recordCoverageAttempt(state, 'https://a/1', { success: false, failure: 'http_500' });
  assert.deepEqual(state.entries[0].events, [{ id: 'session-1', checkedAt: '2026-09-28T00:00:00.000Z' }]);
});

test('recovery replaces every snapshot row for a successfully checkpointed URL', () => {
  const state = normalizeCoverage(null), url = 'https://a.test/event/1';
  addCoverageEntries(state, [{ url, source: 'a' }]);
  recordCoverageAttempt(state, url, { success: true }, '2026-09-28T01:00:00.000Z');
  const current = { id: 'new', url, source: 'a', checkedAt: '2026-09-28T01:00:00.000Z' };
  checkpointCoverageEvents(state, url, [current], '2026-09-28T01:00:00.000Z');
  recordCoverageAttempt(state, url, { success: false, failure: 'later_http_500' }, '2026-09-28T02:00:00.000Z');
  const snapshot = [{ id: 'old-a', url, source: 'a', checkedAt: '2026-09-20T00:00:00.000Z' }, { id: 'old-b', url, source: 'a', checkedAt: '2026-09-20T00:00:00.000Z' }, { id: 'other', url: 'https://b.test/2', source: 'b', checkedAt: '2026-09-20T00:00:00.000Z' }];
  assert.deepEqual(recoverCoverageEvents(snapshot, state), [snapshot[2], current]);
});

test('retirement checkpoint removes snapshot rows across restart and malformed provenance is ignored', () => {
  const state = normalizeCoverage(null), url = 'https://a.test/event/1';
  addCoverageEntries(state, [{ url, source: 'a' }]);
  recordCoverageAttempt(state, url, { retired: true }, '2026-09-28T01:00:00.000Z');
  checkpointCoverageEvents(state, url, [], '2026-09-28T01:00:00.000Z');
  const old = { id: 'old', url, source: 'a', checkedAt: '2026-09-20T00:00:00.000Z' };
  assert.deepEqual(recoverCoverageEvents([old], state), []);
  state.entries[0].eventsCheckpointUrl = 'https://attacker.test/event';
  assert.deepEqual(recoverCoverageEvents([old], state), [old]);
});

test('older local checkpoints never replace a newer restored snapshot', () => {
  const url = 'https://a.test/event/1', newer = { id: 'remote-new', url, source: 'a', checkedAt: '2026-09-28T03:00:00.000Z' };
  const active = normalizeCoverage(null);
  addCoverageEntries(active, [{ url, source: 'a' }]);
  recordCoverageAttempt(active, url, { success: true }, '2026-09-28T01:00:00.000Z');
  checkpointCoverageEvents(active, url, [{ id: 'cache-old', url, source: 'a', checkedAt: '2026-09-28T01:00:00.000Z' }], '2026-09-28T01:00:01.000Z');
  assert.deepEqual(recoverCoverageEvents([newer], active, () => [], new Date('2026-09-28T04:00:00.000Z')), [newer]);

  const retired = normalizeCoverage(null);
  addCoverageEntries(retired, [{ url, source: 'a' }]);
  recordCoverageAttempt(retired, url, { retired: true }, '2026-09-28T02:00:00.000Z');
  checkpointCoverageEvents(retired, url, [], '2026-09-28T02:00:00.000Z');
  assert.deepEqual(recoverCoverageEvents([newer], retired, () => [], new Date('2026-09-28T04:00:00.000Z')), [newer]);
});

test('inconsistent or future checkpoint timestamps cannot freshen recovery', () => {
  const url = 'https://a.test/event/1', old = { id: 'snapshot', url, source: 'a', checkedAt: '2026-09-28T00:00:00.000Z' };
  const state = normalizeCoverage(null);
  addCoverageEntries(state, [{ url, source: 'a' }]);
  recordCoverageAttempt(state, url, { success: true }, '2026-09-28T01:00:00.000Z');
  checkpointCoverageEvents(state, url, [{ id: 'cache', url, source: 'a', checkedAt: '2026-09-28T01:00:00.000Z' }], '2026-09-28T02:00:00.000Z');
  assert.deepEqual(recoverCoverageEvents([old], state, () => [], new Date('2026-09-28T03:00:00.000Z')), [old]);
  state.entries[0].eventsCheckpointAt = '2026-09-29T00:00:00.000Z';
  assert.deepEqual(recoverCoverageEvents([old], state, () => [], new Date('2026-09-28T03:00:00.000Z')), [old]);
});

test('retired pages wait for cadence while explicit rediscovery permits one reactive check', () => {
  const state = normalizeCoverage(null), url = 'https://a.test/event/1';
  addCoverageEntries(state, [{ url, source: 'a' }]);
  recordCoverageAttempt(state, url, { retired: true }, '2026-09-28T00:00:00.000Z');
  assert.deepEqual(fairCoverageOrder(state, ['a'], '2026-09-29T00:00:00.000Z'), []);
  addCoverageEntries(state, [{ url, source: 'a', reactivate: true }], '2026-09-29T00:00:00.000Z');
  assert.equal(fairCoverageOrder(state, ['a'], '2026-09-29T00:00:01.000Z')[0].url, url);
  recordCoverageAttempt(state, url, { retired: true }, '2026-09-29T00:00:02.000Z');
  assert.deepEqual(fairCoverageOrder(state, ['a'], '2026-09-30T00:00:00.000Z'), []);
  assert.equal(fairCoverageOrder(state, ['a'], '2026-10-06T00:00:02.000Z')[0].url, url);
});

test('one invalid session quarantines the whole page without changing its valid checkpoint', () => {
  const state = normalizeCoverage(null), url = 'https://a.test/event/1';
  addCoverageEntries(state, [{ url, source: 'a' }]);
  recordCoverageAttempt(state, url, { success: true }, '2026-09-28T00:00:00.000Z');
  const prior = { id: 'prior', url, source: 'a', checkedAt: '2026-09-28T00:00:00.000Z' };
  checkpointCoverageEvents(state, url, [prior], '2026-09-28T00:00:00.000Z');
  const page = verifyCompletePage([{ id: 'valid' }, { id: 'invalid' }], (event) => event.id === 'invalid' ? ['bad'] : [], 'a', url);
  assert.equal(page.complete, false);
  assert.deepEqual(page.accepted, [{ id: 'valid' }]);
  assert.equal(page.quarantined.length, 1);
  recordCoverageAttempt(state, url, { success: false, failure: 'page_contains_quarantined_sessions' }, '2026-09-29T00:00:00.000Z');
  assert.deepEqual(state.entries[0].events, [prior]);
});
