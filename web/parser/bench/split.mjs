import { readFileSync } from 'node:fs';
// Deterministic family split: alternate families (in corpus order) into dev and test.
export function loadSplit(which) {
  const cases = JSON.parse(readFileSync(new URL('./heldout-200.json', import.meta.url))).cases;
  const families = [...new Set(cases.map((c) => `${c.slice}:${c.family}`))];
  const dev = new Set(families.filter((_, i) => i % 2 === 0));
  return cases.filter((c) => (which === 'all') || (dev.has(`${c.slice}:${c.family}`) === (which === 'dev')));
}
