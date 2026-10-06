import assert from 'node:assert/strict';
import test from 'node:test';
import { recommendRequest, validateRequest, type Dependencies } from '../lib/recommend.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';
import { emptyPlanState } from '../lib/plan-state.ts';
import { interpretSpanInput } from '../lib/span-interpreter.ts';
import { fieldAnswers } from './field-answers.ts';
import type { Condition, Plan } from '../parser/contract.ts';

const now = new Date('2026-10-06T12:00:00Z');
const event = (id: string, category: string): EventRecord => ({
  id, title: `Event ${id}`, description: 'Verified event information.',
  startsAt: '2026-10-07T18:00:00Z', checkedAt: now.toISOString(),
  venue: 'Salon', city: 'İstanbul', district: 'Kadıköy', address: 'Kadıköy',
  price: 300, currency: 'TRY', category, availability: 'available',
  imageUrl: '', url: `https://example.test/${id}`,
  attendanceTiming: { kind: 'timed_session', evidence: 'provider_sessions_and_source_text' },
});
const events = [event('concert', 'Konser'), event('theatre', 'Tiyatro')];
const plan = (children: Condition[] = []): Plan => ({ hard: { type: 'all', children }, preferences: [], order: 'none' });
const legacy = {
  history: [{ role: 'user', content: 'Duman concert tomorrow under 100 TL' }],
  filters: { ...emptyFilters, dateFrom: '2026-10-08', dateTo: '2026-10-08', maxPrice: 100, category: 'Konser' },
  intentVersion: 2,
  planState: { ...emptyPlanState(), revision: 9, requests: ['Duman concert'], plan: plan([
    { type: 'atom', atom: { kind: 'category', value: 'concert' } },
    { type: 'atom', atom: { kind: 'age', years: 6 } },
  ]) },
  intentState: { version: 1, filters: emptyFilters },
  pendingInput: { message: 'Duman concert', reason: 'budget_ambiguous' },
  excludeIds: ['theatre'], alternativeIds: ['theatre'],
};

void test('request validation discards all legacy memory, including malformed context', () => {
  const expected = { message: 'Tiyatro', filters: emptyFilters, history: [], excludeIds: [] };
  assert.deepEqual(validateRequest({ message: ' Tiyatro ', ...legacy }), expected);
  assert.deepEqual(validateRequest({ message: 'Tiyatro', history: 'invalid', filters: false, planState: 1, intentVersion: 99 }), expected);
  for (const value of [null, [], {}, { message: '' }, { message: ' '.repeat(1200) }, { message: 'x'.repeat(1201) }])
    assert.throws(() => validateRequest(value));
});

void test('rules requests use only current Turkish and English constraints and do not hide earlier cards', async () => {
  for (const message of ['yarın tiyatro', 'theatre tomorrow']) {
    const result = await recommendRequest({ message, ...legacy }, { now, config: null, candidates: async () => events });
    assert.equal(result.status, 'results');
    assert.equal(result.filters.dateFrom, '2026-10-07');
    assert.equal(result.filters.maxPrice, null);
    assert.equal(result.filters.category, 'Tiyatro');
    assert.deepEqual(result.recommendations.map(({ event }) => event.id), ['theatre']);
  }
});

void test('the production field reader and ranker receive one new request even from an old client', async () => {
  const config = { apiKey: 'test-only', model: 'jev-1.13.0' };
  const message = 'yarın tiyatro';
  const deps: Dependencies = {
    now, config, inputInterpreter: 'span-v2', candidates: async () => events,
    spanInterpret: (input, options) => {
      assert.equal(input.previousState, null);
      assert.equal(input.utterance, message);
      return interpretSpanInput(input, { ...options, fetcher: async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        assert.equal(body.state.currentSearch, undefined);
        assert.ok(!JSON.stringify(body.state).includes('Duman'));
        return Response.json(fieldAnswers(body.questions, { date: 'tomorrow', category_theatre: 'want' }));
      } });
    },
    rank: async (_config, input, candidates) => {
      assert.equal(input.message, message);
      assert.deepEqual(input.history, []);
      assert.ok(!JSON.stringify(input.plan).includes('"age"'));
      return { model: config.model, usage: { inputTokens: 0, outputTokens: 0 }, ranked: candidates.map(event => ({
        event, score: 3, confidence: 1, probabilities: [0, 0, 0, 1] as const, supportProbability: 1,
      })) };
    },
  };
  const first = await recommendRequest({ message, ...legacy }, deps);
  const second = await recommendRequest({ message, ...legacy, planState: first.planState, excludeIds: ['theatre'] }, deps);
  assert.equal(first.status, 'results');
  assert.deepEqual(first.recommendations.map(({ event }) => event.id), ['theatre']);
  assert.equal(first.planState?.revision, 1);
  assert.deepEqual(first.planState?.requests, [message]);
  assert.deepEqual(second, first);
});

void test('a clarification cannot prepend its unresolved request to the next search', async () => {
  const deps: Dependencies = { now, config: null, inputInterpreter: 'span-v2', candidates: async () => events,
    spanInterpret: async input => {
      assert.equal(input.previousState, null);
      return input.utterance === 'unclear' ? { status: 'unsupported', reason: 'unreadable date', unresolvedSpans: [], debug: { mentions: [], answers: {} } }
        : { status: 'accepted', operations: [], resultingPlan: plan(), debug: { mentions: [], answers: {} } };
    },
  };
  const unclear = await recommendRequest({ message: 'unclear' }, deps);
  assert.equal(unclear.status, 'needs_input');
  const next = await recommendRequest({ message: 'standalone', pendingInput: unclear.pendingInput, planState: legacy.planState }, deps);
  assert.equal(next.status, 'results');
  assert.deepEqual(next.planState?.requests, ['standalone']);
});
