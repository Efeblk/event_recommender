// Runs the parser over Codex's independent GLiNER conversation cases (different schema) for manual review.
import { readFileSync } from 'node:fs';
import * as C from './compact.mjs';
import { parse } from '../parse.ts';
const g = JSON.parse(readFileSync(new URL('./gliner-cases-v2.json', import.meta.url)));
const referenceDate = g.referenceTime.slice(0, 10);
const show = (r) => r.status === 'accepted' ? C.plan(r.resultingPlan)
  : r.status === 'ambiguous' ? `AMBIGUOUS ${r.alternatives.map((a) => C.plan(a.resultingPlan)).join(' | ')}` : `UNSUPPORTED ${JSON.stringify(r.unresolvedSpans.map((s) => s.text))}`;
for (const conv of g.conversations) {
  let state = null;
  for (const t of conv.turns) {
    const r = await parse({ utterance: t.message, language: 'tr', referenceDate, timezone: 'Europe/Istanbul', previousState: state });
    if (r.status === 'accepted') state = { revision: 1, plan: r.resultingPlan, evidence: [] };
    const e = t.expected;
    console.log(`${conv.id}/${t.id} | ${t.message}\n   got  ${show(r)}\n   want ${e.status}${e.issue ? ' ' + e.issue : ''} ${JSON.stringify(e.semanticExpected ?? {})}`);
  }
}
