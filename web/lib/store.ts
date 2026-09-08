import { env } from 'cloudflare:workers';
import seed from '../data/events.json';
import type { EventRecord, Filters } from './types.ts';
import { isEligible } from './search.ts';
import { embeddingText } from './ai.ts';
import {
  embeddingCacheKey,
  validVector,
  type EmbeddingConfig,
  type ProviderEnv,
} from './providers.ts';
export interface RuntimeEnv extends ProviderEnv {
  DB: D1Database;
  SYNC_TOKEN?: string;
  AI_DAILY_LIMIT?: string;
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
      'CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    ),
    db.prepare(
      'CREATE TABLE IF NOT EXISTS request_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)',
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
    const rows = [...sources].map(([url, checked]) =>
      db
        .prepare('DELETE FROM events WHERE source_url=? AND checked_at<=?')
        .bind(url, checked),
    );
    rows.push(...(seed as EventRecord[]).map((e) => upsertStatement(db, e)));
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
function upsertStatement(db: D1Database, e: EventRecord) {
  return db
    .prepare(
      'INSERT INTO events(id,starts_at,checked_at,category,price,source_url,payload) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET starts_at=excluded.starts_at,checked_at=excluded.checked_at,category=excluded.category,price=excluded.price,source_url=excluded.source_url,payload=excluded.payload WHERE excluded.checked_at>=events.checked_at',
    )
    .bind(
      e.id,
      e.startsAt,
      e.checkedAt,
      e.category,
      e.price,
      e.url,
      JSON.stringify(e),
    );
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
  if (f.category) {
    sql.push('category=?');
    args.push(f.category);
  }
  if (f.maxPrice !== null) {
    sql.push('price IS NOT NULL AND price<=?');
    args.push(f.maxPrice);
  }
  const result = await db
    .prepare(
      `SELECT payload FROM events WHERE ${sql.join(' AND ')} ORDER BY starts_at LIMIT 1000`,
    )
    .bind(...args)
    .all<{ payload: string }>();
  return result.results
    .map((r) => JSON.parse(r.payload) as EventRecord)
    .filter((e) => isEligible(e, f, now));
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
    ...items.map((e) => upsertStatement(db, e)),
  ]);
}
export async function consumeLimit(
  key: string,
  limit: number,
  expiresAt: number,
) {
  const db = await database();
  const row = await db
    .prepare(
      'INSERT INTO request_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count',
    )
    .bind(key, expiresAt, limit)
    .first();
  return Boolean(row);
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
export async function rateLimit(request: Request, paid: boolean) {
  const now = Date.now(),
    hour = Math.floor(now / 3600000),
    day = Math.floor(now / 86400000);
  const ip = await digest(request.headers.get('cf-connecting-ip') || 'local');
  if (
    !(await consumeLimit(
      `ip:${ip}:${hour}`,
      paid ? 20 : 120,
      (hour + 1) * 3600000,
    ))
  )
    return false;
  const configured = Number(runtime().AI_DAILY_LIMIT || 100);
  const cap = Number.isFinite(configured)
    ? Math.max(1, Math.min(10000, configured))
    : 100;
  return !paid || (await consumeLimit(`ai:${day}`, cap, (day + 1) * 86400000));
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
