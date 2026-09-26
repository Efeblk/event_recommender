import { recommend, validateInput } from '@/lib/recommend';
import {
  aiDailyRateLimit,
  candidates,
  catalogStatus,
  requestRateLimit,
  runtime,
  type RateLimitResult,
} from '@/lib/store';
import { jevConfigFrom } from '@/lib/jev';
import { voyageConfigFrom } from '@/lib/voyage';
import { voyageVectorsFor } from '@/lib/voyage-index';
import { catalogAllowsRecommendations } from '@/lib/catalog-readiness';
function limited(result: RateLimitResult) {
  const daily = result.scope === 'daily';
  const wait = daily
    ? `${Math.ceil(result.retryAfter / 60)} dakika`
    : `${result.retryAfter} saniye`;
  return Response.json(
    {
      error: daily
        ? `Günlük öneri sınırına ulaşıldı. ${wait} sonra yeniden deneyebilirsin.`
        : `Çok hızlı arama yapıldı. ${wait} sonra yeniden deneyebilirsin.`,
      code: 'rate_limited',
      retryAfter: result.retryAfter,
    },
    {
      status: 429,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(result.retryAfter),
      },
    },
  );
}
export async function POST(request: Request) {
  let input;
  try {
    if (Number(request.headers.get('content-length') || 0) > 24000)
      return Response.json({ error: 'Mesaj çok uzun.' }, { status: 413 });
    const raw = await request.text();
    if (raw.length > 24000)
      return Response.json({ error: 'Mesaj çok uzun.' }, { status: 413 });
    input = validateInput(JSON.parse(raw));
  } catch {
    return Response.json(
      {
        error:
          'Mesaj veya filtreler geçersiz. Tarihleri ve bütçeyi kontrol et.',
      },
      { status: 400 },
    );
  }
  try {
    const config = jevConfigFrom(runtime());
    const embeddingConfig = voyageConfigFrom(runtime());
    const paid = Boolean(config || embeddingConfig);
    const requestLimit = await requestRateLimit(request, paid);
    if (!requestLimit.allowed) return limited(requestLimit);
    const catalog = await catalogStatus();
    if (!catalogAllowsRecommendations(catalog.status))
      return Response.json(
        {
          error:
            catalog.status === 'stale'
              ? 'Etkinlik kataloğu yenileniyor. Güncel olmayan sonuçları göstermiyoruz; lütfen biraz sonra yeniden dene.'
              : 'Etkinlik kataloğu henüz hazır değil. Lütfen biraz sonra yeniden dene.',
          code: 'catalog_unavailable',
          catalog,
        },
        {
          status: 503,
          headers: {
            'Cache-Control': 'no-store',
            'Retry-After': '300',
          },
        },
      );
    if (paid) {
      const dailyLimit = await aiDailyRateLimit();
      if (!dailyLimit.allowed) return limited(dailyLimit);
    }
    return Response.json(
      await recommend(input, {
        candidates,
        config,
        embeddingConfig,
        vectors: voyageVectorsFor,
      }),
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return Response.json(
      { error: 'Arama tamamlanamadı. Lütfen yeniden dene.' },
      { status: 503 },
    );
  }
}
