import {
  embedWithVoyage,
  voyageCacheKey,
  type VoyageConfig,
} from './voyage.ts';

// Phase 1R, R5. The Voyage free plan allows 3 requests a minute for the whole
// API key. Staging runs one Cloud Run instance (`--max-instances 1`), so one
// process-wide pacer keeps query embedding below that limit. Repeated query
// texts use cached vectors and make no call.
export interface QueryEmbeddingLimits {
  callsPerWindow: number;
  windowMs: number;
  maxWaitMs: number;
  cooldownMs: number;
  cacheEntries: number;
  cacheTtlMs: number;
}

export const queryEmbeddingLimits: Readonly<QueryEmbeddingLimits> =
  Object.freeze({
    callsPerWindow: 3,
    windowMs: 60_000,
    // A search waits at most this long for a free call slot. Longer waits
    // would break the p95 latency target, so the search uses word matching.
    maxWaitMs: 2_500,
    // After HTTP 429 (for example while scheduled indexing uses the same key),
    // make no query call for one full window.
    cooldownMs: 60_000,
    cacheEntries: 1_000,
    cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
  });

export class QueryEmbeddingBusyError extends Error {
  constructor() {
    super('Voyage query embedding capacity is in use.');
    this.name = 'QueryEmbeddingBusyError';
  }
}

export interface QueryEmbedderOptions {
  embed?: typeof embedWithVoyage;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limits?: Partial<QueryEmbeddingLimits>;
}

export interface QueryEmbedderStats {
  cacheHits: number;
  providerCalls: number;
  pacedSkips: number;
  cachedEntries: number;
}

/** Normalizes only spacing and Unicode form. Case and words stay exact. */
export function queryEmbeddingText(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function queryCacheKey(config: VoyageConfig, text: string) {
  return `${voyageCacheKey(config).replace(
    'input_type=document',
    'input_type=query',
  )}|text=${text}`;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Returns a function with the signature of `embedWithVoyage`. Query
 * embeddings are cached by model, dimensions and normalized text. Provider
 * calls are paced in a rolling window. When no slot frees within
 * `maxWaitMs`, the call throws `QueryEmbeddingBusyError` and makes no paid
 * request. Document embeddings pass through unchanged.
 */
export function createQueryEmbedder(options: QueryEmbedderOptions = {}) {
  const embed = options.embed ?? embedWithVoyage;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const limits = { ...queryEmbeddingLimits, ...options.limits };
  const cache = new Map<string, { vector: number[]; at: number }>();
  const inFlight = new Map<string, Promise<number[]>>();
  // Reserved call start times. A reservation is made before the wait, so
  // concurrent searches cannot select the same free slot.
  let starts: number[] = [];
  let blockedUntil = 0;
  const stats = { cacheHits: 0, providerCalls: 0, pacedSkips: 0 };

  const cached = (key: string) => {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (now() - entry.at > limits.cacheTtlMs) {
      cache.delete(key);
      return undefined;
    }
    // Map order is insertion order: move the entry to the newest position.
    cache.delete(key);
    cache.set(key, entry);
    return entry.vector;
  };
  const remember = (key: string, vector: number[]) => {
    cache.set(key, { vector, at: now() });
    while (cache.size > limits.cacheEntries)
      cache.delete(cache.keys().next().value as string);
  };
  const reserve = (): number => {
    const time = now();
    if (time < blockedUntil) throw new QueryEmbeddingBusyError();
    starts = starts.filter((start) => start > time - limits.windowMs);
    const startAt =
      starts.length < limits.callsPerWindow
        ? time
        : starts[starts.length - limits.callsPerWindow] + limits.windowMs;
    const wait = startAt - time;
    if (wait > limits.maxWaitMs) throw new QueryEmbeddingBusyError();
    starts.push(startAt);
    starts.sort((a, b) => a - b);
    return wait;
  };
  const fetchOne = async (
    config: VoyageConfig,
    text: string,
    fetcher?: typeof fetch,
    timeoutMs?: number,
  ) => {
    let wait: number;
    try {
      wait = reserve();
    } catch (error) {
      stats.pacedSkips++;
      throw error;
    }
    if (wait > 0) await sleep(wait);
    stats.providerCalls++;
    try {
      const [vector] = await embed(config, [text], 'query', fetcher, timeoutMs);
      return vector;
    } catch (error) {
      if (error instanceof Error && /\(HTTP 429\)/.test(error.message))
        blockedUntil = now() + limits.cooldownMs;
      throw error;
    }
  };

  const queryEmbed: typeof embedWithVoyage & {
    stats: () => QueryEmbedderStats;
  } = Object.assign(
    async (
      config: VoyageConfig,
      texts: string[],
      inputType: 'query' | 'document',
      fetcher?: typeof fetch,
      timeoutMs?: number,
    ): Promise<number[][]> => {
      if (inputType !== 'query')
        return embed(config, texts, inputType, fetcher, timeoutMs);
      return Promise.all(
        texts.map(async (raw) => {
          const text = queryEmbeddingText(raw);
          const key = queryCacheKey(config, text);
          const hit = cached(key);
          if (hit) {
            stats.cacheHits++;
            return hit;
          }
          const pending = inFlight.get(key);
          if (pending) {
            stats.cacheHits++;
            return pending;
          }
          const request = fetchOne(config, text, fetcher, timeoutMs).then(
            (vector) => {
              remember(key, vector);
              return vector;
            },
          );
          inFlight.set(key, request);
          try {
            return await request;
          } finally {
            inFlight.delete(key);
          }
        }),
      );
    },
    { stats: () => ({ ...stats, cachedEntries: cache.size }) },
  );
  return queryEmbed;
}

// One process-wide embedder for the search route.
export const sharedQueryEmbedder = createQueryEmbedder();
