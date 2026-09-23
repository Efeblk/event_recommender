import test from 'node:test';
import assert from 'node:assert/strict';
import {
  embedWithVoyage,
  voyageCacheKey,
  voyageConfigFrom,
  voyageDocumentText,
  type VoyageConfig,
} from '../lib/voyage.ts';
import type { EventRecord } from '../lib/types.ts';

const config: VoyageConfig = {
  apiKey: 'private-test-key',
  model: 'voyage-4-large',
  dimensions: 1024,
};

const vector = (dimensions = 1024) =>
  Array.from({ length: dimensions }, (_, index) => (index + 1) / dimensions);

await test('only a Voyage key enables embeddings and defaults to the chosen profile', () => {
  assert.equal(voyageConfigFrom({}), null);
  assert.equal(
    voyageConfigFrom({ VOYAGE_API_KEY: '', VOYAGE_MODEL: 'invalid' }),
    null,
  );
  assert.deepEqual(
    voyageConfigFrom({ VOYAGE_API_KEY: ' private-test-key ' }),
    config,
  );
  assert.deepEqual(
    voyageConfigFrom({
      VOYAGE_API_KEY: 'key',
      VOYAGE_MODEL: 'voyage-4',
      VOYAGE_DIMENSIONS: ' 512 ',
    }),
    { apiKey: 'key', model: 'voyage-4', dimensions: 512 },
  );
  for (const dimensions of ['0', '512.0', '1536', '2049'])
    assert.throws(() =>
      voyageConfigFrom({
        VOYAGE_API_KEY: 'key',
        VOYAGE_DIMENSIONS: dimensions,
      }),
    );
  for (const model of ['voyage-code-4', 'voyage-3-large', 'voyage-other'])
    assert.throws(() =>
      voyageConfigFrom({ VOYAGE_API_KEY: 'key', VOYAGE_MODEL: model }),
    );
});

await test('document text and cache identity include only stable semantic fields', () => {
  const event: EventRecord = {
    id: 'one',
    title: 'Title',
    description: 'Description',
    startsAt: '2026-01-01T20:00:00Z',
    venue: 'Venue',
    city: 'Istanbul',
    district: 'Kadikoy',
    address: 'Address',
    price: 100,
    currency: 'TRY',
    url: 'https://example.com',
    imageUrl: 'https://example.com/image.jpg',
    category: 'Konser',
    availability: 'available',
    checkedAt: '2026-01-01T00:00:00Z',
  };
  const text = voyageDocumentText(event);
  assert.equal(
    text,
    'Title: Title\nCategory: Konser\nVenue: Venue\nDescription: Description',
  );
  assert.equal(
    voyageDocumentText({
      ...event,
      price: 999,
      startsAt: '2030-01-01T20:00:00Z',
      checkedAt: '2030-01-01T00:00:00Z',
    }),
    text,
  );
  assert.equal(
    voyageDocumentText({ ...event, description: 'x'.repeat(20000) }).length,
    10000,
  );
  const key = voyageCacheKey(config);
  assert.match(key, /voyage-embedding-v1/);
  assert.match(key, /input_type=document/);
  assert.match(key, /dimensions=1024/);
  assert.doesNotMatch(key, /private-test-key/);
});

await test('adapter sends the bounded retrieval request and restores provider index order', async () => {
  let calls = 0;
  const embeddings = await embedWithVoyage(
    config,
    ['query one', 'query two'],
    'query',
    (async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.voyageai.com/v1/embeddings');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'manual');
      assert.equal(
        new Headers(init?.headers).get('Authorization'),
        'Bearer private-test-key',
      );
      const requestBody = init?.body;
      assert.equal(typeof requestBody, 'string');
      if (typeof requestBody !== 'string') throw new Error('Missing body.');
      const body = JSON.parse(requestBody);
      assert.deepEqual(body, {
        input: ['query one', 'query two'],
        model: 'voyage-4-large',
        input_type: 'query',
        truncation: false,
        output_dimension: 1024,
        output_dtype: 'float',
      });
      return Response.json({
        data: [
          { index: 1, embedding: vector().map((value) => -value) },
          { index: 0, embedding: vector() },
        ],
      });
    }) as typeof fetch,
  );
  assert.equal(calls, 1);
  assert.ok(embeddings[0][0] > 0);
  assert.ok(embeddings[1][0] < 0);
});

await test('adapter enforces input bounds before transport', async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return Response.json({});
  }) as typeof fetch;
  await assert.rejects(embedWithVoyage(config, [], 'document', fetcher));
  await assert.rejects(
    embedWithVoyage(config, ['x'.repeat(10001)], 'document', fetcher),
  );
  await assert.rejects(
    embedWithVoyage(config, Array(33).fill('x'), 'document', fetcher),
  );
  await assert.rejects(
    embedWithVoyage(
      { ...config, model: 'voyage-other' },
      ['x'],
      'document',
      fetcher,
    ),
    /model/,
  );
  assert.equal(calls, 0);
});

await test('adapter rejects malformed embeddings and oversized responses', async () => {
  const malformed = [
    { data: [] },
    { data: [{ index: 2, embedding: vector() }] },
    { data: [{ index: 0, embedding: [1] }] },
    { data: [{ index: 0, embedding: vector().fill(0) }] },
    { data: [{ index: 0, embedding: vector().with(3, Number.NaN) }] },
  ];
  for (const response of malformed) {
    await assert.rejects(
      embedWithVoyage(config, ['x'], 'document', (async () =>
        Response.json(response)) as typeof fetch),
    );
  }
  await assert.rejects(
    embedWithVoyage(
      config,
      ['x'],
      'document',
      (async () =>
        new Response('x'.repeat(4 * 1024 * 1024 + 1))) as typeof fetch,
    ),
    /too large/,
  );
});

await test('failed paid calls are not retried and errors disclose no provider body or key', async () => {
  let calls = 0;
  await assert.rejects(
    embedWithVoyage(config, ['x'], 'document', (async () => {
      calls++;
      return new Response('private diagnostics private-test-key', {
        status: 429,
      });
    }) as typeof fetch),
    (error: Error) => {
      assert.match(error.message, /HTTP 429/);
      assert.doesNotMatch(
        error.message,
        /private diagnostics|private-test-key/,
      );
      return true;
    },
  );
  assert.equal(calls, 1);

  await assert.rejects(
    embedWithVoyage(config, ['x'], 'document', (async () => {
      throw new Error('private-test-key');
    }) as typeof fetch),
    { message: 'Voyage request failed.' },
  );
});

await test('manual redirects are rejected without following the target', async () => {
  let calls = 0;
  await assert.rejects(
    embedWithVoyage(config, ['x'], 'document', (async (_url, init) => {
      calls++;
      assert.equal(init?.redirect, 'manual');
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://untrusted.example/collect' },
      });
    }) as typeof fetch),
    /HTTP 302/,
  );
  assert.equal(calls, 1);
});
