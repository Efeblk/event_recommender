import {
  emptyFilters,
  type EventRecord,
  type Filters,
  type Message,
  type PendingInput,
  type SearchDiagnostics,
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
import {
  diverseEvents,
  fallbackEvents,
  searchContext,
  shortlistEvents,
} from './retrieval.ts';
import { embedWithVoyage, type VoyageConfig } from './voyage.ts';
import { semanticQuery, type SemanticRanking } from './hybrid.ts';
import { checkRequirements, deriveRequirements } from './requirements.ts';
import {
  emptyIntentState,
  validateIntentState,
  type IntentState,
} from './input-state.ts';
import { interpretInput } from './input-interpreter.ts';
import { recommendationQuery, retrievalQuery } from './input-retrieval.ts';
import {
  emptyPlanState,
  MAX_PLAN_REQUESTS,
  validatePlanState,
  type PlanState,
} from './plan-state.ts';
import { evaluatePlan, validateSearchPlan } from './plan-evidence.ts';
import { planRetrievalQuery } from './plan-query.ts';
import { interpretSpanInput } from './span-interpreter.ts';
import { isStandaloneInputReset } from './input-reset.ts';
import { isAlternativesRequest } from './intent.ts';
import type { Plan } from '../parser/contract.ts';

export interface RecommendInput {
  message: string;
  history: Message[];
  filters: Filters;
  excludeIds: string[];
  intentVersion?: 1 | 2;
  planState?: PlanState;
  intentState?: IntentState;
  alternativeIds?: string[];
  pendingInput?: PendingInput;
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
  const alternativeIds = x.alternativeIds ?? [];
  if (
    !Array.isArray(alternativeIds) ||
    alternativeIds.length > 100 ||
    alternativeIds.some((id) => typeof id !== 'string' || id.length > 100)
  )
    throw new Error('Etkinlik seçimi geçersiz.');
  if (
    x.intentVersion !== undefined &&
    x.intentVersion !== 1 &&
    x.intentVersion !== 2
  )
    throw new Error('Arama sürümü geçersiz.');
  if (x.intentState !== undefined && x.intentVersion !== 1)
    throw new Error('Arama sürümü geçersiz.');
  if (x.planState !== undefined && x.intentVersion !== 2)
    throw new Error('Plan version is invalid.');
  let pendingInput: PendingInput | undefined;
  if (x.pendingInput !== undefined) {
    const pending = x.pendingInput as Record<string, unknown>;
    if (
      (x.intentVersion !== 1 && x.intentVersion !== 2) ||
      !pending ||
      typeof pending !== 'object' ||
      Array.isArray(pending) ||
      Object.keys(pending).some(
        (key) => !['message', 'reason'].includes(key),
      ) ||
      typeof pending.message !== 'string' ||
      !pending.message.trim() ||
      pending.message.length > 1200 ||
      ![
        'budget_ambiguous',
        'date_ambiguous',
        'constraint_ambiguous',
        'unsupported_location',
        'unsupported_constraint',
        'interpreter_unavailable',
      ].includes(pending.reason as string)
    )
      throw new Error('Bekleyen arama geçersiz.');
    pendingInput = {
      message: pending.message.trim(),
      reason: pending.reason as PendingInput['reason'],
    };
  }
  return {
    message: x.message.trim(),
    // Old clients may send assistant messages. Only user requests are context.
    history: history.filter((m) => m.role === 'user').slice(-6),
    filters: validateFilters(x.filters ?? emptyFilters),
    excludeIds: exclude,
    ...(pendingInput ? { pendingInput } : {}),
    ...(x.intentVersion === 1 || x.intentVersion === 2
      ? { intentVersion: x.intentVersion, alternativeIds }
      : {}),
    ...(x.planState !== undefined
      ? { planState: validatePlanState(x.planState) }
      : {}),
    ...(x.intentState !== undefined
      ? { intentState: validateIntentState(x.intentState) }
      : {}),
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
  inputInterpreter?: 'rules' | 'jev-v1' | 'span-v2';
  spanInterpret?: typeof interpretSpanInput;
  interpret?: typeof interpretInput;
}

// Initial product policy, not an empirically calibrated quality claim.
// Level 2 requires source support; a valid no-match remains empty.
export const MIN_JEV_SUPPORT_PROBABILITY = 0.7;

// Shared with the evaluation harness so it measures exactly what users see.
// Only canonical candidates may become cards, even if a ranker supplies others.
export function selectJevEvents(
  candidates: EventRecord[],
  ranking: JevRanking,
  order?: IntentState['preferences']['order'],
): EventRecord[] {
  const byId = new Map(candidates.map((event) => [event.id, event]));
  const supported = ranking.ranked
    .filter(({ event, score, probabilities, supportProbability }) => {
      if (
        !byId.has(event.id) ||
        !Number.isFinite(score) ||
        score < 0 ||
        score > 3 ||
        !Array.isArray(probabilities) ||
        probabilities.length !== 4 ||
        !probabilities.every(
          (value) =>
            typeof value === 'number' &&
            Number.isFinite(value) &&
            value >= 0 &&
            value <= 1,
        ) ||
        Math.abs(probabilities.reduce((sum, value) => sum + value, 0) - 1) >
          0.02
      )
        return false;
      const derivedSupport = probabilities[2] + probabilities[3];
      return (
        Number.isFinite(supportProbability) &&
        supportProbability >= MIN_JEV_SUPPORT_PROBABILITY &&
        supportProbability <= 1 &&
        Math.abs(supportProbability - derivedSupport) <= 1e-9
      );
    })
    .sort((a, b) => b.score - a.score)
    .map(({ event }) => byId.get(event.id)!);
  const selected = diverseEvents(
    uniqueEvents(supported, supported.length),
    supported.length,
  );
  return order === 'soonest'
    ? selected.sort(
        (a, b) =>
          a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id),
      )
    : selected;
}

const basicNotice =
  'Sonuçlar tarih, bütçe, kategori ve kelime eşleşmesine göre listeleniyor.';
const issueNotices = {
  budget_ambiguous:
    'Bu bütçe kişi başı mı, toplam mı? Örneğin: kişi başı 800 TL veya iki kişi toplam 800 TL.',
  date_ambiguous:
    'Tarihi daha açık belirt. Örneğin: yarın, bu hafta sonu veya YYYY-AA-GG biçiminde bir tarih.',
  constraint_ambiguous:
    'Koşulları ayrı ve açık biçimde belirt. Örneğin: cumartesi, kişi başı 800 TL, konser hariç.',
  unsupported_location:
    'Şu an yalnızca İstanbul etkinlikleri var. İstanbul için bir arama yapabilirsin.',
  unsupported_constraint:
    'Bu zorunlu koşulu mevcut etkinlik bilgileriyle güvenilir biçimde değerlendiremiyoruz. Koşulu değiştirerek yeniden arayabilirsin.',
  interpreter_unavailable:
    'Arama hizmeti isteğini şu anda işleyemiyor. İsteğin ve önceki koşulların korunuyor; biraz sonra yeniden deneyebilirsin.',
};

export async function recommend(
  input: RecommendInput,
  deps: Dependencies,
): Promise<SearchResult> {
  if (
    input.intentVersion === 2 ||
    input.planState ||
    deps.inputInterpreter === 'span-v2'
  )
    return recommendSpan(input, deps);
  // A configuration rollback must not turn persisted evidence requirements
  // into best-effort reconstruction from a truncated conversation history.
  if (
    deps.inputInterpreter !== 'jev-v1' &&
    (input.intentState || input.pendingInput)
  )
    return {
      recommendations: [],
      filters: input.intentState?.filters ?? input.filters,
      intentState: input.intentState,
      mode: 'filters',
      status: 'needs_input',
      totalCandidates: 0,
      resetRequired: true,
      notice:
        'Arama anlayışı güncellendi. “Yeni arama” ile koşullarını bir kez yeniden yazabilirsin.',
    };
  if (deps.inputInterpreter !== 'jev-v1' || input.intentVersion !== 1)
    return recommendResolved(input, deps);
  // A rules-era conversation cannot silently lose its unrecorded requirements.
  if (!input.intentState && input.history.length)
    return {
      recommendations: [],
      filters: input.filters,
      mode: 'filters',
      status: 'needs_input',
      totalCandidates: 0,
      notice:
        'Arama anlayışı güncellendi. “Yeni arama” ile koşullarını bir kez yeniden yazabilirsin.',
      resetRequired: true,
    };
  const pendingMessage = input.pendingInput
    ? `${input.pendingInput.message}\n${input.message}`
    : input.message;
  // Never truncate unresolved constraints to fit the interpretation window.
  if (pendingMessage.length > 1200)
    return {
      recommendations: [],
      filters: input.intentState?.filters ?? input.filters,
      intentState: input.intentState ?? emptyIntentState(input.filters),
      pendingInput: input.pendingInput,
      mode: 'filters',
      status: 'needs_input',
      totalCandidates: 0,
      notice:
        'Arama çok uzadı. “Yeni arama” ile koşullarını tek mesajda yeniden yazabilirsin.',
      resetRequired: true,
    };
  const interpreted = await (deps.interpret ?? interpretInput)(
    {
      message: input.message,
      previous: input.intentState ?? emptyIntentState(input.filters),
      now: deps.now ?? new Date(),
      ...(input.pendingInput
        ? { unresolvedRequest: input.pendingInput.message }
        : {}),
    },
    { config: deps.config },
  );
  const intentState = validateIntentState(interpreted.state);
  if (interpreted.issue)
    return {
      recommendations: [],
      filters: intentState.filters,
      intentState,
      mode: 'filters',
      status:
        interpreted.issue === 'unsupported_location'
          ? 'unsupported_location'
          : 'needs_input',
      totalCandidates: 0,
      pendingInput: {
        message:
          interpreted.action === 'reset' ? input.message : pendingMessage,
        reason: interpreted.issue,
      },
      notice: issueNotices[interpreted.issue],
      ...(interpreted.issue === 'budget_ambiguous'
        ? {
            clarification: [
              {
                label: 'Kişi başı',
                message: 'Bütçe kişi başı.',
              },
              { label: 'Toplam', message: 'Bütçe toplam.' },
            ],
          }
        : {}),
    };
  const excludeIds =
    interpreted.action === 'alternatives'
      ? [
          ...new Set([...input.excludeIds, ...(input.alternativeIds ?? [])]),
        ].slice(-100)
      : [];
  const result = await recommendResolved(
    {
      ...input,
      message: retrievalQuery(intentState),
      history: [],
      filters: intentState.filters,
      excludeIds,
    },
    deps,
    intentState,
  );
  return { ...result, intentState, excludedIds: excludeIds };
}

async function recommendResolved(
  input: RecommendInput,
  deps: Dependencies,
  intent?: IntentState,
  plan?: Plan,
  planRequests: string[] = [],
): Promise<SearchResult> {
  const now = deps.now ?? new Date();
  const { filters, issue } = plan
    ? { filters: emptyFilters, issue: null }
    : intent
      ? { filters: intent.filters, issue: null }
      : interpretConstraints(input.message, input.filters, now);
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
  const catalog = await deps.candidates(filters);
  let events = catalog.filter((event) => isEligible(event, filters, now));
  const excludedIds = new Set(input.excludeIds);
  const isExcluded = (event: EventRecord) =>
    excludedIds.has(event.id) ||
    (event.canonicalProductionKey &&
      excludedIds.has(event.canonicalProductionKey)) ||
    (event.canonicalShowKey && excludedIds.has(event.canonicalShowKey)) ||
    event.mergedIds?.some((id) => excludedIds.has(id));
  const excludedProductions = new Set(
    events.filter(isExcluded).map(productionIdentity),
  );
  const beforeAlternativeExclusions = events.length;
  events = events.filter(
    (event) =>
      !isExcluded(event) && !excludedProductions.has(productionIdentity(event)),
  );
  const context =
    intent || plan
      ? { history: [] }
      : searchContext(input.message, input.history);
  const requirements = plan
    ? []
    : (intent?.requirements ??
      deriveRequirements(input.message, context.history));
  const hardRequirements = requirements.map((requirement) => ({
    ...requirement,
    supported: 0,
    unknown: 0,
    contradicted: 0,
  }));
  const eventsWithChecks = events.map((event) => ({
    event,
    checks: checkRequirements(event, requirements),
    planCheck: plan ? evaluatePlan(event, plan, now) : undefined,
  }));
  for (const { checks } of eventsWithChecks)
    checks.forEach((check, index) => hardRequirements[index][check.status]++);
  const beforeEvidence = events.length;
  events = eventsWithChecks
    .filter(
      ({ checks, planCheck }) =>
        (!planCheck || planCheck.status === 'supported') &&
        checks.every((check) => check.status === 'supported'),
    )
    .map(({ event }) => event);
  const totalCandidates = events.length;
  const diagnostics: SearchDiagnostics = {
    catalogRetrieved: catalog.length,
    eligibleBeforeSourceEvidence: beforeEvidence,
    hardRequirements,
    eligibleAfterSourceEvidence: totalCandidates,
    alternativeExclusions: beforeAlternativeExclusions - beforeEvidence,
    distinctShortlist: 0,
    vectorCoverage: { available: 0, eligible: totalCandidates },
    returnedAboveSupportThreshold: null,
    ...(plan
      ? {
          planEvidence: {
            supported: eventsWithChecks.filter(
              (x) => x.planCheck?.status === 'supported',
            ).length,
            unknown: eventsWithChecks.filter(
              (x) => x.planCheck?.status === 'unknown',
            ).length,
            contradicted: eventsWithChecks.filter(
              (x) => x.planCheck?.status === 'contradicted',
            ).length,
          },
        }
      : {}),
  };
  if (!events.length)
    return {
      recommendations: [],
      filters,
      mode: 'filters',
      status: 'empty',
      notice:
        beforeEvidence && (requirements.length || plan)
          ? 'Zorunlu koşullarını etkinlik açıklamalarından doğrulayamadık. Bilgisi eksik seçenekleri göstermiyoruz.'
          : 'Bu koşullara uyan güncel bir etkinlik bulunamadı.',
      totalCandidates,
      diagnostics,
    };
  const resolved = plan
    ? {
        query: input.message,
        order: plan.order === 'nearest' ? ('none' as const) : plan.order,
      }
    : undefined;
  let shortlist = shortlistEvents(
    events,
    input.message,
    input.history,
    16,
    undefined,
    intent,
    resolved,
  );
  if (!shortlist.length)
    return {
      recommendations: [],
      filters,
      mode: 'filters',
      status: 'empty',
      notice:
        'Belirttiğin tercih ve hariç tutmalara uyan bir etkinlik bulunamadı.',
      totalCandidates,
      diagnostics,
    };
  let semantic: SemanticRanking | undefined;
  let retrievalNotice: string | null = null;
  if (deps.embeddingConfig) {
    try {
      const vectors = await deps.vectors?.(events, deps.embeddingConfig);
      if (vectors?.size) {
        diagnostics.vectorCoverage.available = events.filter((event) =>
          vectors.has(event.id),
        ).length;
        const [queryVector] = await (deps.embed ?? embedWithVoyage)(
          deps.embeddingConfig,
          [
            intent || plan
              ? input.message
              : semanticQuery(input.message, context.history),
          ],
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
    intent,
    resolved,
  );
  diagnostics.distinctShortlist = shortlist.length;
  const fallback = fallbackEvents(
    shortlist,
    input.message,
    input.history,
    shortlist.length,
    semantic,
    intent,
    resolved,
  ).map((event) => ({ event }));
  if (deps.config) {
    try {
      const result = await (deps.rank ?? rankWithJev)(
        deps.config,
        {
          ...input,
          ...(intent ? { message: recommendationQuery(intent) } : {}),
          ...(plan
            ? {
                // The user's own words carry names and nuance the plan cannot
                // type; the plan alone decides admission.
                message:
                  planRequests.at(-1) ??
                  'Etkinlikleri doğrulanmış plan ve tercihlere göre değerlendir.',
                history: planRequests
                  .slice(0, -1)
                  .map((content) => ({ role: 'user' as const, content })),
                plan,
                planEvidence: Object.fromEntries(
                  shortlist.map((event) => [
                    event.id,
                    evaluatePlan(event, plan, now).evidence,
                  ]),
                ),
              }
            : {}),
          filters,
          ...(plan ? {} : { history: context.history }),
          requirements,
          ...(intent ? { preferences: intent.preferences } : {}),
        },
        shortlist,
      );
      const selected = selectJevEvents(
        shortlist,
        result,
        intent?.preferences.order,
      );
      if (plan?.order === 'soonest')
        selected.sort(
          (a, b) =>
            a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id),
        );
      if (plan?.order === 'cheapest')
        selected.sort(
          (a, b) =>
            (a.price ?? Infinity) - (b.price ?? Infinity) ||
            a.startsAt.localeCompare(b.startsAt),
        );
      const recommendations = selected.map((event) => ({ event }));
      return {
        recommendations,
        filters,
        mode: 'jev',
        status: recommendations.length ? 'results' : 'empty',
        notice: recommendations.length
          ? retrievalNotice
          : 'İsteğine yeterince uyan bir etkinlik bulunamadı. İsteğini değiştirebilirsin.',
        totalCandidates,
        diagnostics: {
          ...diagnostics,
          returnedAboveSupportThreshold: recommendations.length,
        },
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
        diagnostics,
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
    diagnostics,
  };
}

/** Exact v2 tree state is authoritative; legacy text/history never reconstructs it. */
async function recommendSpan(
  input: RecommendInput,
  deps: Dependencies,
): Promise<SearchResult> {
  const previous = input.planState ?? emptyPlanState();
  const base = {
    recommendations: [],
    filters: { ...emptyFilters },
    mode: 'filters' as const,
    totalCandidates: 0,
    planState: previous,
  };
  if (
    input.intentVersion !== 2 ||
    deps.inputInterpreter !== 'span-v2' ||
    input.intentState ||
    (!input.planState &&
      (input.history.length ||
        Object.entries(input.filters).some(
          ([, value]) =>
            value != null &&
            value !== false &&
            (!Array.isArray(value) || value.length > 0),
        )))
  )
    return {
      ...base,
      status: 'needs_input',
      resetRequired: true,
      notice:
        'Arama anlayışı güncellendi. Yeni arama ile koşullarını yeniden yazabilirsin.',
    };
  if (isStandaloneInputReset(input.message))
    return {
      ...base,
      planState: { ...emptyPlanState(), revision: previous.revision + 1 },
      status: 'empty',
      excludedIds: [],
      notice: 'Önceki koşullar temizlendi. Yeni planını yazabilirsin.',
    };
  const message = input.pendingInput
    ? `${input.pendingInput.message}\n${input.message}`
    : input.message;
  if (message.length > 1200)
    return {
      ...base,
      status: 'needs_input',
      resetRequired: true,
      pendingInput: input.pendingInput,
      notice:
        'Arama çok uzadı. Yeni arama ile koşullarını tek mesajda yazabilirsin.',
    };
  try {
    validateSearchPlan(previous.plan);
  } catch {
    return {
      ...base,
      status: 'needs_input',
      resetRequired: true,
      notice: issueNotices.unsupported_constraint,
    };
  }
  let interpreted;
  try {
    interpreted = await (deps.spanInterpret ?? interpretSpanInput)(
      {
        utterance: message,
        language: 'tr',
        referenceDate: new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Istanbul',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(deps.now ?? new Date()),
        timezone: 'Europe/Istanbul',
        previousState: input.planState
          ? { revision: previous.revision, plan: previous.plan, evidence: [] }
          : null,
      },
      { config: deps.config },
    );
  } catch {
    return {
      ...base,
      status: 'needs_input',
      pendingInput: { message, reason: 'interpreter_unavailable' },
      notice: issueNotices.interpreter_unavailable,
    };
  }
  if (interpreted.status !== 'accepted') {
    const unavailable =
      interpreted.status === 'unsupported' &&
      interpreted.reason === 'invalid or incomplete provider judgments';
    const reason = unavailable
      ? ('interpreter_unavailable' as const)
      : interpreted.status === 'ambiguous'
        ? ('constraint_ambiguous' as const)
        : ('unsupported_constraint' as const);
    return {
      ...base,
      status: 'needs_input',
      pendingInput: { message, reason },
      notice: issueNotices[reason],
    };
  }
  let state: PlanState;
  try {
    const reset = interpreted.operations.some(
      (operation) => operation.op === 'reset',
    );
    const requests = reset
      ? [message]
      : isAlternativesRequest(input.message)
        ? previous.requests
        : [...previous.requests, message];
    state = validatePlanState({
      version: 2,
      revision: previous.revision + 1,
      plan: interpreted.resultingPlan,
      requests: requests.slice(-MAX_PLAN_REQUESTS),
    });
    validateSearchPlan(state.plan);
  } catch {
    return {
      ...base,
      status: 'needs_input',
      pendingInput: { message, reason: 'unsupported_constraint' },
      notice: issueNotices.unsupported_constraint,
    };
  }
  const excludeIds =
    !interpreted.operations.some((operation) => operation.op === 'reset') &&
    isAlternativesRequest(input.message)
      ? [
          ...new Set([...input.excludeIds, ...(input.alternativeIds ?? [])]),
        ].slice(-100)
      : [];
  // Newest words first so truncation drops the oldest context.
  const query =
    [planRetrievalQuery(state.plan), ...[...state.requests].reverse()]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1200) || 'İstanbul etkinlikleri';
  const result = await recommendResolved(
    {
      ...input,
      message: query,
      history: [],
      filters: { ...emptyFilters },
      excludeIds,
    },
    deps,
    undefined,
    state.plan,
    state.requests,
  );
  return { ...result, planState: state, excludedIds: excludeIds };
}
