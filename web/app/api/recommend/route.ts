import { recommend, validateInput } from '@/lib/recommend';
import {
  aiDailyRateLimit,
  candidates,
  catalogStatus,
  logRequest,
  requestRateLimit,
  runtime,
  pinRecommendationCatalog,
  type RateLimitResult,
} from '@/lib/store';
import { jevConfigFrom, rankWithJev } from '@/lib/jev';
import { voyageConfigFrom, embedWithVoyage } from '@/lib/voyage';
import { interpretSpanInput } from '@/lib/span-interpreter';
import { inputInterpreterFrom } from '@/lib/interpreter-config';
import { interpretInput } from '@/lib/input-interpreter';
import { voyageVectorsFor } from '@/lib/voyage-index';
import { catalogAllowsRecommendations } from '@/lib/catalog-readiness';
import { visitorRateLimitEnabled } from '@/lib/rate-limit';
import { publicEventRecord } from '@/lib/catalog';
import { requestLogEnabled, requestLogEntry } from '@/lib/request-log';
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
  const started = performance.now();
  const timings: string[] = [];
  async function measured<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const before = performance.now();
    try {
      return await operation();
    } finally {
      timings.push(`${name};dur=${(performance.now() - before).toFixed(1)}`);
    }
  }
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
    const inputInterpreter = inputInterpreterFrom(runtime(), Boolean(config));
    const embeddingConfig = voyageConfigFrom(runtime());
    const paid = Boolean(config || embeddingConfig);
    if (visitorRateLimitEnabled(runtime())) {
      const requestLimit = await requestRateLimit(request, paid);
      if (!requestLimit.allowed) return limited(requestLimit);
    }
    const now = new Date();
    const capturedPinned = await measured('publication_pin', () => pinRecommendationCatalog(now));
    const available = capturedPinned?.availability
      ? await measured('catalog_availability', () => capturedPinned.availability!())
      : null;
    const catalog = available === true ? null : await measured('catalog', () =>
      available === false && capturedPinned?.catalogStatus ? capturedPinned.catalogStatus() : catalogStatus(now));
    if (available === false || (catalog && !catalogAllowsRecommendations(catalog.status)))
      return Response.json(
        {
          error:
            catalog?.status === 'stale'
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
      const dailyLimit = await measured('daily_limit', () =>
        aiDailyRateLimit(),
      );
      if (!dailyLimit.allowed) return limited(dailyLimit);
    }
    let parsed: Awaited<ReturnType<typeof interpretSpanInput>> | null = null;
    const result = await recommend(input, {
      now,
      pinCatalog: async () => {
        const pinned = capturedPinned;
        if (!pinned) return null;
        return {
          ...pinned,
          candidates: (filters) =>
            measured('candidates', () => pinned.candidates(filters)),
          vectors: (events, config) =>
            measured('vectors', () => pinned.vectors(events, config)),
          ...(pinned.dense
            ? {
                dense: {
                  coverage: (events, config) =>
                    measured('vector_coverage', () =>
                      pinned.dense!.coverage(events, config),
                    ),
                  rank: (events, config, vector) =>
                    measured('dense_exact', () =>
                      pinned.dense!.rank(events, config, vector),
                    ),
                },
              }
            : {}),
          finalize: (events) =>
            measured('source_revalidation', () => pinned.finalize(events)),
        };
      },
      candidates: (filters) =>
        measured('candidates', () => candidates(filters)),
      config,
      embeddingConfig,
      vectors: (events, config) =>
        measured('vectors', () => voyageVectorsFor(events, config)),
      interpret: (input, options) =>
        measured('interpret', () => interpretInput(input, options)),
      embed: (config, texts, kind) =>
        measured('query_embedding', () => embedWithVoyage(config, texts, kind)),
      rank: (config, input, events) =>
        measured('rank', () => rankWithJev(config, input, events)),
      spanInterpret: async (input, options) =>
        (parsed = await measured('interpret', () =>
          interpretSpanInput(input, options),
        )),
      inputInterpreter,
    });
    // Approved staging tests keep requests for parser evaluation; a failed
    // write never fails the search.
    if (requestLogEnabled(runtime()))
      await measured('request_log', () =>
        logRequest(
          requestLogEntry({
            id: crypto.randomUUID(),
            at: now,
            deploymentSha: runtime().DEPLOYMENT_SHA,
            input,
            parse: parsed,
            result,
          }),
        ),
      ).catch(() => undefined);
    return Response.json(
      {
        ...result,
        recommendations: result.recommendations.map((recommendation) => ({
          ...recommendation,
          event: publicEventRecord(recommendation.event),
        })),
      },
      {
        headers: {
          'Cache-Control': 'no-store',
          'Server-Timing': [
            ...timings,
            `total;dur=${(performance.now() - started).toFixed(1)}`,
          ].join(', '),
        },
      },
    );
  } catch {
    return Response.json(
      { error: 'Arama tamamlanamadı. Lütfen yeniden dene.' },
      { status: 503 },
    );
  }
}
