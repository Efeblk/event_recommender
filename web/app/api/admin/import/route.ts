import { database, digest, runtime, replaceSource } from '@/lib/store';
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
  const db = await database(),
    now = Date.now(),
    lease = `${now + 300000}:${crypto.randomUUID()}`;
  const lock = await db
    .prepare(
      "INSERT INTO metadata(key,value) VALUES('sync_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(value AS INTEGER)<? RETURNING value",
    )
    .bind(lease, now)
    .first();
  if (!lock)
    return Response.json({ error: 'Sync already running' }, { status: 409 });
  let imported = 0,
    skipped = 0;
  try {
    for (const page of pages) {
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
      for (const event of page.events) {
        const normalize = (text: string) =>
          text
            .toLocaleLowerCase('tr-TR')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/ı/g, 'i')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
        event.productionKey = (
          await digest(
            [event.title, event.venue, event.category].map(normalize).join('|'),
          )
        ).slice(0, 24);
      }
      await replaceSource(page.url, page.events);
      imported += page.events.length;
    }
    return Response.json({ imported, skipped });
  } catch {
    return Response.json(
      { error: 'Import failed; retry is safe' },
      { status: 503 },
    );
  } finally {
    await db
      .prepare("DELETE FROM metadata WHERE key='sync_lock' AND value=?")
      .bind(lease)
      .run();
  }
}
