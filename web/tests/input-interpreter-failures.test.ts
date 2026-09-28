import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInputInterpreterRequest, interpretInput, type InputInterpreterFailure } from '../lib/input-interpreter.ts';
import { emptyIntentState } from '../lib/input-state.ts';

const now = new Date('2026-09-28T13:30:19.548Z');
const config = { apiKey: 'secret-never-log', model: 'jev-1.13.0' };
const input = { message: 'cumartesi sevgilimle çıkıcaz, biraz gülsek iyi olur ya. konser istemiyoruz', previous: emptyIntentState(), now };

await test('standalone reset bypasses provider even with a large pending request', async () => {
  let calls = 0;
  const result = await interpretInput({ ...input, message: 'Sıfırla.', unresolvedRequest: 'x'.repeat(30_000) }, {
    config, fetcher: async () => { calls++; throw new Error('must not run'); },
  });
  assert.equal(calls, 0);
  assert.equal(result.action, 'reset');
});

await test('oversized built input reports request_size before network', async () => {
  let calls = 0;
  const failures: InputInterpreterFailure[] = [];
  const result = await interpretInput(
    { ...input, unresolvedRequest: 'bekleyen koşul '.repeat(4000) },
    {
      config,
      fetcher: async () => { calls++; throw new Error('must not run'); },
      onFailure: (failure) => failures.push(failure),
    },
  );
  assert.equal(calls, 0);
  assert.equal(result.issue, 'interpreter_unavailable');
  assert.equal(failures[0].stage, 'proposal_request');
  assert.equal(failures[0].code, 'request_size');
});

await test('HTTP 503 makes one call and exposes only fixed safe fields', async () => {
  let calls = 0;
  const failures: InputInterpreterFailure[] = [];
  const result = await interpretInput(input, {
    config,
    fetcher: async () => { calls++; return new Response('sensitive upstream body', { status: 503 }); },
    onFailure: (failure) => failures.push(failure),
  });
  assert.equal(calls, 1);
  assert.equal(result.issue, 'interpreter_unavailable');
  assert.deepEqual(Object.keys(failures[0]).sort(), ['code', 'elapsedMs', 'httpStatus', 'stage']);
  assert.deepEqual({ ...failures[0], elapsedMs: 0 }, { stage: 'proposal_request', code: 'http', httpStatus: 503, elapsedMs: 0 });
  assert.doesNotMatch(JSON.stringify(failures), /secret|sensitive|cumartesi/i);
});

await test('timeout, invalid JSON, and network failures have distinct codes', async () => {
  const cases: Array<[typeof fetch, string]> = [
    [((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch, 'timeout'],
    [(async () => new Response('{')) as typeof fetch, 'invalid_response'],
    [(async () => { throw new TypeError('secret network detail'); }) as typeof fetch, 'network'],
  ];
  for (const [fetcher, code] of cases) {
    const failures: InputInterpreterFailure[] = [];
    const result = await interpretInput(input, { config, fetcher, timeoutMs: 5, onFailure: (failure) => failures.push(failure) });
    assert.equal(result.issue, 'interpreter_unavailable');
    assert.equal(failures[0].code, code);
    assert.equal(failures[0].stage, 'proposal_request');
  }
});

await test('malformed distribution is proposal invalid_response with no partial patch', async () => {
  const response = validResponse();
  response.answers.action.probabilities.search = 0.8;
  const failures: InputInterpreterFailure[] = [];
  let calls = 0;
  const result = await interpretInput(input, {
    config,
    fetcher: async () => { calls++; return Response.json(response); },
    onFailure: (failure) => failures.push(failure),
  });
  assert.equal(calls, 1);
  assert.equal(failures[0].stage, 'proposal_parse');
  assert.equal(failures[0].code, 'invalid_response');
  assert.deepEqual(result.state, input.previous);
});

await test('observer exceptions cannot alter fail-closed behavior', async () => {
  const result = await interpretInput(input, {
    config,
    fetcher: async () => new Response('', { status: 503 }),
    onFailure: () => { throw new Error('observer failure'); },
  });
  assert.equal(result.issue, 'interpreter_unavailable');
  assert.deepEqual(result.state, input.previous);
});

function validResponse() {
  const request = buildInputInterpreterRequest(config.model, input);
  const defaults: Record<string, string> = {
    action: 'search', issue: 'none', budget: 'keep', budget_basis: 'none', budget_boundary: 'none', party: 'keep', date: 'keep', time: 'keep',
    district: 'keep', companion: 'keep', mood: 'keep', interest_clear: 'keep', genre_logic: 'keep', activity_logic: 'keep', candidate_coverage: 'complete',
  };
  const answers: Record<string, {
    type: 'choice';
    choice: string;
    confidence: number;
    probabilities: Record<string, number>;
  }> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const choices = Object.keys(question.criteria);
    const choice = defaults[id] ?? (id.startsWith('interest_') ? 'skip' : 'keep');
    answers[id] = { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(choices.map((item) => [item, item === choice ? 1 : 0])) };
  }
  return { model: config.model, answers, usage: { input_tokens: 1, output_tokens: 1 } };
}
