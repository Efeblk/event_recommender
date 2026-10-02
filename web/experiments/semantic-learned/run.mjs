import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus, platform, release } from 'node:os';
import { prepareInput, compile } from './compiler.ts';
import { SYSTEM_PROMPT, buildPrompt, RESPONSE_SCHEMA } from './prompt.ts';
import { applyOperations, validatePlan } from '../semantic-grammar/state.ts';
import { canonicalInterpretation, semanticPlan, stable } from '../semantic-grammar/semantics.ts';
import { callModel, ledger, CONFIG, MODEL, PROJECT, WORK } from './provider.mjs';

const here = import.meta.dirname, repo = resolve(here, '../../..');
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');
const write = (p, v) => writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`, { flag: 'wx' });
const policy = json(resolve(here, 'evaluation-policy.json'));
const corpusPath = resolve(WORK, 'fresh-cases.json');
const selectionPath = resolve(WORK, 'selection.json');
const freezePath = resolve(WORK, 'evaluation-freeze.json');
const sources = ['values.ts', 'wire.ts', 'prompt.ts', 'compiler.ts', 'compiler.test.ts', 'provider.mjs',
  'run.mjs', 'cli.mjs', 'select.mjs', 'evaluation-policy.json', '../semantic-grammar/contract.ts',
  '../semantic-grammar/state.ts', '../semantic-grammar/semantics.ts'];
const hashes = () => Object.fromEntries(sources.map(p => [p, hash(readFileSync(resolve(here, p)))]));

// A disclosed development regression, separate from the independently authored fresh sample.
const knownInput = { utterance: 'kişi başı maks 2000tl olan kız arkadaşımla gideceğim etkinlik konser veya tiyatro olmasın, workshop olabilir, en yakın tarih',
  language: 'tr', referenceDate: '2026-10-01', timezone: 'Europe/Istanbul', previousState: null };
const atom = a => ({ type: 'atom', atom: a });
const knownOperations = [
  { op: 'add', strength: 'hard', condition: atom({ kind: 'budget', comparison: 'lte', amount: 2000, currency: 'TRY', basis: 'per_person' }) },
  { op: 'add', strength: 'hard', condition: atom({ kind: 'companion', value: 'partner' }) },
  { op: 'add', strength: 'hard', condition: { type: 'not', child: { type: 'any', children: [atom({ kind: 'category', value: 'concert' }), atom({ kind: 'category', value: 'theatre' })] } } },
  { op: 'add', strength: 'preferred', condition: atom({ kind: 'category', value: 'workshop' }) },
  { op: 'order', value: 'soonest' },
];
const known = { ...knownInput, id: 'known-original-complex-request', family: 'disclosed development regression', slice: 'clear',
  expected: { status: 'accepted', interpretation: { operations: knownOperations, resultingPlan: applyOperations(null, knownOperations) } } };

function preflight() {
  const corpus = json(corpusPath), all = Array.isArray(corpus) ? corpus : corpus.cases;
  assert.equal(hash(readFileSync(corpusPath)), 'f6c36f84f9dc39279af53376753522c637bfb57756a892d40741a8a0c5bbf640');
  const selection = json(selectionPath), chosen = selection.cases.map(m => ({ ...all.find(c => c.id === m.id), cohort: m.cohort }));
  assert.equal(chosen.length, policy.sample.total);
  assert.ok(chosen.every(c => c.id));
  assert.equal(new Set(all.map(c => c.id)).size, all.length);
  const chains = new Map();
  for (const c of all) {
    const prior = c.chainId && chains.has(c.chainId) ? chains.get(c.chainId) : c.previousState;
    if (prior) validatePlan(prior.plan);
    const expected = c.expected.status === 'accepted' ? [c.expected.interpretation] : c.expected.alternatives ?? [];
    const keys = new Set();
    for (const i of expected) {
      validatePlan(i.resultingPlan);
      assert.equal(stable(applyOperations(prior, i.operations)), stable(i.resultingPlan), `gold transition ${c.id}`);
      assert.ok(!keys.has(canonicalInterpretation(i)), `duplicate gold ${c.id}`); keys.add(canonicalInterpretation(i));
    }
    if (c.expected.status === 'unsupported') for (const q of c.expected.unresolvedQuotes ?? []) assert.ok(c.utterance.includes(q));
    if (c.chainId) {
      if (c.expected.status === 'accepted') chains.set(c.chainId, { revision: (prior?.revision ?? 0) + 1, plan: c.expected.interpretation.resultingPlan, evidence: [] });
      else chains.set(c.chainId, prior);
    }
  }
  for (const language of ['tr', 'en']) {
    assert.equal(chosen.filter(c => c.language === language).length, 12);
    for (const [slice, n] of [['clear', 8], ['ambiguous', 2], ['unsupported', 2]]) assert.equal(chosen.filter(c => c.language === language && c.slice === slice).length, n);
  }
  return { chosen, selection, corpusCount: all.length };
}

function invariants(input, result, before) {
  const errors = [];
  if (stable(input) !== before) errors.push('input or prior state mutated');
  if (!result || !['accepted', 'ambiguous', 'unsupported'].includes(result.status)) return [...errors, 'invalid status'];
  for (const s of [...(result.evidence ?? []), ...(result.ownership ?? []), ...(result.unresolvedSpans ?? [])]) {
    if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start || s.end > input.utterance.length || input.utterance.slice(s.start, s.end) !== s.text) errors.push('nonliteral UTF-16 evidence');
  }
  const readings = result.status === 'accepted' ? [result] : result.alternatives ?? [];
  if (result.status === 'ambiguous' && (readings.length < 2 || readings.length > 8)) errors.push('ambiguity bound');
  if (result.status === 'unsupported' && !result.unresolvedSpans?.length) errors.push('unsupported without unresolved evidence');
  for (const i of readings) {
    try {
      validatePlan(i.resultingPlan);
      if (stable(applyOperations(input.previousState, i.operations)) !== stable(i.resultingPlan)) errors.push('non-atomic or inconsistent transition');
    } catch (error) { errors.push(`transition: ${error.message}`); }
  }
  return errors;
}

function score(c, input, result, errors) {
  const actual = result.status === 'accepted' ? [result] : result.alternatives ?? [];
  const gold = c.expected.status === 'accepted' ? [c.expected.interpretation] : c.expected.alternatives ?? [];
  const actualKeys = new Set(actual.map(canonicalInterpretation)), goldKeys = new Set(gold.map(canonicalInterpretation));
  const matched = [...goldKeys].filter(k => actualKeys.has(k));
  const exactAccepted = result.status === 'accepted' && c.expected.status === 'accepted' && matched.length === 1 && errors.length === 0;
  const resultingPlanEqual = result.status === 'accepted' && c.expected.status === 'accepted' && stable(semanticPlan(result.resultingPlan)) === stable(semanticPlan(c.expected.interpretation.resultingPlan));
  const extraAlternativeCount = [...actualKeys].filter(k => !goldKeys.has(k)).length;
  const completeAmbiguity = result.status === 'ambiguous' && c.expected.status === 'ambiguous' && matched.length === goldKeys.size && extraAlternativeCount === 0 && errors.length === 0;
  const unsupportedCorrect = result.status === 'unsupported' && c.expected.status === 'unsupported' && errors.length === 0 && (c.expected.unresolvedQuotes ?? []).every(q => {
    const s = input.utterance.indexOf(q), e = s + q.length;
    for (let i = s; i < e; i++) if (!/\s/u.test(input.utterance[i]) && !result.unresolvedSpans.some(span => span.start <= i && span.end > i)) return false;
    return true;
  });
  return { exactAccepted, resultingPlanEqual, completeAmbiguity, unsupportedCorrect, extraAlternativeCount,
    missingAlternativeCount: goldKeys.size - matched.length, correct: exactAccepted || completeAmbiguity || unsupportedCorrect,
    reviewRequired: result.status === 'accepted' && !exactAccepted };
}

const command = process.argv[2];
if (command === 'freeze') {
  const p = preflight();
  assert.equal((await ledger()).length, 0, 'Freeze precedes any inference');
  mkdirSync(resolve(WORK, 'evaluated-sources'), { recursive: true });
  for (const source of sources) {
    const target = resolve(WORK, 'evaluated-sources', source.replaceAll('../', 'shared-'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(resolve(here, source)), { flag: 'wx' });
  }
  write(freezePath, { frozenAt: new Date().toISOString(), sources: hashes(), corpusSha256: hash(readFileSync(corpusPath)),
    receiptSha256: hash(readFileSync(resolve(WORK, 'fresh-corpus-receipt.json'))), selectionSha256: hash(readFileSync(selectionPath)),
    authorizationSha256: hash(readFileSync(resolve(WORK, 'authorization.json'))), policy, provider: { MODEL, PROJECT, CONFIG },
    selectedCount: p.chosen.length, unusedCount: p.corpusCount - p.chosen.length,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    dirtyState: execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' }).trim().split(/\r?\n/u),
    hardware: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model },
    provenance: 'Isolated source files in pre-existing dirty tree; runtime snapshot and metadata-selected fresh corpus frozen before provider output. Implementation worker did not read fresh gold.',
    limitations: ['Agent-authored gold, not independent human annotation.', 'Small constructed corpus, no production search/catalog claims.',
      'CountTokens plus margin is admission estimation; recorded actual usage governs reported cost.', 'Single sequential pass; no retries or output-based tuning.'] });
  console.log(JSON.stringify({ frozen: true, selected: p.chosen.length, unused: p.corpusCount - p.chosen.length, freezeSha256: hash(readFileSync(freezePath)) }));
} else if (command === 'run') {
  const freeze = json(freezePath), p = preflight();
  const verify = () => {
    assert.equal(stable(hashes()), stable(freeze.sources), 'Runtime source changed after freeze');
    for (const [file, expected] of [['fresh-cases.json', freeze.corpusSha256], ['fresh-corpus-receipt.json', freeze.receiptSha256], ['selection.json', freeze.selectionSha256], ['authorization.json', freeze.authorizationSha256]]) assert.equal(hash(readFileSync(resolve(WORK, file))), expected);
  };
  verify();
  const rawPath = resolve(WORK, 'raw-results.jsonl'); writeFileSync(rawPath, '', { flag: 'wx' });
  const ordered = [known, ...p.chosen.filter(c => c.cohort !== 'final-confirmation'), ...p.chosen.filter(c => c.cohort === 'final-confirmation')];
  const records = [], chains = new Map(); let runtimeFailure = null;
  for (const c of ordered) {
    verify();
    const chain = c.chainId ? chains.get(c.chainId) : null;
    const previousState = chain ? chain.state : c.previousState;
    const input = structuredClone({ utterance: c.utterance, language: c.language, referenceDate: c.referenceDate, timezone: c.timezone, previousState });
    const before = stable(input), start = performance.now();
    try {
      const prepAt = performance.now(), prepared = prepareInput(input), prepareMs = performance.now() - prepAt;
      const inference = await callModel(SYSTEM_PROMPT, buildPrompt(input, prepared), RESPONSE_SCHEMA, { id: c.id, cohort: c.cohort ?? 'known-regression' });
      const compileAt = performance.now(), result = compile(input, prepared, inference.wire), compileMs = performance.now() - compileAt;
      const elapsedMs = performance.now() - start, errors = invariants(input, result, before), checks = score(c, input, result, errors);
      const record = { id: c.id, family: c.family, language: c.language, slice: c.slice, cohort: c.cohort ?? 'known-regression',
        input, prepared, expected: c.expected, wire: inference.wire, wireError: inference.wireError, result, invariants: errors, ...checks,
        latency: { prepareMs, tokenAdmissionMs: inference.countMs, providerMs: inference.elapsedMs, compileMs, totalMs: elapsedMs },
        cost: { inputTokens: inference.inputTokens, outputTokens: inference.outputTokens, listPriceUsd: inference.listPriceUsd },
        capture: relative(repo, inference.capture), chainId: c.chainId, turn: c.turn, earlierChainFailure: Boolean(chain?.failed) };
      appendFileSync(rawPath, `${JSON.stringify(record)}\n`); records.push(record);
      if (c.chainId) {
        const state = result.status === 'accepted' && errors.length === 0 ? { revision: (previousState?.revision ?? 0) + 1, plan: structuredClone(result.resultingPlan), evidence: structuredClone(result.evidence) } : previousState;
        chains.set(c.chainId, { state, failed: Boolean(chain?.failed) || !record.correct });
      }
      console.log(JSON.stringify({ id: c.id, status: result.status, correct: record.correct, reason: result.reason ?? null, ms: Math.round(elapsedMs), costUsd: inference.listPriceUsd }));
    } catch (error) {
      runtimeFailure = { id: c.id, name: error.name, message: error.message, elapsedMs: performance.now() - start };
      write(resolve(WORK, 'runtime-failure.json'), runtimeFailure); break;
    }
  }
  verify();
  const fresh = records.filter(r => r.cohort !== 'known-regression'), count = f => fresh.filter(f).length;
  const percentile = (v, q) => [...v].sort((a, b) => a - b)[Math.max(0, Math.ceil(v.length * q) - 1)] ?? null;
  const accepted = count(r => r.result.status === 'accepted'), exact = count(r => r.exactAccepted);
  const l = await ledger(), reserved = l.filter(r => r.type === 'reserved'), completed = l.filter(r => r.type === 'complete');
  const authorization = json(resolve(WORK, 'authorization.json'));
  const additionalReserved = reserved.reduce((n, r) => n + r.reservedUsd, 0), additionalCost = completed.reduce((n, r) => n + r.listPriceUsd, 0);
  const summary = { completedAt: new Date().toISOString(), model: MODEL, freezeSha256: hash(readFileSync(freezePath)), rawSha256: hash(readFileSync(rawPath)),
    selectedFresh: p.chosen.length, completedFresh: fresh.length, unusedFresh: p.corpusCount - p.chosen.length, runtimeFailure,
    knownRegression: records.find(r => r.cohort === 'known-regression') ? { correct: records[0].correct, status: records[0].result.status, reason: records[0].result.reason ?? null } : null,
    counts: { clearCorrect: count(r => r.slice === 'clear' && r.exactAccepted), clearTotal: 16, accepted, exactAccepted: exact,
      exactAcceptedRatio: accepted ? exact / accepted : 0, resultingPlanEqual: count(r => r.resultingPlanEqual),
      completeAmbiguities: count(r => r.completeAmbiguity), ambiguousTotal: 4, correctUnsupported: count(r => r.unsupportedCorrect), unsupportedTotal: 4,
      acceptedUnsupported: count(r => r.slice === 'unsupported' && r.result.status === 'accepted'), invariantViolations: count(r => r.invariants.length > 0),
      subsequentChainFailures: count(r => r.earlierChainFailure && !r.correct), missingAlternatives: fresh.reduce((n, r) => n + r.missingAlternativeCount, 0), extraAlternatives: fresh.reduce((n, r) => n + r.extraAlternativeCount, 0) },
    byLanguage: Object.fromEntries(['tr', 'en'].map(language => [language, { clearCorrect: count(r => r.language === language && r.exactAccepted), completeAmbiguities: count(r => r.language === language && r.completeAmbiguity), correctUnsupported: count(r => r.language === language && r.unsupportedCorrect) }])),
    latency: Object.fromEntries(['prepareMs', 'tokenAdmissionMs', 'providerMs', 'compileMs', 'totalMs'].map(stage => [stage, { warmP50: percentile(fresh.map(r => r.latency[stage]), .5), warmP95: percentile(fresh.map(r => r.latency[stage]), .95), warmMax: fresh.length ? Math.max(...fresh.map(r => r.latency[stage])) : null }])),
    latencyScope: 'Sequential Windows client to global Vertex, includes token preflight/ADC; known first call excluded. No inference/search cache requested; not deployment latency.',
    gates: { completeRun: fresh.length === 24 && !runtimeFailure, clearResolution: count(r => r.slice === 'clear' && r.exactAccepted) >= policy.gates.clearCorrectMinimum,
      exactAccepted: accepted > 0 && exact / accepted >= policy.gates.exactAcceptedRatioMinimum,
      ambiguities: count(r => r.completeAmbiguity) >= policy.gates.completeAmbiguitiesMinimum,
      unsupportedSafety: count(r => r.slice === 'unsupported' && r.result.status === 'accepted') <= policy.gates.acceptedUnsupportedMaximum,
      invariants: count(r => r.invariants.length > 0) === 0,
      warmLatency: fresh.length > 0 && percentile(fresh.map(r => r.latency.totalMs), .95) <= policy.gates.warmP95MsMaximum,
      successfulMaximum: fresh.filter(r => r.result.status !== 'unsupported').every(r => r.latency.totalMs <= policy.gates.successfulMaximumMs),
      hardConstraintSafety: 'PENDING_EVERY_ACCEPTED_PLAN_REVIEW' },
    reviewIds: fresh.filter(r => r.result.status === 'accepted').map(r => r.id), sourcesUnchanged: true,
    finalConfirmationCalls: count(r => r.cohort === 'final-confirmation'), providerCalls: reserved.length,
    cost: { additionalReservedUsd: additionalReserved, additionalListPriceUsd: additionalCost, cumulativeReservedUsd: authorization.previousReservedUsd + additionalReserved,
      cumulativeListPriceUsd: authorization.previousListPriceUsd + additionalCost, capUsd: authorization.cumulativeReservationCapUsd },
    limitations: freeze.limitations, verdict: 'ISOLATED_DIAGNOSTIC_REQUIRES_REVIEW; NO_APP_INTEGRATION' };
  write(resolve(WORK, 'summary.json'), summary);
  write(resolve(WORK, 'cost-receipt.json'), { at: summary.completedAt, scope: policy.scope, model: MODEL, project: PROJECT,
    previousReceipt: authorization.previousReceipt, previousReceiptSha256: authorization.previousReceiptSha256,
    ledgerSha256: l.length ? hash(readFileSync(resolve(WORK, 'provider-ledger.jsonl'))) : null,
    attemptedCalls: reserved.length, completedCalls: completed.length, failedCalls: l.filter(r => r.type === 'failed').length,
    tokenizationRequests: (() => { try { return readFileSync(resolve(WORK, 'tokenization-ledger.jsonl'), 'utf8').trim().split('\n').length; } catch { return 0; } })(),
    inputTokens: completed.reduce((n, r) => n + r.inputTokens, 0), outputTokensIncludingReasoning: completed.reduce((n, r) => n + r.outputTokens, 0),
    inputUsdPerMillion: authorization.inputUsdPerMillion, outputUsdPerMillion: authorization.outputUsdPerMillion, priceSource: authorization.priceSource,
    reservedUsd: additionalReserved, listPriceUsd: additionalCost, cumulativeReservedUsd: summary.cost.cumulativeReservedUsd, cumulativeListPriceUsd: summary.cost.cumulativeListPriceUsd,
    cumulativeReservationCapUsd: .9, actualBillingVerified: false, creditBalanceVerified: false, retries: 0,
    voyageCalls: 0, jevCalls: 0, servingHostingExcluded: true, finalConfirmationCalls: summary.finalConfirmationCalls });
  console.log(JSON.stringify(summary, null, 2));
  if (runtimeFailure || Object.values(summary.gates).some(g => g === false)) process.exitCode = 1;
} else throw new Error('Usage: run.mjs freeze|run');
