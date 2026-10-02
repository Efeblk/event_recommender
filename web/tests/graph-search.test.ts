import assert from 'node:assert/strict';
import test from 'node:test';
import { graphSearch } from '../experiments/graph/search.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';

const checkedAt = '2026-09-29T09:00:00.000Z';
function event(id: string, title: string, description = ''): EventRecord {
  return {
    id, title, description, startsAt: '2026-10-02T17:00:00.000Z', venue: 'Salon', city: 'İstanbul',
    district: 'Kadıköy', address: 'Moda, Kadıköy', price: 200, currency: 'TRY', url: `https://example.com/${id}`,
    imageUrl: '', category: 'Konser', availability: 'available', checkedAt,
  };
}

void test('graph filters the complete pool and preserves frozen event order', async () => {
  const events = [event('first', 'First'), event('second', 'Second'), event('third', 'Third')];
  const calls: { statement: string; parameters?: Record<string, unknown> }[] = [];
  const client = { query: async (statement: string, parameters?: Record<string, unknown>) => {
    calls.push({ statement, parameters });
    return [{ id: 'third' }, { id: 'first' }];
  } };
  const result = await graphSearch(client as never, new Map(events.map((item) => [item.id, item])), {
    filters: { ...emptyFilters, district: 'Kadıköy', startTimeFrom: '19:30', maxPrice: 250 }, query: '', neighborhood: 'Moda',
  });
  assert.deepEqual(result.eligible.map(({ id }) => id), ['first', 'third']);
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0].statement, /\bLIMIT\b/i);
  assert.equal(calls[0].parameters?.districtKey, 'kadikoy');
  assert.equal(calls[0].parameters?.neighborhoodKey, 'moda');
  assert.equal(calls[0].parameters?.startTimeFrom, 19 * 60 + 30);
});

void test('source requirements run before dense scoring and missing vectors remain lexical candidates', async () => {
  const jazz = event('jazz', 'Gece', 'Canlı caz konseri.');
  const rock = event('rock', 'Rock gecesi', 'Rock konseri.');
  const lexicalOnly = event('lexical', 'Zümrüt Kristal', 'Özel gösteri.');
  const calls: { statement: string; parameters?: Record<string, unknown> }[] = [];
  const client = { query: async (statement: string, parameters?: Record<string, unknown>) => {
    calls.push({ statement, parameters });
    if (statement.includes('vector.similarity.cosine')) return [{ id: 'jazz', score: 0.75 }];
    return [{ id: 'rock' }, { id: 'lexical' }, { id: 'jazz' }];
  } };
  const result = await graphSearch(client as never, new Map([jazz, rock, lexicalOnly].map((item) => [item.id, item])), {
    filters: emptyFilters, query: 'Zümrüt Kristal', queryVector: Array(1024).fill(0.1),
    requirements: [{ kind: 'genre', value: 'jazz|classical', policy: 'require_support' }],
  });
  assert.deepEqual(result.eligible.map(({ id }) => id), ['jazz']);
  assert.deepEqual(calls[1].parameters?.ids, ['jazz']);
  assert.equal(result.denseScores?.get('jazz'), 0.5);

  const withoutRequirement = await graphSearch(client as never, new Map([jazz, rock, lexicalOnly].map((item) => [item.id, item])), {
    filters: emptyFilters, query: 'Zümrüt Kristal', queryVector: Array(1024).fill(0.1),
  });
  assert.ok(withoutRequirement.ranked.some(({ id }) => id === 'lexical'));
});

void test('graph search rejects invalid vectors before querying the graph', async () => {
  let queried = false;
  const client = { query: async () => { queried = true; return []; } };
  await assert.rejects(
    graphSearch(client as never, new Map(), { filters: emptyFilters, query: 'x', queryVector: [1, 2] }),
    /1024 finite numbers/,
  );
  assert.equal(queried, false);
});
