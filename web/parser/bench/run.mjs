// Usage: node bench/run.mjs <dev|test|all> [--offline] [--only=id,id] [--verbose]
// Scores the span parser against the frozen 200-case plan benchmark.
import { writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { loadSplit } from './split.mjs';
import * as C from './compact.mjs';
import { parse } from '../parse.ts';
import { canonicalInterpretation, semanticPlan, stable } from '../semantics.ts';
import { spentUsd } from '../jev.ts';

const split = process.argv[2] ?? 'dev';
const offline = process.argv.includes('--offline');
const verbose = process.argv.includes('--verbose');
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7).split(',');
let cases = loadSplit(split);
if (only) cases = cases.filter((c) => only.includes(c.id));

const startSpend = spentUsd();
const chains = new Map();
const records = [];

async function runCase(c) {
  const chain = c.chainId ? chains.get(c.chainId) : null;
  const previousState = c.chainId ? (chain?.state ?? null) : c.previousState;
  const input = { utterance: c.utterance, language: c.language, referenceDate: c.referenceDate, timezone: c.timezone, previousState };
  const began = performance.now();
  let result, error = null;
  try { result = await parse(input, { offline }); } catch (e) { error = e.message; }
  const ms = performance.now() - began;
  const e = c.expected;
  const interpretations = result?.status === 'accepted' ? [result] : result?.alternatives ?? [];
  const keys = new Set(interpretations.map((i) => { try { return canonicalInterpretation(i); } catch { return 'INVALID'; } }));
  const expectedList = e.status === 'accepted' ? [e.interpretation] : e.alternatives ?? [];
  const expectedKeys = new Set(expectedList.map(canonicalInterpretation));
  const matched = [...expectedKeys].filter((k) => keys.has(k)).length;
  const planKeys = new Set(interpretations.map((i) => stable(semanticPlan(i.resultingPlan))));
  const expectedPlans = new Set(expectedList.map((i) => stable(semanticPlan(i.resultingPlan))));
  const statusOk = result?.status === e.status;
  const strict = statusOk && (e.status === 'unsupported'
    ? (e.unresolvedQuotes ?? []).every((q) => result.unresolvedSpans.some((s) => s.text.includes(q)))
    : matched === expectedKeys.size && keys.size === expectedKeys.size);
  const planOk = statusOk && (e.status === 'unsupported' ? strict
    : [...expectedPlans].every((k) => planKeys.has(k)) && planKeys.size === expectedPlans.size);
  const record = { id: c.id, slice: c.slice, family: c.family, language: c.language, utterance: c.utterance, chainId: c.chainId,
    earlierChainFailure: Boolean(chain?.failed), statusOk, strict, planOk, error, ms: Math.round(ms), result, expected: e, previousState };
  if (c.chainId) {
    let state = previousState;
    if (result?.status === 'accepted') state = { revision: (previousState?.revision ?? 0) + 1, plan: result.resultingPlan, evidence: [] };
    chains.set(c.chainId, { state, failed: Boolean(chain?.failed) || !planOk });
  }
  return record;
}

// Independent cases run concurrently; chains run in order.
const independent = cases.filter((c) => !c.chainId);
const chained = [...new Set(cases.filter((c) => c.chainId).map((c) => c.chainId))];
const queue = [...independent.map((c) => async () => records.push(await runCase(c))),
  ...chained.map((id) => async () => { for (const c of cases.filter((x) => x.chainId === id).sort((a, b) => a.turn - b.turn)) records.push(await runCase(c)); })];
await Promise.all(Array.from({ length: offline ? 1 : 6 }, async () => { while (queue.length) await queue.shift()(); }));
records.sort((a, b) => cases.findIndex((c) => c.id === a.id) - cases.findIndex((c) => c.id === b.id));

const show = (r) => {
  const res = r.result;
  const got = !res ? `ERROR ${r.error}` : res.status === 'accepted' ? res.operations.map(C.op).join(' ; ')
    : res.status === 'ambiguous' ? res.alternatives.map((a) => `{${a.operations.map(C.op).join(' ; ')}}`).join(' OR ')
    : `UNSUPPORTED ${JSON.stringify(res.unresolvedSpans.map((s) => s.text))} (${res.reason})`;
  const e = r.expected;
  const want = e.status === 'accepted' ? e.interpretation.operations.map(C.op).join(' ; ')
    : e.status === 'ambiguous' ? e.alternatives.map((a) => `{${a.operations.map(C.op).join(' ; ')}}`).join(' OR ')
    : `UNSUPPORTED ${JSON.stringify(e.unresolvedQuotes)}`;
  return `${r.planOk ? 'ok  ' : 'FAIL'} ${r.id}${r.earlierChainFailure ? ' (after chain failure)' : ''} | ${r.utterance}${r.previousState ? `\n     prev ${C.plan(r.previousState.plan)}` : ''}\n     got  ${got}\n     want ${want}${!r.planOk && res?.debug ? `\n     jev  ${Object.entries(res.debug.answers).map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`;
};
for (const r of records) if (verbose || !r.planOk) console.log(show(r));

const by = (pred) => records.filter(pred).length;
const slices = ['clear', 'ambiguous', 'unsupported'];
const summary = {
  split, cases: records.length,
  planCorrect: by((r) => r.planOk), strictCorrect: by((r) => r.strict),
  bySlice: Object.fromEntries(slices.map((s) => [s, `${by((r) => r.slice === s && r.planOk)}/${by((r) => r.slice === s)}`])),
  byLanguage: Object.fromEntries(['tr', 'en'].map((l) => [l, `${by((r) => r.language === l && r.planOk)}/${by((r) => r.language === l)}`])),
  acceptedWrong: by((r) => r.result?.status === 'accepted' && !r.planOk),
  unsupportedAccepted: by((r) => r.slice === 'unsupported' && r.result?.status === 'accepted'),
  falseUnsupported: by((r) => r.slice !== 'unsupported' && r.result?.status === 'unsupported'),
  errors: by((r) => r.error),
  medianMs: records.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(records.length / 2)],
  spendThisRunUsd: Number((spentUsd() - startSpend).toFixed(5)), spendTotalUsd: Number(spentUsd().toFixed(5)),
};
console.log(JSON.stringify(summary, null, 2));
mkdirSync(new URL('../.runtime/results/', import.meta.url), { recursive: true });
writeFileSync(new URL(`../.runtime/results/${basename(split).replace(/\.json$/u, '')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url), JSON.stringify({ summary, records }, null, 1));
