import { readFileSync, openSync, writeSync, closeSync, fsyncSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cpus, totalmem, platform, release } from 'node:os';
import { preflight, readJson, writeNewJson, sha256 } from './prepare.mjs';
import { applyOperations, validatePlan } from './state.ts';
import { canonicalInterpretation, semanticPlan, stable } from './semantics.ts';
import { LIMITS } from './contract.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const corpusPath = resolve(process.argv[3] ?? resolve(here, '../../work/semantic-grammar-20261001/heldout.json'));
const output = resolve(process.argv[4] ?? dirname(corpusPath));
const manifestPath = resolve(output, 'evaluation-freeze.json');
const sources = ['chart.ts', 'parser.ts', 'lexicon.ts', 'contract.ts', 'state.ts', 'semantics.ts', 'prepare.mjs',
  'run.mjs', 'evaluation-policy.json', 'parser-development.test.ts', 'state.test.ts', 'cli.mjs'];
const hashes = () => Object.fromEntries(sources.map((p) => [p, sha256(readFileSync(resolve(here, p)))]));
const corpus = readJson(corpusPath), policy = readJson(resolve(here, 'evaluation-policy.json'));
const check = preflight(corpus);
if (!check.ok) throw new Error(`gold preflight failed: ${JSON.stringify(check.errors)}`);
const now = () => new Date().toISOString();
const command = process.argv[2];
if (command === 'freeze') {
  const manifest = { schemaVersion: 1, frozenAt: now(), corpusPath: relative(repo, corpusPath),
    corpusSha256: sha256(readFileSync(corpusPath)), corpusReceiptSha256: sha256(readFileSync(resolve(dirname(corpusPath), 'corpus-receipt.json'))),
    sources: hashes(), preflight: check, policy,
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
    dirtyState: execFileSync('git', ['status', '--short'], { cwd: repo, encoding: 'utf8' }).trim().split(/\r?\n/u),
    provenance: 'Sources in a pre-existing dirty working tree, sealed independently of HEAD by SHA-256; no production source changes in this experiment.',
    hardware: { node: process.version, os: `${platform()} ${release()}`, cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem() },
    calls: { model: 0, paid: 0 }, limitations: [policy.goldProvenance, policy.exposureLimitation] };
  writeNewJson(manifestPath, manifest);
  console.log(JSON.stringify({ frozen: true, manifestPath, corpusSha256: manifest.corpusSha256, counts: check.counts }, null, 2));
} else if (command === 'run') {
  const manifest = readJson(manifestPath);
  const verify = () => {
    if (stable(hashes()) !== stable(manifest.sources) || sha256(readFileSync(corpusPath)) !== manifest.corpusSha256)
      throw new Error('frozen source or corpus hash changed');
    if (sha256(readFileSync(resolve(dirname(corpusPath), 'corpus-receipt.json'))) !== manifest.corpusReceiptSha256) throw new Error('corpus receipt changed');
  };
  verify();
  const start = performance.now(), moduleStart = performance.now();
  const { parse } = await import('./parser.ts');
  const moduleImportMs = performance.now() - moduleStart;
  const fd = openSync(resolve(output, 'raw-results.jsonl'), 'wx');
  const chains = new Map(), records = [];
  const spans = (input, result) => {
    const errors = [];
    for (const s of [...(result.evidence ?? []), ...(result.ownership ?? []), ...(result.unresolvedSpans ?? [])]) {
      if (!Number.isInteger(s.start) || !Number.isInteger(s.end) || s.start < 0 || s.end <= s.start || s.end > input.utterance.length || input.utterance.slice(s.start, s.end) !== s.text)
        errors.push('non-literal original UTF-16 span');
    }
    if (result.status === 'accepted' || result.status === 'ambiguous') {
      const covered = new Set();
      for (const s of result.ownership ?? []) for (let i = s.start; i < s.end; i++) covered.add(i);
      for (let i = 0; i < input.utterance.length; i++) {
        if (!covered.has(i) && !/[\s.,;!?'’"“”():]/u.test(input.utterance[i])) { errors.push(`unowned material at UTF-16 offset ${i}`); break; }
      }
    }
    return errors;
  };
  let runtimeFailure = null;
  try {
    for (let index = 0; index < corpus.cases.length; index++) {
      const c = corpus.cases[index];
      const chain = c.chainId ? chains.get(c.chainId) : null;
      const previousState = chain ? chain.state : c.previousState;
      const input = structuredClone({ utterance: c.utterance, language: c.language, referenceDate: c.referenceDate,
        timezone: c.timezone, previousState });
      const before = stable(input), began = performance.now();
      let result, thrown = null;
      try { result = parse(input); } catch (error) { thrown = error.message; }
      const elapsedMs = performance.now() - began;
      const invariants = [];
      if (stable(input) !== before) invariants.push('input or prior state mutated');
      if (thrown) invariants.push(`uncaught parser error: ${thrown}`);
      const interpretations = result?.status === 'accepted' ? [result] : result?.alternatives ?? [];
      if (!result || !['accepted', 'ambiguous', 'unsupported'].includes(result.status)) invariants.push('invalid result status');
      if (result) {
        invariants.push(...spans(input, result));
        const d = result.diagnostics;
        if (!d || !Number.isInteger(d.chartItems) || d.chartItems < 0 || d.chartItems > LIMITS.chartItems || d.materialAlternatives > LIMITS.alternatives) invariants.push('invalid resource diagnostics');
        if (result.status === 'ambiguous' && (interpretations.length < 2 || interpretations.length > LIMITS.alternatives)) invariants.push('invalid ambiguity cardinality');
        if (result.status === 'unsupported' && !result.unresolvedSpans?.length) invariants.push('unsupported without unresolved source');
        for (const interpretation of interpretations) {
          try {
            validatePlan(interpretation.resultingPlan);
            const reduced = applyOperations(previousState, interpretation.operations);
            if (stable(reduced) !== stable(interpretation.resultingPlan)) invariants.push('operations/state inconsistency including IDs');
          } catch (error) { invariants.push(`invalid transition: ${error.message}`); }
        }
      }
      const expected = c.expected;
      const actualKeys = new Set(interpretations.map((i) => {
        try { return canonicalInterpretation(i); } catch { return 'INVALID'; }
      }));
      const expectedInterpretations = expected.status === 'accepted' ? [expected.interpretation] : expected.alternatives ?? [];
      const expectedKeys = new Set(expectedInterpretations.map(canonicalInterpretation));
      const matchedKeys = [...expectedKeys].filter((k) => actualKeys.has(k));
      const exactAccepted = result?.status === 'accepted' && expected.status === 'accepted' && matchedKeys.length === 1 && invariants.length === 0;
      const resultingPlanEqual = result?.status === 'accepted' && expected.status === 'accepted'
        && stable(semanticPlan(result.resultingPlan)) === stable(semanticPlan(expected.interpretation.resultingPlan));
      const completeAmbiguity = result?.status === 'ambiguous' && expected.status === 'ambiguous' && matchedKeys.length === expectedKeys.size && invariants.length === 0;
      const unsupportedCorrect = result?.status === 'unsupported' && expected.status === 'unsupported' && invariants.length === 0
        && (expected.unresolvedQuotes ?? []).every((q) => result.unresolvedSpans.some((s) => s.text.includes(q)));
      const record = { index, id: c.id, family: c.family, language: c.language, slice: c.slice, utterance: c.utterance,
        chainId: c.chainId, turn: c.turn, earlierChainFailure: Boolean(chain?.failed), suppliedPreviousState: previousState,
        expected, result: result ?? null, thrown, elapsedMs, coldFirstCall: index === 0, invariants,
        exactAccepted, resultingPlanEqual, completeAmbiguity, unsupportedCorrect,
        missingAlternativeCount: expected.status === 'ambiguous' ? expectedKeys.size - matchedKeys.length : 0,
        extraAlternativeCount: result?.status === 'ambiguous' ? [...actualKeys].filter((k) => !expectedKeys.has(k)).length : 0,
        reviewRequired: result?.status === 'accepted' && !exactAccepted,
        correct: exactAccepted || completeAmbiguity || unsupportedCorrect };
      writeSync(fd, `${JSON.stringify(record)}\n`);
      records.push(record);
      if (c.chainId) {
        let state = previousState;
        if (result?.status === 'accepted' && invariants.length === 0) state = {
          revision: (previousState?.revision ?? 0) + 1, plan: structuredClone(result.resultingPlan), evidence: structuredClone(result.evidence),
        };
        chains.set(c.chainId, { state, failed: Boolean(chain?.failed) || !record.correct });
      }
    }
    fsyncSync(fd);
  } catch (error) { runtimeFailure = error.message; }
  finally { closeSync(fd); }
  verify();
  const count = (predicate) => records.filter(predicate).length;
  const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * p) - 1)] ?? null;
  const latency = records.filter((r) => !r.coldFirstCall).map((r) => r.elapsedMs);
  const acceptedCount = count((r) => r.result?.status === 'accepted');
  const exactCount = count((r) => r.exactAccepted), clearCount = count((r) => r.slice === 'clear' && r.exactAccepted);
  const unsupportedAccepted = count((r) => r.slice === 'unsupported' && r.result?.status === 'accepted');
  const ambiguityCount = count((r) => r.completeAmbiguity), invariantCount = count((r) => r.invariants.length > 0);
  const summary = { schemaVersion: 1, completedAt: now(), corpusSha256: manifest.corpusSha256,
    freezeSha256: sha256(readFileSync(manifestPath)), rawSha256: sha256(readFileSync(resolve(output, 'raw-results.jsonl'))),
    completedCases: records.length, runtimeFailure, providerCalls: 0, paidCostUsd: 0,
    provenance: manifest.provenance, limitations: manifest.limitations,
    counts: { correctClearAutomatic: clearCount, clearTotal: policy.corpus.slices.clear, accepted: acceptedCount,
      exactAccepted: exactCount, exactAcceptedRatio: acceptedCount ? exactCount / acceptedCount : 0,
      resultingPlanEqualAccepted: count((r) => r.resultingPlanEqual), completeAmbiguities: ambiguityCount,
      ambiguousTotal: policy.corpus.slices.ambiguous, correctUnsupported: count((r) => r.unsupportedCorrect), unsupportedTotal: policy.corpus.slices.unsupported,
      acceptedUnsupported: unsupportedAccepted, invariantViolations: invariantCount,
      reviewRequired: count((r) => r.reviewRequired), subsequentChainFailures: count((r) => r.earlierChainFailure && !r.correct),
      missingAlternatives: records.reduce((a, r) => a + r.missingAlternativeCount, 0), extraAlternatives: records.reduce((a, r) => a + r.extraAlternativeCount, 0) },
    byLanguage: Object.fromEntries(['tr', 'en'].map((language) => [language, {
      correctClear: count((r) => r.language === language && r.exactAccepted),
      accepted: count((r) => r.language === language && r.result?.status === 'accepted'),
      completeAmbiguities: count((r) => r.language === language && r.completeAmbiguity),
      correctUnsupported: count((r) => r.language === language && r.unsupportedCorrect),
    }])),
    latency: { concurrency: 1, moduleImportMs, firstParseMs: records[0]?.elapsedMs, warmCases: latency.length,
      warmP50Ms: percentile(latency, .5), warmP95Ms: percentile(latency, .95), warmMaxMs: Math.max(...latency),
      totalRunMs: performance.now() - start, scope: 'Local parser only, single sequential pass; not GCP/search latency', hardware: manifest.hardware },
    gates: { clearResolution: clearCount >= policy.gates.correctClearAutomaticMinimum,
      exactAccepted: acceptedCount > 0 && exactCount / acceptedCount >= policy.gates.exactAcceptedRatioMinimum,
      unsupportedSafety: unsupportedAccepted <= policy.gates.acceptedUnsupportedMaximum,
      ambiguities: ambiguityCount >= policy.gates.completeAmbiguitiesMinimum,
      warmLatency: percentile(latency, .95) <= policy.gates.warmParserP95MillisecondsMaximum,
      invariants: invariantCount <= policy.gates.invariantViolationsMaximum,
      hardConstraintSafety: 'PENDING_MANUAL_REVIEW' },
    verdict: 'DO_NOT_INTEGRATE_UNTIL_ALL_GATES_AND_ACCEPTED_OUTPUT_REVIEW_PASS',
    sourceHashesAfter: hashes(), sourceHashesUnchanged: true,
    reviewIds: records.filter((r) => r.reviewRequired).map((r) => r.id) };
  writeNewJson(resolve(output, 'summary.json'), summary);
  console.log(JSON.stringify(summary, null, 2));
  if (runtimeFailure || Object.values(summary.gates).some((g) => g === false)) process.exitCode = 1;
} else throw new Error('Usage: run.mjs freeze|run [corpusPath] [outputDirectory]');
