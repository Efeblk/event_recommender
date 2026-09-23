import {
  emptyFilters,
  type EventRecord,
  type Filters,
  type Message,
  type SearchResult,
} from './types.ts';
import {
  productionIdentity,
  isEligible,
  interpretConstraints,
  uniqueEvents,
  validateFilters,
} from './search.ts';
import { rankWithJev, type JevConfig, type JevRanking } from './jev.ts';
import { fallbackEvents, searchContext, shortlistEvents } from './retrieval.ts';
import { embedWithVoyage, type VoyageConfig } from './voyage.ts';
import { semanticQuery, type SemanticRanking } from './hybrid.ts';

export interface RecommendInput {
  message: string;
  history: Message[];
  filters: Filters;
  excludeIds: string[];
}
export function validateInput(value: unknown): RecommendInput {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('İstek geçersiz.');
  const x = value as Record<string, unknown>;
  if (
    typeof x.message !== 'string' ||
    !x.message.trim() ||
    x.message.length > 1200
  )
    throw new Error('Mesaj 1–1.200 karakter olmalı.');
  const history = x.history ?? [];
  if (
    !Array.isArray(history) ||
    history.length > 12 ||
    history.some(
      (m) =>
        !m ||
        !['user', 'assistant'].includes(m.role) ||
        typeof m.content !== 'string' ||
        m.content.length > 2000,
    )
  )
    throw new Error('Arama geçmişi geçersiz.');
  const exclude = x.excludeIds ?? [];
  if (
    !Array.isArray(exclude) ||
    exclude.length > 100 ||
    exclude.some((id) => typeof id !== 'string' || id.length > 100)
  )
    throw new Error('Etkinlik seçimi geçersiz.');
  return {
    message: x.message.trim(),
    // Old clients may send assistant messages. Only user requests are context.
    history: history.filter((m) => m.role === 'user').slice(-6),
    filters: validateFilters(x.filters ?? emptyFilters),
    excludeIds: exclude,
  };
}
export interface Dependencies {
  candidates: (f: Filters) => Promise<EventRecord[]>;
  config: JevConfig | null;
  now?: Date;
  rank?: typeof rankWithJev;
  embeddingConfig?: VoyageConfig | null;
  vectors?: (
    events: EventRecord[],
    config: VoyageConfig,
  ) => Promise<Map<string, number[]>>;
  embed?: typeof embedWithVoyage;
}

// Initial product policy, not an empirically calibrated quality claim.
// Level 2 requires source support; a valid no-match remains empty.
export const MIN_JEV_SCORE = 2;

// Shared with the evaluation harness so it measures exactly what users see.
// Only canonical candidates may become cards, even if a ranker supplies others.
export function selectJevEvents(
  candidates: EventRecord[],
  ranking: JevRanking,
  limit = 5,
): EventRecord[] {
  const byId = new Map(candidates.map((event) => [event.id, event]));
  const supported = ranking.ranked
    .filter(
      ({ event, score }) =>
        byId.has(event.id) &&
        Number.isFinite(score) &&
        score >= MIN_JEV_SCORE &&
        score <= 3,
    )
    .sort((a, b) => b.score - a.score)
    .map(({ event }) => byId.get(event.id)!);
  return uniqueEvents(supported, Math.max(0, Math.min(5, limit)));
}

const basicNotice =
  'Sonuçlar tarih, bütçe, kategori ve kelime eşleşmesine göre listeleniyor.';
const issueNotices = {
  budget_ambiguous:
    'Bütçeyi kişi başı belirt veya toplam bütçeyle birlikte kişi sayısını yaz. Örneğin: iki kişi toplam 800 TL.',
  date_ambiguous:
    'Tarihi daha açık belirt. Örneğin: yarın, bu hafta sonu veya YYYY-AA-GG biçiminde bir tarih.',
  constraint_ambiguous:
    'Koşulları ayrı ve açık biçimde belirt. Örneğin: cumartesi, kişi başı 800 TL, konser hariç.',
  unsupported_location:
    'Şu an yalnızca İstanbul etkinlikleri var. İstanbul için bir arama yapabilirsin.',
};

export async function recommend(
  input: RecommendInput,
  deps: Dependencies,
): Promise<SearchResult> {
  const now = deps.now ?? new Date();
  const { filters, issue } = interpretConstraints(
    input.message,
    input.filters,
    now,
  );
  if (issue)
    return {
      recommendations: [],
      filters,
      mode: 'filters',
      status:
        issue === 'unsupported_location'
          ? 'unsupported_location'
          : 'needs_input',
      notice: issueNotices[issue],
      totalCandidates: 0,
    };
  let events = (await deps.candidates(filters)).filter((event) =>
    isEligible(event, filters, now),
  );
  const excludedProductions = new Set(
    events
      .filter((event) => input.excludeIds.includes(event.id))
      .map(productionIdentity),
  );
  events = events.filter(
    (event) =>
      !input.excludeIds.includes(event.id) &&
      !excludedProductions.has(productionIdentity(event)),
  );
  const totalCandidates = events.length;
  if (!events.length)
    return {
      recommendations: [],
      filters,
      mode: 'filters',
      status: 'empty',
      notice: 'Bu koşullara uyan güncel bir etkinlik bulunamadı.',
      totalCandidates,
    };
  const context = searchContext(input.message, input.history);
  let shortlist = shortlistEvents(events, input.message, input.history, 16);
  if (!shortlist.length)
    return {
      recommendations: [],
      filters,
      mode: 'filters',
      status: 'empty',
      notice:
        'Belirttiğin tercih ve hariç tutmalara uyan bir etkinlik bulunamadı.',
      totalCandidates,
    };
  let semantic: SemanticRanking | undefined;
  let retrievalNotice: string | null = null;
  if (deps.embeddingConfig) {
    try {
      const vectors = await deps.vectors?.(events, deps.embeddingConfig);
      if (vectors?.size) {
        const [queryVector] = await (deps.embed ?? embedWithVoyage)(
          deps.embeddingConfig,
          [semanticQuery(input.message, context.history)],
          'query',
        );
        semantic = { queryVector, vectors };
        if (vectors.size < events.length)
          retrievalNotice =
            'Anlamsal dizin kısmen hazır; yeni etkinlikler kelime aramasıyla da değerlendiriliyor.';
      } else
        retrievalNotice =
          'Anlamsal arama dizini henüz hazır değil; kelime araması kullanılıyor.';
    } catch {
      retrievalNotice =
        'Anlamsal aramaya şu anda ulaşılamıyor; kelime araması kullanılıyor.';
    }
  }
  shortlist = shortlistEvents(
    events,
    input.message,
    input.history,
    16,
    semantic,
  );
  const fallback = fallbackEvents(
    events,
    input.message,
    input.history,
    5,
    semantic,
  ).map((event) => ({ event }));
  if (deps.config) {
    try {
      const result = await (deps.rank ?? rankWithJev)(
        deps.config,
        { ...input, filters, history: context.history },
        shortlist,
      );
      const recommendations = selectJevEvents(shortlist, result).map(
        (event) => ({
          event,
        }),
      );
      return {
        recommendations,
        filters,
        mode: 'jev',
        status: recommendations.length ? 'results' : 'empty',
        notice: recommendations.length
          ? retrievalNotice
          : 'İsteğine yeterince uyan bir etkinlik bulunamadı. İsteğini değiştirebilirsin.',
        totalCandidates,
      };
    } catch {
      return {
        recommendations: fallback,
        filters,
        mode: 'filters',
        status: fallback.length ? 'results' : 'empty',
        notice: [
          retrievalNotice,
          'Akıllı sıralamaya şu anda ulaşılamıyor. Temel arama sonuçları gösteriliyor.',
        ]
          .filter(Boolean)
          .join(' '),
        totalCandidates,
      };
    }
  }
  return {
    recommendations: fallback,
    filters,
    mode: 'filters',
    status: fallback.length ? 'results' : 'empty',
    notice:
      retrievalNotice ??
      (semantic
        ? 'Sonuçlar anlamsal benzerlik ve kelime eşleşmesine göre listeleniyor.'
        : basicNotice),
    totalCandidates,
  };
}
