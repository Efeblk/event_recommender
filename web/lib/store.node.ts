import { env } from './runtime-env.node.ts';
import { createGcpClients } from './gcp-clients.node.ts';
import { createGcpStore } from './store.gcp.ts';
import { clientIp } from './client-ip.node.ts';
import {
  consumeBuckets,
  requestLimitBuckets,
  type LimitConsumer,
} from './rate-limit.ts';
import { embeddingText } from './ai.ts';
import { embeddingCacheKey, type EmbeddingConfig } from './providers.ts';
import type { EventRecord } from './types.ts';
import type { HighLevelStore } from './storage-contract.ts';
export type { RateLimitResult } from './rate-limit.ts';

export function runtime() {
  return env;
}
let instance: Promise<HighLevelStore> | undefined;
function store() {
  return (instance ??= createGcpClients(env)
    .then((clients) =>
      createGcpStore({ ...clients, namespace: env.DEPLOYMENT_ENV }),
    )
    .catch((error) => {
      instance = undefined;
      throw error;
    }));
}
export const candidates: HighLevelStore['candidates'] = async (...args) =>
  (await store()).candidates(...args);
export const catalogStatus: HighLevelStore['catalogStatus'] = async (...args) =>
  (await store()).catalogStatus(...args);
export const health: HighLevelStore['health'] = async (...args) =>
  (await store()).health(...args);
export const consumeLimit: HighLevelStore['consumeLimit'] = async (...args) =>
  (await store()).consumeLimit(...args);
export const acquireLease: HighLevelStore['acquireLease'] = async (...args) =>
  (await store()).acquireLease(...args);
export const releaseLease: HighLevelStore['releaseLease'] = async (...args) =>
  (await store()).releaseLease(...args);
export const importPages: HighLevelStore['importPages'] = async (...args) =>
  (await store()).importPages(...args);
export const checkpointPointer: HighLevelStore['checkpointPointer'] = async (
  ...args
) => (await store()).checkpointPointer(...args);
export const readCheckpoint: HighLevelStore['readCheckpoint'] = async (
  ...args
) => (await store()).readCheckpoint(...args);
export const publishCheckpoint: HighLevelStore['publishCheckpoint'] = async (
  ...args
) => (await store()).publishCheckpoint(...args);
export const checkpointExists: HighLevelStore['checkpointExists'] = async (
  ...args
) => (await store()).checkpointExists(...args);
export const currentPublished: HighLevelStore['currentPublished'] = async (
  ...args
) => (await store()).currentPublished(...args);
export const voyageVectorsByHash: HighLevelStore['voyageVectorsByHash'] =
  async (...args) => (await store()).voyageVectorsByHash(...args);
export const saveVoyageVectors: HighLevelStore['saveVoyageVectors'] = async (
  ...args
) => (await store()).saveVoyageVectors(...args);
export function collectionStateConfigured() {
  return Boolean(env.GCP_STORAGE_BUCKET && env.BIPLAN_GCP_PROJECT);
}

export async function digest(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
}
export async function requestRateLimit(
  request: Request,
  paid: boolean,
  now = Date.now(),
  consume: LimitConsumer = consumeLimit,
) {
  return consumeBuckets(
    requestLimitBuckets(await digest(clientIp(request, env)), paid, now),
    now,
    consume,
  );
}
export async function aiDailyRateLimit(
  now = Date.now(),
  configuredValue = env.AI_DAILY_LIMIT,
  consume: LimitConsumer = consumeLimit,
) {
  const day = Math.floor(now / 86400000),
    configured = Number(configuredValue || 100);
  const cap = Number.isFinite(configured)
    ? Math.max(1, Math.min(10000, configured))
    : 100;
  return consumeBuckets(
    [
      {
        key: `ai:${day}`,
        limit: cap,
        expiresAt: (day + 1) * 86400000,
        scope: 'daily',
      },
    ],
    now,
    consume,
  );
}
export async function vectorsFor(
  events: EventRecord[],
  config: EmbeddingConfig,
) {
  const documents = await Promise.all(
    events.map(async (event) => ({
      id: event.id,
      hash: await digest(embeddingText(event)),
    })),
  );
  const cached = await voyageVectorsByHash(
    `legacy:${embeddingCacheKey(config)}`,
    documents.map((d) => d.hash),
    config.dimensions,
  );
  return new Map(
    documents.flatMap((d) =>
      cached.has(d.hash) ? [[d.id, cached.get(d.hash)!] as const] : [],
    ),
  );
}
// GCP uses collector/ imports followed by an explicit checkpoint publication.
export async function legacySync(_request: Request) {
  return Response.json(
    { error: 'Use the collector import and checkpoint pipeline on GCP' },
    { status: 410 },
  );
}
