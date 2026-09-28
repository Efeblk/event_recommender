import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { mergeEventSessions } from '../lib/event-merge.ts';
import { buildSearchCatalog, searchCatalogCandidates } from '../lib/materialized-catalog.ts';
import { isEligible } from '../lib/search.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';
import { voyageDocumentText } from '../lib/voyage.ts';

const publishedAt = new Date('2026-09-29T12:00:00.000Z');
const expiry = Date.parse('2026-09-30T12:00:00.000Z');
function event(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'biletinial:1', title: 'Ortak Oyun', description: 'Bir tiyatro gösterisi.',
    startsAt: '2026-10-02T17:00:00.000Z', venue: 'Örnek Sahne',
    city: 'İstanbul', district: 'Kadıköy', address: 'Örnek adres',
    price: 500, currency: 'TRY', url: 'https://biletinial.example/1',
    imageUrl: '', category: 'Tiyatro', availability: 'available',
    source: 'biletinial', checkedAt: '2026-09-27T12:00:00.000Z',
    ...overrides,
  };
}
function later(overrides: Partial<EventRecord> = {}): EventRecord {
  return event({ id: 'bubilet:2', source: 'bubilet', url: 'https://bubilet.example/2',
    checkedAt: publishedAt.toISOString(), ...overrides });
}
function expected(events: EventRecord[], at: Date) {
  return mergeEventSessions(events.filter((entry) => isEligible(entry, emptyFilters, at)));
}
function sourceRecords(events: EventRecord[]) {
  return events.map((entry) => {
    const event = { ...entry };
    delete event.preparedSearch;
    return event;
  });
}

await test('materialized offers expire individually at the exact inclusive freshness boundary', () => {
  const old = event({ price: 100 });
  const fresh = later({ price: 600 });
  const raw = [old, fresh];
  const original = structuredClone(raw);
  const snapshot = buildSearchCatalog(raw, publishedAt);
  for (const instant of [publishedAt.getTime(), expiry - 1, expiry, expiry + 1]) {
    const at = new Date(instant);
    assert.deepEqual(sourceRecords(searchCatalogCandidates(snapshot, emptyFilters, at)), expected(raw, at));
  }
  const atBoundary = searchCatalogCandidates(snapshot, emptyFilters, new Date(expiry));
  assert.equal(atBoundary[0].offers?.length, 2);
  assert.equal(atBoundary[0].price, 100);
  const after = searchCatalogCandidates(snapshot, emptyFilters, new Date(expiry + 1));
  assert.deepEqual(after[0].offers?.map(({ id }) => id), [fresh.id]);
  assert.equal(after[0].price, 600);
  assert.equal(after[0].url, fresh.url);
  assert.deepEqual(searchCatalogCandidates(snapshot, { ...emptyFilters, maxPrice: 200 }, new Date(expiry + 1)), []);
  assert.deepEqual(raw, original, 'publication must preserve raw checkpoint records');
});

await test('expiry recombines previously conflicting policy groups within the full identity family', () => {
  const adult = event({ description: 'Yalnızca yetişkinler için.' });
  const child = later({ description: 'Sadece çocuklar için.' });
  const unspecified = later({ id: 'biletix:3', source: 'biletix', url: 'https://biletix.example/3' });
  const raw = [adult, child, unspecified];
  const snapshot = buildSearchCatalog(raw, publishedAt);
  const initial = searchCatalogCandidates(snapshot, emptyFilters, publishedAt);
  assert.equal(initial.length, 3);
  assert.deepEqual(new Set(initial.map(({ id }) => id)), new Set(raw.map(({ id }) => id)));
  const after = searchCatalogCandidates(snapshot, emptyFilters, new Date(expiry + 1));
  assert.equal(after.length, 1);
  assert.deepEqual(new Set(after[0].offers?.map(({ id }) => id)), new Set([child.id, unspecified.id]));
  assert.deepEqual(sourceRecords(after), expected(raw, new Date(expiry + 1)));
});

await test('publication preserves distinct sessions and expires started performances', () => {
  const raw = [event(), later({ startsAt: '2026-10-02T19:00:00.000Z' })];
  const snapshot = buildSearchCatalog(raw, publishedAt);
  const cards = searchCatalogCandidates(snapshot, emptyFilters, publishedAt);
  assert.equal(cards.length, 2);
  assert.deepEqual(new Set(cards.map(({ startsAt }) => startsAt)), new Set(raw.map(({ startsAt }) => startsAt)));
  const near = event({ checkedAt: publishedAt.toISOString(), startsAt: '2026-09-29T13:00:00.000Z' });
  const shortSnapshot = buildSearchCatalog([near], publishedAt);
  assert.equal(searchCatalogCandidates(shortSnapshot, emptyFilters, new Date(near.startsAt)).length, 1);
  assert.deepEqual(searchCatalogCandidates(shortSnapshot, emptyFilters, new Date(Date.parse(near.startsAt) + 1)), []);
});

await test('active representative keeps exact embedding document text as offers expire', () => {
  const old = event({ description: 'İlk kaynağın açıklaması.' });
  const fresh = later({ description: 'İkinci kaynağın açıklaması.' });
  const snapshot = buildSearchCatalog([old, fresh], publishedAt);
  const initial = searchCatalogCandidates(snapshot, emptyFilters, publishedAt)[0];
  assert.equal(voyageDocumentText(initial), voyageDocumentText(old));
  assert.equal(initial.preparedSearch?.documentText, voyageDocumentText(old));
  assert.equal(initial.preparedSearch?.documentHash, createHash('sha256').update(voyageDocumentText(old)).digest('hex'));
  const after = searchCatalogCandidates(snapshot, emptyFilters, new Date(expiry + 1))[0];
  assert.equal(voyageDocumentText(after), voyageDocumentText(fresh));
  assert.equal(after.preparedSearch?.documentText, voyageDocumentText(fresh));
  assert.equal(after.preparedSearch?.documentHash, createHash('sha256').update(voyageDocumentText(fresh)).digest('hex'));
  assert.notEqual(voyageDocumentText(initial), voyageDocumentText(after));
});

await test('future clock-skewed source activates when it enters the five-minute allowance', () => {
  const future = event({ checkedAt: '2026-09-29T12:06:00.000Z' });
  const snapshot = buildSearchCatalog([future], publishedAt);
  assert.deepEqual(searchCatalogCandidates(snapshot, emptyFilters, publishedAt), []);
  const activation = new Date('2026-09-29T12:01:00.000Z');
  assert.deepEqual(sourceRecords(searchCatalogCandidates(snapshot, emptyFilters, activation)), expected([future], activation));
  assert.equal(searchCatalogCandidates(snapshot, emptyFilters, activation).length, 1);
});

await test('materialized catalog fails closed for requests before its publication time', () => {
  const snapshot = buildSearchCatalog([event()], publishedAt);
  assert.throws(() => searchCatalogCandidates(snapshot, emptyFilters, new Date(publishedAt.getTime() - 1)));
});
