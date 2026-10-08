import { recommendRequest, validateRequest } from '@/lib/recommend';
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
import {
  readBoundedRequestText,
  RequestBodyTooLargeError,
} from '@/lib/request-body';
import {
  DeadlineExceededError,
  fetchWithSignal,
  withDeadline,
} from '@/lib/deadline';
const MAX_REQUEST_BYTES = 24_000;
const REQUEST_BODY_TIMEOUT_MS = 5_000;
const REQUEST_BUDGET_MS = 35_000;
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
  try {
    // Vinext's Node adapter does not currently surface incoming disconnects on
    // this signal. The request-wide timer still bounds every provider fetch.
    return await withDeadline(
      REQUEST_BUDGET_MS,
      'Recommendation request timed out.',
      (signal) => postWithinBudget(request, signal, started),
      request.signal,
    );
  } catch {
    return Response.json(
      { error: 'Arama tamamlanamadı. Lütfen yeniden dene.' },
      { status: 503 },
    );
  }
}

async function postWithinBudget(
  request: Request,
  requestSignal: AbortSignal,
  started: number,
) {
  const timings: string[] = [];
  async function measured<T>(
    name: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const before = performance.now();
    try {
      requestSignal.throwIfAborted();
      const value = await operation();
      requestSignal.throwIfAborted();
      return value;
    } finally {
      timings.push(`${name};dur=${(performance.now() - before).toFixed(1)}`);
    }
  }
  let input;
  try {
    const raw = await withDeadline(
      REQUEST_BODY_TIMEOUT_MS,
      'Recommendation request body timed out.',
      (bodySignal) =>
        readBoundedRequestText(request, MAX_REQUEST_BYTES, bodySignal),
      requestSignal,
    );
    input = validateRequest(JSON.parse(raw));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return Response.json({ error: 'Mesaj çok uzun.' }, { status: 413 });
    if (requestSignal.aborted) throw error;
    if (error instanceof DeadlineExceededError)
      return Response.json(
        { error: 'Mesaj zamanında alınamadı. Lütfen yeniden dene.' },
        { status: 408 },
      );
    return Response.json(
      {
        error:
          'Mesaj veya filtreler geçersiz. Tarihleri ve bütçeyi kontrol et.',
      },
      { status: 400 },
    );
  }
  try {
    requestSignal.throwIfAborted();
    const config = jevConfigFrom(runtime());
    const inputInterpreter = inputInterpreterFrom(runtime(), Boolean(config));
    const embeddingConfig = voyageConfigFrom(runtime());
    const providerFetch = fetchWithSignal(requestSignal);
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
    const result = await recommendRequest(input, {
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
        measured('interpret', () =>
          interpretInput(input, { ...options, fetcher: providerFetch }),
        ),
      embed: (config, texts, kind) =>
        measured('query_embedding', () =>
          embedWithVoyage(config, texts, kind, providerFetch),
        ),
      rank: (config, input, events) =>
        measured('rank', () =>
          rankWithJev(config, input, events, providerFetch),
        ),
      spanInterpret: async (input, options) =>
        (parsed = await measured('interpret', () =>
          interpretSpanInput(input, { ...options, fetcher: providerFetch }),
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
    requestSignal.throwIfAborted();
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
