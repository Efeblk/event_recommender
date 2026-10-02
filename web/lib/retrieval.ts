import type { EventRecord, Message } from './types.ts';
import {
  normalize,
  productionIdentity,
  rankEvents,
  uniqueEvents,
} from './search.ts';
import {
  categoryIntent,
  isAlternativesRequest,
  isFullPreferenceReset,
} from './intent.ts';
import type { Category } from './types.ts';
import { hybridRank, lexicalRank, type SemanticRanking } from './hybrid.ts';
import { displayShowIdentity } from './event-merge.ts';
import type { IntentState } from './input-state.ts';
import { primaryTopicRetrievalQuery, retrievalQuery } from './input-retrieval.ts';

export interface SearchContext {
  query: string;
  history: Message[];
  rejectedTerms: string[];
  reset: boolean;
  category: Category | null;
}

export { isAlternativesRequest };

/**
 * Removes repeated cards for a clearly identical show title across venues or
 * sessions. This is presentation-only: session and provider records stay
 * separate, and generic titles retain their normal production identity.
 */
export function diverseEvents(events: EventRecord[], limit = 5): EventRecord[] {
  const seen = new Set<string>();
  return events
    .filter((event) => {
      const key =
        event.canonicalShowKey ??
        displayShowIdentity(event) ??
        productionIdentity(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(0, limit));
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function positiveCategories(message: string) {
  return categoryIntent(message).requestedCategories;
}

function isPreferenceReset(message: string) {
  const q = normalize(message);
  return (
    isFullPreferenceReset(message) ||
    /\b(?:her (?:tur|kategori)|kategori(?:yi)? (?:kaldir|fark etmez|onemli degil)|bastan basla|tercihleri kaldir)\b/.test(
      q,
    )
  );
}

export function searchContext(
  message: string,
  history: Message[],
): SearchContext {
  const allRecent = history.filter(({ role }) => role === 'user').slice(-6);
  const latestReset = allRecent.findLastIndex(({ content }) =>
    isPreferenceReset(content),
  );
  const recent =
    latestReset >= 0
      ? allRecent.slice(
          latestReset +
            (isFullPreferenceReset(allRecent[latestReset].content) ? 0 : 1),
        )
      : allRecent;
  let latestCategorySwitch = -1;
  let previousCategories: Category[] = [];
  for (const [index, turn] of recent.entries()) {
    const categories = positiveCategories(turn.content);
    if (!categories.length) continue;
    if (
      previousCategories.length &&
      categories.every((category) => !previousCategories.includes(category))
    )
      latestCategorySwitch = index;
    previousCategories = categories;
  }
  const persistentRecent =
    latestCategorySwitch >= 0 ? recent.slice(latestCategorySwitch) : recent;
  const reset = isPreferenceReset(message);
  const currentCategories = positiveCategories(message);
  const latestCategories =
    persistentRecent
      .toReversed()
      .map(({ content }) => positiveCategories(content))
      .find((categories) => categories.length > 0) ?? [];
  const categorySwitch =
    currentCategories.length > 0 &&
    latestCategories.length > 0 &&
    currentCategories.every((category) => !latestCategories.includes(category));
  const relevantHistory = reset || categorySwitch ? [] : persistentRecent;

  const rejected = new Set<string>();
  for (const turn of [
    ...relevantHistory.map(({ content }) => content),
    message,
  ]) {
    const intent = categoryIntent(turn);
    for (const term of intent.rejectedTerms) rejected.add(term);
    const currentRejected = new Set(intent.rejectedTerms);
    const positiveText = normalize(intent.positiveText);
    for (const term of rejected) {
      if (
        rejectedTermCategory(term) &&
        intent.requestedCategories.includes(rejectedTermCategory(term)!)
      ) {
        rejected.delete(term);
        continue;
      }
      if (
        !currentRejected.has(term) &&
        new RegExp(`\\b${escapeRegExp(term)}\\b`).test(positiveText)
      )
        rejected.delete(term);
    }
  }

  const query = [
    message,
    message,
    message,
    ...relevantHistory.map((m) => m.content),
  ].join('\n');
  return {
    query,
    history: relevantHistory,
    rejectedTerms: [...rejected],
    reset: reset || categorySwitch,
    category: inheritedCategory(
      currentCategories,
      latestCategories,
      rejected,
      reset,
    ),
  };
}

function inheritedCategory(
  current: Category[],
  latest: Category[],
  rejected: Set<string>,
  reset: boolean,
): Category | null {
  const candidate =
    current.length === 1
      ? current[0]
      : current.length === 0 && !reset && latest.length === 1
        ? latest[0]
        : null;
  if (!candidate) return null;
  return [...rejected].some((term) => rejectedTermCategory(term) === candidate)
    ? null
    : candidate;
}

const rejectedCategoryCache = new Map<string, Category | null>();
function rejectedTermCategory(term: string): Category | null {
  if (rejectedCategoryCache.has(term)) return rejectedCategoryCache.get(term)!;
  const categories = categoryIntent(`${term} istemiyorum`).excludedCategories;
  const category = categories.length === 1 ? categories[0] : null;
  rejectedCategoryCache.set(term, category);
  return category;
}

function eventText(event: EventRecord) {
  return normalize(
    `${event.title} ${event.description} ${event.category} ${event.venue}`,
  );
}

function requestsCalmOptionalMood(message: string, history: Message[]) {
  const turns = [
    message,
    ...history
      .filter(({ role }) => role === 'user')
      .toReversed()
      .map(({ content }) => content),
  ];
  for (const turn of turns) {
    const text = normalize(turn);
    if (
      /\b(?:sakin(?:les(?:mek|ebilecegim|ebilecegimiz))?|huzurlu|dinlendirici|calm|relaxed|relaxing|quiet)\b[^.!?]{0,24}\b(?:istemiyorum|istemem|olmasin|degil|is not|isn't)\b/.test(
        text,
      ) ||
      /\b(?:not|no|don't want|do not want)\s+(?:a\s+)?(?:calm|relaxed|relaxing|quiet)\b/.test(
        text,
      )
    )
      return false;
    if (
      /\b(?:sakin(?:les(?:mek|ebilecegim|ebilecegimiz))?|huzurlu|dinlendirici|yoruldum|yorgunum|rahat(?:\s+bir)?\s+aksam|calm|relaxed|relaxing|tired|exhausted)\b/.test(
        text,
      )
    )
      return true;
  }
  return false;
}

/**
 * These are sourced program/format signals, not claims that an event is quiet.
 * They reserve a little shortlist coverage so Jev can judge a calm optional
 * mood against the actual description instead of seeing only generic nightlife.
 */
function calmFormatTags(event: EventRecord) {
  const title = normalize(event.title);
  const description = normalize(event.description);
  const text = `${title} ${description}`;
  const tags: string[] = [];
  const highEnergy =
    /\b(?:yuksek sesli|enerjik\s+(?:rock|metal)|hard rock|heavy metal)\b/.test(
      text,
    );
  if (
    /\bakustik\b/.test(text) &&
    !/\bakustik\b[^.!?]{0,20}\b(?:degil|olmayan|yok)\b/.test(text)
  )
    tags.push('acoustic');
  const stringProgram =
    /\b(?:viyolonsel|cello|yayli|keman|oda muzigi)\b[^.!?]{0,64}\b(?:konser|program|performans|resital|eser|muzik)\b/.test(
      text,
    ) ||
    /\b(?:konser|program|performans|resital|eser|muzik)\b[^.!?]{0,64}\b(?:viyolonsel|cello|yayli|keman|oda muzigi)\b/.test(
      text,
    ) ||
    /\b(?:viyolonsel|cello|yayli|keman|oda muzigi)\b/.test(title);
  if (stringProgram && !highEnergy) tags.push('chamber-strings');
  if (!highEnergy && /\b(?:piyano resitali|klasik muzik|resital)\b/.test(text))
    tags.push('recital-classical');
  if (/\b(?:candle|mum isigi|mum isiginda)\b/.test(text))
    tags.push('candle-format');
  return tags;
}

function calmMoodShortlistCoverage(
  ranked: EventRecord[],
  message: string,
  history: Message[],
  limit: number,
  intent?: IntentState,
) {
  const calm = intent
    ? intent.preferences.mood === 'calm'
    : requestsCalmOptionalMood(message, history);
  if (!calm || limit < 2) return null;
  const requestedChildEvent = intent
    ? intent.requirements.some(
        (requirement) =>
          requirement.kind === 'audience' &&
          requirement.policy === 'require_support' &&
          requirement.value
            .split('|')
            .some(
              (value) =>
                value === 'children' ||
                value === 'family_friendly' ||
                value.startsWith('age:'),
            ),
      )
    : /\bcocuk(?:lar|lara|larin)?\b/.test(normalize(message));
  const seenTags = new Set<string>();
  const supplements: EventRecord[] = [];
  for (const event of ranked) {
    if (!requestedChildEvent && hasChildAudienceEvidence(event)) continue;
    const tag = calmFormatTags(event).find((item) => !seenTags.has(item));
    if (!tag) continue;
    seenTags.add(tag);
    supplements.push(event);
    if (supplements.length === Math.min(4, limit)) break;
  }
  if (!supplements.length) return null;
  const supplementalIds = new Set(supplements.map(({ id }) => id));
  const selected = ranked
    .filter(({ id }) => !supplementalIds.has(id))
    .slice(0, limit - supplements.length);
  selected.push(...supplements);
  const selectedIds = new Set(selected.map(({ id }) => id));
  for (const event of ranked) {
    if (selected.length === limit) break;
    if (!selectedIds.has(event.id)) {
      selected.push(event);
      selectedIds.add(event.id);
    }
  }
  // Coverage may change membership, never the underlying hybrid order.
  return ranked.filter(({ id }) => selectedIds.has(id)).slice(0, limit);
}

function eligibleForContext(event: EventRecord, context: SearchContext) {
  if (context.category && event.category !== context.category) return false;
  if (!context.rejectedTerms.length) return true;
  const text = eventText(event);
  return !context.rejectedTerms.some((term) => {
    if (term === 'cocuk') return hasChildAudienceEvidence(event);
    if (term === 'konser' || term === 'muzik')
      return event.category === 'Konser';
    if (term === 'tiyatro') return event.category === 'Tiyatro';
    if (term === 'stand-up' || term === 'stand up')
      return event.category === 'Stand-up';
    const matches = [
      ...text.matchAll(new RegExp(`\\b${escapeRegExp(term)}\\b`, 'g')),
    ];
    return matches.some((match) => {
      const after = text.slice(
        (match.index ?? 0) + match[0].length,
        (match.index ?? 0) + match[0].length + 24,
      );
      return !/^\s+(?:degil(?:dir)?|icermez|yok)\b/.test(after);
    });
  });
}

function hasChildAudienceEvidence(event: EventRecord) {
  const withoutNegatedChildClaims = [event.title, event.description]
    .map((value) =>
      normalize(value).replace(
        /\b(?:cocuk(?:lar|lara|larin)?|children|kids?)\b[^.!?\n]{0,36}\b(?:degil(?:dir)?|degildir|icermez|yok|not|isn't|is not)\b/g,
        ' ',
      ),
    )
    .join(' ');
  return (
    /\b(?:cocuk(?:lar|lara|larin)?\s+(?:icin|oyunu|tiyatrosu|muzikali|sirki|stand[ -]?up)|cocuklara\s+yonelik|(?:children|kids?)['’s]*\s+(?:show|theatre|theater|musical|circus|comedy)|(?:show|theatre|theater|musical|circus|comedy)\s+for\s+(?:children|kids?))\b/.test(
      withoutNegatedChildClaims,
    ) ||
    /\b\d{1,2}\s*[–-]\s*\d{1,2}\s*yas\b[^.!?\n]{0,40}\bcocuk(?:lar|lara|larin)?\b/.test(
      withoutNegatedChildClaims,
    ) ||
    /\bcocuk(?:lar|lara|larin)?\b[^.!?\n]{0,32}\b(?:aileleri|aileler)\b[^.!?\n]{0,16}\bicin\b/.test(
      withoutNegatedChildClaims,
    ) ||
    /\b(?:merhaba\s+cocuklar|(?:cocuklar|minik\s+(?:seyirciler|izleyiciler))[^.!?\n]{0,64}(?:davet|bekliyor|bulusuyor|katil))\b/.test(
      withoutNegatedChildClaims,
    )
  );
}

function requestsChildAudience(intent: IntentState) {
  return intent.requirements.some(
    (requirement) =>
      requirement.kind === 'audience' &&
      requirement.policy === 'require_support' &&
      requirement.value
        .split('|')
        .some(
          (value) =>
            value === 'children' ||
            value === 'family_friendly' ||
            value.startsWith('age:'),
        ),
  );
}

/**
 * A partner outing is a soft relevance signal. Keep every eligible event, but
 * place programs whose source description explicitly targets children after
 * the other ranked options unless the request itself asks for children.
 */
function demoteChildDirectedPartnerResults(
  ranked: EventRecord[],
  intent?: IntentState,
) {
  if (
    intent?.preferences.companion !== 'partner' ||
    requestsChildAudience(intent)
  )
    return ranked;
  const adultOrUnspecified: EventRecord[] = [];
  const childDirected: EventRecord[] = [];
  for (const event of ranked)
    (hasChildAudienceEvidence(event) ? childDirected : adultOrUnspecified).push(
      event,
    );
  return [...adultOrUnspecified, ...childDirected];
}

function rankedCandidates(
  events: EventRecord[],
  message: string,
  history: Message[],
  semantic?: SemanticRanking,
  intent?: IntentState,
) {
  const context: SearchContext = intent
    ? {
        query: retrievalQuery(intent),
        history: [],
        rejectedTerms: [],
        reset: false,
        category: null,
      }
    : searchContext(message, history);
  // Rank sessions before selecting a representative for each production.
  // The structured path has already applied validated filters and source
  // requirements. Do not infer constraints again from its query or old turns.
  const allowed = intent
    ? events
    : events.filter((event) => eligibleForContext(event, context));
  return {
    context,
    allowed,
    ranked: uniqueEvents(
      demoteChildDirectedPartnerResults(
        semantic
        ? hybridRank(allowed, context.query, semantic)
        : rankEvents(allowed, context.query),
        intent,
      ),
      allowed.length,
    ),
  };
}

function soonestProductionRepresentatives(
  events: EventRecord[],
  intent?: IntentState,
) {
  return diverseEvents(
    uniqueEvents(
      demoteChildDirectedPartnerResults(
        [...events].sort(
          (a, b) =>
            a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id),
        ),
        intent,
      ),
      events.length,
    ),
    events.length,
  );
}

function interleaveSoonestCoverage(
  chronological: EventRecord[],
  relevant: EventRecord[],
  limit: number,
) {
  const selected: EventRecord[] = [];
  const seenProductions = new Set<string>();
  const seenShows = new Set<string>();
  const add = (event: EventRecord | undefined) => {
    if (!event) return;
    const production = productionIdentity(event);
    const show = displayShowIdentity(event) ?? production;
    if (seenProductions.has(production) || seenShows.has(show)) return;
    seenProductions.add(production);
    seenShows.add(show);
    selected.push(event);
  };
  let earliestIndex = 0, relevanceIndex = 0;
  while (
    selected.length < limit &&
    (earliestIndex < chronological.length || relevanceIndex < relevant.length)
  ) {
    add(chronological[earliestIndex++]);
    if (selected.length < limit) add(relevant[relevanceIndex++]);
  }
  return selected;
}

function mapRelevanceToEarliest(
  relevant: EventRecord[],
  chronological: EventRecord[],
) {
  const byProduction = new Map(
    chronological.map((event) => [productionIdentity(event), event]),
  );
  const byShow = new Map(
    chronological.flatMap((event) => {
      const show = displayShowIdentity(event);
      return show ? [[show, event] as const] : [];
    }),
  );
  return relevant.map((event) => {
    const show = displayShowIdentity(event);
    return (
      byProduction.get(productionIdentity(event)) ??
      (show ? byShow.get(show) : undefined) ??
      event
    );
  });
}

export function shortlistEvents(
  events: EventRecord[],
  message: string,
  history: Message[],
  limit = 16,
  semantic?: SemanticRanking,
  intent?: IntentState,
): EventRecord[] {
  if (limit <= 0) return [];
  const { context, allowed, ranked } = rankedCandidates(
    events,
    message,
    history,
    semantic,
    intent,
  );
  const diverseRanked = diverseEvents(ranked, ranked.length);
  const relevanceCovered = semantic
    ? (
      calmMoodShortlistCoverage(
        diverseRanked,
        message,
        context.history,
        limit,
        intent,
      ) ?? diverseRanked.slice(0, limit)
    )
    : diverseRanked;
  // Dense+lexical RRF otherwise gives two-list candidates an inherent edge
  // over exact topic matches whose vectors are absent. Reserve a bounded,
  // production-distinct lexical lane so the final Jev judge can evaluate them.
  if (semantic && intent?.primaryTopics?.length) {
    const topicQuery = primaryTopicRetrievalQuery(intent);
    // Reserve half of the judge budget for direct topic recall and retain the
    // other half for semantic paraphrases. The final judge still establishes
    // source support; a lexical match alone is never treated as proof.
    const topicCandidates = diverseEvents(
      lexicalRank(allowed, topicQuery),
      Math.ceil(limit / 2),
    );
    const reserved = diverseEvents(
      [...topicCandidates, ...relevanceCovered],
      limit,
    );
    relevanceCovered.splice(0, relevanceCovered.length, ...reserved);
  }
  if (intent?.preferences.order === 'soonest')
    {
      const chronological = soonestProductionRepresentatives(allowed, intent);
      return interleaveSoonestCoverage(
        chronological,
        mapRelevanceToEarliest(relevanceCovered, chronological),
        limit,
      );
    }
  if (semantic) return relevanceCovered;
  const selected: EventRecord[] = [];
  const seenProductions = new Set<string>();
  const seenCategories = new Set<string>();
  for (const event of diverseRanked) {
    if (seenCategories.has(event.category)) continue;
    selected.push(event);
    seenCategories.add(event.category);
    seenProductions.add(productionIdentity(event));
    if (selected.length === limit) return selected;
  }
  for (const event of diverseRanked) {
    const key = productionIdentity(event);
    if (seenProductions.has(key)) continue;
    selected.push(event);
    seenProductions.add(key);
    if (selected.length === limit) break;
  }
  return selected;
}

export function fallbackEvents(
  events: EventRecord[],
  message: string,
  history: Message[],
  limit = 5,
  semantic?: SemanticRanking,
  intent?: IntentState,
): EventRecord[] {
  if (limit <= 0) return [];
  const candidates = rankedCandidates(events, message, history, semantic, intent);
  return intent?.preferences.order === 'soonest'
    ? soonestProductionRepresentatives(candidates.allowed, intent).slice(0, limit)
    : diverseEvents(candidates.ranked, limit);
}
