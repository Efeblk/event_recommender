import type { EventRecord, Message } from './types.ts';
import {
  normalize,
  productionIdentity,
  rankEvents,
  uniqueEvents,
} from './search.ts';
import {
  isAlternativesRequest,
  positiveCategoryText,
  requestedCategories,
} from './intent.ts';
import type { Category } from './types.ts';
import { hybridRank, type SemanticRanking } from './hybrid.ts';
import { canonicalShowTitle } from './event-merge.ts';

export interface SearchContext {
  query: string;
  history: Message[];
  rejectedTerms: string[];
  reset: boolean;
  category: Category | null;
}

export { isAlternativesRequest };

const genericShowTitles = new Set([
  'etkinlik',
  'konser',
  'tiyatro',
  'stand up',
  'komedi',
  'acik mikrofon',
  'open mic',
]);

/**
 * Removes repeated cards for a clearly identical show title across venues or
 * sessions. This is presentation-only: session and provider records stay
 * separate, and generic titles retain their normal production identity.
 */
export function diverseEvents(events: EventRecord[], limit = 5): EventRecord[] {
  const seen = new Set<string>();
  return events
    .filter((event) => {
      const title = canonicalShowTitle(event.title);
      const key =
        title && !genericShowTitles.has(title)
          ? `${normalize(event.city)}\u001f${event.category}\u001f${title}`
          : productionIdentity(event);
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
    const pattern = new RegExp(
      `\\b${escaped}\\b\\s+(?:istemiyorum|istemem|olmasin|degil|haric|disinda|yerine)\\b`,
      'g',
    );
    if (pattern.test(remaining)) {
      rejected.add(term.startsWith('cocuk ') ? 'cocuk' : term);
      remaining = remaining.replace(pattern, ' ');
    }
  }
  return rejected;
}

function positiveCategories(message: string) {
  return requestedCategories(normalize(message));
}

function isPreferenceReset(message: string) {
  const q = normalize(message);
  return /\b(?:her (?:tur|kategori)|kategori(?:yi)? (?:kaldir|fark etmez|onemli degil)|bastan basla|tercihleri kaldir)\b/.test(
    q,
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
    latestReset >= 0 ? allRecent.slice(latestReset + 1) : allRecent;
  const reset = isPreferenceReset(message);
  const currentCategories = positiveCategories(message);
  const latestCategories =
    recent
      .toReversed()
      .map(({ content }) => positiveCategories(content))
      .find((categories) => categories.length > 0) ?? [];
  const categorySwitch =
    currentCategories.length > 0 &&
    latestCategories.length > 0 &&
    currentCategories.every((category) => !latestCategories.includes(category));
  const relevantHistory = reset || categorySwitch ? [] : recent;

  const rejected = new Set<string>();
  for (const item of relevantHistory) {
    for (const term of explicitRejections(item.content)) rejected.add(term);
  }
  for (const term of explicitRejections(message)) rejected.add(term);
  const currentPositive = positiveCategoryText(normalize(message));
  for (const term of rejected) {
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
  const { ranked } = rankedCandidates(events, message, history, semantic);
  const diverseRanked = diverseEvents(ranked, ranked.length);
  if (semantic) return diverseRanked.slice(0, limit);
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
