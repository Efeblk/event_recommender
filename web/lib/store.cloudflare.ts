import { env } from 'cloudflare:workers';
import {
  CHECKPOINT_POINTER_KEY,
  MAX_CHECKPOINT_BYTES,
  MAX_CHECKPOINT_EVENTS,
  parseCheckpointPointer,
  type CheckpointPointer,
  type CollectionCheckpoint,
  type CollectionReport,
} from './operations.ts';
import type { Lease, SourcePage, VectorEntry } from './storage-contract.ts';
export { POST as legacySync } from './legacy-sync.cloudflare.ts';
import seed from '../data/events.json';
import { emptyFilters, type EventRecord, type Filters } from './types.ts';
import { mergeEventSessions } from './event-merge.ts';
import { isEligible } from './search.ts';
import { embeddingText } from './ai.ts';
import {
  consumeBuckets,
  requestLimitBuckets,
  type LimitConsumer,
} from './rate-limit.ts';
export type { RateLimitResult } from './rate-limit.ts';
import {
  embeddingCacheKey,
  validVector,
  type EmbeddingConfig,
  type ProviderEnv,
} from './providers.ts';
export interface RuntimeEnv extends ProviderEnv {
  DB: D1Database;
  COLLECTION_STATE?: R2Bucket;
  SYNC_TOKEN?: string;
  AI_DAILY_LIMIT?: string;
  DONATION_URL?: string;
  DEPLOYMENT_ENV?: string;
  DEPLOYMENT_SHA?: string;
  TYPESAFE_API_KEY?: string;
  TYPESAFE_MODEL?: string;
  VOYAGE_API_KEY?: string;
  VOYAGE_MODEL?: string;
  VOYAGE_DIMENSIONS?: string;
}
export function runtime() {
  return env as unknown as RuntimeEnv;
}
let initialized: Promise<void> | undefined;
export async function database() {
  const db = runtime().DB;
  if (!db) throw new Error('Database binding is missing');
  initialized ??= initialize(db).catch((error) => {
    initialized = undefined;
    throw error;
  });
  await initialized;
  return db;
}
async function initialize(db: D1Database) {
  await db.batch([
    db.prepare(
      'CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, starts_at TEXT NOT NULL, checked_at TEXT NOT NULL, category TEXT NOT NULL, price REAL, source_url TEXT NOT NULL, payload TEXT NOT NULL)',
    ),
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_events_starts_at ON events(starts_at)',
    ),
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_events_source_url ON events(source_url)',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS embeddings (event_id TEXT PRIMARY KEY, hash TEXT NOT NULL, model TEXT NOT NULL, vector TEXT NOT NULL)',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS voyage_embeddings (profile TEXT NOT NULL, hash TEXT NOT NULL, vector TEXT NOT NULL, PRIMARY KEY(profile,hash))',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS request_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
    ),
    db.prepare(
      'CREATE INDEX IF NOT EXISTS idx_request_limits_expires_at ON request_limits(expires_at)',
    ),
  ]);
  const version =
    seed.reduce((v, e) => (e.checkedAt > v ? e.checkedAt : v), '') + ':2';
  const previous = await db
    .prepare("SELECT value FROM metadata WHERE key='seed_version'")
    .first<{ value: string }>();
  if (version && (!previous || previous.value < version)) {
    const sources = new Map<string, string>();
    for (const e of seed)
      sources.set(
        e.url,
        e.checkedAt > (sources.get(e.url) || '')
          ? e.checkedAt
          : sources.get(e.url)!,
      );
    // One indexed delete and bounded JSON inserts avoid one D1 query per row.
    const rows = [
      db
        .prepare(
          "DELETE FROM events WHERE id IN (SELECT events.id FROM json_each(?) AS incoming JOIN events ON events.source_url=json_extract(incoming.value,'$[0]') WHERE events.checked_at<=json_extract(incoming.value,'$[1]'))",
        )
        .bind(JSON.stringify([...sources])),
    ];
    rows.push(...upsertStatements(db, seed as EventRecord[]));
    rows.push(
      db
        .prepare(
          "INSERT INTO metadata(key,value) VALUES('seed_version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .bind(version),
    );
    await db.batch(rows);
  }
}
function upsertStatements(db: D1Database, items: EventRecord[]) {
  const statements: D1PreparedStatement[] = [];
  // Bound UTF-8 bytes as well as row count; multi-byte descriptions must still
  // fit D1's parameter value limit. The SQL itself uses one bind parameter.
  const batches: string[] = [];
  let parts: string[] = [],
    bytes = 2;
  const encoder = new TextEncoder();
  for (const item of items) {
    const part = JSON.stringify(item),
      size = encoder.encode(part).length + 1;
    if (parts.length && (parts.length === 100 || bytes + size > 500000)) {
      batches.push('[' + parts.join(',') + ']');
      parts = [];
      bytes = 2;
    }
    parts.push(part);
    bytes += size;
  }
  if (parts.length) batches.push('[' + parts.join(',') + ']');
  for (const payload of batches) {
    statements.push(
      db
        .prepare(
          `INSERT INTO events(id,starts_at,checked_at,category,price,source_url,payload)
       SELECT json_extract(value,'$.id'),json_extract(value,'$.startsAt'),
              json_extract(value,'$.checkedAt'),json_extract(value,'$.category'),
              json_extract(value,'$.price'),json_extract(value,'$.url'),value
       FROM json_each(?) AS incoming
       WHERE NOT EXISTS (
         SELECT 1 FROM events AS current
         WHERE current.source_url=json_extract(incoming.value,'$.url')
           AND current.checked_at>json_extract(incoming.value,'$.checkedAt')
       )
       ON CONFLICT(id) DO UPDATE SET starts_at=excluded.starts_at,
         checked_at=excluded.checked_at,category=excluded.category,price=excluded.price,
         source_url=excluded.source_url,payload=excluded.payload
       WHERE excluded.checked_at>=events.checked_at`,
        )
        .bind(payload),
    );
  }
  return statements;
}
export async function candidates(f: Filters, now = new Date()) {
  const db = await database();
  const sql = ['starts_at>=?', 'checked_at>=?'];
  const args: unknown[] = [
    now.toISOString(),
    new Date(now.getTime() - 72 * 3600000).toISOString(),
  ];
  if (f.dateFrom) {
    sql.push('starts_at>=?');
    args.push(new Date(f.dateFrom + 'T00:00:00+03:00').toISOString());
  }
  if (f.dateTo) {
    sql.push('starts_at<?');
    args.push(
      new Date(
        Date.parse(f.dateTo + 'T00:00:00+03:00') + 86400000,
      ).toISOString(),
    );
  }
  // Resolve provider disagreements before applying category/price filters.
  // Otherwise filtering a single provider row can split one session back up.
  const events: EventRecord[] = [];
  let afterStart = '',
    afterId = '';
  for (;;) {
    const page = await db
      .prepare(
        `SELECT id,starts_at,payload FROM events WHERE ${sql.join(' AND ')}
         AND (starts_at>? OR (starts_at=? AND id>?))
         ORDER BY starts_at,id LIMIT 200`,
      )
      .bind(...args, afterStart, afterStart, afterId)
      .all<{ id: string; starts_at: string; payload: string }>();
    if (!page.results.length) break;
    for (const row of page.results) {
      const event = JSON.parse(row.payload) as EventRecord;
      if (isEligible(event, emptyFilters, now)) events.push(event);
      afterStart = row.starts_at;
      afterId = row.id;
    }
  }
  return mergeEventSessions(events).filter((event) =>
    isEligible(event, f, now),
  );
}
export async function catalogStatus(now = new Date()) {
  const db = await database();
  const cutoff = new Date(now.getTime() - 72 * 3600000).toISOString();
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS stored, MIN(checked_at) AS oldestCheckedAt,
       MAX(checked_at) AS lastCheckedAt,
       COALESCE(SUM(CASE WHEN checked_at>=? AND starts_at>=?
         AND json_extract(payload,'$.availability')='available' THEN 1 ELSE 0 END),0) AS eligible,
       COALESCE(SUM(CASE WHEN checked_at>=? THEN 1 ELSE 0 END),0) AS fresh
     FROM events`,
    )
    .bind(cutoff, now.toISOString(), cutoff)
    .first<{
      stored: number;
      oldestCheckedAt: string | null;
      lastCheckedAt: string | null;
      eligible: number;
      fresh: number;
    }>();
  return {
    status: row?.eligible
      ? 'ready'
      : row?.stored && !row.fresh
        ? 'stale'
        : 'empty',
    stored: row?.stored ?? 0,
    eligible: row?.eligible ?? 0,
    lastCheckedAt: row?.lastCheckedAt ?? null,
    oldestCheckedAt: row?.oldestCheckedAt ?? null,
    expiresAt: row?.lastCheckedAt
      ? new Date(Date.parse(row.lastCheckedAt) + 72 * 3600000).toISOString()
      : null,
  };
}
export async function replaceSource(url: string, items: EventRecord[]) {
  const db = await database();
  await db.batch([
    db
      .prepare(
        'DELETE FROM embeddings WHERE event_id IN (SELECT id FROM events WHERE source_url=?) AND event_id NOT IN (SELECT value FROM json_each(?))',
      )
      .bind(url, JSON.stringify(items.map((e) => e.id))),
    db.prepare('DELETE FROM events WHERE source_url=?').bind(url),
    ...upsertStatements(db, items),
  ]);
}
export async function consumeLimit(
  key: string,
  limit: number,
  expiresAt: number,
) {
  const db = await database();
  await maybeCleanupExpiredLimits(db);
  const row = await db
    .prepare(
      'INSERT INTO request_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count',
    )
    .bind(key, expiresAt, limit)
    .first();
  return Boolean(row);
}

let nextLimitCleanupAt = 0;
async function maybeCleanupExpiredLimits(db: D1Database, now = Date.now()) {
  if (now < nextLimitCleanupAt) return;
  // At most one small indexed cleanup per isolate per five minutes. The LIMIT keeps a
  // long-idle database from turning a user request into an unbounded delete.
  nextLimitCleanupAt = now + 5 * 60000;
  try {
    await db
      .prepare(
        'DELETE FROM request_limits WHERE key IN (SELECT key FROM request_limits WHERE expires_at<? ORDER BY expires_at LIMIT 500)',
      )
      .bind(now)
      .run();
  } catch {
    // Rate limiting must remain available if housekeeping fails.
    nextLimitCleanupAt = now + 60000;
  }
}
export async function digest(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
  )
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('');
}
export async function requestRateLimit(
  request: Request,
  paid: boolean,
  now = Date.now(),
  consume: LimitConsumer = consumeLimit,
) {
  const ip = await digest(request.headers.get('cf-connecting-ip') || 'local');
  return consumeBuckets(requestLimitBuckets(ip, paid, now), now, consume);
}

export async function aiDailyRateLimit(
  now = Date.now(),
  configuredValue = runtime().AI_DAILY_LIMIT,
  consume: LimitConsumer = consumeLimit,
) {
  const day = Math.floor(now / 86400000);
  const configured = Number(configuredValue || 100);
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
  const db = await database();
  if (!events.length) return new Map<string, number[]>();
  const rows = await db
    .prepare(
      'SELECT event_id,hash,vector FROM embeddings WHERE model=? AND event_id IN (SELECT value FROM json_each(?))',
    )
    .bind(embeddingCacheKey(config), JSON.stringify(events.map((e) => e.id)))
    .all<{ event_id: string; hash: string; vector: string }>();
  const hashes = new Map(
    await Promise.all(
      events.map(async (e) => [e.id, await digest(embeddingText(e))] as const),
    ),
  );
  const vectors = new Map<string, number[]>();
  for (const row of rows.results) {
    if (hashes.get(row.event_id) !== row.hash) continue;
    try {
      const vector: unknown = JSON.parse(row.vector);
      if (validVector(vector, config.dimensions))
        vectors.set(row.event_id, vector);
    } catch {
      /* A damaged cache entry is a miss, not a failed search. */
    }
  }
  return vectors;
}

export async function health() {
  await (await database()).prepare('SELECT 1').first();
}
export function collectionStateConfigured() {
  return Boolean(runtime().COLLECTION_STATE);
}
export async function acquireLease(
  key: string,
  ttlMs = 300000,
): Promise<Lease | null> {
  const now = Date.now(),
    expiresAt = now + ttlMs;
  const token = `${expiresAt}:${crypto.randomUUID()}`;
  const row = await (
    await database()
  )
    .prepare(
      'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(value AS INTEGER)<? RETURNING value',
    )
    .bind(key, token, now)
    .first();
  return row ? { key, token, expiresAt } : null;
}
export async function releaseLease(lease: Lease) {
  await (
    await database()
  )
    .prepare('DELETE FROM metadata WHERE key=? AND value=?')
    .bind(lease.key, lease.token)
    .run();
}
async function assertLease(lease: Lease) {
  const row = await (
    await database()
  )
    .prepare('SELECT value FROM metadata WHERE key=? AND value=?')
    .bind(lease.key, lease.token)
    .first();
  if (!row || lease.expiresAt <= Date.now()) throw new Error('Lease expired');
}
export async function importPages(pages: SourcePage[], lease: Lease) {
  if (lease.key !== 'sync_lock') throw new Error('Invalid import lease');
  const db = await database();
  let imported = 0,
    skipped = 0;
  for (const page of pages) {
    await assertLease(lease);
    const checked = page.events.reduce(
      (last, e) => (e.checkedAt < last ? e.checkedAt : last),
      page.events[0].checkedAt,
    );
    const old = await db
      .prepare(
        'SELECT MAX(checked_at) AS checked FROM events WHERE source_url=?',
      )
      .bind(page.url)
      .first<{ checked: string | null }>();
    if (old?.checked && old.checked > checked) {
      skipped++;
      continue;
    }
    const items = [];
    for (const original of page.events) {
      const normalize = (text: string) =>
        text
          .toLocaleLowerCase('tr-TR')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/ı/g, 'i')
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
      items.push({
        ...original,
        productionKey: (
          await digest(
            [original.title, original.venue, original.category]
              .map(normalize)
              .join('|'),
          )
        ).slice(0, 24),
      });
    }
    await replaceSource(page.url, items);
    imported += items.length;
  }
  return { imported, skipped };
}
export async function checkpointPointer() {
  const row = await (
    await database()
  )
    .prepare('SELECT value FROM metadata WHERE key=?')
    .bind(CHECKPOINT_POINTER_KEY)
    .first<{ value: string }>();
  return parseCheckpointPointer(row?.value ?? null);
}
export async function currentPublished(now = new Date()) {
  const [catalog, checkpoint] = await Promise.all([
    catalogStatus(now),
    checkpointPointer(),
  ]);
  return { catalog, checkpoint };
}
export async function checkpointExists(pointer: CheckpointPointer) {
  return Boolean(await runtime().COLLECTION_STATE?.head(pointer.key));
}
export async function readCheckpoint() {
  const bucket = runtime().COLLECTION_STATE;
  if (!bucket) throw new Error('Collection state unavailable');
  const pointer = await checkpointPointer();
  if (!pointer) return null;
  const object = await bucket.get(pointer.key);
  if (!object || object.size > MAX_CHECKPOINT_BYTES)
    throw new Error('Checkpoint unavailable');
  return object.text();
}
export async function publishCheckpoint(
  report: CollectionReport,
  lease: Lease,
): Promise<CheckpointPointer> {
  if (lease.key !== 'sync_lock') throw new Error('Invalid publication lease');
  const bucket = runtime().COLLECTION_STATE;
  if (!bucket) throw new Error('Collection state unavailable');
  await assertLease(lease);
  const previous = await checkpointPointer();
  if (previous && report.finishedAt <= previous.finishedAt) return previous;
  const db = await database(),
    events: EventRecord[] = [],
    encoder = new TextEncoder();
  let after = '',
    approximateBytes = 2;
  for (;;) {
    const rows = await db
      .prepare('SELECT id,payload FROM events WHERE id>? ORDER BY id LIMIT 500')
      .bind(after)
      .all<{ id: string; payload: string }>();
    if (!rows.results.length) break;
    for (const row of rows.results) {
      approximateBytes += encoder.encode(row.payload).byteLength + 1;
      if (
        events.length + 1 > MAX_CHECKPOINT_EVENTS ||
        approximateBytes > MAX_CHECKPOINT_BYTES
      )
        throw new Error('Checkpoint exceeds limit');
      events.push(JSON.parse(row.payload) as EventRecord);
      after = row.id;
    }
  }
  const savedAt = new Date().toISOString();
  const checkpoint: CollectionCheckpoint = {
    schemaVersion: 1,
    savedAt,
    events,
    report,
  };
  const body = JSON.stringify(checkpoint),
    bytes = encoder.encode(body).byteLength;
  if (bytes > MAX_CHECKPOINT_BYTES) throw new Error('Checkpoint exceeds limit');
  const key = `collection/${savedAt.replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`;
  await bucket.put(key, body, {
    httpMetadata: { contentType: 'application/json' },
  });
  const pointer: CheckpointPointer = {
    schemaVersion: 1,
    key,
    savedAt,
    finishedAt: report.finishedAt,
    events: events.length,
    bytes,
    summary: report.summary,
  };
  const row = await db
    .prepare(
      'INSERT INTO metadata(key,value) SELECT ?,? WHERE EXISTS(SELECT 1 FROM metadata WHERE key=? AND value=? AND CAST(value AS INTEGER)>?) ON CONFLICT(key) DO UPDATE SET value=excluded.value RETURNING value',
    )
    .bind(
      CHECKPOINT_POINTER_KEY,
      JSON.stringify(pointer),
      lease.key,
      lease.token,
      Date.now(),
    )
    .first();
  if (!row) throw new Error('Lease expired');
  return pointer;
}
export async function voyageVectorsByHash(
  profile: string,
  hashes: string[],
  dimensions: number,
) {
  const vectors = new Map<string, number[]>();
  if (!hashes.length) return vectors;
  const db = await database();
  for (let offset = 0; offset < hashes.length; offset += 200) {
    const rows = await db
      .prepare(
        'SELECT hash,vector FROM voyage_embeddings WHERE profile=? AND hash IN (SELECT value FROM json_each(?))',
      )
      .bind(profile, JSON.stringify(hashes.slice(offset, offset + 200)))
      .all<{ hash: string; vector: string }>();
    for (const row of rows.results) {
      try {
        const vector: unknown = JSON.parse(row.vector);
        if (validVector(vector, dimensions)) vectors.set(row.hash, vector);
      } catch {
        /* Cache miss. */
      }
    }
  }
  return vectors;
}
export async function saveVoyageVectors(
  profile: string,
  entries: VectorEntry[],
  lease: Lease,
) {
  await assertLease(lease);
  const db = await database();
  if (entries.length)
    await db.batch(
      entries.map(({ hash, vector }) =>
        db
          .prepare(
            'INSERT INTO voyage_embeddings(profile,hash,vector) VALUES(?,?,?) ON CONFLICT(profile,hash) DO UPDATE SET vector=excluded.vector',
          )
          .bind(profile, hash, JSON.stringify(vector)),
      ),
    );
}
