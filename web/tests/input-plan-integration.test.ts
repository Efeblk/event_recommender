import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInputInterpreterRequest, interpretInput } from '../lib/input-interpreter.ts';
import { emptyIntentState } from '../lib/input-state.ts';
import { recommend, validateInput } from '../lib/recommend.ts';

const config = { model: 'jev-test', apiKey: 'test-only' };
const now = new Date('2026-09-28T09:00:00Z');
function proposal(input: Parameters<typeof buildInputInterpreterRequest>[1]) {
  const request = buildInputInterpreterRequest(config.model, input);
  return { model: config.model, answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const choices = Object.keys(question.criteria);
    const choice = id === 'action' ? 'search' : id === 'issue' ? 'none' : id === 'candidate_coverage' ? 'complete'
      : ['budget_basis', 'budget_boundary'].includes(id) ? 'none' : choices.includes('keep') ? 'keep' : choices.includes('skip') ? 'skip' : choices[0];
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(choices.map((value) => [value, value === choice ? 1 : 0])) }];
  })) };
}

void test('no faithful complete plan preserves prior state and stops before catalog and ranking', async () => {
  const state = emptyIntentState({ dateFrom: '2026-10-03', dateTo: '2026-10-03', maxPrice: 500, category: null });
  const input = validateInput({ message: 'Vale hizmeti kesin şart', intentVersion: 1, intentState: state });
  let calls = 0;
  const result = await recommend(input, {
    config, now, inputInterpreter: 'jev-v1',
    candidates: async () => { throw new Error('An uncommitted plan must not search the catalog'); },
    rank: async () => { throw new Error('An uncommitted plan must not rank'); },
    interpret: async (incoming) => interpretInput(incoming, { config, fetcher: async (_url, init) => {
      calls += 1;
      if (calls === 1) return Response.json(proposal(incoming));
      assert.ok(typeof init?.body === 'string');
      const request = JSON.parse(init.body);
      const choices = Object.keys(request.questions.faithful_plan.criteria);
      return Response.json({ model: config.model, answers: { faithful_plan: {
        type: 'choice', choice: 'no_supported_plan', confidence: 1,
        probabilities: Object.fromEntries(choices.map((value) => [value, value === 'no_supported_plan' ? 1 : 0])),
      } } });
    } }),
  });
  assert.equal(calls, 2);
  assert.equal(result.status, 'needs_input');
  assert.deepEqual(result.intentState, state);
  assert.equal(result.pendingInput?.message, input.message);
  assert.deepEqual(result.recommendations, []);
});

void test('shared deadline interrupts the audit without a partial commit or a retry', async () => {
  const state = emptyIntentState({ dateFrom: null, dateTo: null, maxPrice: 500, category: null });
  const input = { message: 'Planıma uygun bir etkinlik', previous: state, now };
  let calls = 0;
  const result = await interpretInput(input, { config, timeoutMs: 50, fetcher: async () => {
    calls += 1;
    if (calls === 1) return Response.json(proposal(input));
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }));
  } });
  assert.equal(calls, 2);
  assert.equal(result.issue, 'interpreter_unavailable');
  assert.deepEqual(result.state, state);
});
