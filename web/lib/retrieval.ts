import type { EventRecord, Message } from './types.ts';
import {
  normalize,
  productionIdentity,
  rankEvents,
  uniqueEvents,
} from './search.ts';
import {
  isAlternativesRequest,
  isFullPreferenceReset,
  positiveCategoryText,
  requestedCategories,
} from './intent.ts';
import type { Category } from './types.ts';
import { hybridRank, type SemanticRanking } from './hybrid.ts';
import { displayShowIdentity } from './event-merge.ts';

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
      const key = displayShowIdentity(event) ?? productionIdentity(event);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.max(0, limit));
}

const rejectionTerms = [
  'elektronik muzik',
  'cocuk tiyatrosu',
  'cocuk oyunu',
  'sahne oyunu',
  'stand-up',
  'stand up',
  'akustik',
  'techno',
  'rock',
  'jazz',
  'caz',
  'comedy',
  'komedi',
  'konser',
  'tiyatro',
  'muzik',
] as const;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function explicitRejections(message: string) {
  let remaining = normalize(message);
  const rejected = new Set<string>();
  for (const term of rejectionTerms) {
    const escaped = escapeRegExp(term);
    const suffixPattern = new RegExp(
      `\\b${escaped}\\b\\s+(?:istemiyorum|istemem|olmasin|degil|haric|disinda|yerine)\\b`,
      'g',
    );
    const prefixPattern = new RegExp(
      `\\b(?:no|not|without|excluding?)\\s+(?:any\\s+)?${escaped}\\b`,
      'g',
    );
    if (suffixPattern.test(remaining) || prefixPattern.test(remaining)) {
      rejected.add(term.startsWith('cocuk ') ? 'cocuk' : term);
      remaining = remaining
        .replace(suffixPattern, ' ')
        .replace(prefixPattern, ' ');
    }
  }
  return rejected;
}

function positiveCategories(message: string) {
  return requestedCategories(normalize(message));
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
  for (const item of relevantHistory) {
    for (const term of explicitRejections(item.content)) rejected.add(term);
  }
  const currentRejected = explicitRejections(message);
  for (const term of currentRejected) rejected.add(term);
  const currentPositive = positiveCategoryText(normalize(message));
  const categoryRejections: Record<string, Category> = {
    konser: 'Konser',
    muzik: 'Konser',
    tiyatro: 'Tiyatro',
    'stand-up': 'Stand-up',
    'stand up': 'Stand-up',
  };
  for (const term of rejected) {
    if (currentRejected.has(term)) continue;
    if (
      categoryRejections[term] &&
      currentCategories.includes(categoryRejections[term])
    ) {
      rejected.delete(term);
      continue;
    }
    if (new RegExp(`\\b${escapeRegExp(term)}\\b`).test(currentPositive))
      rejected.delete(term);
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
  const blocked =
    candidate === 'Konser'
      ? ['konser', 'muzik']
      : candidate === 'Tiyatro'
        ? ['tiyatro', 'sahne oyunu']
        : ['stand-up', 'stand up', 'komedi'];
  return blocked.some((term) => rejected.has(term)) ? null : candidate;
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
      /\b(?:sakin|huzurlu|dinlendirici|calm|relaxed|relaxing|quiet)\b[^.!?]{0,24}\b(?:istemiyorum|istemem|olmasin|degil|is not|isn't)\b/.test(
        text,
      ) ||
      /\b(?:not|no|don't want|do not want)\s+(?:a\s+)?(?:calm|relaxed|relaxing|quiet)\b/.test(
        text,
      )
    )
      return false;
    if (
      /\b(?:sakin|huzurlu|dinlendirici|yoruldum|yorgunum|rahat(?:\s+bir)?\s+aksam|calm|relaxed|relaxing|tired|exhausted)\b/.test(
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
) {
  if (!requestsCalmOptionalMood(message, history) || limit < 2) return null;
  const requestedChildEvent = /\bcocuk(?:lar|lara|larin)?\b/.test(
    normalize(message),
  );
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
  const text = eventText(event);
  if (context.category && event.category !== context.category) return false;
  return !context.rejectedTerms.some((term) => {
    if (term === 'cocuk') return hasChildAudienceEvidence(event);
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
  const description = normalize(event.description);
  const withoutNegatedChildClaims = description.replace(
    /\bcocuk(?:lar|lara|larin)?\b[^.!?\n]{0,36}\b(?:degil(?:dir)?|degildir|icermez|yok)\b/g,
    ' ',
  );
  return (
    /\b(?:cocuk(?:lar|lara|larin)?\s+(?:icin|oyunu|tiyatrosu)|cocuklara\s+yonelik)\b/.test(
      withoutNegatedChildClaims,
    ) ||
    /\b\d{1,2}\s*[–-]\s*\d{1,2}\s*yas\b[^.!?\n]{0,40}\bcocuk(?:lar|lara|larin)?\b/.test(
      withoutNegatedChildClaims,
    ) ||
    /\bcocuk(?:lar|lara|larin)?\b[^.!?\n]{0,32}\b(?:aileleri|aileler)\b[^.!?\n]{0,16}\bicin\b/.test(
      withoutNegatedChildClaims,
    )
  );
}

function rankedCandidates(
  events: EventRecord[],
  message: string,
  history: Message[],
  semantic?: SemanticRanking,
) {
  const context = searchContext(message, history);
  // Rank sessions before selecting a representative for each production.
  const allowed = events.filter((event) => eligibleForContext(event, context));
  return {
    context,
    ranked: uniqueEvents(
      semantic
        ? hybridRank(allowed, context.query, semantic)
        : rankEvents(allowed, context.query),
      allowed.length,
    ),
  };
}

export function shortlistEvents(
  events: EventRecord[],
  message: string,
  history: Message[],
  limit = 16,
  semantic?: SemanticRanking,
): EventRecord[] {
  if (limit <= 0) return [];
  const { context, ranked } = rankedCandidates(
    events,
    message,
    history,
    semantic,
  );
  const diverseRanked = diverseEvents(ranked, ranked.length);
  if (semantic)
    return (
      calmMoodShortlistCoverage(
        diverseRanked,
        message,
        context.history,
        limit,
      ) ?? diverseRanked.slice(0, limit)
    );
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
): EventRecord[] {
  if (limit <= 0) return [];
  return diverseEvents(
    rankedCandidates(events, message, history, semantic).ranked,
    limit,
  );
}
