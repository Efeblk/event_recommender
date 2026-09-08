import { embeddingCacheKey } from '@/lib/providers';
import { collect } from '@/lib/source';
import { database, digest, replaceSource, runtime } from '@/lib/store';
import { embeddingConfigFrom, embed, embeddingText } from '@/lib/ai';
export async function POST(request: Request) {
  const token = runtime().SYNC_TOKEN;
  if (
    !token ||
    !request.headers.get('authorization') ||
    (await digest(request.headers.get('authorization')!)) !==
      (await digest(`Bearer ${token}`))
  )
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const db = await database();
  const now = Date.now();
  const lock = await db
    .prepare(
      "INSERT INTO metadata(key,value) VALUES('sync_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(value AS INTEGER)<? RETURNING value",
    )
    .bind(String(now + 300000), now)
    .first();
  if (!lock)
    return Response.json({ error: 'Sync already running' }, { status: 409 });
  try {
    const report = await collect();
    for (const source of report.sources)
      await replaceSource(source.url, source.events);
    let embedded = 0,
      embeddingError = false;
    try {
      const config = embeddingConfigFrom(runtime());
      if (config) {
        const cacheKey = embeddingCacheKey(config);
        const pending = [];
        for (const event of report.sources.flatMap((s) => s.events)) {
          const hash = await digest(embeddingText(event));
          const old = await db
            .prepare('SELECT hash,model FROM embeddings WHERE event_id=?')
            .bind(event.id)
            .first<{ hash: string; model: string }>();
          if (!old || old.hash !== hash || old.model !== cacheKey)
            pending.push({ event, hash });
        }
        for (let i = 0; i < pending.length; i += 32) {
          const batch = pending.slice(i, i + 32);
          const vectors = await embed(
            config,
            batch.map((x) => embeddingText(x.event)),
          );
          await db.batch(
            batch.map((x, index) =>
              db
                .prepare(
                  'INSERT INTO embeddings(event_id,hash,model,vector) VALUES(?,?,?,?) ON CONFLICT(event_id) DO UPDATE SET hash=excluded.hash,model=excluded.model,vector=excluded.vector',
                )
                .bind(
                  x.event.id,
                  x.hash,
                  cacheKey,
                  JSON.stringify(vectors[index]),
                ),
            ),
          );
          embedded += batch.length;
        }
      }
    } catch {
      embeddingError = true;
    }
    await db
      .prepare('DELETE FROM request_limits WHERE expires_at<?')
      .bind(now)
      .run();
    return Response.json(
      {
        pages: report.pages,
        events: report.events,
        failures: report.failures,
        embedded,
        embeddingError,
      },
      { status: report.pages ? 200 : 502 },
    );
  } catch {
    return Response.json({ error: 'Sync failed' }, { status: 502 });
  } finally {
    await db.prepare("DELETE FROM metadata WHERE key='sync_lock'").run();
  }
}
