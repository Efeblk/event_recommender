// Runs the parser over Codex's independent 58-case fixture (different schema) for manual review.
import { readFileSync } from 'node:fs';
import * as C from './compact.mjs';
import { parse } from '../parse.ts';
const f = JSON.parse(readFileSync(new URL('./input-intent-v1.json', import.meta.url)));
const states = new Map();
const show = (r) => r.status === 'accepted' ? `${C.plan(r.resultingPlan)}  ops: ${r.operations.map(C.op).join(' ; ')}`
  : r.status === 'ambiguous' ? `AMBIGUOUS ${r.alternatives.map((a) => C.plan(a.resultingPlan)).join(' | ')}` : `UNSUPPORTED ${JSON.stringify(r.unresolvedSpans.map((s) => s.text))}`;
for (const c of f.cases) {
  const previousState = c.parent ? states.get(c.parent) ?? null : null;
  const utterance = c.message.split('\n').pop();
  // Two-line cases are a pending clarification answered on the second line.
  const prevFor = c.message.includes('\n') ? null : previousState;
  const r = await parse({ utterance: c.message.includes('\n') ? c.message.replace('\n', ' ') : utterance, language: c.language, referenceDate: f.referenceDate, timezone: 'Europe/Istanbul', previousState: prevFor });
  if (r.status === 'accepted') states.set(c.id, { revision: 1, plan: r.resultingPlan, evidence: [] });
  else states.set(c.id, previousState);
  console.log(`${c.id}${c.parent ? ' <' + c.parent : ''} | ${c.message.replace('\n', ' / ')}\n   got  ${show(r)}\n   want ${c.expected.status} ${JSON.stringify(c.expected.filters ?? {})} ${c.expected.requirements ? 'req=' + JSON.stringify(c.expected.requirements) : ''} ${c.expected.soft ? 'soft=' + JSON.stringify(c.expected.soft) : ''}`);
}
