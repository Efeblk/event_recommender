import { database, digest, runtime } from '@/lib/store';
import {
  CHECKPOINT_POINTER_KEY,
  MAX_CHECKPOINT_BYTES,
  MAX_CHECKPOINT_EVENTS,
  MAX_REPORT_BYTES,
  parseCheckpointPointer,
  parseCollectionReport,
  type CollectionCheckpoint,
  type CheckpointPointer,
} from '@/lib/operations';
import type { EventRecord } from '@/lib/types';

async function authorized(request: Request) {
  const token = runtime().SYNC_TOKEN;
  return (
    Boolean(token) &&
    (await digest(request.headers.get('authorization') ?? '')) ===
      (await digest(`Bearer ${token}`))
  );
}

async function pointer(db: D1Database) {
  const row = await db
    .prepare('SELECT value FROM metadata WHERE key=?')
    .bind(CHECKPOINT_POINTER_KEY)
    .first<{ value: string }>();
  return parseCheckpointPointer(row?.value ?? null);
}

export async function GET(request: Request) {
  if (!(await authorized(request)))
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const bucket = runtime().COLLECTION_STATE;
  if (!bucket)
    return Response.json(
      { error: 'Collection state unavailable' },
      { status: 503 },
    );
  try {
    const current = await pointer(await database());
    if (!current)
      return Response.json(
        { error: 'No collection checkpoint' },
        { status: 404 },
      );
    const object = await bucket.get(current.key);
    if (!object)
      return Response.json(
        { error: 'Collection checkpoint unavailable' },
        { status: 503 },
      );
    if (object.size > MAX_CHECKPOINT_BYTES)
      return Response.json(
        { error: 'Collection checkpoint exceeds limit' },
        { status: 503 },
      );
    return new Response(object.body, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return Response.json(
      { error: 'Collection checkpoint unavailable' },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  if (!(await authorized(request)))
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const bucket = runtime().COLLECTION_STATE;
  if (!bucket)
    return Response.json(
      { error: 'Collection state unavailable' },
      { status: 503 },
    );
  let report;
  try {
    const declared = Number(request.headers.get('content-length'));
    if (declared > MAX_REPORT_BYTES)
      return Response.json({ error: 'Report too large' }, { status: 413 });
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Missing body');
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_REPORT_BYTES)
          return Response.json({ error: 'Report too large' }, { status: 413 });
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    report = parseCollectionReport(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    return Response.json(
      { error: 'Invalid or blocked collection report' },
      { status: 400 },
    );
  }
  let db: D1Database | undefined, lease: string | undefined;
  try {
    db = await database();
    const now = Date.now();
    lease = `${now + 300000}:${crypto.randomUUID()}`;
    const lock = await db
      .prepare(
        "INSERT INTO metadata(key,value) VALUES('sync_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(value AS INTEGER)<? RETURNING value",
      )
      .bind(lease, now)
      .first();
    if (!lock)
      return Response.json({ error: 'Sync already running' }, { status: 409 });
    const previous = await pointer(db);
    if (previous && report.finishedAt <= previous.finishedAt)
      return Response.json({
        schemaVersion: 1,
        savedAt: previous.savedAt,
        key: previous.key,
        events: previous.events,
      });

    const events: EventRecord[] = [];
    let after = '',
      approximateBytes = 2;
    for (;;) {
      const rows = await db
        .prepare(
          'SELECT id,payload FROM events WHERE id>? ORDER BY id LIMIT 500',
        )
        .bind(after)
        .all<{ id: string; payload: string }>();
      if (!rows.results.length) break;
      for (const row of rows.results) {
        if (events.length + 1 > MAX_CHECKPOINT_EVENTS)
          throw new Error('Checkpoint event limit exceeded');
        approximateBytes +=
          new TextEncoder().encode(row.payload).byteLength + 1;
        if (approximateBytes > MAX_CHECKPOINT_BYTES)
          throw new Error('Checkpoint byte limit exceeded');
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
      bytes = new TextEncoder().encode(body).byteLength;
    if (bytes > MAX_CHECKPOINT_BYTES)
      throw new Error('Checkpoint byte limit exceeded');
    const key = `collection/${savedAt.replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`;
    await bucket.put(key, body, {
      httpMetadata: { contentType: 'application/json' },
    });
    const next: CheckpointPointer = {
      schemaVersion: 1,
      key,
      savedAt,
      finishedAt: report.finishedAt,
      events: events.length,
      bytes,
      summary: report.summary,
    };
    await db
      .prepare(
        'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .bind(CHECKPOINT_POINTER_KEY, JSON.stringify(next))
      .run();
    return Response.json({
      schemaVersion: 1,
      savedAt,
      key,
      events: events.length,
    });
  } catch {
    return Response.json(
      { error: 'Collection checkpoint failed; retry is safe' },
      { status: 503 },
    );
  } finally {
    if (db && lease) {
      try {
        await db
          .prepare("DELETE FROM metadata WHERE key='sync_lock' AND value=?")
          .bind(lease)
          .run();
      } catch {
        // The lease expires on its own; cleanup must not replace the response.
      }
    }
  }
}
