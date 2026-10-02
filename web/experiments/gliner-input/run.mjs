import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { emptyIntentState, validateIntentState } from '../../lib/input-state.ts';
import { buildExperimentRequest, compileExperimentResponse } from './interpreter.ts';
import { callJev, entries, summary, work } from './provider.mjs';

const web = resolve(import.meta.dirname, '../..');
const sha = data => createHash('sha256').update(data).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const mode = process.argv[2] ?? '--prepare';
assert.ok(['--prepare', '--main', '--final', '--score'].includes(mode));
const corpusFile = resolve(import.meta.dirname, 'cases-v2.json');
const corpusRaw = await readFile(corpusFile), corpus = JSON.parse(corpusRaw);
const now = new Date(corpus.referenceTime);
assert.equal(now.toISOString(), '2026-09-30T09:00:00.000Z');
const runtimeFile = resolve(work, `runtime/${mode === '--final' ? 'final' : 'development'}-output.jsonl`);
const runtime = new Map();
if (mode !== '--score') {
  for (const line of (await readFile(runtimeFile, 'utf8')).split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    assert.equal(row.validationErrors.length, 0, 'GLiNER source offsets failed validation.');
    assert.equal(runtime.has(`${row.conversationId}/${row.turnId}`), false);
    runtime.set(`${row.conversationId}/${row.turnId}`, row);
  }
}
const files = [
  'experiments/gliner-input/interpreter.ts', 'experiments/gliner-input/provider.mjs',
  'experiments/gliner-input/run.mjs', 'experiments/gliner-input/gliner_extract.py',
  'experiments/gliner-input/requirements.txt', 'experiments/gliner-input/cases-v2.json',
  'lib/input-candidates.ts', 'lib/input-propositions.ts', 'lib/input-spelling.ts',
  'lib/input-state.ts', 'lib/input-experiences.ts', 'lib/search.ts', 'lib/requirements.ts', 'lib/types.ts',
];
const manifest = async () => Promise.all(files.map(async file => ({ file, sha256: sha(await readFile(resolve(web, file))) })));
const canonical = state => {
  const valid = validateIntentState(state), filters = valid.filters;
  const categories = [...(filters.categories ?? (filters.category ? [filters.category] : []))].sort();
  return {
    filters: {
      dateFrom: filters.dateFrom, dateTo: filters.dateTo, maxPrice: filters.maxPrice,
      maxPriceExclusive: filters.maxPriceExclusive ?? false, partySize: filters.partySize ?? null,
      totalBudget: filters.totalBudget ?? null, categories,
      excludedCategories: [...(filters.excludedCategories ?? [])].sort(), district: filters.district ?? null,
      startTimeFrom: filters.startTimeFrom ?? null, startTimeTo: filters.startTimeTo ?? null,
      startTimeFromExclusive: filters.startTimeFromExclusive ?? false, startTimeToExclusive: filters.startTimeToExclusive ?? false,
    },
    requirements: valid.requirements.map(row => `${row.kind}:${row.value}:${row.policy}`).sort(),
    primaryTopics: [...(valid.primaryTopics ?? [])].sort(),
    preferences: { mood: valid.preferences.mood, companion: valid.preferences.companion,
      interests: [...valid.preferences.interests].sort(), experiences: [...(valid.preferences.experiences ?? [])].sort(), order: valid.preferences.order ?? null },
  };
};
function differences(actual, expected, path = '') {
  if (typeof actual === 'number' && typeof expected === 'number') return Math.abs(actual - expected) <= 1e-9 ? [] : [{ path, actual, expected }];
  if (Array.isArray(actual) || Array.isArray(expected)) return JSON.stringify(actual) === JSON.stringify(expected) ? [] : [{ path, actual, expected }];
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object')
    return [...new Set([...Object.keys(actual), ...Object.keys(expected)])].flatMap(key => differences(actual[key], expected[key], path ? `${path}.${key}` : key));
  return actual === expected ? [] : [{ path, actual, expected }];
}
function score(record, turn) {
  const expected = turn.expected;
  const actualStatus = record.result.issue ? (record.result.issue.startsWith('unsupported_') ? 'unsupported' : 'clarify') : 'executable';
  const diffs = differences(canonical(record.result.state), canonical(expected.state));
  const statusCorrect = actualStatus === expected.status;
  const issueCorrect = (record.result.issue ?? null) === (expected.issue ?? null);
  const atomic = record.result.issue ? differences(canonical(record.result.state), canonical(record.previous)).length === 0 : true;
  const notApplied = record.result.diagnostics?.unappliedPreferences ?? [];
  const missingUnapplied = (expected.notApplied ?? []).filter(item => !notApplied.some(actual => actual.text.includes(item.span) || item.span.includes(actual.text)));
  const manual = diffs.some(row => row.path === 'primaryTopics' || row.path === 'preferences.interests');
  return { actualStatus, expectedStatus: expected.status, statusCorrect, issueCorrect, atomic,
    accuracyGate: expected.accuracyGate !== false, goldDisputed: expected.goldDisputed === true,
    differences: diffs, missingUnapplied, manualEquivalenceReviewNeeded: manual,
    automaticStrictPass: statusCorrect && issueCorrect && atomic && diffs.length === 0 && missingUnapplied.length === 0 };
}
function glinerFor(current, pendingRows) {
  const rows = [{ row: current, message: 'current', offset: 0 }];
  let offset = 0;
  for (const row of pendingRows) {
    rows.push({ row, message: 'pending', offset });
    offset += [...row.message].length + 1;
  }
  const source = { current: current.message, pending: pendingRows.map(row => row.message).join('\n') };
  const anchor = (value, message, shift) => ({ message, start: value.start + shift, end: value.end + shift, text: value.text });
  return {
    coordinateSpace: 'python-codepoint',
    spans: rows.flatMap(({ row, message, offset: shift }) => row.spans.map(span => ({ ...anchor(span, message, shift), type: span.type, score: span.score }))),
    relations: rows.flatMap(({ row, message, offset: shift }) => row.relations.map(relation => {
      const head = anchor(relation.head, message, shift), tail = anchor(relation.tail, message, shift);
      const start = Math.min(head.start, tail.start), end = Math.max(head.end, tail.end);
      return { message, start, end, text: [...source[message]].slice(start, end).join(''), type: relation.type, score: relation.score, head, tail };
    })),
  };
}
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
}
async function summarize(file) {
  const rows = (await json(file)).records;
  const arms = {};
  for (const arm of ['exact-clauses-jev', 'gliner-clauses-jev']) {
    const selected = rows.filter(row => row.arm === arm);
    const gated = selected.filter(row => row.score.accuracyGate);
    const executable = gated.filter(row => row.score.expectedStatus === 'executable');
    const regression = gated.filter(row => row.cohort === 'regression-original');
    arms[arm] = {
      totalTurns: selected.length, accuracyGateTurns: gated.length, goldDisputedTurns: selected.filter(row => row.score.goldDisputed).length,
      automaticStrictPass: gated.filter(row => row.score.automaticStrictPass).length,
      supportedTurns: executable.length, supportedAutomaticStrictPass: executable.filter(row => row.score.automaticStrictPass).length,
      regressionTurns: regression.length, regressionAutomaticStrictPass: regression.filter(row => row.score.automaticStrictPass).length,
      atomicRefusals: selected.filter(row => row.result.issue && row.score.atomic).length,
      nonAtomicRefusals: selected.filter(row => !row.score.atomic).length,
      manualReviewTurns: selected.filter(row => row.score.manualEquivalenceReviewNeeded).map(row => `${row.conversationId}/${row.turnId}`),
      apiP50Ms: percentile(selected.filter(row => row.provider).map(row => row.provider.elapsedMs), .5),
      apiP95Ms: percentile(selected.filter(row => row.provider).map(row => row.provider.elapsedMs), .95),
      glinerWarmP50Ms: arm.startsWith('gliner') ? percentile(selected.map(row => row.glinerInferenceMs), .5) : 0,
      glinerWarmP95Ms: arm.startsWith('gliner') ? percentile(selected.map(row => row.glinerInferenceMs), .95) : 0,
      warmReconstructedStageP50Ms: percentile(selected.filter(row => row.provider).map(row => row.provider.elapsedMs + row.buildMs + row.compileMs + row.glinerInferenceMs), .5),
      warmReconstructedStageP95Ms: percentile(selected.filter(row => row.provider).map(row => row.provider.elapsedMs + row.buildMs + row.compileMs + row.glinerInferenceMs), .95),
    };
  }
  const report = { at: new Date().toISOString(), corpusSha256: sha(corpusRaw), arms, usage: await summary(),
    latencyQualification: 'Sequential concurrency=1, desktop CPU GLiNER outputs precomputed once. Warm reconstructed stage timings add recorded extraction time to measured Jev/build/compile durations; they are not Cloud Run or HTTP end-to-end latency. Model load measured separately.',
    gateQualification: 'Automatic exact-state score; all free-text differences require source-based human review. Two disputed gold cases remain reported and excluded from strict acceptance before provider calls.',
    deployed: false, documentEmbeddings: 0, voyageCalls: 0 };
  await writeFile(resolve(work, mode === '--final' ? 'final-summary.json' : 'main-summary.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report));
}
if (mode === '--score') { await summarize(resolve(work, 'main-results.json')); process.exit(0); }
const conversations = corpus.conversations.filter(row => mode === '--final' ? row.cohort === 'final-confirmation' : row.cohort !== 'final-confirmation');
const total = conversations.reduce((n, row) => n + row.turns.length, 0);
assert.equal(total, mode === '--final' ? 4 : 36);
assert.equal(runtime.size, total);
for (const conversation of conversations) for (const turn of conversation.turns) {
  const row = runtime.get(`${conversation.id}/${turn.id}`);
  assert.ok(row); assert.equal(row.message, turn.message);
  validateIntentState(turn.expected.state);
}
if (mode === '--prepare') {
  assert.equal((await entries()).length, 0);
  const requestShapes = [];
  for (const conversation of conversations) for (const turn of conversation.turns) {
    for (const arm of ['exact-clauses-jev', 'gliner-clauses-jev']) {
      try {
        const built = buildExperimentRequest({ message: turn.message, previous: emptyIntentState(), now,
          ...(arm.startsWith('gliner') ? { gliner: glinerFor(runtime.get(`${conversation.id}/${turn.id}`), []) } : {}) });
        requestShapes.push({ conversationId: conversation.id, turnId: turn.id, arm,
          requestBytes: Buffer.byteLength(JSON.stringify(built.request)), questions: Object.keys(built.request.questions).length });
      } catch (error) { requestShapes.push({ conversationId: conversation.id, turnId: turn.id, arm, error: error.message }); }
    }
  }
  const receipt = { at: new Date().toISOString(), corpusSha256: sha(corpusRaw), sourceManifest: await manifest(),
    runtimeSha256: sha(await readFile(runtimeFile)), runtimeRows: total, requestShapes,
    previousStateQualification: 'Preparation shapes use empty state only. Evaluation always uses each arm own actual returned state and pending input.',
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: web, encoding: 'utf8' }).trim(),
    dirtyStatusSha256: sha(execFileSync('git', ['status', '--porcelain=v1'], { cwd: web })), providerCalls: 0 };
  await writeFile(resolve(work, 'prepare.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ prepared: true, runtimeRows: total, maxRequestBytes: Math.max(...requestShapes.map(row => row.requestBytes ?? 0)),
    maxQuestions: Math.max(...requestShapes.map(row => row.questions ?? 0)), preflightErrors: requestShapes.filter(row => row.error) }));
  process.exit(0);
}
const prepared = await json(resolve(work, 'prepare.json'));
assert.equal(prepared.corpusSha256, sha(corpusRaw));
assert.deepEqual(await manifest(), prepared.sourceManifest, 'Code/schema/gold changed since preparation.');
const resultFile = resolve(work, mode === '--final' ? 'final-results.json' : 'main-results.json');
const records = [];
const startingLedger = await entries();
if (mode === '--main') assert.equal(startingLedger.length, 0, 'Main evaluation is a single run.');
else {
  const main = await json(resolve(work, 'main-results.json')); assert.equal(main.complete, true);
  assert.ok(!startingLedger.some(row => row.cohort === 'final-confirmation'), 'Final confirmation is a single run.');
}
await writeFile(resultFile, JSON.stringify({ at: new Date().toISOString(), corpusSha256: sha(corpusRaw), complete: false, records }, null, 2), { flag: 'wx' });
let turnOrdinal = 0;
for (const conversation of conversations) {
  const states = new Map(['exact-clauses-jev', 'gliner-clauses-jev'].map(arm => [arm, emptyIntentState()]));
  const pending = new Map(['exact-clauses-jev', 'gliner-clauses-jev'].map(arm => [arm, []]));
  for (const turn of conversation.turns) {
    const current = runtime.get(`${conversation.id}/${turn.id}`);
    const armOrder = turnOrdinal++ % 2 ? ['gliner-clauses-jev', 'exact-clauses-jev'] : ['exact-clauses-jev', 'gliner-clauses-jev'];
    for (const arm of armOrder) {
      assert.deepEqual(await manifest(), prepared.sourceManifest, 'Evaluation source changed.');
      const previous = structuredClone(states.get(arm)), pendingRows = pending.get(arm);
      const input = { message: turn.message, previous, now,
        ...(pendingRows.length ? { unresolvedRequest: pendingRows.map(row => row.message).join('\n') } : {}),
        ...(arm.startsWith('gliner') ? { gliner: glinerFor(current, pendingRows) } : {}) };
      const dir = resolve(work, 'captures', arm, conversation.id, turn.id);
      await mkdir(dir, { recursive: true });
      const buildStarted = performance.now();
      let built, buildError;
      try { built = buildExperimentRequest(input); } catch (error) { buildError = error.message; }
      const buildMs = performance.now() - buildStarted;
      let result, provider, compileMs = 0;
      if (!built) result = { state: previous, issue: 'constraint_ambiguous', action: 'search', diagnostics: { buildError } };
      else {
        await writeFile(resolve(dir, 'context.json'), JSON.stringify(built.context, null, 2), { flag: 'wx' });
        provider = await callJev(built.request, { arm, cohort: conversation.cohort, conversationId: conversation.id, turnId: turn.id }, dir);
        const compileStarted = performance.now();
        try { result = compileExperimentResponse(provider.response, built.context); }
        catch (error) { result = { state: previous, issue: 'constraint_ambiguous', action: 'search', diagnostics: { compileError: error.message } }; }
        compileMs = performance.now() - compileStarted;
      }
      validateIntentState(result.state);
      if (result.issue) pending.set(arm, [...pendingRows, current]);
      else { states.set(arm, result.state); pending.set(arm, []); }
      const record = { arm, cohort: conversation.cohort, family: conversation.family, conversationId: conversation.id, turnId: turn.id,
        message: turn.message, previous, unresolvedRequest: input.unresolvedRequest ?? null, result,
        ...(provider ? { provider: { ordinal: provider.ordinal, elapsedMs: provider.elapsedMs, requestBytes: provider.requestBytes, questionCount: provider.questionCount, usage: provider.response.usage } } : {}),
        buildMs, compileMs, glinerInferenceMs: arm.startsWith('gliner') ? current.timing.inferenceSeconds * 1000 : 0 };
      record.score = score(record, turn);
      records.push(record);
      await writeFile(resolve(dir, 'result.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
      await writeFile(resultFile, JSON.stringify({ at: new Date().toISOString(), corpusSha256: sha(corpusRaw), sourceManifest: prepared.sourceManifest, complete: false, records }, null, 2));
      console.log(JSON.stringify({ arm, conversationId: conversation.id, turnId: turn.id, issue: result.issue, automaticStrictPass: record.score.automaticStrictPass, calls: provider ? 1 : 0 }));
    }
  }
}
await writeFile(resultFile, JSON.stringify({ at: new Date().toISOString(), corpusSha256: sha(corpusRaw), sourceManifest: prepared.sourceManifest, complete: true, records }, null, 2));
await summarize(resultFile);
