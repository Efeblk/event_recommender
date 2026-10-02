import { jevConfigFrom } from '@/lib/jev';
import { voyageConfigFrom } from '@/lib/voyage';
import { candidates, catalogStatus, runtime, pinRecommendationCatalog } from '@/lib/store';
import { emptyFilters } from '@/lib/types';
import { uniqueEvents } from '@/lib/search';
export async function GET() {
  try {
    const pinned = await pinRecommendationCatalog(new Date());
    const [events, catalog] = await Promise.all([
      pinned ? pinned.candidates(emptyFilters) : candidates(emptyFilters),
      catalogStatus(),
    ]);
    const cards = pinned ? await pinned.finalize(uniqueEvents(events, 12)) : uniqueEvents(events, 12);
    return Response.json(
      {
        events: cards.map(card => { const event = { ...card }; delete event.preparedSearch; return event; }),
        ...(pinned ? { publicationId: pinned.publicationId } : {}),
        total: events.length,
        aiEnabled: Boolean(
          jevConfigFrom(runtime()) || voyageConfigFrom(runtime()),
        ),
        catalog,
        checkedAt:
          events.reduce(
            (last, e) => (e.checkedAt > last ? e.checkedAt : last),
            '',
          ) || null,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { error: 'Etkinlikler şu anda yüklenemiyor.' },
      { status: 503 },
    );
  }
}
