export type RateLimitScope = 'minute' | 'hour' | 'daily';
export interface RateLimitResult {
  allowed: boolean;
  retryAfter: number;
  scope: RateLimitScope | null;
}
export interface LimitBucket {
  key: string;
  limit: number;
  expiresAt: number;
  scope: RateLimitScope;
}
export type LimitConsumer = (
  key: string,
  limit: number,
  expiresAt: number,
) => Promise<boolean>;

export function requestLimitBuckets(ip: string, paid: boolean, now: number) {
  const minute = Math.floor(now / 60000),
    hour = Math.floor(now / 3600000);
  return [
    ...(paid
      ? [{ key: `ip-minute:${ip}:${minute}`, limit: 5, expiresAt: (minute + 1) * 60000, scope: 'minute' as const }]
      : []),
    {
      key: `ip-hour:${ip}:${hour}`,
      limit: paid ? 20 : 60,
      expiresAt: (hour + 1) * 3600000,
      scope: 'hour' as const,
    },
  ];
}

export async function consumeBuckets(
  buckets: LimitBucket[],
  now: number,
  consume: LimitConsumer,
): Promise<RateLimitResult> {
  for (const bucket of buckets)
    if (!(await consume(bucket.key, bucket.limit, bucket.expiresAt)))
      return {
        allowed: false,
        retryAfter: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)),
        scope: bucket.scope,
      };
  return { allowed: true, retryAfter: 0, scope: null };
}
