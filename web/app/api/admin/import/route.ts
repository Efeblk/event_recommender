import {
  digest,
  runtime,
  acquireLease,
  releaseLease,
  importPages,
} from '@/lib/store';
import { validateImport } from '@/lib/catalog';
export async function POST(request: Request) {
  const token = runtime().SYNC_TOKEN;
  if (
    !token ||
    (await digest(request.headers.get('authorization') ?? '')) !==
      (await digest(`Bearer ${token}`))
  )
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let pages;
  try {
    if (Number(request.headers.get('content-length')) > 4000000)
      return Response.json({ error: 'Import too large' }, { status: 413 });
    // Bound bytes while reading rather than after allocating an arbitrary body.
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Missing body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4000000) throw new Error('Body too large');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    pages = validateImport(JSON.parse(new TextDecoder().decode(buffer)));
  } catch {
    return Response.json({ error: 'Invalid collection data' }, { status: 400 });
  }
  let lease;
  try {
    lease = await acquireLease('sync_lock');
    if (!lease)
      return Response.json({ error: 'Sync already running' }, { status: 409 });
    return Response.json(await importPages(pages, lease));
  } catch {
    return Response.json(
      { error: 'Import failed; retry is safe' },
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
