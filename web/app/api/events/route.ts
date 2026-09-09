import { configFrom } from '@/lib/ai';
import { candidates, runtime } from '@/lib/store';
import { emptyFilters } from '@/lib/types';
import { uniqueEvents } from '@/lib/search';
export async function GET() {
  try {
    const events = await candidates(emptyFilters);
    return Response.json(
      {
        events: uniqueEvents(events, 12),
        total: events.length,
        aiEnabled: Boolean(configFrom(runtime())),
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
