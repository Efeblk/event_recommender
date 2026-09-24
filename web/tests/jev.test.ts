import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildJevRequest,
  jevConfigFrom,
  parseJevRanking,
  rankWithJev,
} from '../lib/jev.ts';
import { evaluationCases, evaluationEvents } from '../evals/jev-cases.ts';
const candidates = evaluationEvents.slice(0, 2);
const input = evaluationCases[0];
await test('only a TypeSafe key enables the model; legacy provider keys are not reused', () => {
  assert.equal(jevConfigFrom({}), null);
  const legacy = {
    TYPESAFE_API_KEY: '',
    OPENAI_API_KEY: 'old-key',
    AI_API_KEY: 'old-key',
  };
  assert.equal(jevConfigFrom(legacy), null);
  assert.deepEqual(jevConfigFrom({ TYPESAFE_API_KEY: ' test-only ' }), {
    apiKey: 'test-only',
    model: 'jev-1.13.0',
  });
  assert.throws(() =>
    jevConfigFrom({ TYPESAFE_API_KEY: 'test', TYPESAFE_MODEL: 'wrong' }),
  );
});
const response = () => ({
  model: 'jev-1.13.0',
  usage: { input_tokens: 1500, output_tokens: 30 },
  answers: {
    candidate_0: {
      type: 'score',
      score: 1,
      confidence: 0.8,
      probabilities: { '0': 0, '1': 1, '2': 0, '3': 0 },
    },
    candidate_1: {
      type: 'score',
      score: 3,
      confidence: 0.9,
      probabilities: { '0': 0, '1': 0, '2': 0, '3': 1 },
    },
  },
});
await test('Jev compares candidates through explicit state paths, with bounded inputs', () => {
  const body = buildJevRequest('jev-1.13.0', input, candidates);
  assert.match(body.questions.candidate_1.instructions, /candidates\[1\]/);
  assert.equal(body.questions.candidate_0.type, 'score');
  assert.equal(body.state.request, input.message);
  assert.equal(body.state.candidates[0].title, candidates[0].title);
  assert.throws(() => buildJevRequest('jev-1.13.0', input, []));
  assert.throws(() =>
    buildJevRequest('jev-1.13.0', input, [candidates[0], candidates[0]]),
  );
  assert.throws(() =>
    buildJevRequest(
      'jev-1.13.0',
      input,
      Array.from({ length: 17 }, (_, i) => ({
        ...candidates[0],
        id: String(i),
      })),
    ),
  );
});
await test('Jev can reorder only supplied events and preserves authoritative event facts', () => {
  const r = parseJevRanking(response(), candidates);
  assert.deepEqual(
    r.ranked.map(({ event }) => event.id),
    ['electronic', 'acoustic'],
  );
  assert.strictEqual(r.ranked[0].event, candidates[1]);
  assert.equal(r.usage.inputTokens, 1500);
});
await test('Jev rejects missing answers and malformed probability/score outputs', () => {
  assert.throws(() =>
    parseJevRanking({ ...response(), answers: {} }, candidates),
  );
  const invalid = response();
  invalid.answers.candidate_0.score = 100;
  assert.throws(() => parseJevRanking(invalid, candidates));
  const invalidProbability = response();
  invalidProbability.answers.candidate_0.probabilities['0'] = 0.5;
  assert.throws(() => parseJevRanking(invalidProbability, candidates));
  const inconsistent = response();
  inconsistent.answers.candidate_0.score = 3;
  assert.throws(() => parseJevRanking(inconsistent, candidates), /contradicts/);
  assert.throws(() =>
    parseJevRanking(
      { ...response(), usage: { input_tokens: 1.5, output_tokens: 0 } },
      candidates,
    ),
  );
});
await test('Jev uses its own HTTPS API and never retries a failed paid call', async () => {
  let calls = 0;
  const fetcher = (async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init?.redirect, 'manual');
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer test-only',
    );
    return new Response('private provider diagnostics', { status: 429 });
  }) as typeof fetch;
  await assert.rejects(
    rankWithJev(
      { apiKey: 'test-only', model: 'jev-1.13.0' },
      input,
      candidates,
      fetcher,
    ),
    /HTTP 429/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    rankWithJev(
      { apiKey: '', model: 'jev-1.13.0' },
      input,
      candidates,
      fetcher,
    ),
    /TYPESAFE_API_KEY/,
  );
  assert.equal(calls, 1);
});
await test('Jev rejects manual redirects without following them', async () => {
  let calls = 0;
  await assert.rejects(
    rankWithJev(
      { apiKey: 'test-only', model: 'jev-1.13.0' },
      input,
      candidates,
      (async (_url, init) => {
        calls++;
        assert.equal(init?.redirect, 'manual');
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://untrusted.example/collect' },
        });
      }) as typeof fetch,
    ),
    /HTTP 307/,
  );
  assert.equal(calls, 1);
});
await test('Jev adapter consumes actual token usage and rejects oversized responses', async () => {
  const good = await rankWithJev(
    { apiKey: 'test-only', model: 'jev-1.13.0' },
    input,
    candidates,
    (async () => Response.json(response())) as typeof fetch,
  );
  assert.equal(good.usage.outputTokens, 30);
  await assert.rejects(
    rankWithJev(
      { apiKey: 'test-only', model: 'jev-1.13.0' },
      input,
      candidates,
      (async () => new Response('x'.repeat(256001))) as typeof fetch,
    ),
    /too large/,
  );
});

await test('Jev deadline includes delayed response bodies and makes no retry', async () => {
  let calls = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"answers":'));
    },
  });
  await assert.rejects(
    rankWithJev(
      { apiKey: 'test-only', model: 'jev-1.13.0' },
      input,
      candidates,
      (async () => {
        calls++;
        return new Response(body);
      }) as typeof fetch,
      30,
    ),
    { message: 'Jev request timed out.' },
  );
  assert.equal(calls, 1);
});
