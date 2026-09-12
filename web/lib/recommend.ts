import {
  emptyFilters,
  type EventRecord,
  type Filters,
  type Message,
  type SearchResult,
} from './types.ts';
import {
  normalize,
  productionIdentity,
  isEligible,
  parseFilters,
  rankEvents,
  sourceReason,
  uniqueEvents,
  validateFilters,
} from './search.ts';
import { choose, embed, understand, type AIConfig } from './ai.ts';
import type { EmbeddingConfig } from './providers.ts';
export interface RecommendInput {
  message: string;
  history: Message[];
  filters: Filters;
  excludeIds: string[];
}
export function validateInput(value: unknown): RecommendInput {
  if (!value || typeof value !== 'object') throw new Error('İstek geçersiz.');
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
    throw new Error('Sohbet geçmişi geçersiz.');
  const exclude = x.excludeIds ?? [];
  if (
    !Array.isArray(exclude) ||
    exclude.length > 100 ||
    exclude.some((id) => typeof id !== 'string' || id.length > 100)
  )
    throw new Error('Etkinlik seçimi geçersiz.');
  return {
    message: x.message.trim(),
    history,
    filters: validateFilters(x.filters ?? emptyFilters),
    excludeIds: exclude,
  };
}
export interface Dependencies {
  candidates: (f: Filters) => Promise<EventRecord[]>;
  vectors: (
    e: EventRecord[],
    config: EmbeddingConfig,
  ) => Promise<Map<string, number[]>>;
  config: AIConfig | null;
  embeddings?: () => EmbeddingConfig | null;
  now?: Date;
  ai?: {
    understand: typeof understand;
    embed: typeof embed;
    choose: typeof choose;
  };
}
export async function recommend(
  input: RecommendInput,
  deps: Dependencies,
): Promise<SearchResult> {
  const now = deps.now ?? new Date(),
    ai = deps.ai ?? { understand, embed, choose };
  let filters = parseFilters(input.message, input.filters, now),
    query = input.message,
    mode: SearchResult['mode'] = 'filters';
  let notice = deps.config
    ? null
    : 'Anahtarsız önizleme: tarih, bütçe, kategori ve kelime eşleşmesiyle arama yapılır. Serbest sohbet ve anlamsal AI araması henüz açık değil.';
  if (deps.config) {
    try {
      const intent = await ai.understand(
        deps.config,
        input.message,
        input.history,
        input.filters,
        now,
      );
      filters = validateFilters(intent);
      query = intent.query;
      mode = 'ai';
      if (intent.clarification)
        return {
          message: intent.clarification,
          recommendations: [],
          filters,
          mode,
          notice,
          totalCandidates: 0,
        };
    } catch {
      notice =
        'AI bağlantısına şu anda ulaşılamıyor. Filtreli arama sonuçları gösteriliyor.';
    }
  }
  if (
    mode === 'filters' &&
    /\b(ankara|izmir|antalya|bursa|eskisehir|adana)\b/.test(
      normalize(input.message),
    )
  )
    return {
      message:
        'Şu an yalnızca İstanbul etkinliklerini arayabiliyorum. İstanbul için bir plan yapalım mı?',
      recommendations: [],
      filters,
      mode,
      notice,
      totalCandidates: 0,
    };
  let events = (await deps.candidates(filters)).filter((e) =>
    isEligible(e, filters, now),
  );
  const excludedUrls = new Set(
    events
      .filter((e) => input.excludeIds.includes(e.id))
      .map(productionIdentity),
  );
  events = events.filter(
    (e) =>
      !input.excludeIds.includes(e.id) &&
      !excludedUrls.has(productionIdentity(e)),
  );
  const totalCandidates = events.length;
  if (!events.length)
    return {
      message:
        'Bu koşullarla doğrulanmış, güncel bir etkinlik bulamadım. Tarihi genişletebilir, bütçeyi değiştirebilir veya başka bir kategori seçebilirsin.',
      recommendations: [],
      filters,
      mode,
      notice,
      totalCandidates,
    };
  if (deps.config && mode === 'ai') {
    try {
      const embedding = deps.embeddings?.();
      const vectors = embedding
        ? await deps.vectors(events, embedding)
        : new Map<string, number[]>();
      if (embedding && vectors.size) {
        const [vector] = await ai.embed(embedding, [query]);
        events = rankEvents(events, query, vector, vectors);
        mode = 'semantic';
      } else events = rankEvents(events, query);
    } catch {
      events = rankEvents(events, query);
      notice =
        'Anlamsal arama şu anda kullanılamıyor; metin araması ve AI değerlendirmesi kullanıldı.';
    }
    const shortlist = uniqueEvents(events, 16);
    try {
      const chosen = await ai.choose(deps.config, query, filters, shortlist);
      const byId = new Map(shortlist.map((e) => [e.id, e]));
      const seen = new Set<string>();
      const recommendations = chosen.selections
        .filter(
          (s) => byId.has(s.id) && !seen.has(s.id) && Boolean(seen.add(s.id)),
        )
        .slice(0, 5)
        .map((s) => ({
          event: byId.get(s.id)!,
          reason: s.reason.slice(0, 500),
        }));
      return {
        message: chosen.message.slice(0, 1500),
        recommendations,
        filters,
        mode,
        notice,
        totalCandidates,
      };
    } catch {
      notice =
        'AI önerisi tamamlanamadı. Filtrelere uyan etkinlikler gösteriliyor.';
      mode = 'filters';
    }
  } else events = rankEvents(events, query);
  return {
    message:
      'Seçtiğin koşullara uyan seçenekler bunlar. İstersen tarih, bütçe veya kategoriyi değiştirerek aramayı daraltabilirsin.',
    recommendations: uniqueEvents(events).map((event) => ({
      event,
      reason: sourceReason(event, filters),
    })),
    filters,
    mode,
    notice,
    totalCandidates,
  };
}
