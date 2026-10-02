import { readFileSync } from 'node:fs';
// Deterministic family split: alternate families (in corpus order) into dev and test.
// `which` may also be a path to another corpus in the same schema (scored whole).
export function loadSplit(which) {
  if (which.endsWith('.json')) {
    const corpus = JSON.parse(readFileSync(which, 'utf8'));
    const cases = Array.isArray(corpus) ? corpus : corpus.cases;
    if (!Array.isArray(cases)) throw new Error('Corpus must be an array or an object with a cases array.');
    return cases;
  }
  const cases = JSON.parse(readFileSync(new URL('./heldout-200.json', import.meta.url))).cases;
  const families = [...new Set(cases.map((c) => `${c.slice}:${c.family}`))];
  const dev = new Set(families.filter((_, i) => i % 2 === 0));
  return cases.filter((c) => (which === 'all') || (dev.has(`${c.slice}:${c.family}`) === (which === 'dev')));
}
