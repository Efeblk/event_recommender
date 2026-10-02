import assert from 'node:assert/strict';
import test from 'node:test';
import { buildJevRequest, type JevRanking } from '../lib/jev.ts';
import { emptyPlanState } from '../lib/plan-state.ts';
import { recommend, validateInput, type Dependencies } from '../lib/recommend.ts';
import { interpretSpanInput } from '../lib/span-interpreter.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';
import { buildRequest, compose, type JevResponse, type ParseResult } from '../parser/parse-core.ts';
import type { Condition, ParserInput, Plan } from '../parser/contract.ts';

const now = new Date('2026-10-02T09:00:00Z');
const config = { apiKey: 'test-only', model: 'jev-1.13.0' };
const event = (id: string, overrides: Partial<EventRecord> = {}): EventRecord => ({
  id, title: `Event ${id}`, description: 'Verified event information.', startsAt: '2026-10-03T18:00:00Z',
  checkedAt: now.toISOString(), venue: 'Salon', city: '\u0130stanbul', district: 'Kad\u0131k\u00f6y', address: 'Kad\u0131k\u00f6y',
  price: 300, currency: 'TRY', category: 'Konser', availability: 'available', imageUrl: '', url: `https://example.test/${id}`,
  attendanceTiming: { kind: 'timed_session', evidence: 'provider_sessions_and_source_text' }, ...overrides,
});
const plan = (children: Condition[], preferences: Condition[] = [], order: Plan['order'] = 'none'): Plan => ({ hard: { type: 'all', children }, preferences, order });
const hardChildren = (value: Plan) => {
  assert.equal(value.hard.type, 'all');
  return value.hard.children;
};
const accepted = (resultingPlan: Plan): ParseResult => ({ status: 'accepted', operations: [], resultingPlan, debug: { mentions: [], answers: {} } });
const request = (message: string, planState = emptyPlanState()) => validateInput({ message, intentVersion: 2, planState, filters: emptyFilters });
const deps = (events: EventRecord[], resultingPlan: Plan, extra: Partial<Dependencies> = {}): Dependencies => ({
  now, config: null, inputInterpreter: 'span-v2', candidates: async () => events,
  spanInterpret: async () => accepted(resultingPlan), ...extra,
});

function fullJudgments(built: ReturnType<typeof buildRequest>, overrides: Record<string, string> = {}): JevResponse {
  const answers = Object.fromEntries(Object.entries(built.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: id.startsWith('supported_') ? 1 : 0 }];
    const keys = Object.keys(question.criteria);
    const preferred = overrides[id] ?? (id.startsWith('polarity_') ? 'wanted'
      : id.startsWith('cmp_') ? 'lt' : id.startsWith('basis_') ? 'per_person'
        : id.startsWith('clock_') ? 'at' : id.startsWith('link_') ? 'and'
          : id.startsWith('edit_') ? 'unchanged' : id === 'order' ? 'unchanged'
            : id === 'action' ? 'continue' : id === 'vague' ? 'none' : keys[0]);
    return [id, { type: 'choice', choice: preferred, confidence: 1,
      probabilities: Object.fromEntries(keys.map((key) => [key, key === preferred ? 1 : 0])) }];
  }));
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 1 } } as JevResponse;
}

function actualInterpret(overrides: (built: ReturnType<typeof buildRequest>) => Record<string, string> = () => ({})) {
  return async (input: ParserInput): Promise<ParseResult> => {
    const built = buildRequest(input);
    return compose(input, built, fullJudgments(built, overrides(built)));
  };
}

function providerResponse(body: string) {
  const request = JSON.parse(body) as { model: string; questions: Record<string, { type: 'choice' | 'noul'; criteria?: Record<string, unknown> }> };
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: id.startsWith('supported_') ? 1 : 0 }];
    const keys = Object.keys(question.criteria ?? {});
    const choice = id.startsWith('polarity_') ? 'wanted' : id.startsWith('cmp_') ? 'lt'
      : id.startsWith('basis_') ? 'per_person' : id === 'order' ? 'unchanged'
        : id === 'action' ? 'continue' : keys[0];
    return [id, { type: 'choice', choice, confidence: 1,
      probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])) }];
  }));
  return { model: request.model, answers, usage: { input_tokens: 10, output_tokens: 5 } };
}

void test('initial recommendation runs through the production span transport with injected Jev fetch', async () => {
  let fetches = 0;
  const candidate = event('raw-chain', { price: 500 });
  const result = await recommend(validateInput({
    message: 'concert on 2026-10-03 under 600 TL', intentVersion: 2, filters: emptyFilters,
  }), {
    now, config, inputInterpreter: 'span-v2', candidates: async () => [candidate],
    spanInterpret: (input, options) => interpretSpanInput(input, { ...options, fetcher: async (_url, init) => {
      fetches++;
      const body = init?.body;
      if (typeof body !== 'string') throw new Error('expected request body');
      return Response.json(providerResponse(body));
    } }),
    rank: async (_config, _input, candidates) => supported(candidates),
  });
  assert.equal(fetches, 1);
  assert.equal(result.status, 'results');
  assert.deepEqual(result.recommendations.map((item) => item.event.id), ['raw-chain']);
  assert.ok(result.planState && hardChildren(result.planState.plan).some((condition) => condition.type === 'atom' && condition.atom.kind === 'budget'));
});

void test('real span composition handles Turkish and English initial dates, exclusions, and budgets', async () => {
  for (const message of ['2026-10-03 tarihinde 600 TL alt\u0131 tiyatro, konser olmas\u0131n', 'Theatre on 2026-10-03 under 600 TL, no concerts']) {
    const seen: Plan[] = [];
    const result = await recommend(request(message), {
      ...deps([event('theatre', { category: 'Tiyatro', price: 500 }), event('concert')], plan([])),
      spanInterpret: actualInterpret((built) => Object.fromEntries(built.mentions.flatMap((mention) =>
        mention.kind === 'category' && mention.value === 'concert' ? [[`polarity_${mention.id}`, 'unwanted']]
          : mention.kind === 'topic' && mention.value === 'history' ? [[`polarity_${mention.id}`, 'not_condition']] : []))),
      candidates: async () => [event('theatre', { category: 'Tiyatro', price: 500 }), event('concert')],
      rank: async (_config, input, candidates) => { seen.push(input.plan!); return supported(candidates); }, config,
    });
    assert.deepEqual(result.recommendations.map((item) => item.event.id), ['theatre'], JSON.stringify({ result, seen }));
    assert.ok(hardChildren(seen[0]).some((condition) => condition.type === 'atom' && condition.atom.kind === 'date'));
    assert.ok(hardChildren(seen[0]).some((condition) => condition.type === 'atom' && condition.atom.kind === 'budget'));
  }
});

void test('real span correction updates group attendance while preserving the prior budget', async () => {
  const previousPlan = plan([
    { type: 'atom', id: 'h0', atom: { kind: 'party', count: 2 } },
    { type: 'atom', id: 'h1', atom: { kind: 'budget', comparison: 'lte', amount: 900, currency: 'TRY', basis: 'group_total' } },
  ]);
  const state = { version: 2 as const, revision: 4, plan: previousPlan, requests: ["konser"] };
  const result = await recommend(request('Art\u0131k 3 ki\u015fiyiz', state), deps([event('cheap', { price: 250 }), event('costly', { price: 350 })], previousPlan, {
    spanInterpret: actualInterpret((built) => Object.fromEntries(Object.keys(built.questions).filter((id) => id.startsWith('edit_h0')).map((id) => [id, 'replace']))),
  }));
  assert.equal(result.planState?.revision, 5);
  assert.deepEqual(result.recommendations.map((item) => item.event.id), ['cheap']);
  assert.ok(result.planState && hardChildren(result.planState.plan).some((condition) => condition.type === 'atom' && condition.atom.kind === 'party' && condition.atom.count === 3));
});

void test('nested alternatives preserve category, location, and date branches', async () => {
  const alternatives: Condition = { type: 'any', children: [
    { type: 'atom', atom: { kind: 'category', value: 'theatre' } },
    { type: 'atom', atom: { kind: 'location', name: 'Kad\u0131k\u00f6y', precision: 'district' } },
    { type: 'atom', atom: { kind: 'date', from: '2026-10-04', to: '2026-10-04' } },
  ] };
  const result = await recommend(request('alternatives'), deps([
    event('category', { category: 'Tiyatro', district: 'Be\u015fikta\u015f' }),
    event('location'), event('date', { startsAt: '2026-10-04T18:00:00Z', district: 'Be\u015fikta\u015f' }),
    event('miss', { category: 'Konser', district: 'Be\u015fikta\u015f' }),
  ], plan([alternatives])));
  assert.deepEqual(new Set(result.recommendations.map((item) => item.event.id)), new Set(['category', 'location', 'date']));
  assert.equal(result.planState && hardChildren(result.planState.plan)[0].type, 'any');
});

void test('unknown evidence under NOT is rejected and optional workshop stays optional', async () => {
  const cases: Condition[] = [
    { type: 'not', child: { type: 'atom', atom: { kind: 'budget', comparison: 'lte', amount: 500, currency: 'TRY', basis: 'per_person' } } },
    { type: 'not', child: { type: 'atom', atom: { kind: 'content', value: 'profanity' } } },
    { type: 'not', child: { type: 'atom', atom: { kind: 'experience', value: 'wheelchair_accessible' } } },
  ];
  for (const hard of cases) {
    const result = await recommend(request('unknown must fail'), deps([event('unknown', { price: null, description: '' })], plan([hard])));
    assert.equal(result.status, 'empty');
  }
  const optional = plan([], [{ type: 'atom', atom: { kind: 'category', value: 'workshop' } }]);
  const result = await recommend(request('workshop preferred'), deps([event('concert')], optional));
  assert.equal(result.status, 'results');
});

function supported(events: EventRecord[]): JevRanking {
  return { model: 'jev-test', usage: { inputTokens: 0, outputTokens: 0 }, ranked: events.map((candidate) => ({
    event: candidate, score: 3, confidence: 1, probabilities: [0, 0, 0.2, 0.8] as const, supportProbability: 1,
  })) };
}

void test('vectors cover every eligible event before a 16-item rank cap and can surface a late event', async () => {
  const events = Array.from({ length: 20 }, (_, index) => event(`vector-${index}`, { title: `Distinct show ${index}` }));
  let vectorIds: string[] = [], rankedIds: string[] = [];
  const result = await recommend(request('semantic'), deps(events, plan([]), {
    config, embeddingConfig: { apiKey: 'voyage-test', model: 'voyage-4-lite', dimensions: 256 },
    vectors: async (items) => { vectorIds = items.map((item) => item.id); return new Map(items.map((item, index) => [item.id, index === 19 ? [1, 0] : [0, 1]])); },
    embed: async () => [[1, 0]],
    rank: async (_config, input, candidates) => { rankedIds = candidates.map((item) => item.id); const body = buildJevRequest(config.model, input, candidates); assert.deepEqual(body.state.verifiedPlan, input.plan?.hard); assert.deepEqual(body.state.optionalPlanPreferences, input.plan?.preferences); assert.ok(body.state.candidates.every((candidate) => candidate.planEvidence)); return supported(candidates); },
  }));
  assert.equal(vectorIds.length, 20);
  assert.equal(rankedIds.length, 16);
  assert.ok(rankedIds.includes('vector-19'));
  assert.equal(result.diagnostics?.vectorCoverage.eligible, 20);
});

void test('ranking returns every supported card rather than a fixed five', async () => {
  const events = Array.from({ length: 9 }, (_, index) => event(`supported-${index}`, { title: `Unique supported ${index}` }));
  const result = await recommend(request('all supported'), deps(events, plan([]), { config, rank: async (_c, _i, candidates) => supported(candidates) }));
  assert.equal(result.recommendations.length, 9);
});

void test('fallback applies the committed tree without reparsing rendered query or history', async () => {
  let interpretations = 0;
  const committed = plan([{ type: 'atom', atom: { kind: 'category', value: 'theatre' } }]);
  const state = { version: 2 as const, revision: 2, plan: committed, requests: ["konser"] };
  const input = validateInput({ message: 'keep it', history: [{ role: 'user', content: 'concerts only' }], filters: emptyFilters, intentVersion: 2, planState: state });
  const result = await recommend(input, { ...deps([event('play', { category: 'Tiyatro' }), event('concert')], committed),
    spanInterpret: async () => { interpretations++; return accepted(committed); },
    candidates: async (filters) => { assert.deepEqual(filters, emptyFilters); return [event('play', { category: 'Tiyatro' }), event('concert')]; },
  });
  assert.equal(interpretations, 1);
  assert.deepEqual(result.recommendations.map((item) => item.event.id), ['play']);
});

void test('version rollback/mixing rejects, and ambiguous or unavailable turns preserve prior state without retrieval', async () => {
  const prior = { version: 2 as const, revision: 7, plan: plan([{ type: 'atom', id: 'h0', atom: { kind: 'category', value: 'concert' } }]), requests: ["konser"] };
  assert.throws(() => validateInput({ message: 'x', intentVersion: 1, planState: prior }));
  let retrievals = 0;
  const base: Dependencies = { now, config: null, inputInterpreter: 'span-v2', candidates: async () => { retrievals++; return [event('x')]; } };
  assert.throws(() => validateInput({ message: 'x', intentVersion: 2, planState: prior, intentState: { version: 1, filters: emptyFilters, requirements: [], preferences: { genres: [], activities: [], order: 'none' } } }));
  for (const mode of ['ambiguous', 'unavailable'] as const) {
    const result = await recommend(request('change', prior), { ...base, spanInterpret: mode === 'unavailable'
      ? async () => { throw new Error('secret provider body'); }
      : async () => ({ status: 'ambiguous', alternatives: [], reason: 'unclear', debug: { mentions: [], answers: {} } }) });
    assert.deepEqual(result.planState, prior);
    assert.equal(result.pendingInput?.message, 'change');
  }
  assert.equal(retrievals, 0);
});

void test('standalone reset skips providers and retrieval, while returned records retain merged-offer metadata', async () => {
  let calls = 0;
  const prior = { version: 2 as const, revision: 3, plan: plan([{ type: 'atom', id: 'h0', atom: { kind: 'category', value: 'concert' } }]), requests: ["konser"] };
  const reset = await recommend(request('s\u0131f\u0131rla', prior), { now, config, inputInterpreter: 'span-v2',
    candidates: async () => { calls++; return []; }, spanInterpret: async () => { calls++; return accepted(plan([])); }, rank: async () => { calls++; return supported([]); } });
  assert.equal(calls, 0);
  assert.deepEqual(reset.planState?.plan, plan([]));
  const merged = event('canonical', { source: 'biletix', sourceVersion: 'v3', sourceSessionIds: ['session-a'], mergedIds: ['source-a', 'source-b'], canonicalProductionKey: 'production', canonicalShowKey: 'show', offers: [{ id: 'source-a', source: 'biletix', url: 'https://example.test/a', price: 300, currency: 'TRY', checkedAt: now.toISOString(), category: 'Konser', venue: 'Salon', availability: 'available' }] });
  const result = await recommend(request('show it'), deps([merged], plan([])));
  assert.deepEqual(result.recommendations[0].event, merged);
});

void test('strict start-time bounds reject equal sessions and non-session attendance windows', async () => {
  const timed = plan([{ type: 'atom', atom: { kind: 'time', from: '20:00', fromExclusive: true } }]);
  const result = await recommend(request('after 8 PM'), deps([
    event('equal', { startsAt: '2026-10-03T17:00:00Z' }),
    event('after', { startsAt: '2026-10-03T17:01:00Z' }),
    event('window', { startsAt: '2026-10-03T17:01:00Z', attendanceTiming: { kind: 'admission_window', evidence: 'provider_flexible_window', validFrom: '2026-10-03T07:00:00Z', validThrough: '2026-10-03T20:00:00Z' } }),
  ], timed));
  assert.deepEqual(result.recommendations.map((item) => item.event.id), ['after']);
});

void test('named performers stay in retrieval text and reach Jev as the user request', async () => {
  const concert = plan([{ type: 'atom', id: 'h0', atom: { kind: 'category', value: 'concert' } }]);
  const others = Array.from({ length: 20 }, (_, index) => event(`other-${index}`, { title: `Akustik gece ${index}` }));
  const duman = event('duman', { title: 'Duman Konseri', description: 'Duman sahnede.' });
  const seen: { message: string; history: unknown[] }[] = [];
  let shortlisted: string[] = [];
  const first = await recommend(request('Duman konseri istiyorum'), deps([...others, duman], concert, {
    config,
    rank: async (_config, input, candidates) => {
      seen.push({ message: input.message, history: input.history });
      shortlisted = candidates.map((item) => item.id);
      return supported(candidates);
    },
  }));
  assert.ok(shortlisted.includes('duman'));
  assert.equal(seen[0].message, 'Duman konseri istiyorum');
  assert.deepEqual(seen[0].history, []);
  assert.deepEqual(first.planState?.requests, ['Duman konseri istiyorum']);

  const followUp = await recommend(request('hafta sonu olsun', first.planState), deps([...others, duman], concert, {
    config,
    rank: async (_config, input, candidates) => {
      seen.push({ message: input.message, history: input.history });
      return supported(candidates);
    },
  }));
  assert.equal(seen[1].message, 'hafta sonu olsun');
  assert.deepEqual(seen[1].history, [{ role: 'user', content: 'Duman konseri istiyorum' }]);
  assert.deepEqual(followUp.planState?.requests, ['Duman konseri istiyorum', 'hafta sonu olsun']);

  const fallback = await recommend(request('Duman konseri istiyorum'), deps([...others, duman], concert));
  assert.equal(fallback.recommendations[0]?.event.id, 'duman');
});

void test('plan requests restart on reset and skip bare alternatives requests', async () => {
  const concert = plan([{ type: 'atom', id: 'h0', atom: { kind: 'category', value: 'concert' } }]);
  const prior = { version: 2 as const, revision: 1, plan: concert, requests: ['Duman konseri'] };
  const more = await recommend(request('başka', prior), deps([event('a')], concert));
  assert.deepEqual(more.planState?.requests, ['Duman konseri']);
  const reset = await recommend(request('caz konseri', prior), deps([event('a')], concert, {
    spanInterpret: async () => ({ ...accepted(concert), operations: [{ op: 'reset' }] }),
  }));
  assert.deepEqual(reset.planState?.requests, ['caz konseri']);
});
