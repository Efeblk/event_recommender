import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeEventSessions } from '../lib/event-merge.ts';
import { SessionMergeCache } from '../lib/session-merge-cache.ts';
import { isEligible } from '../lib/search.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';

const event = (id: string, overrides: Partial<EventRecord> = {}): EventRecord => ({
  id, title: 'Specific concert', description: 'A concert program', startsAt: '2026-10-05T17:00:00Z',
  checkedAt: '2026-10-03T09:00:00Z', venue: 'Salon', city: 'İstanbul', district: 'Kadıköy', address: '',
  price: 300, currency: 'TRY', category: 'Konser', availability: 'available', imageUrl: '', url: `https://example.test/${id}`, ...overrides,
});
// Undefined optional properties are absent from the HTTP JSON contract.
const wireEqual = (actual: EventRecord[], expected: EventRecord[]) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
function countedCache(budget?: number) {
  let calls = 0;
  const cache = new SessionMergeCache(budget, records => { calls++; return mergeEventSessions(records); });
  return { cache, calls: () => calls };
}

void test('exact content reuse preserves conservative merge output and isolates returned mutations', () => {
  const records = [event('a'), event('b', { price: 200 })];
  const { cache, calls } = countedCache();
  const first = cache.read(records);
  assert.equal(first.length, 1);
  first[0].price = 1;
  first[0].offers![0].price = 1;
  first[0].mergedIds!.push('forged-id');
  const second = cache.read(structuredClone(records));
  wireEqual(second, mergeEventSessions(records));
  assert.equal(calls(), 1);
  second[0].offers!.pop();
  wireEqual(cache.read(records), mergeEventSessions(records));
});

void test('every changed source fact invalidates reuse, including mandatory policy and offer facts', () => {
  for (const change of [
    { checkedAt: '2026-10-03T10:00:00Z' }, { price: 800 }, { availability: 'cancelled' as const },
    { startsAt: '2026-10-05T18:00:00Z' }, { venue: 'Another venue' }, { description: '18+ yaş sınırı' },
    { attendanceTiming: { kind: 'unknown' as const, evidence: 'insufficient_source_evidence' as const } },
  ]) {
    const { cache, calls } = countedCache();
    cache.read([event('a')]);
    const changed = [event('a', change)];
    assert.deepEqual(cache.read(changed), mergeEventSessions(changed));
    assert.equal(calls(), 2, JSON.stringify(change));
  }
});

void test('reuse never freezes freshness, current time or user filters', () => {
  const { cache } = countedCache();
  const records = [event('a')];
  const serve = (now: Date, maxPrice: number | null = null) => cache.read(records.filter(e => isEligible(e, emptyFilters, now)))
    .filter(e => isEligible(e, { ...emptyFilters, maxPrice }, now));
  assert.equal(serve(new Date('2026-10-03T10:00:00Z')).length, 1);
  assert.equal(serve(new Date('2026-10-03T10:00:00Z'), 100).length, 0);
  assert.equal(serve(new Date('2026-10-04T10:00:00Z')).length, 1);
  assert.equal(serve(new Date('2026-10-06T10:00:00Z')).length, 0);
});

void test('a replaced or oversize catalog cannot leave an unbounded or stale cache entry', () => {
  const { cache, calls } = countedCache(10000);
  const small = [event('a')], huge = [event('large', { description: 'ü'.repeat(10000) })];
  cache.read(small); cache.read(small);
  assert.equal(calls(), 1);
  cache.read(huge); cache.read(huge);
  assert.equal(calls(), 3);
  cache.read(small);
  assert.equal(calls(), 4);
  assert.deepEqual(cache.read([]), []);
  assert.deepEqual(cache.read([event('b')]), mergeEventSessions([event('b')]));
});
