import type { JevResponse, Question } from '../parser/parse-core.ts';

/**
 * Synthetic Jev answers for the field reader: the named picks, otherwise the
 * first option (the "not stated" reading, except for numeric options, which
 * JavaScript orders first) and noul 0.
 */
export function fieldAnswers(questions: Record<string, Question>, picks: Record<string, string | number> = {}): JevResponse {
  for (const id of Object.keys(picks)) if (!questions[id]) throw new Error(`no question ${id}`);
  const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    if (question.type === 'noul') return [id, { type: 'noul', noul: typeof picks[id] === 'number' ? picks[id] : 0 }];
    const keys = Object.keys(question.criteria);
    const choice = typeof picks[id] === 'string' ? picks[id] as string : keys[0];
    if (!keys.includes(choice)) throw new Error(`${id}: no option ${choice}`);
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])) }];
  }));
  return { model: 'jev-test', answers, usage: { input_tokens: 1, output_tokens: 1 } };
}
