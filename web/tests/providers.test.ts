import test from 'node:test';
import assert from 'node:assert/strict';
import {
  configFrom,
  embeddingConfigFrom,
  embeddingCacheKey,
  structured,
  embed,
  type Fetcher,
  type OutputSchema,
} from '../lib/providers.ts';
function requestBody(init: RequestInit | undefined) {
  assert.equal(typeof init?.body, 'string');
  return init!.body as string;
}
const schema: OutputSchema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
  additionalProperties: false,
};
const legacy = configFrom({ OPENAI_API_KEY: 'legacy-secret' })!;
const compatible = configFrom({
  AI_API_KEY: 'chat-secret',
  AI_BASE_URL: 'https://chat.example/v1/',
  AI_MODEL: 'chat-model',
})!;
const embedding = embeddingConfigFrom({
  EMBEDDING_API_KEY: 'embed-secret',
  EMBEDDING_BASE_URL: 'https://vectors.example/v1/',
  EMBEDDING_MODEL: 'vector-model',
  EMBEDDING_DIMENSIONS: '2',
})!;
const completion = (content: unknown, finish = 'stop') => ({
  choices: [
    { finish_reason: finish, message: { content: JSON.stringify(content) } },
  ],
});
const reply =
  (body: unknown): Fetcher =>
  async () =>
    Response.json(body);

await test('keyless configuration and third-party key isolation', () => {
  assert.equal(configFrom({}), null);
  assert.equal(embeddingConfigFrom({}), null);
  assert.equal(
    configFrom({
      OPENAI_API_KEY: 'legacy',
      AI_BASE_URL: 'https://chat.example/v1',
    }),
    null,
  );
  assert.equal(
    embeddingConfigFrom({
      AI_API_KEY: 'chat',
      AI_BASE_URL: 'https://chat.example/v1',
      OPENAI_API_KEY: 'legacy',
    }),
    null,
  );
  assert.equal(
    embeddingConfigFrom({
      OPENAI_API_KEY: 'legacy',
      EMBEDDING_BASE_URL: 'https://vectors.example/v1',
    }),
    null,
  );
  assert.equal(
    embeddingConfigFrom({
      OPENAI_API_KEY: 'legacy',
      EMBEDDING_ENABLED: 'false',
    }),
    null,
  );
  assert.equal(
    embeddingConfigFrom({ EMBEDDING_API_KEY: 'separate' })?.key,
    'separate',
  );
});
await test('legacy OpenAI configuration remains supported', () => {
  assert.equal(legacy.protocol, 'responses');
  assert.equal(legacy.model, 'gpt-4.1-mini');
  assert.equal(
    embeddingConfigFrom({ OPENAI_API_KEY: 'legacy' })?.dimensions,
    512,
  );
});
await test('settings reject ambiguous model and unsafe or malformed endpoints', () => {
  assert.throws(() => configFrom({ AI_API_KEY: 'key' }));
  for (const url of [
    'http://api.example/v1',
    'https://user:pass@api.example',
    'https://api.example?key=secret',
    'https://api.example/#fragment',
    'invalid',
  ])
    assert.throws(() =>
      configFrom({ AI_API_KEY: 'key', AI_MODEL: 'test', AI_BASE_URL: url }),
    );
  assert.throws(() =>
    configFrom({ OPENAI_API_KEY: 'key', AI_PROTOCOL: 'typo' }),
  );
  assert.throws(() =>
    configFrom({ OPENAI_API_KEY: 'key', AI_MAX_OUTPUT_TOKENS: '999999' }),
  );
  assert.throws(() =>
    embeddingConfigFrom({ OPENAI_API_KEY: 'key', EMBEDDING_DIMENSIONS: '1.5' }),
  );
  assert.throws(() =>
    embeddingConfigFrom({
      EMBEDDING_API_KEY: 'key',
      EMBEDDING_BASE_URL: 'https://vectors.example/v1',
    }),
  );
});
await test('Responses transport sends structured output, storage and token settings', async () => {
  const transport: Fetcher = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(init?.redirect, 'manual');
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer legacy-secret',
    );
    const body = JSON.parse(requestBody(init));
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 1800);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.input, JSON.stringify({ message: 'konser' }));
    return Response.json({
      status: 'completed',
      output: [
        { content: [{ type: 'output_text', text: '{"answer":"tamam"}' }] },
      ],
    });
  };
  assert.deepEqual(
    await structured(
      legacy,
      'test',
      schema,
      'Interpret',
      { message: 'konser' },
      transport,
    ),
    { answer: 'tamam' },
  );
});
await test('provider transport rejects manual redirects without following them', async () => {
  let calls = 0;
  await assert.rejects(
    structured(legacy, 'test', schema, 'Interpret', {}, async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, 'manual');
      return new Response(null, {
        status: 308,
        headers: { Location: 'https://untrusted.example/collect' },
      });
    }),
    /returned 308/,
  );
  assert.equal(calls, 1);
});
await test('compatible transport uses its own URL/key and chat response format', async () => {
  const transport: Fetcher = async (url, init) => {
    assert.equal(url, 'https://chat.example/v1/chat/completions');
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer chat-secret',
    );
    const body = JSON.parse(requestBody(init));
    assert.equal(body.model, 'chat-model');
    assert.equal(body.max_tokens, 1800);
    assert.deepEqual(body.response_format.json_schema.schema, schema);
    assert.equal(body.messages[0].role, 'system');
    assert.equal(body.messages[1].content, '{"message":"konser"}');
    assert.equal(body.store, undefined);
    return Response.json(completion({ answer: 'tamam' }));
  };
  assert.deepEqual(
    await structured(
      compatible,
      'test',
      schema,
      'Interpret',
      { message: 'konser' },
      transport,
    ),
    { answer: 'tamam' },
  );
});
await test('JSON mode embeds schema and supports alternate token parameter', async () => {
  const transport: Fetcher = async (_url, init) => {
    const body = JSON.parse(requestBody(init));
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(body.messages[0].content, /"required":\["answer"\]/);
    assert.equal(body.max_completion_tokens, 1800);
    assert.equal(body.max_tokens, undefined);
    return Response.json(completion({ answer: 'ok' }));
  };
  await structured(
    {
      ...compatible,
      outputFormat: 'json_object',
      tokenParameter: 'max_completion_tokens',
    },
    'test',
    schema,
    '',
    {},
    transport,
  );
});
await test('both output modes reject missing, wrong and extra fields', async () => {
  for (const outputFormat of ['json_schema', 'json_object'] as const)
    for (const value of [
      null,
      {},
      { answer: 12 },
      { answer: 'ok', extra: true },
    ])
      await assert.rejects(
        structured(
          { ...compatible, outputFormat },
          'test',
          schema,
          '',
          {},
          reply(completion(value)),
        ),
        /Invalid AI output/,
      );
});
await test('nested arrays, nullable fields and enum IDs are validated locally', async () => {
  const nested: OutputSchema = {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: { type: ['string', 'null'], enum: ['known', null] },
      },
    },
    required: ['items'],
    additionalProperties: false,
  };
  assert.deepEqual(
    await structured(
      compatible,
      'test',
      nested,
      '',
      {},
      reply(completion({ items: ['known', null] })),
    ),
    { items: ['known', null] },
  );
  await assert.rejects(
    structured(
      compatible,
      'test',
      nested,
      '',
      {},
      reply(completion({ items: ['invented'] })),
    ),
    /Invalid AI output/,
  );
});
await test('truncation, refusals, empty or malformed JSON do not become recommendations', async () => {
  for (const value of [
    completion({ answer: 'partial' }, 'length'),
    { choices: [{ finish_reason: 'stop', message: { content: '{bad' } }] },
    {
      choices: [
        {
          finish_reason: 'stop',
          message: { content: '{"answer":"ok"}', refusal: 'No' },
        },
      ],
    },
    { choices: [] },
  ])
    await assert.rejects(
      structured(compatible, 'test', schema, '', {}, reply(value)),
    );
  for (const value of [
    { status: 'incomplete' },
    { status: 'completed', output: [{ content: [{ type: 'refusal' }] }] },
  ])
    await assert.rejects(
      structured(legacy, 'test', schema, '', {}, reply(value)),
    );
});
await test('provider failures are not retried or exposed in error bodies', async () => {
  let calls = 0;
  const transport: Fetcher = async () => {
    calls++;
    return new Response('private upstream information', { status: 429 });
  };
  await assert.rejects(
    structured(compatible, 'test', schema, '', {}, transport),
    { message: 'AI provider returned 429' },
  );
  assert.equal(calls, 1);
});
await test('oversized responses are bounded and network errors propagate to fallback', async () => {
  await assert.rejects(
    structured(
      compatible,
      'test',
      schema,
      '',
      {},
      async () => new Response('x'.repeat(256001)),
    ),
    /too large/,
  );
  await assert.rejects(
    structured(compatible, 'test', schema, '', {}, async () => {
      throw new DOMException('Timeout', 'TimeoutError');
    }),
    { name: 'TimeoutError' },
  );
});
await test('embedding provider has separate authentication and restores input order', async () => {
  const transport: Fetcher = async (url, init) => {
    assert.equal(url, 'https://vectors.example/v1/embeddings');
    assert.equal(
      new Headers(init?.headers).get('authorization'),
      'Bearer embed-secret',
    );
    const body = JSON.parse(requestBody(init));
    assert.equal(body.model, 'vector-model');
    assert.equal(body.dimensions, undefined);
    assert.deepEqual(body.input, ['one', 'two']);
    return Response.json({
      data: [
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ],
    });
  };
  assert.deepEqual(await embed(embedding, ['one', 'two'], transport), [
    [1, 0],
    [0, 1],
  ]);
});
await test('embedding dimensions can be explicitly requested', async () => {
  await embed(
    { ...embedding, sendDimensions: true },
    ['one'],
    async (_url, init) => {
      assert.equal(JSON.parse(requestBody(init)).dimensions, 2);
      return Response.json({ data: [{ index: 0, embedding: [1, 0] }] });
    },
  );
});
await test('invalid embedding indices, dimensions and zero/non-number vectors are rejected', async () => {
  for (const data of [
    [],
    [{ index: 1, embedding: [1, 0] }],
    [{ index: 0, embedding: [1] }],
    [{ index: 0, embedding: [0, 0] }],
    [{ index: 0, embedding: [1, null] }],
    [{ index: 0, embedding: 'invalid' }],
  ])
    await assert.rejects(
      embed(embedding, ['one'], reply({ data })),
      /Invalid embeddings/,
    );
  await assert.rejects(
    embed(
      embedding,
      ['one', 'two'],
      reply({
        data: [
          { index: 0, embedding: [1, 0] },
          { index: 0, embedding: [0, 1] },
        ],
      }),
    ),
    /Invalid embeddings/,
  );
  assert.deepEqual(
    await embed(embedding, [], async () => {
      throw new Error('Must not call');
    }),
    [],
  );
});
await test('embedding cache isolates endpoints/models/dimensions but survives key rotation', () => {
  const key = embeddingCacheKey(embedding);
  assert.equal(key, embeddingCacheKey({ ...embedding, key: 'rotated-secret' }));
  assert.ok(!key.includes('secret'));
  for (const change of [
    { baseUrl: 'https://elsewhere.example/v1' },
    { model: 'other' },
    { dimensions: 3 },
    { sendDimensions: true },
  ])
    assert.notEqual(key, embeddingCacheKey({ ...embedding, ...change }));
});
