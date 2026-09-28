import test from 'node:test';
import assert from 'node:assert/strict';
import { recommend, validateInput } from '../lib/recommend.ts';
import type { JevRanking } from '../lib/jev.ts';
import type { EventRecord } from '../lib/types.ts';

const now = new Date('2026-09-07T09:00:00Z');

function event(id: string, description: string): EventRecord {
  return {
    id,
    title: `Concert ${id}`,
    description,
    startsAt: '2026-09-12T18:00:00Z',
    checkedAt: now.toISOString(),
    venue: 'Test Venue',
    city: 'İstanbul',
    district: 'Kadıköy',
    address: '',
    price: 500,
    currency: 'TRY',
    category: 'Konser',
    availability: 'available',
    imageUrl: '',
    url: `https://example.test/${id}`,
  };
}

const supported = event(
  'supported',
  'Tekerlekli sandalye erişimi bulunan bir konser.',
);
const unknown = event('unknown', 'Canlı müzik konseri.');
const contradicted = event(
  'contradicted',
  'Tekerlekli sandalye erişimi bulunmuyor.',
);
const wheelchairRequest = validateInput({
  message: 'Tekerlekli sandalye erişimi kesin şart, konser öner.',
});

await test('diagnostics distinguish missing and contradicted evidence from actual filtering', async () => {
  const result = await recommend(wheelchairRequest, {
    now,
    config: null,
    candidates: async () => [supported, unknown, contradicted],
  });

  assert.deepEqual(
    result.recommendations.map(({ event }) => event.id),
    ['supported'],
  );
  assert.deepEqual(result.diagnostics, {
    catalogRetrieved: 3,
    eligibleBeforeSourceEvidence: 3,
    hardRequirements: [
      {
        kind: 'accessibility',
        value: 'step_free',
        policy: 'require_support',
        supported: 1,
        unknown: 1,
        contradicted: 1,
      },
    ],
    eligibleAfterSourceEvidence: 1,
    alternativeExclusions: 0,
    distinctShortlist: 1,
    vectorCoverage: { available: 0, eligible: 1 },
    returnedAboveSupportThreshold: null,
  });
});

await test('fallback and AI diagnostics share the same funnel and report vector coverage', async () => {
  const candidates = [
    supported,
    event('second', 'Tekerlekli sandalye erişimi bulunan caz konseri.'),
    event('third', 'Engelsiz erişim bulunan rock konseri.'),
  ];
  const base = {
    now,
    candidates: async () => candidates,
    embeddingConfig: {
      apiKey: 'test-only',
      model: 'voyage-4-lite',
      dimensions: 256 as const,
    },
    vectors: async () =>
      new Map([
        ['supported', [1, 0]],
        ['second', [0.8, 0.2]],
      ]),
    embed: async () => [[1, 0]],
  };
  const fallback = await recommend(wheelchairRequest, {
    ...base,
    config: null,
  });
  const ai = await recommend(wheelchairRequest, {
    ...base,
    config: { apiKey: 'test-only', model: 'jev-test' },
    rank: async (_config, _input, shortlist): Promise<JevRanking> => ({
      model: 'jev-test',
      usage: { inputTokens: 0, outputTokens: 0 },
      ranked: shortlist.map((candidate, index) => ({
        event: candidate,
        score: 3 - index * 0.1,
        confidence: 0.9,
        probabilities:
          index < 2
            ? ([0, 0, 0.2, 0.8] as const)
            : ([0.1, 0.3, 0.3, 0.3] as const),
        supportProbability: index < 2 ? 1 : 0.6,
      })),
    }),
  });

  for (const result of [fallback, ai]) {
    assert.equal(result.diagnostics?.catalogRetrieved, 3);
    assert.equal(result.diagnostics?.eligibleBeforeSourceEvidence, 3);
    assert.equal(result.diagnostics?.eligibleAfterSourceEvidence, 3);
    assert.equal(result.diagnostics?.distinctShortlist, 3);
    assert.deepEqual(result.diagnostics?.vectorCoverage, {
      available: 2,
      eligible: 3,
    });
  }
  assert.equal(fallback.diagnostics?.returnedAboveSupportThreshold, null);
  assert.equal(fallback.recommendations.length, 3);
  assert.equal(ai.diagnostics?.returnedAboveSupportThreshold, 2);
  assert.equal(ai.recommendations.length, 2);
});

await test('all-passing searches and alternative exclusions keep exact funnel counts', async () => {
  const first = event('first', 'Canlı müzik.');
  const second = event('second', 'Akustik müzik.');
  const result = await recommend(
    { ...validateInput({ message: 'Konser' }), excludeIds: ['first'] },
    {
      now,
      config: null,
      candidates: async () => [first, second],
    },
  );

  assert.deepEqual(result.diagnostics?.hardRequirements, []);
  assert.equal(result.diagnostics?.alternativeExclusions, 1);
  assert.equal(result.diagnostics?.eligibleBeforeSourceEvidence, 1);
  assert.equal(result.diagnostics?.eligibleAfterSourceEvidence, 1);
  assert.equal(result.diagnostics?.distinctShortlist, 1);
  assert.deepEqual(
    result.recommendations.map(({ event }) => event.id),
    ['second'],
  );
});
