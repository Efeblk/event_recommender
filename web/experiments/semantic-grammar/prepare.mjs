import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { applyOperations, validatePlan } from './state.ts';
import { semanticPlan, stable } from './semantics.ts';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
export const writeNewJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });

/** Gold consistency only. This never imports or invokes the parser. */
export function preflight(corpus) {
  const errors = [];
  const ids = new Set();
  const counts = { total: 0, languages: {}, slices: {}, seeded: 0, chainTurns: 0, chains: 0 };
  const chains = new Map();
  const record = (id, message) => errors.push({ id, message });
  if (!Array.isArray(corpus.cases)) throw new Error('corpus.cases must be an array');
  for (const c of corpus.cases) {
    counts.total++;
    counts.languages[c.language] = (counts.languages[c.language] ?? 0) + 1;
    counts.slices[c.slice] = (counts.slices[c.slice] ?? 0) + 1;
    if (ids.has(c.id)) record(c.id, 'duplicate ID');
    ids.add(c.id);
    if (!c.id || !c.family || typeof c.utterance !== 'string' || !['tr', 'en'].includes(c.language)) record(c.id, 'invalid case metadata');
    if (c.referenceDate !== '2026-10-01' || c.timezone !== 'Europe/Istanbul') record(c.id, 'unexpected reference date or timezone');
    if (!Object.hasOwn(c, 'previousState')) record(c.id, 'missing explicit previousState');
    if (c.previousState) counts.seeded++;
    let previous = c.previousState;
    let chain;
    if (c.chainId) {
      counts.chainTurns++;
      chain = chains.get(c.chainId);
      if (!chain) {
        if (c.turn !== 1) record(c.id, 'chain must start at turn 1');
        chain = { turn: 0, state: previous, language: c.language };
        chains.set(c.chainId, chain);
      } else {
        if (c.previousState !== null) record(c.id, 'later chain turn must not contain gold seed');
        previous = chain.state;
      }
      if (c.turn !== chain.turn + 1 || c.language !== chain.language) record(c.id, 'non-contiguous or mixed-language chain');
      chain.turn = c.turn;
    }
    try {
      if (previous) {
        if (!Number.isInteger(previous.revision) || previous.revision < 0 || !Array.isArray(previous.evidence)) throw new Error('invalid previous state');
        validatePlan(previous.plan);
      }
      const expectedStatus = { clear: 'accepted', ambiguous: 'ambiguous', unsupported: 'unsupported' }[c.slice];
      if (c.expected?.status !== expectedStatus) throw new Error('slice/status mismatch');
      const interpretations = c.expected.status === 'accepted' ? [c.expected.interpretation] : c.expected.alternatives ?? [];
      if (c.expected.status === 'ambiguous' && (interpretations.length < 2 || interpretations.length > 8)) throw new Error('ambiguous gold must enumerate 2..8 readings');
      for (const interpretation of interpretations) {
        if (!interpretation || !Array.isArray(interpretation.operations)) throw new Error('missing interpretation');
        validatePlan(interpretation.resultingPlan);
        const reduced = applyOperations(previous, interpretation.operations);
        if (stable(semanticPlan(reduced)) !== stable(semanticPlan(interpretation.resultingPlan))) throw new Error('gold operations do not produce gold resultingPlan');
      }
      if (c.expected.status === 'unsupported') {
        if (!c.expected.unresolvedQuotes?.length) throw new Error('unsupported gold needs unresolved quotes');
        if (c.expected.unresolvedQuotes.some((quote) => typeof quote !== 'string' || !quote || !c.utterance.includes(quote))) throw new Error('invalid unresolved quote');
      }
      if (chain && c.expected.status === 'accepted') {
        // This is solely checking gold internal consistency, never used in runtime evaluation.
        chain.state = { revision: (previous?.revision ?? 0) + 1, plan: c.expected.interpretation.resultingPlan, evidence: [] };
      }
    } catch (error) { record(c.id, error.message); }
  }
  counts.chains = chains.size;
  if (counts.total !== 200 || counts.languages.tr !== 100 || counts.languages.en !== 100 || counts.slices.clear !== 120 || counts.slices.ambiguous !== 40 || counts.slices.unsupported !== 40) record('corpus', 'unexpected frozen distribution');
  if (counts.seeded + counts.chainTurns < 40 || counts.chains < 2) record('corpus', 'insufficient contextual cases');
  return { ok: errors.length === 0, counts, errors, parserInvoked: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const corpusPath = resolve(process.argv[2] ?? '../../work/semantic-grammar-20261001/heldout.json');
  const result = preflight(readJson(corpusPath));
  result.corpusSha256 = sha256(readFileSync(corpusPath));
  if (process.argv[3]) writeNewJson(resolve(process.argv[3]), result);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
