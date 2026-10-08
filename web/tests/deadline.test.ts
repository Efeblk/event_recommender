import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchWithSignal, withDeadline } from '../lib/deadline.ts';

await test('overall deadline aborts the active provider transport and forbids a later paid stage', async () => {
  const providerSignals: AbortSignal[] = [];
  let laterStageCalls = 0;
  const stalledFetch = (async (
    _input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const providerSignal = init?.signal;
    if (providerSignal) providerSignals.push(providerSignal);
    return new Promise<Response>((_resolve, reject) => {
      providerSignal?.addEventListener(
        'abort',
        () => reject(providerSignal.reason),
        { once: true },
      );
    });
  }) as typeof fetch;

  await assert.rejects(
    withDeadline(20, 'Overall request timed out.', async (signal) => {
      const providerFetch = fetchWithSignal(signal, stalledFetch);
      try {
        await providerFetch('https://provider.example');
      } catch {
        // Retrieval may fall back after a provider failure. The request guard
        // must still stop any later paid rank call after the overall timeout.
      }
      signal.throwIfAborted();
      laterStageCalls++;
      return 'unreachable';
    }),
    /Overall request timed out/,
  );
  await delay(0);
  assert.equal(providerSignals[0]?.aborted, true);
  assert.equal(laterStageCalls, 0);
});

await test('an already aborted parent signal starts no operation', async () => {
  const parent = new AbortController();
  parent.abort(new Error('Client stopped.'));
  let calls = 0;
  await assert.rejects(
    withDeadline(
      100,
      'Request timed out.',
      async () => {
        calls++;
      },
      parent.signal,
    ),
    /Client stopped/,
  );
  assert.equal(calls, 0);
});

await test('ordinary completion clears the deadline without aborting the operation', async () => {
  const signals: AbortSignal[] = [];
  assert.equal(
    await withDeadline(100, 'Request timed out.', async (active) => {
      signals.push(active);
      return 'ok';
    }),
    'ok',
  );
  await delay(120);
  assert.equal(signals[0]?.aborted, false);
});
