import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyIntentState, intentQuery } from '../lib/input-state.ts';
import {
  recommend,
  validateInput,
  type Dependencies,
} from '../lib/recommend.ts';
import type { EventRecord } from '../lib/types.ts';
import { emptyPlan } from '../parser/contract.ts';

const now = new Date('2026-09-30T09:00:00Z');
const config = { apiKey: 'test-only', model: 'jev-test' };

function event(id: string, title = `Pinned ${id}`): EventRecord {
  return {
    id,
    title,
    description: 'Akustik konser',
    startsAt: '2026-10-03T18:00:00Z',
    checkedAt: now.toISOString(),
    venue: 'Sahne',
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

const input = validateInput({
  message: 'Konser öner',
  intentVersion: 1,
});

function rankAll(): NonNullable<Dependencies['rank']> {
  return async (_config, _input, candidates) => ({
    model: 'jev-test',
    usage: { inputTokens: 0, outputTokens: 0 },
    ranked: candidates.map((candidate) => ({
      event: candidate,
      score: 3,
      confidence: 1,
      probabilities: [0, 0, 0, 1] as const,
      supportProbability: 1,
    })),
  });
}

void test('catalog is pinned before structured interpretation and publication ID survives', async () => {
  const calls: string[] = [];
  const pinned = event('pinned');
  const state = emptyIntentState();
  state.filters.category = 'Konser';
  const result = await recommend(input, {
    now,
    config,
    inputInterpreter: 'jev-v1',
    pinCatalog: async (at) => {
      calls.push('pin');
      assert.equal(at, now);
      return {
        publicationId: 'publication-42',
        availability: async () => {
          calls.push('availability');
          return true;
        },
        candidates: async () => {
          calls.push('candidates');
          return [pinned];
        },
        vectors: async () => new Map(),
        finalize: async (events) => {
          calls.push('finalize');
          return events;
        },
      };
    },
    candidates: async () => assert.fail('unpinned catalog must not be read'),
    interpret: async () => {
      calls.push('interpret');
      return {
        state,
        action: 'search',
        issue: null,
        query: intentQuery(state),
        origin: 'jev',
      };
    },
    rank: rankAll(),
  });

  assert.deepEqual(calls, [
    'pin',
    'interpret',
    'availability',
    'candidates',
    'finalize',
  ]);
  assert.equal(result.publicationId, 'publication-42');
  assert.deepEqual(
    result.recommendations.map(({ event }) => event.id),
    ['pinned'],
  );
});

void test('unavailable pinned catalog is checked after interpretation and before candidates or ranking', async () => {
  const calls: string[] = [];
  const state = emptyIntentState();
  state.filters.category = 'Konser';
  const result = await recommend(input, {
    now,
    config,
    inputInterpreter: 'jev-v1',
    pinCatalog: async () => ({
      publicationId: 'publication-unavailable',
      availability: async () => {
        calls.push('availability');
        return false;
      },
      catalogStatus: async () => {
        calls.push('status');
        return {
          status: 'stale',
          stored: 1,
          eligible: 0,
          lastCheckedAt: now.toISOString(),
          oldestCheckedAt: now.toISOString(),
          expiresAt: now.toISOString(),
        };
      },
      candidates: async () => assert.fail('stale catalog must not be read'),
      vectors: async () => assert.fail('vectors must not be read'),
      finalize: async (events) => {
        calls.push('finalize');
        assert.deepEqual(events, []);
        return [];
      },
    }),
    candidates: async () => assert.fail('unpinned catalog must not be read'),
    interpret: async () => {
      calls.push('interpret');
      return {
        state,
        action: 'search',
        issue: null,
        query: intentQuery(state),
        origin: 'jev',
      };
    },
    rank: async () => assert.fail('ranking must not run'),
  });

  assert.deepEqual(calls, ['interpret', 'availability', 'status', 'finalize']);
  assert.equal(result.status, 'empty');
  assert.equal(result.publicationId, 'publication-unavailable');
  assert.equal(result.intentState?.filters.category, 'Konser');
  assert.match(result.notice ?? '', /güncel kaynak durumu/);
});

void test('clarification preserves state without consulting catalog freshness', async () => {
  const calls: string[] = [];
  const state = emptyIntentState();
  const result = await recommend(input, {
    now,
    config,
    inputInterpreter: 'jev-v1',
    pinCatalog: async () => ({
      publicationId: 'publication-needs-input',
      availability: async () =>
        assert.fail('clarification must not check the catalog'),
      candidates: async () =>
        assert.fail('clarification must not read candidates'),
      vectors: async () => new Map(),
      finalize: async (events) => {
        calls.push('finalize');
        return events;
      },
    }),
    candidates: async () => [],
    interpret: async () => {
      calls.push('interpret');
      return {
        state,
        action: 'search',
        issue: 'budget_ambiguous',
        query: intentQuery(state),
        origin: 'jev',
      };
    },
  });

  assert.deepEqual(calls, ['interpret', 'finalize']);
  assert.equal(result.status, 'needs_input');
  assert.equal(result.publicationId, 'publication-needs-input');
  assert.deepEqual(result.intentState, state);
  assert.ok(result.clarification?.length);
});

for (const mode of ['ai', 'fallback'] as const) {
  void test(`final validation applies to ${mode} cards and cannot replace pinned facts`, async () => {
    const kept = event('kept', 'Pinned title');
    const stale = event('stale');
    let finalized: string[] = [];
    const result = await recommend(validateInput({ message: 'konser' }), {
      now,
      config: mode === 'ai' ? config : null,
      candidates: async () => assert.fail('unpinned catalog must not be read'),
      rank: rankAll(),
      pinCatalog: async () => ({
        publicationId: `publication-${mode}`,
        candidates: async () => [kept, stale],
        vectors: async () => new Map(),
        finalize: async (events) => {
          finalized = events.map(({ id }) => id);
          return [
            { ...kept, title: 'Unpinned replacement', price: 1 },
            event('injected'),
          ];
        },
      }),
    });

    assert.deepEqual(new Set(finalized), new Set(['kept', 'stale']));
    assert.equal(result.publicationId, `publication-${mode}`);
    assert.deepEqual(
      result.recommendations.map(({ event }) => event.id),
      ['kept'],
    );
    assert.equal(result.recommendations[0].event.title, 'Pinned title');
    assert.equal(result.recommendations[0].event.price, 500);
    assert.equal(result.status, 'results');
    assert.match(result.notice ?? '', /güncel durumu değişti/);
  });
}

void test('all stale cards are withheld and diagnostics reflect rendered results', async () => {
  const result = await recommend(validateInput({ message: 'konser' }), {
    now,
    config,
    candidates: async () => [],
    rank: rankAll(),
    pinCatalog: async () => ({
      publicationId: 'publication-stale',
      candidates: async () => [event('stale')],
      vectors: async () => new Map(),
      finalize: async () => [],
    }),
  });
  assert.equal(result.status, 'empty');
  assert.deepEqual(result.recommendations, []);
  assert.equal(result.diagnostics?.returnedAboveSupportThreshold, 0);
  assert.equal(result.publicationId, 'publication-stale');
});

void test('span-v2 uses the pinned catalog and withholds stale finalized cards', async () => {
  const calls: string[] = [];
  const kept = event('span-kept');
  const stale = event('span-stale');
  const result = await recommend(
    validateInput({ message: 'konser', intentVersion: 2 }),
    {
      now,
      config: null,
      inputInterpreter: 'span-v2',
      candidates: async () => assert.fail('unpinned catalog must not be read'),
      spanInterpret: async () => {
        calls.push('interpret');
        return {
          status: 'accepted',
          operations: [],
          resultingPlan: emptyPlan(),
          debug: { mentions: [], answers: {} },
        };
      },
      pinCatalog: async () => ({
        publicationId: 'publication-span',
        candidates: async () => {
          calls.push('candidates');
          return [kept, stale];
        },
        vectors: async () => new Map(),
        finalize: async (events) => {
          calls.push(`finalize:${events.map(({ id }) => id).join(',')}`);
          return [kept];
        },
      }),
    },
  );

  assert.deepEqual(calls, [
    'interpret',
    'candidates',
    'finalize:span-kept,span-stale',
  ]);
  assert.equal(result.publicationId, 'publication-span');
  assert.deepEqual(
    result.recommendations.map(({ event }) => event.id),
    ['span-kept'],
  );
  assert.match(result.notice ?? '', /durumu/);
});

void test('legacy dependencies retain behavior without a publication pin', async () => {
  const legacy = event('legacy');
  const result = await recommend(validateInput({ message: 'konser' }), {
    now,
    config: null,
    candidates: async () => [legacy],
  });
  assert.equal(result.publicationId, undefined);
  assert.deepEqual(
    result.recommendations.map(({ event }) => event.id),
    ['legacy'],
  );
});
