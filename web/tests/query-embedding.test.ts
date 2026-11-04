import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createQueryEmbedder,
  queryEmbeddingLimits,
  queryEmbeddingText,
  QueryEmbeddingBusyError,
  type QueryEmbeddingLimits,
} from '../lib/query-embedding.ts';
import type { VoyageConfig } from '../lib/voyage.ts';

const config: VoyageConfig = {
  apiKey: 'test-key',
  model: 'voyage-4-large',
  dimensions: 256,
};

function harness(
  limits: Partial<QueryEmbeddingLimits> = {},
  fail?: (call: number) => Error | undefined,
) {
  let clock = 1_000_000;
  const calls: { texts: string[]; kind: string; at: number }[] = [];
  const sleeps: number[] = [];
  const embedder = createQueryEmbedder({
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    limits,
    embed: async (_config, texts, kind) => {
      calls.push({ texts, kind, at: clock });
      const error = fail?.(calls.length);
      if (error) throw error;
      return texts.map((_, index) => [calls.length, index + 1]);
    },
  });
  return {
    embedder,
    calls,
    sleeps,
    advance: (ms: number) => (clock += ms),
  };
}

await test('normalizes only spacing and Unicode form', () => {
  assert.equal(
    queryEmbeddingText('  Caz   konseri\n bu akşam '),
    'Caz konseri bu akşam',
  );
  assert.equal(queryEmbeddingText('Kadıköy'.normalize('NFD')), 'Kadıköy');
  assert.notEqual(queryEmbeddingText('Caz'), queryEmbeddingText('caz'));
});

await test('a repeated query text uses the cached vector and makes no call', async () => {
  const h = harness();
  const [first] = await h.embedder(config, ['caz konseri'], 'query');
  const [second] = await h.embedder(config, ['  caz   konseri '], 'query');
  assert.deepEqual(second, first);
  assert.equal(h.calls.length, 1);
  assert.equal(h.embedder.stats().cacheHits, 1);
  // Another model or dimension is a different cache entry.
  await h.embedder({ ...config, dimensions: 512 }, ['caz konseri'], 'query');
  assert.equal(h.calls.length, 2);
});

await test('concurrent identical queries share one provider call', async () => {
  const h = harness();
  const results = await Promise.all([
    h.embedder(config, ['stand-up'], 'query'),
    h.embedder(config, ['stand-up'], 'query'),
  ]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(h.calls.length, 1);
});

await test('paces calls below the per-minute limit and skips when the wait is too long', async () => {
  const h = harness({ maxWaitMs: 2_500 });
  for (const text of ['a', 'b', 'c']) await h.embedder(config, [text], 'query');
  assert.equal(h.calls.length, 3);
  // The fourth distinct query would wait about 60 s: no paid call.
  await assert.rejects(
    h.embedder(config, ['d'], 'query'),
    QueryEmbeddingBusyError,
  );
  assert.equal(h.calls.length, 3);
  assert.equal(h.embedder.stats().pacedSkips, 1);
  // A cached query still works while the window is full.
  assert.deepEqual(await h.embedder(config, ['a'], 'query'), [[1, 1]]);
  // Near the end of the window the next call waits for its slot.
  h.advance(58_000);
  await h.embedder(config, ['d'], 'query');
  assert.equal(h.calls.length, 4);
  assert.deepEqual(h.sleeps, [2_000]);
  const startsInAnyMinute = h.calls.filter(
    (call) => call.at > h.calls[3].at - queryEmbeddingLimits.windowMs,
  ).length;
  assert.ok(startsInAnyMinute <= queryEmbeddingLimits.callsPerWindow);
});

await test('concurrent distinct queries cannot reserve the same slot', async () => {
  const h = harness({ callsPerWindow: 1, maxWaitMs: 0 });
  const results = await Promise.allSettled([
    h.embedder(config, ['x'], 'query'),
    h.embedder(config, ['y'], 'query'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(h.calls.length, 1);
});

await test('HTTP 429 stops query calls for one cooldown period', async () => {
  const h = harness({}, (call) =>
    call === 1 ? new Error('Voyage request failed (HTTP 429).') : undefined,
  );
  await assert.rejects(h.embedder(config, ['a'], 'query'), /HTTP 429/);
  await assert.rejects(
    h.embedder(config, ['b'], 'query'),
    QueryEmbeddingBusyError,
  );
  assert.equal(h.calls.length, 1);
  h.advance(queryEmbeddingLimits.cooldownMs + 1);
  await h.embedder(config, ['b'], 'query');
  assert.equal(h.calls.length, 2);
});

await test('a failed call is not cached', async () => {
  const h = harness({}, (call) =>
    call === 1 ? new Error('Voyage request failed (HTTP 500).') : undefined,
  );
  await assert.rejects(h.embedder(config, ['a'], 'query'));
  assert.deepEqual(await h.embedder(config, ['a'], 'query'), [[2, 1]]);
});

await test('the cache is bounded and entries expire', async () => {
  const h = harness({ cacheEntries: 2, callsPerWindow: 100 });
  for (const text of ['a', 'b', 'c']) await h.embedder(config, [text], 'query');
  assert.equal(h.embedder.stats().cachedEntries, 2);
  await h.embedder(config, ['a'], 'query');
  assert.equal(h.calls.length, 4, 'the oldest entry was evicted');
  h.advance(queryEmbeddingLimits.cacheTtlMs + 1);
  await h.embedder(config, ['c'], 'query');
  assert.equal(h.calls.length, 5, 'an expired entry is fetched again');
});

await test('document embeddings pass through without cache or pacing', async () => {
  const h = harness({ callsPerWindow: 1 });
  await h.embedder(config, ['d1', 'd2'], 'document');
  await h.embedder(config, ['d1', 'd2'], 'document');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].kind, 'document');
});
