import { cosine, normalize, rankEvents } from './search.ts';
import type { EventRecord, Message } from './types.ts';

export interface SemanticRanking {
  queryVector: number[];
  vectors: Map<string, number[]>;
}
const stop = new Set(
  'bir biraz icin olsun bana gore olan var neler ne bu ve ile etkinlik istiyorum plan daha tl lira hafta sonu'.split(
    ' ',
  ),
);
const tokens = (text: string) =>
  normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !stop.has(word));

// One current request, with bounded relevant history. Do not embed the repeated
// lexical query or assistant-generated claims as if they were user preferences.
export function semanticQuery(message: string, history: Message[]) {
  return [
    ...history
      .filter((item) => item.role === 'user')
      .slice(-3)
      .map((item) => `Önceki istek: ${item.content.slice(0, 1200)}`),
    `Güncel istek: ${message}`,
  ].join('\n');
}

export function hybridRank(
  events: EventRecord[],
  query: string,
  semantic: SemanticRanking,
): EventRecord[] {
  const queryTerms = [...new Set(tokens(query))];
  const documents = events.map((event) =>
    tokens(
      [event.title, event.category, event.venue, event.description].join(' '),
    ),
  );
  const averageLength =
    documents.reduce((sum, words) => sum + words.length, 0) /
      Math.max(1, documents.length) || 1;
  const frequencies = new Map(
    queryTerms.map((term) => [
      term,
      documents.filter((words) => words.includes(term)).length,
    ]),
  );
  const lexical = events
    .map((event, index) => {
      const words = documents[index];
      const score = queryTerms.reduce((sum, term) => {
        const tf = words.filter((word) => word === term).length;
        if (!tf) return sum;
        const df = frequencies.get(term)!;
        const idf = Math.log(1 + (events.length - df + 0.5) / (df + 0.5));
        return (
          sum +
          (idf * tf * 2.2) /
            (tf + 1.2 * (0.25 + (0.75 * words.length) / averageLength))
        );
      }, 0);
      return { event, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const dense = events
    .filter((event) => semantic.vectors.has(event.id))
    .map((event) => ({
      event,
      score: cosine(semantic.queryVector, semantic.vectors.get(event.id)!),
    }))
    .sort((a, b) => b.score - a.score);
  if (!dense.length) return rankEvents(events, query);
  const scores = new Map<string, number>();
  // Reciprocal rank fusion avoids mixing incomparable raw cosine/BM25 scores.
  // Zero-keyword matches do not receive an arbitrary chronological ranking boost.
  for (const ranking of [lexical, dense])
    ranking.forEach(({ event }, index) => {
      scores.set(event.id, (scores.get(event.id) ?? 0) + 1 / (60 + index + 1));
    });
  return [...events].sort(
    (a, b) =>
      (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
      a.startsAt.localeCompare(b.startsAt) ||
      a.id.localeCompare(b.id),
  );
}
