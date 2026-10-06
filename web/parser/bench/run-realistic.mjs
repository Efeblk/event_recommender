// Usage: node bench/run-realistic.mjs [--fields] [--offline] [--verbose]
// Scores a parser on realistic requests by their exact hard conditions.
import { cases, referenceDate } from './realistic-v1.mjs';
import { parse as parseSpans } from '../parse.ts';
import { parseFields } from '../parse-fields.ts';
import { semanticCondition, stable } from '../semantics.ts';
import { spentUsd } from '../jev.ts';

const fields = process.argv.includes('--fields');
const offline = process.argv.includes('--offline');
const verbose = process.argv.includes('--verbose');
const parse = fields ? parseFields : parseSpans;
const kind = (c) => c.type === 'atom' ? c.atom.kind : c.type === 'not' ? kind(c.child) : kind(c.children[0]);
const key = (c) => stable(semanticCondition(c));

function score(c, plan) {
  const hard = plan.hard.children;
  const got = new Set(hard.map(key)), want = new Set(c.hard.map(key));
  const missing = c.hard.filter((x) => !got.has(key(x)) && !(c.allowMissing ?? []).includes(kind(x)));
  const extra = hard.filter((x) => !want.has(key(x)) && !(c.allowExtra ?? []).includes(kind(x)));
  const prefs = new Set(plan.preferences.map(key));
  const missingPrefs = (c.prefer ?? []).filter((x) => !prefs.has(key(x)));
  const orderOk = !c.order || plan.order === c.order;
  return { ok: !missing.length && !extra.length && !missingPrefs.length && orderOk, missing, extra, missingPrefs, orderOk };
}

const start = spentUsd();
let pass = 0;
const rows = [];
await Promise.all(Array.from({ length: offline ? 1 : 6 }, async (_, w) => {
  for (let i = w; i < cases.length; i += offline ? 1 : 6) {
    const c = cases[i];
    let result, error = null;
    try { result = await parse({ utterance: c.text, language: 'tr', referenceDate, timezone: 'Europe/Istanbul', previousState: null }, { offline }); }
    catch (e) { error = e.message; }
    let ok = false, detail = error ?? '';
    if (result && c.status === 'unsupported') { ok = result.status === 'unsupported'; detail = result.status; }
    else if (result?.status === 'unsupported') detail = `UNSUPPORTED (${result.reason})`;
    else if (result) {
      const plans = result.status === 'accepted' ? [result.resultingPlan] : result.alternatives.map((a) => a.resultingPlan);
      const scored = plans.map((p) => score(c, p));
      ok = scored.some((s) => s.ok);
      const s = scored[0];
      detail = `${result.status}${ok ? '' : ` missing=${s.missing.map(key).join(' | ')} extra=${s.extra.map(key).join(' | ')}${s.missingPrefs.length ? ` missingPrefs=${s.missingPrefs.map(key).join(' | ')}` : ''}${s.orderOk ? '' : ' order'}`}`;
    }
    rows[i] = `${ok ? 'ok  ' : 'FAIL'} ${c.id} | ${c.text}${ok && !verbose ? '' : `\n     ${detail}`}`;
    if (ok) pass++;
  }
}));
for (const row of rows) if (verbose || row.startsWith('FAIL')) console.log(row);
console.log(JSON.stringify({ parser: fields ? 'fields' : 'spans', pass, cases: cases.length, spendThisRunUsd: Number((spentUsd() - start).toFixed(5)) }));
