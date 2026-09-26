import {
  digest,
  runtime,
  readCheckpoint,
  publishCheckpoint,
  acquireLease,
  releaseLease,
  collectionStateConfigured,
} from '@/lib/store';
import { MAX_REPORT_BYTES, parseCollectionReport } from '@/lib/operations';

async function authorized(request: Request) {
  const token = runtime().SYNC_TOKEN;
  return (
    Boolean(token) &&
    (await digest(request.headers.get('authorization') ?? '')) ===
      (await digest(`Bearer ${token}`))
  );
}

export async function GET(request: Request) {
  if (!(await authorized(request)))
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const body = await readCheckpoint();
    if (!body)
      return Response.json(
        { error: 'No collection checkpoint' },
        { status: 404 },
      );
    return new Response(body, {
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
  if (!collectionStateConfigured())
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
  let lease;
  try {
    lease = await acquireLease('sync_lock');
    if (!lease)
      return Response.json({ error: 'Sync already running' }, { status: 409 });
    const pointer = await publishCheckpoint(report, lease);
    return Response.json({
      schemaVersion: 1,
      savedAt: pointer.savedAt,
      key: pointer.key,
      events: pointer.events,
    });
  } catch {
    return Response.json(
      { error: 'Collection checkpoint failed; retry is safe' },
      { status: 503 },
    );
  } finally {
    if (lease)
      try {
        await releaseLease(lease);
      } catch {
        /* The lease expires. */
      }
  }
}
