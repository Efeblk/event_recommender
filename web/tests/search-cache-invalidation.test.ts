import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSupportedEventFormat } from '../lib/event-format.ts';
import { isEligible, rankEvents } from '../lib/search.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';
const event = (id: string): EventRecord => ({ id, title: 'Example', description: 'An event', startsAt: '2026-10-04T17:00:00Z', checkedAt: '2026-10-03T10:00:00Z', venue: 'Salon', city: 'İstanbul', district: 'Kadıköy', address: '', price: 500, currency: 'TRY', category: 'Konser', availability: 'available', url: `https://example.test/${id}`, imageUrl: '' });

void test('reused lexical text invalidates for every ranking field mutation', () => {
  const a = event('a'), b = { ...event('b'), title: 'Jazz' };
  const records = [a, b];
  for (const field of ['title', 'description', 'venue', 'category'] as const) {
    assert.deepEqual(rankEvents(records, 'jazz').map(e => e.id), ['b', 'a']);
    a[field] = 'Jazz'; b.title = 'Example';
    assert.deepEqual(rankEvents(records, 'jazz').map(e => e.id), ['a', 'b']);
    a[field] = event('a')[field]; b.title = 'Jazz';
  }
});

void test('format reuse invalidates title, description and category while freshness and cancellation stay live', () => {
  const candidate = event('a');
  assert.equal(hasSupportedEventFormat(candidate), true);
  candidate.title = 'Seramik Atölyesi';
  assert.equal(hasSupportedEventFormat(candidate), false);
  candidate.category = 'Workshop';
  assert.equal(hasSupportedEventFormat(candidate), true);
  candidate.title = 'Specific event'; candidate.description = 'Canlı konser. A concert program.';
  candidate.category = 'Konser';
  assert.equal(hasSupportedEventFormat(candidate), true);
  candidate.description = 'Katılımcılarla uygulamalı seramik workshop çalışması';
  assert.equal(hasSupportedEventFormat(candidate), false);
  candidate.category = 'Workshop';
  const now = new Date('2026-10-03T11:00:00Z');
  assert.equal(isEligible(candidate, emptyFilters, now), true);
  candidate.availability = 'cancelled';
  assert.equal(isEligible(candidate, emptyFilters, now), false);
  candidate.availability = 'available'; candidate.checkedAt = '2026-09-30T10:00:00Z';
  assert.equal(isEligible(candidate, emptyFilters, now), false);
});
