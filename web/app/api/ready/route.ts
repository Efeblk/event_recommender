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
    const published = await currentPublished();
    const { catalog } = published;
    const checkpoint = published.search ? published.search.checkpoint : published.checkpoint;
    const comparableCatalog = published.search ? { ...published.search.sourceCatalog, status: catalog.status } : catalog;
    const reasons = checkpointReadiness(comparableCatalog, checkpoint);
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
        ...(published.search ? { search: {
          pending: published.search.pending,
          latestCollectedAt: published.checkpoint?.finishedAt ?? null,
          activeCollectedAt: checkpoint?.finishedAt ?? null,
        } } : {}),
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
