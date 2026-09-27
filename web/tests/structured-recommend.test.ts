import assert from 'node:assert/strict';
import test from 'node:test';
import type { InterpretedInput } from '../lib/input-interpreter.ts';
import {
  emptyIntentState,
  intentQuery,
  type IntentState,
} from '../lib/input-state.ts';
import {
  recommend,
  validateInput,
  type Dependencies,
} from '../lib/recommend.ts';
import type { EventRecord } from '../lib/types.ts';

const now = new Date('2026-09-28T09:00:00Z');
const config = { apiKey: 'test-only', model: 'jev-test' };

function event(
  id: string,
  description = 'Akustik müzik konseri.',
): EventRecord {
  return {
    id,
    title: `Etkinlik ${id}`,
    description,
    startsAt: '2026-10-03T18:00:00Z',
    checkedAt: now.toISOString(),
    venue: `Sahne ${id}`,
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

function interpreted(
  state: IntentState,
  overrides: Partial<InterpretedInput> = {},
): InterpretedInput {
  return {
    state,
    action: 'search',
    issue: null,
    query: intentQuery(state),
    origin: 'jev',
    ...overrides,
  };
}

function structuredRequest(
  message: string,
  state?: IntentState,
  extra: Record<string, unknown> = {},
) {
  return validateInput({
    message,
    intentVersion: 1,
    ...(state ? { intentState: state } : {}),
    ...extra,
  });
}

void test('structured integration ignores stale history and passes only canonical state to retrieval and rank', async () => {
  const state = emptyIntentState({
    ...emptyIntentState().filters,
    category: 'Konser',
  });
  state.preferences.mood = 'calm';
  const stale = event('stale-jazz', 'Jazz konseri.');
  let rankedInput: Parameters<NonNullable<Dependencies['rank']>>[1] | undefined;
  const result = await recommend(
    structuredRequest('Keep the current search', state, {
      history: [
        { role: 'user', content: 'No jazz. Wheelchair access required.' },
      ],
    }),
    {
      inputInterpreter: 'jev-v1',
      now,
      config,
      interpret: async () => interpreted(state),
      candidates: async () => [stale],
      rank: async (_config, input, candidates) => {
        rankedInput = input;
        return {
          model: 'jev-test',
          usage: { inputTokens: 0, outputTokens: 0 },
          ranked: candidates.map((candidate) => ({
            event: candidate,
            score: 3,
            confidence: 1,
            probabilities: [0, 0, 0, 1] as const,
            supportProbability: 1,
          })),
        };
      },
    },
  );
  assert.deepEqual(rankedInput?.history, []);
  assert.deepEqual(rankedInput?.requirements, []);
  assert.equal(rankedInput?.message, intentQuery(state));
  assert.deepEqual(
    result.recommendations.map(({ event }) => event.id),
    ['stale-jazz'],
  );
});

void test('structured state survives evidence-empty results and ranker fallback', async () => {
  const inaccessible = emptyIntentState();
  inaccessible.requirements = [
    { kind: 'accessibility', value: 'step_free', policy: 'require_support' },
  ];
  const empty = await recommend(
    structuredRequest('Keep access', inaccessible),
    {
      inputInterpreter: 'jev-v1',
      now,
      config,
      interpret: async () => interpreted(inaccessible),
      candidates: async () => [event('unknown-access')],
      rank: async () => {
        throw new Error('must not rank unsupported evidence');
      },
    },
  );
  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.intentState, inaccessible);

  const accessibleEvent = event(
    'accessible',
    'Akustik konser. Basamaksız giriş.',
  );
  const fallback = await recommend(
    structuredRequest('Keep access', inaccessible),
    {
      inputInterpreter: 'jev-v1',
      now,
      config,
      interpret: async () => interpreted(inaccessible),
      candidates: async () => [accessibleEvent],
      rank: async () => {
        throw new Error('ranker outage');
      },
    },
  );
  assert.equal(fallback.status, 'results');
  assert.deepEqual(fallback.intentState, inaccessible);
  assert.deepEqual(
    fallback.recommendations.map(({ event }) => event.id),
    ['accessible'],
  );
});

void test('all eligible catalog rows reach semantic retrieval before the bounded shortlist and every supported shortlist row returns', async () => {
  const state = emptyIntentState();
  state.preferences.mood = 'uplifting';
  const catalog = Array.from({ length: 25 }, (_, index) => event(`e${index}`));
  let vectorCount = 0;
  let rankCount = 0;
  const result = await recommend(
    structuredRequest('Something uplifting', state),
    {
      inputInterpreter: 'jev-v1',
      now,
      config,
      embeddingConfig: {
        apiKey: 'test',
        model: 'voyage-test',
        dimensions: 256,
      },
      interpret: async () => interpreted(state),
      candidates: async () => catalog,
      vectors: async (events) => {
        vectorCount = events.length;
        return new Map(events.map((item, index) => [item.id, [index + 1, 1]]));
      },
      embed: async (_config, texts) => {
        assert.deepEqual(texts, [intentQuery(state)]);
        return [[1, 1]];
      },
      rank: async (_config, input, candidates) => {
        assert.deepEqual(input.history, []);
        rankCount = candidates.length;
        return {
          model: 'jev-test',
          usage: { inputTokens: 0, outputTokens: 0 },
          ranked: candidates.map((candidate) => ({
            event: candidate,
            score: 2,
            confidence: 1,
            probabilities: [0, 0, 1, 0] as const,
            supportProbability: 1,
          })),
        };
      },
    },
  );
  assert.equal(vectorCount, 25);
  assert.equal(rankCount, 16);
  assert.equal(result.totalCandidates, 25);
  assert.equal(result.recommendations.length, 16);
});

void test('interpreter issues stop catalog, embedding, and ranking work', async () => {
  for (const issue of [
    'constraint_ambiguous',
    'interpreter_unavailable',
  ] as const) {
    const state = emptyIntentState();
    let paidOrCatalogCalls = 0;
    const result = await recommend(structuredRequest('unclear', state), {
      inputInterpreter: 'jev-v1',
      now,
      config,
      embeddingConfig: {
        apiKey: 'test',
        model: 'voyage-test',
        dimensions: 256,
      },
      interpret: async () => interpreted(state, { issue }),
      candidates: async () => {
        paidOrCatalogCalls++;
        return [event('unexpected')];
      },
      embed: async () => {
        paidOrCatalogCalls++;
        return [[1]];
      },
      rank: async () => {
        paidOrCatalogCalls++;
        throw new Error('unexpected rank');
      },
    });
    assert.equal(result.status, 'needs_input');
    assert.equal(paidOrCatalogCalls, 0);
    assert.deepEqual(result.intentState, state);
  }
});

void test('requests without structured version remain on the legacy path', async () => {
  let interpretCalls = 0;
  const result = await recommend(validateInput({ message: 'Konser' }), {
    inputInterpreter: 'jev-v1',
    now,
    config: null,
    interpret: async ({ previous }) => {
      interpretCalls++;
      return interpreted(previous);
    },
    candidates: async () => [event('legacy')],
  });
  assert.equal(interpretCalls, 0);
  assert.equal(result.status, 'results');
  assert.equal(result.intentState, undefined);
});

void test('alternatives exclude accumulated semantic IDs while ordinary search does not', async () => {
  const state = emptyIntentState();
  const catalog = [event('a'), event('b'), event('c')];
  const run = (action: InterpretedInput['action']) =>
    recommend(
      structuredRequest('more', state, {
        excludeIds: ['a'],
        alternativeIds: ['b'],
      }),
      {
        inputInterpreter: 'jev-v1',
        now,
        config: null,
        interpret: async () => interpreted(state, { action }),
        candidates: async () => catalog,
      },
    );
  assert.deepEqual(
    (await run('alternatives')).recommendations.map(({ event }) => event.id),
    ['c'],
  );
  assert.deepEqual(
    new Set((await run('search')).recommendations.map(({ event }) => event.id)),
    new Set(['a', 'b', 'c']),
  );
});

void test('reset may clear prior filters and exclusions atomically', async () => {
  const previous = emptyIntentState({
    ...emptyIntentState().filters,
    category: 'Tiyatro',
    excludedCategories: ['Konser'],
  });
  previous.requirements = [
    { kind: 'genre', value: 'comedy', policy: 'exclude_positive_evidence' },
  ];
  const reset = emptyIntentState();
  let receivedPrevious: IntentState | undefined;
  let candidateFilters: IntentState['filters'] | undefined;
  const result = await recommend(structuredRequest('Yeni arama', previous), {
    inputInterpreter: 'jev-v1',
    now,
    config: null,
    interpret: async ({ previous: supplied }) => {
      receivedPrevious = supplied;
      return interpreted(reset, { action: 'reset' });
    },
    candidates: async (filters) => {
      candidateFilters = filters;
      return [event('concert')];
    },
  });
  assert.deepEqual(receivedPrevious, previous);
  assert.deepEqual(candidateFilters, reset.filters);
  assert.deepEqual(result.intentState, reset);
  assert.equal(result.status, 'results');
});

void test('invalid structured client state is rejected at the request boundary', () => {
  const state = emptyIntentState();
  assert.throws(() =>
    validateInput({
      message: 'Konser',
      intentVersion: 1,
      intentState: { ...state, sourceVerified: true },
    }),
  );
  assert.throws(() => validateInput({ message: 'Konser', intentState: state }));
});

void test('rules rollback cannot silently drop structured hard requirements', async () => {
  const state = emptyIntentState();
  state.requirements = [
    { kind: 'accessibility', value: 'step_free', policy: 'require_support' },
  ];
  let candidateCalls = 0;
  const result = await recommend(
    structuredRequest('Başka öner', state, {
      history: [{ role: 'user', content: 'Tekerlekli sandalye erişimi şart.' }],
    }),
    {
      inputInterpreter: 'rules',
      now,
      config: null,
      candidates: async () => {
        candidateCalls++;
        return [event('must-not-run')];
      },
    },
  );
  assert.equal(result.status, 'needs_input');
  assert.equal(result.resetRequired, true);
  assert.equal(candidateCalls, 0);
});

void test('typed budget clarification retains the unresolved request without committing partial filters', async () => {
  const state = emptyIntentState();
  const message = 'Cumartesi üç kişiyiz, bütçe 1500 TL';
  const first = await recommend(structuredRequest(message, state), {
    inputInterpreter: 'jev-v1',
    now,
    config,
    interpret: async () => interpreted(state, { issue: 'budget_ambiguous' }),
    candidates: async () => {
      throw new Error('must stop for clarification');
    },
  });
  assert.deepEqual(first.intentState, state);
  assert.deepEqual(first.pendingInput, { message, reason: 'budget_ambiguous' });
  assert.deepEqual(
    first.clarification?.map((choice) => choice.message),
    ['Bütçe kişi başı.', 'Bütçe toplam.'],
  );
  const next = emptyIntentState({
    ...state.filters,
    partySize: 3,
    maxPrice: 1500,
  });
  const resolved = await recommend(
    structuredRequest('kişi başı', state, { pendingInput: first.pendingInput }),
    {
      inputInterpreter: 'jev-v1',
      now,
      config: null,
      interpret: async (input) => {
        assert.equal(input.message, 'kişi başı');
        assert.equal(input.unresolvedRequest, message);
        assert.deepEqual(input.previous, state);
        return interpreted(next);
      },
      candidates: async () => [],
    },
  );
  assert.equal(resolved.pendingInput, undefined);
  assert.deepEqual(resolved.intentState, next);
});

void test('pending input is validated and cannot silently overflow or fall back to rules', async () => {
  for (const pendingInput of [
    null,
    [],
    { message: 'x', reason: 'invented' },
    { message: 'x', reason: 'budget_ambiguous', verified: true },
    { message: 'x'.repeat(1201), reason: 'budget_ambiguous' },
  ])
    assert.throws(() =>
      structuredRequest('kişi başı', undefined, { pendingInput }),
    );
  assert.throws(() =>
    validateInput({
      message: 'kişi başı',
      pendingInput: { message: 'bütçe 500', reason: 'budget_ambiguous' },
    }),
  );
  const request = structuredRequest('kişi başı', emptyIntentState(), {
    pendingInput: { message: 'x'.repeat(1200), reason: 'budget_ambiguous' },
  });
  for (const inputInterpreter of ['jev-v1', 'rules'] as const) {
    const result = await recommend(request, {
      inputInterpreter,
      now,
      config,
      interpret: async () => {
        throw new Error('must not call provider');
      },
      candidates: async () => {
        throw new Error('must not retrieve');
      },
    });
    assert.equal(result.status, 'needs_input');
    assert.equal(result.resetRequired, true);
  }
});
