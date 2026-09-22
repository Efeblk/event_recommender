import { jevConfigFrom } from '@/lib/jev';
import { candidates, catalogStatus, runtime } from '@/lib/store';
import { emptyFilters } from '@/lib/types';
import { uniqueEvents } from '@/lib/search';
export async function GET() {
  try {
    const [events, catalog] = await Promise.all([
      candidates(emptyFilters),
      catalogStatus(),
    ]);
    return Response.json(
      {
        events: uniqueEvents(events, 12),
        total: events.length,
        aiEnabled: Boolean(jevConfigFrom(runtime())),
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
