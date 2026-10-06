import assert from 'node:assert/strict';
import test from 'node:test';
import { interpretSpanInput } from '../lib/span-interpreter.ts';
import type { ParserInput } from '../parser/contract.ts';

const input = (utterance: string): ParserInput => ({
  utterance,
  language: 'en',
  referenceDate: '2026-10-02',
  timezone: 'Europe/Istanbul',
  previousState: null,
});
const config = { apiKey: 'server-secret', model: 'jev-1.13.0' };

function completeResponse(body: string, overrides: Record<string, string> = {}) {
  const request = JSON.parse(body) as {
    model: string;
    questions: Record<string, { type: 'choice' | 'noul'; criteria?: Record<string, unknown> }>;
  };
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: id.startsWith('supported_') ? 1 : 0 }];
    const keys = Object.keys(question.criteria ?? {});
    const preferred = overrides[id] ?? (id.startsWith('polarity_') ? 'wanted'
      : id.startsWith('cmp_') ? 'lte'
        : id.startsWith('basis_') ? 'per_person'
          : id.startsWith('clock_') ? 'at'
            : id === 'order' ? 'unchanged'
              : id === 'action' ? 'continue'
                : keys[0]);
    return [id, {
      type: 'choice',
      choice: preferred,
      confidence: 1,
      probabilities: Object.fromEntries(keys.map((key) => [key, key === preferred ? 1 : 0])),
    }];
  }));
  return { model: request.model, answers, usage: { input_tokens: 12, output_tokens: 7 } };
}

void test('empty persisted plans produce complete judgments for initial and reset turns', async () => {
  for (const [revision, utterance, overrides] of [
    [0, 'concert', {}],
    [2, 'start over', { action: 'reset' }],
  ] as const) {
    const parserInput: ParserInput = {
      ...input(utterance),
      previousState: { revision, plan: { hard: { type: 'all', children: [] }, preferences: [], order: 'none' }, evidence: [] },
    };
    let calls = 0;
    const result = await interpretSpanInput(parserInput, { config, fetcher: async (_url, init) => {
      calls++;
      const body = init?.body;
      if (typeof body !== 'string') throw new Error('expected request body');
      const request = JSON.parse(body) as { questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
      for (const question of Object.values(request.questions))
        if (question.type === 'choice') assert.ok(Object.keys(question.criteria ?? {}).length > 0);
      assert.equal('vague_target' in request.questions, false);
      return Response.json(completeResponse(body, overrides));
    } });
    assert.equal(calls, 1);
    assert.equal(result.status, 'accepted');
  }
});

void test('sends one typed model/state/questions request and composes the full response', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer server-secret');
    const body = init?.body;
    if (typeof body !== 'string') throw new Error('expected serialized request body');
    const request = JSON.parse(body);
    assert.deepEqual(Object.keys(request).sort(), ['model', 'questions', 'state']);
    assert.equal(request.model, config.model);
    assert.equal(request.state.message, 'concert');
    return Response.json(completeResponse(body));
  };
  const result = await interpretSpanInput(input('concert'), { config, fetcher });
  assert.equal(calls, 1);
  assert.equal(result.status, 'accepted');
});

void test('invalid provider judgments throw a sanitized generic error', async () => {
  const fetcher: typeof fetch = async () => Response.json({ model: config.model, answers: {}, usage: {} });
  await assert.rejects(
    interpretSpanInput(input('concert'), { config, fetcher }),
    (error: Error) => error.message === 'Span interpreter unavailable.' && !error.message.includes(config.apiKey),
  );
});

void test('missing server configuration fails before any provider call', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({}); };
  await assert.rejects(
    interpretSpanInput(input('concert'), { config: null, fetcher }),
    { message: 'Span interpreter unavailable.' },
  );
  assert.equal(calls, 0);
});

void test('an impossible calendar date asks for the date after one provider call', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++;
    return Response.json(completeResponse(init?.body as string, { date: 'calendar_date', date_day: '30', date_month: 'February' }));
  };
  const result = await interpretSpanInput(input('concert on 2027-02-30'), { config, fetcher });
  assert.equal(calls, 1);
  assert.equal(result.status, 'unsupported');
  assert.equal(result.status === 'unsupported' && result.reason, 'unreadable date');
});

void test('times out across the response body without retrying', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response(new ReadableStream({ start() { /* body intentionally never closes */ } }));
  };
  await assert.rejects(
    interpretSpanInput(input('concert'), { config, fetcher, timeoutMs: 10 }),
    { message: 'Span interpreter unavailable.' },
  );
  assert.equal(calls, 1);
});

void test('non-success responses are not retried and do not expose their body', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response('credential=provider-detail', { status: 503 });
  };
  await assert.rejects(
    interpretSpanInput(input('concert'), { config, fetcher }),
    (error: Error) => error.message === 'Span interpreter unavailable.' && !error.message.includes('provider-detail'),
  );
  assert.equal(calls, 1);
});
