import {
  CHECKPOINT_POINTER_KEY,
  checkpointReadiness,
  parseCheckpointPointer,
} from '@/lib/operations';
import { catalogStatus, database, runtime } from '@/lib/store';

export async function GET() {
  const checkedAt = new Date().toISOString();
  const headers = { 'cache-control': 'no-store' };
  if (!runtime().COLLECTION_STATE)
    return Response.json(
      { ready: false, checkedAt, reasons: ['collection_state_unavailable'] },
      { status: 503, headers },
    );
  try {
    const db = await database();
    const [catalog, row] = await Promise.all([
      catalogStatus(),
      db
        .prepare('SELECT value FROM metadata WHERE key=?')
        .bind(CHECKPOINT_POINTER_KEY)
        .first<{ value: string }>(),
    ]);
    const checkpoint = parseCheckpointPointer(row?.value ?? null);
    const reasons = checkpointReadiness(catalog, checkpoint);
    if (checkpoint) {
      try {
        if (!(await runtime().COLLECTION_STATE!.head(checkpoint.key)))
          reasons.push('checkpoint_unavailable');
      } catch {
        reasons.push('checkpoint_unavailable');
      }
    }
    return Response.json(
      {
        ready: reasons.length === 0,
        checkedAt,
        reasons,
        catalog,
        checkpoint: checkpoint
          ? {
              savedAt: checkpoint.savedAt,
              finishedAt: checkpoint.finishedAt,
              events: checkpoint.events,
              bytes: checkpoint.bytes,
              summary: checkpoint.summary,
            }
          : null,
      },
      { status: reasons.length ? 503 : 200, headers },
    );
  } catch {
    return Response.json(
      { ready: false, checkedAt, reasons: ['database_unavailable'] },
      { status: 503, headers },
    );
  }
}
