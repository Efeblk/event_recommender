import assert from 'node:assert/strict';
import test from 'node:test';
import {
  readBoundedRequestText,
  RequestBodyTooLargeError,
} from '../lib/request-body.ts';
import { DeadlineExceededError, withDeadline } from '../lib/deadline.ts';

await test('bounded request text counts UTF-8 bytes and accepts the exact boundary', async () => {
  assert.equal(
    await readBoundedRequestText(
      new Request('https://example.test', { method: 'POST', body: 'üü' }),
      4,
    ),
    'üü',
  );
  await assert.rejects(
    readBoundedRequestText(
      new Request('https://example.test', { method: 'POST', body: 'üü' }),
      3,
    ),
    RequestBodyTooLargeError,
  );
});

await test('bounded request text cancels an oversized stream without reading its remainder', async () => {
  let cancelled = false;
  let reads = 0;
  const request = {
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: async () => {
          reads++;
          if (reads > 1) throw new Error('The remainder must not be read.');
          return { done: false, value: new Uint8Array(5) };
        },
        cancel: async () => {
          cancelled = true;
        },
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Request;
  await assert.rejects(
    readBoundedRequestText(request, 4),
    RequestBodyTooLargeError,
  );
  assert.equal(cancelled, true);
  assert.equal(reads, 1);
});

await test('declared oversized bodies fail before their stream is read', async () => {
  let cancelled = false;
  const request = {
    headers: new Headers({ 'content-length': '5' }),
    body: {
      cancel: async () => {
        cancelled = true;
      },
      getReader: () => {
        throw new Error('The body reader must not be opened.');
      },
    },
  } as unknown as Request;
  await assert.rejects(
    readBoundedRequestText(request, 4),
    RequestBodyTooLargeError,
  );
  assert.equal(cancelled, true);
});

await test('request cancellation stops a stalled body read and cancels the reader', async () => {
  let cancelled = false;
  const request = {
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: () => new Promise<never>(() => undefined),
        cancel: async () => {
          cancelled = true;
        },
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Request;
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('Request stopped.')), 10);
  await assert.rejects(
    readBoundedRequestText(request, 4, controller.signal),
    /Request stopped/,
  );
  assert.equal(cancelled, true);
});

await test('a body deadline cancels a stalled reader before recommendation work can start', async () => {
  let cancelled = false;
  let providerStarted = false;
  const request = {
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: () => new Promise<never>(() => undefined),
        cancel: async () => {
          cancelled = true;
        },
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Request;

  await assert.rejects(
    withDeadline(20, 'Body timed out.', async (signal) => {
      await readBoundedRequestText(request, 4, signal);
      providerStarted = true;
    }),
    (error) =>
      error instanceof DeadlineExceededError && error.message === 'Body timed out.',
  );
  assert.equal(cancelled, true);
  assert.equal(providerStarted, false);
});
