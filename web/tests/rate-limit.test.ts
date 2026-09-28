import test from 'node:test';
import assert from 'node:assert/strict';

import {
  consumeBuckets,
  requestLimitBuckets,
  visitorRateLimitEnabled,
  type LimitConsumer,
} from '../lib/rate-limit.ts';

await test('visitor limits default to enabled', () => {
  assert.equal(visitorRateLimitEnabled({}), true);
  assert.equal(visitorRateLimitEnabled({ DEPLOYMENT_ENV: 'staging' }), true);
});

await test('preview testing disables only visitor limits in staging', () => {
  assert.equal(
    visitorRateLimitEnabled({
      DEPLOYMENT_ENV: 'staging',
      BIPLAN_PREVIEW_TESTING: 'true',
    }),
    false,
  );
});

await test('production cannot bypass visitor limits with the preview flag', () => {
  assert.equal(
    visitorRateLimitEnabled({
      DEPLOYMENT_ENV: 'production',
      BIPLAN_PREVIEW_TESTING: 'true',
    }),
    true,
  );
});

await test('preview flag does not alter the global daily AI bucket', async () => {
  assert.equal(
    visitorRateLimitEnabled({
      DEPLOYMENT_ENV: 'staging',
      BIPLAN_PREVIEW_TESTING: 'true',
    }),
    false,
  );
  const deny: LimitConsumer = async () => false;
  assert.deepEqual(
    await consumeBuckets(
      [{ key: 'ai:preview', limit: 100, expiresAt: 86400000, scope: 'daily' }],
      0,
      deny,
    ),
    { allowed: false, retryAfter: 86400, scope: 'daily' },
  );
});

function counter() {
  const counts = new Map<string, number>();
  const consume: LimitConsumer = async (key, limit) => {
    const count = counts.get(key) ?? 0;
    if (count >= limit) return false;
    counts.set(key, count + 1);
    return true;
  };
  return { consume, counts };
}

await test('AI request buckets enforce five per minute and twenty per hour concurrently', async () => {
  const now = Date.parse('2026-09-26T19:55:30.000Z');
  const { consume, counts } = counter();
  const attempts = await Promise.all(
    Array.from({ length: 6 }, () =>
      consumeBuckets(requestLimitBuckets('same-user', true, now), now, consume),
    ),
  );
  assert.equal(attempts.filter((result) => result.allowed).length, 5);
  assert.deepEqual(attempts.at(-1), {
    allowed: false,
    retryAfter: 30,
    scope: 'minute',
  });
  assert.equal([...counts.entries()].find(([key]) => key.startsWith('ip-minute:'))?.[1], 5);
  assert.equal([...counts.entries()].find(([key]) => key.startsWith('ip-hour:'))?.[1], 5);
});

await test('fallback mode keeps a sixty-per-hour cap without the paid burst bucket', () => {
  const buckets = requestLimitBuckets('local', false, 1234);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].limit, 60);
  assert.equal(buckets[0].scope, 'hour');
});

await test('retry timing follows the failing minute, hour, and daily boundaries', async () => {
  const minuteNow = Date.parse('2026-09-26T19:55:59.500Z');
  const deny: LimitConsumer = async () => false;
  assert.deepEqual(
    await consumeBuckets(requestLimitBuckets('user', true, minuteNow), minuteNow, deny),
    { allowed: false, retryAfter: 1, scope: 'minute' },
  );
  const hourNow = Date.parse('2026-09-26T19:59:50.000Z');
  let call = 0;
  assert.deepEqual(
    await consumeBuckets(
      requestLimitBuckets('user', true, hourNow),
      hourNow,
      async () => ++call === 1,
    ),
    { allowed: false, retryAfter: 10, scope: 'hour' },
  );
  const dayNow = Date.parse('2026-09-26T23:59:30.000Z');
  assert.deepEqual(
    await consumeBuckets(
      [{ key: 'ai', limit: 100, expiresAt: Date.parse('2026-09-27T00:00:00.000Z'), scope: 'daily' }],
      dayNow,
      deny,
    ),
    { allowed: false, retryAfter: 30, scope: 'daily' },
  );
});
