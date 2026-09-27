import { checkpointReadiness } from '@/lib/operations';
import {
  currentPublished,
  checkpointExists,
  collectionStateConfigured,
} from '@/lib/store';

export async function GET() {
  const checkedAt = new Date().toISOString();
  const headers = { 'cache-control': 'no-store' };
  if (!collectionStateConfigured())
    return Response.json(
      { ready: false, checkedAt, reasons: ['collection_state_unavailable'] },
      { status: 503, headers },
    );
  try {
    const { catalog, checkpoint } = await currentPublished();
    const reasons = checkpointReadiness(catalog, checkpoint);
    if (checkpoint) {
      try {
        if (!(await checkpointExists(checkpoint)))
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
