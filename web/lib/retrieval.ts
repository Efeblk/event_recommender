import type { EventRecord, Message } from './types.ts';
import {
  normalize,
  productionIdentity,
  rankEvents,
  uniqueEvents,
} from './search.ts';

export interface SearchContext {
  query: string;
  history: Message[];
  rejectedTerms: string[];
  reset: boolean;
}

const categoryPatterns = [
  /\b(?:konser|muzik|rock|caz|jazz|akustik|techno|elektronik)\b/,
  /\b(?:tiyatro|sahne oyunu)\b/,
  /\b(?:stand[ -]?up|komedi)\b/,
];
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
  const q = normalize(message).replace(
    /\b[\p{L}-]+(?:\s+[\p{L}-]+)?\s+(?:istemiyorum|istemem|olmasin|degil|haric|disinda)\b/gu,
    ' ',
  );
  return categoryPatterns
    .map((pattern, index) => (pattern.test(q) ? index : -1))
    .filter((index) => index >= 0);
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
  const recent = history.filter(({ role }) => role === 'user').slice(-6);
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
  const currentPositive = normalize(message).replace(
    /\b[\p{L}-]+(?:\s+[\p{L}-]+)?\s+(?:istemiyorum|istemem|olmasin|degil|haric|disinda|yerine)\b/gu,
    ' ',
  );
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
  };
}

function eventText(event: EventRecord) {
  return normalize(
    `${event.title} ${event.description} ${event.category} ${event.venue}`,
  );
}

function eligibleForContext(event: EventRecord, context: SearchContext) {
  const text = eventText(event);
  return !context.rejectedTerms.some((term) => {
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

function rankedCandidates(
  events: EventRecord[],
  message: string,
  history: Message[],
) {
  const context = searchContext(message, history);
  const allowed = events.filter((event) => eligibleForContext(event, context));
  return {
    context,
    ranked: uniqueEvents(rankEvents(allowed, context.query), allowed.length),
  };
}

export function shortlistEvents(
  events: EventRecord[],
  message: string,
  history: Message[],
  limit = 16,
): EventRecord[] {
  if (limit <= 0) return [];
  const { ranked } = rankedCandidates(events, message, history);
  const selected: EventRecord[] = [];
  const seenProductions = new Set<string>();
  const seenCategories = new Set<string>();
  for (const event of ranked) {
    if (seenCategories.has(event.category)) continue;
    selected.push(event);
    seenCategories.add(event.category);
    seenProductions.add(productionIdentity(event));
    if (selected.length === limit) return selected;
  }
  for (const event of ranked) {
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
): EventRecord[] {
  if (limit <= 0) return [];
  return rankedCandidates(events, message, history).ranked.slice(0, limit);
}
