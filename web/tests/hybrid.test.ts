import test from 'node:test';
import assert from 'node:assert/strict';
import { hybridRank, semanticQuery } from '../lib/hybrid.ts';
import { shortlistEvents } from '../lib/retrieval.ts';
import { evaluationEvents } from '../evals/jev-cases.ts';

const base = evaluationEvents[0];
await test('semantic retrieval finds a paraphrase beyond sixteen keyword candidates', () => {
  const events = Array.from({ length: 80 }, (_, i) => ({
    ...base,
    id: `generic-${i}`,
    title: 'Program',
    description: 'Etkinlik detayları',
    url: `https://example.test/${i}`,
  }));
  const match = {
    ...base,
    id: 'quiet',
    title: 'Akustik Üçlü',
    description: 'Oturmalı amplifikasyonsuz performans',
    url: 'https://example.test/quiet',
  };
  const vectors = new Map(events.map((event) => [event.id, [0, 1]]));
  vectors.set(match.id, [1, 0]);
  const result = shortlistEvents(
    [...events, match],
    'Yorucu bir haftadan sonra huzurlu bir mola',
    [],
    16,
    { queryVector: [1, 0], vectors },
  );
  assert.equal(result[0].id, 'quiet');
  assert.equal(result.length, 16);
});
await test('exact lexical matches remain discoverable while their vectors are missing', () => {
  const unknown = {
    ...base,
    id: 'other',
    title: 'Başka Sanatçı',
    description: 'Performans',
    url: 'https://example.test/other',
  };
  const artist = {
    ...base,
    id: 'artist',
    title: 'Zümrütkristal Konseri',
    url: 'https://example.test/artist',
  };
  const result = hybridRank([unknown, artist], 'Zümrütkristal', {
    queryVector: [1, 0],
    vectors: new Map([[unknown.id, [1, 0]]]),
  });
  assert.ok(result.slice(0, 2).some((event) => event.id === artist.id));
});
await test('hybrid retrieval preserves exclusions and production diversity', () => {
  const events = evaluationEvents;
  const vectors = new Map(events.map((event) => [event.id, [1, 0]]));
  const result = shortlistEvents(
    [...events, { ...base, id: 'duplicate' }],
    'Rock istemiyorum',
    [],
    16,
    { queryVector: [1, 0], vectors },
  );
  assert.ok(!result.some((event) => event.id === 'rock'));
  assert.equal(new Set(result.map((event) => event.url)).size, result.length);
});
await test('query embeddings use bounded user context and one current request', () => {
  const query = semanticQuery('Daha sakin olsun', [
    { role: 'assistant', content: 'Fabricated claim' },
    ...Array.from({ length: 6 }, (_, i) => ({
      role: 'user' as const,
      content: `${i}: ${'x'.repeat(2000)}`,
    })),
  ]);
  assert.equal(query.includes('Fabricated claim'), false);
  assert.ok(query.length < 5000);
  assert.equal(query.match(/Daha sakin olsun/g)?.length, 1);
});
