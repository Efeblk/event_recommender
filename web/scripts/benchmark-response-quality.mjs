import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_FIXTURE = resolve(webRoot, 'fixtures/response-quality-benchmark-v1.json');

const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
};
export const canonicalJson = (value) => JSON.stringify(stable(value));
export const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
const compareText = (a, b) => a.localeCompare(b);
const contractState = (state) => {
  const { committed: _committed, ...observed } = state ?? {};
  return { ...observed, required: [...(observed.required ?? [])].sort(compareText), excluded: [...(observed.excluded ?? [])].sort(compareText), optional: [...(observed.optional ?? [])].sort(compareText) };
};
const contractPrior = (prior) => {
  const committed = prior?.committed ?? {};
  if (committed.filters) return { committed: contractState(committed) };
  return { committed: contractState({ filters: committed, required: [], excluded: [], optional: [], logic: 'AND', action: 'search' }) };
};

function compareExact(path, expected, actual, failures) {
  if (!same(expected, actual)) failures.push({ code: 'exact_mismatch', path, expected, actual });
}

function validateCard(card, event, expectedState, failures) {
  if (!event) return failures.push({ code: 'unknown_record', recordId: card.recordId });
  if (card.familyId !== event.familyId) failures.push({ code: 'family_mismatch', recordId: card.recordId });
  const references = new Set(card.sourceReferences ?? []);
  if (!event.sources.some((source) => references.has(source.id))) failures.push({ code: 'missing_source_reference', recordId: card.recordId });
  for (const key of expectedState.required ?? []) {
    if (event.evidence[key] !== true || !references.has(event.evidenceSources[key])) failures.push({ code: 'missing_required_evidence', recordId: card.recordId, key });
  }
  for (const key of expectedState.excluded ?? []) {
    const category = key.startsWith('category:') ? key.slice('category:'.length) : null;
    const normalizedCategory = event.category.toLocaleLowerCase('tr-TR');
    const categoryAliases = { concert: 'konser', theatre: 'tiyatro', workshop: 'atölye' };
    if (event.evidence[key] === true || (category && normalizedCategory === (categoryAliases[category] ?? category))) failures.push({ code: 'positive_excluded_topic', recordId: card.recordId, key });
  }
  const filters = expectedState.filters ?? {};
  if (card.price !== undefined && card.price !== event.price) failures.push({ code: 'price_fact_mismatch', recordId: card.recordId, expected: event.price, actual: card.price });
  if (filters.date && event.date !== filters.date) failures.push({ code: 'hard_filter_failure', recordId: card.recordId, key: 'date' });
  if (filters.maxPrice !== undefined && !(event.price <= filters.maxPrice)) failures.push({ code: 'hard_filter_failure', recordId: card.recordId, key: 'maxPrice' });
  if (filters.categories?.length && !filters.categories.includes(event.category)) failures.push({ code: 'hard_filter_failure', recordId: card.recordId, key: 'categories' });
  if (filters.categoryAny?.length && !filters.categoryAny.includes(event.category)) failures.push({ code: 'or_arm_failure', recordId: card.recordId, key: 'categoryAny' });
  if (filters.city && event.city !== filters.city) failures.push({ code: 'hard_filter_failure', recordId: card.recordId, key: 'city' });
  if (filters.district && event.district !== filters.district) failures.push({ code: 'hard_filter_failure', recordId: card.recordId, key: 'district' });
  if (filters.partySize !== undefined && event.availableQuantity !== undefined && event.availableQuantity < filters.partySize) failures.push({ code: 'hard_filter_failure', recordId: card.recordId, key: 'partySize' });
  if (filters.totalBudget !== undefined && filters.partySize !== undefined && event.price * filters.partySize > filters.totalBudget) failures.push({ code: 'hard_filter_failure', recordId: card.recordId, key: 'totalBudget' });
  for (const key of ['supportScore', 'optionalFitScore']) {
    if (card[key] !== undefined && (!Number.isFinite(card[key]) || card[key] < 0 || card[key] > 1)) failures.push({ code: 'invalid_card_score', recordId: card.recordId, key });
  }
}

export function scoreRun(dataset, run, options = {}) {
  const interpretationOnly = options.stage === 'interpretation';
  const failures = [];
  const caseResults = [];
  const catalog = new Map(dataset.catalog.map((event) => [event.recordId, event]));
  const actualCases = new Map();
  for (const item of run.cases ?? []) {
    if (actualCases.has(item.id)) failures.push({ caseId: item.id, code: 'duplicate_case' });
    else actualCases.set(item.id, item);
  }
  let expectedRecordCount = 0;
  let foundRecordCount = 0;
  let expectedFamilyCount = 0;
  let foundFamilyCount = 0;
  let interpretationTurns = 0;
  let passedInterpretationTurns = 0;
  const interpretationCodes = new Set(['missing_case', 'missing_turn', 'duplicate_turn', 'extraneous_turn', 'turn_count', 'exact_mismatch', 'false_clarification', 'atomic_refusal_cards', 'atomic_refusal_retrieval', 'atomic_refusal_mutated_state', 'human_review_needed', 'unknown_disposition']);
  for (const testCase of dataset.cases) {
    const actualCase = actualCases.get(testCase.id);
    const turnResults = [];
    if (!actualCase) {
      failures.push({ caseId: testCase.id, code: 'missing_case' });
      for (const expected of testCase.turns) {
        interpretationTurns += 1;
        if (!interpretationOnly) {
          expectedRecordCount += expected.recall?.recordIds?.length ?? 0;
          expectedFamilyCount += expected.recall?.familyIds?.length ?? 0;
          for (const recordId of expected.recall?.recordIds ?? []) failures.push({ caseId: testCase.id, turnId: expected.id, code: 'missing_recall_record', recordId });
          for (const familyId of expected.recall?.familyIds ?? []) failures.push({ caseId: testCase.id, turnId: expected.id, code: 'missing_recall_family', familyId });
        }
      }
      caseResults.push({ id: testCase.id, pass: false, turns: [] });
      continue;
    }
    const expectedTurns = testCase.turns;
    const actualTurns = actualCase.turns ?? [];
    const actualTurnIds = new Set();
    const duplicateTurnIds = new Set();
    for (const turn of actualTurns) {
      if (actualTurnIds.has(turn.id)) duplicateTurnIds.add(turn.id);
      actualTurnIds.add(turn.id);
      if (!expectedTurns.some((expected) => expected.id === turn.id)) failures.push({ caseId: testCase.id, turnId: turn.id, code: 'extraneous_turn' });
    }
    for (let index = 0; index < expectedTurns.length; index += 1) {
      const expected = expectedTurns[index];
      const actual = actualTurns.find((turn) => turn.id === expected.id);
      const turnFailures = [];
      interpretationTurns += 1;
      if (!interpretationOnly) {
        expectedRecordCount += expected.recall?.recordIds?.length ?? 0;
        expectedFamilyCount += expected.recall?.familyIds?.length ?? 0;
      }
      if (duplicateTurnIds.has(expected.id)) turnFailures.push({ code: 'duplicate_turn' });
      if (!actual) turnFailures.push({ code: 'missing_turn', turnId: expected.id });
      else {
        compareExact('message', expected.message, actual.message, turnFailures);
        compareExact('priorState', contractPrior(expected.priorState), contractPrior(actual.priorState), turnFailures);
        compareExact('pendingState', expected.pendingState ?? null, actual.pendingState ?? null, turnFailures);
        compareExact('state', contractState(expected.expectedState), contractState(actual.state), turnFailures);
        const shouldRefuse = ['clarify', 'refuse'].includes(expected.expectedState.action);
        if (shouldRefuse) {
          if ((actual.cards ?? []).length) turnFailures.push({ code: 'atomic_refusal_cards' });
          if ((actual.usage?.retrievalCalls ?? 0) !== 0) turnFailures.push({ code: 'atomic_refusal_retrieval' });
          if (expected.preservePrior && actual.atomicStateUnchanged !== true) turnFailures.push({ code: 'atomic_refusal_mutated_state' });
        } else if (actual.state.action === 'clarify') turnFailures.push({ code: 'false_clarification' });
        const cards = actual.cards ?? [];
        if (!interpretationOnly) for (const card of cards) validateCard(card, catalog.get(card.recordId), expected.expectedState, turnFailures);
        const seenFamilies = new Set();
        for (const card of cards) {
          if (!interpretationOnly && seenFamilies.has(card.familyId)) turnFailures.push({ code: 'semantic_duplicate', familyId: card.familyId });
          seenFamilies.add(card.familyId);
        }
        const ids = new Set(cards.map((card) => card.recordId));
        const families = new Set(cards.map((card) => card.familyId));
        if (!interpretationOnly) for (const id of expected.recall?.recordIds ?? []) if (!ids.has(id)) turnFailures.push({ code: 'missing_recall_record', recordId: id });
        if (!interpretationOnly) for (const family of expected.recall?.familyIds ?? []) if (!families.has(family)) turnFailures.push({ code: 'missing_recall_family', familyId: family });
        if (actual.disposition === 'human_review_needed') turnFailures.push({ code: 'human_review_needed' });
        if (actual.disposition === 'unknown') turnFailures.push({ code: 'unknown_disposition' });
        if (!interpretationOnly) foundRecordCount += (expected.recall?.recordIds ?? []).filter((id) => ids.has(id)).length;
        if (!interpretationOnly) foundFamilyCount += (expected.recall?.familyIds ?? []).filter((family) => families.has(family)).length;
        if (actual.usage) {
          for (const key of ['latencyMs', 'inputTokens', 'outputTokens', 'costUsd']) {
            if (actual.usage[key] !== undefined && (!Number.isFinite(actual.usage[key]) || actual.usage[key] < 0)) turnFailures.push({ code: 'invalid_usage', key });
          }
        }
      }
      failures.push(...turnFailures.map((failure) => ({ caseId: testCase.id, turnId: expected.id, ...failure })));
      if (!turnFailures.some((failure) => interpretationCodes.has(failure.code))) passedInterpretationTurns += 1;
      turnResults.push({ id: expected.id, pass: turnFailures.length === 0, failures: turnFailures });
    }
    if (actualTurns.length !== expectedTurns.length) failures.push({ caseId: testCase.id, code: 'turn_count', expected: expectedTurns.length, actual: actualTurns.length });
    caseResults.push({ id: testCase.id, pass: turnResults.every((turn) => turn.pass) && actualTurns.length === expectedTurns.length, turns: turnResults });
  }
  for (const id of actualCases.keys()) if (!dataset.cases.some((testCase) => testCase.id === id)) failures.push({ caseId: id, code: 'extraneous_case' });

  const allTurns = (run.cases ?? []).flatMap((testCase) => testCase.turns ?? []);
  const observedUsage = allTurns.map((turn) => turn.usage).filter(Boolean);
  const usage = { observations: observedUsage.length, note: 'Totals include only values explicitly recorded by the adapter; absent usage is unknown and never estimated.' };
  for (const key of ['latencyMs', 'inputTokens', 'outputTokens', 'costUsd']) {
    const values = observedUsage.filter((item) => item[key] !== undefined).map((item) => item[key]);
    if (values.length) usage[key] = { observations: values.length, total: values.reduce((sum, value) => sum + value, 0) };
  }
  const cardFailureCodes = new Set(['unknown_record', 'family_mismatch', 'missing_source_reference', 'missing_required_evidence', 'positive_excluded_topic', 'hard_filter_failure', 'or_arm_failure', 'invalid_card_score', 'price_fact_mismatch']);
  const cards = allTurns.flatMap((turn) => turn.cards ?? []);
  const invalidCards = new Set(failures.filter((failure) => cardFailureCodes.has(failure.code)).map((failure) => `${failure.caseId}#${failure.turnId}#${failure.recordId ?? '?'}`));
  const scoreObservation = (key) => {
    const values = cards.map((card) => card[key]).filter((value) => value !== undefined);
    return values.length ? { observations: values.length, min: Math.min(...values), max: Math.max(...values), mean: values.reduce((sum, value) => sum + value, 0) / values.length } : { observations: 0, note: 'Adapter did not report this score.' };
  };
  const quality = {
    interpretation: { passedTurns: passedInterpretationTurns, totalTurns: interpretationTurns },
    cardValidityPrecision: { validCards: Math.max(0, cards.length - invalidCards.size), returnedCards: cards.length, rate: cards.length ? Math.max(0, cards.length - invalidCards.size) / cards.length : null },
    semanticDuplicates: failures.filter((failure) => failure.code === 'semantic_duplicate').length,
    fixedRecordRecall: { found: foundRecordCount, expected: expectedRecordCount, rate: expectedRecordCount ? foundRecordCount / expectedRecordCount : null },
    fixedFamilyRecall: { found: foundFamilyCount, expected: expectedFamilyCount, rate: expectedFamilyCount ? foundFamilyCount / expectedFamilyCount : null },
    supportScore: scoreObservation('supportScore'), optionalFitScore: scoreObservation('optionalFitScore'),
  };
  return { pass: failures.length === 0, failures, cases: caseResults, quality, usage };
}

export function validateDataset(dataset) {
  if (dataset.schemaVersion !== 1 || dataset.id !== 'response-quality-benchmark-v1') throw new Error('Unsupported benchmark fixture');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(dataset.referenceInstant)) throw new Error('referenceInstant must be frozen and explicit');
  if (!['cold', 'warm', 'mixed'].includes(dataset.execution.cacheState) || !Number.isInteger(dataset.execution.concurrency)) throw new Error('Dataset execution labels are invalid');
  const ids = new Set();
  for (const testCase of dataset.cases) {
    if (ids.has(testCase.id)) throw new Error(`Duplicate case ${testCase.id}`);
    ids.add(testCase.id);
    if (!testCase.split || !testCase.turns?.length) throw new Error(`Incomplete case ${testCase.id}`);
  }
}

async function gitProvenance() {
  try {
    const [{ stdout: revision }, { stdout: status }] = await Promise.all([
      execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: webRoot }),
      execFileAsync('git', ['status', '--porcelain=v1'], { cwd: webRoot }),
    ]);
    return { revision: revision.trim(), dirty: status.length > 0, statusHash: sha256(status) };
  } catch { return { revision: null, dirty: null, statusHash: null }; }
}

async function createOnly(path, data) {
  await mkdir(dirname(path), { recursive: true });
  try { await access(path, constants.F_OK); throw new Error(`Refusing to overwrite benchmark artifact: ${path}`); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
}

function parseArgs(argv) {
  const options = { fixture: DEFAULT_FIXTURE, mode: 'offline' };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--fixture') options.fixture = resolve(argv[++index]);
    else if (value === '--run') options.run = resolve(argv[++index]);
    else if (value === '--output') options.output = resolve(argv[++index]);
    else if (value === '--mode') options.mode = argv[++index];
    else if (value === '--adapter') options.adapter = resolve(argv[++index]);
    else if (value === '--subset') options.subset = argv[++index];
    else if (value === '--stage') options.stage = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

export async function runBenchmark(options) {
  const fixtureBytes = await readFile(options.fixture);
  const dataset = JSON.parse(fixtureBytes);
  validateDataset(dataset);
  if (options.subset) {
    if (options.subset !== 'live-interpretation') throw new Error('Unknown subset');
    const selected = new Set(dataset.liveSubset.interpretationTurnIds);
    dataset.cases = dataset.cases.map((testCase) => ({ ...testCase, turns: testCase.turns.filter((turn) => selected.has(`${testCase.id}#${turn.id}`)) })).filter((testCase) => testCase.turns.length);
  }
  if (options.stage && !['interpretation', 'full'].includes(options.stage)) throw new Error('Stage must be interpretation or full');
  let run;
  let source;
  if (options.mode === 'offline') {
    const runPath = options.run ?? resolve(webRoot, dataset.baselineArtifact);
    const bytes = await readFile(runPath);
    run = JSON.parse(bytes);
    source = { kind: 'preserved-artifact', path: runPath, hash: sha256(bytes) };
  } else if (options.mode === 'adapter') {
    if (!options.adapter) throw new Error('Adapter mode requires --adapter; no default adapter or network access exists.');
    const adapter = await import(pathToFileURL(options.adapter).href);
    if (typeof adapter.run !== 'function') throw new Error('Adapter must export async function run(dataset).');
    run = await adapter.run(structuredClone(dataset));
    source = { kind: 'explicit-adapter', path: options.adapter, hash: sha256(await readFile(options.adapter)) };
  } else throw new Error('Mode must be offline or adapter');
  if (options.subset) {
    const selectedCases = new Set(dataset.cases.map((testCase) => testCase.id));
    run = { ...run, cases: (run.cases ?? []).filter((testCase) => selectedCases.has(testCase.id)).map((actualCase) => {
      const expectedCase = dataset.cases.find((testCase) => testCase.id === actualCase.id);
      const selectedTurns = new Set(expectedCase.turns.map((turn) => turn.id));
      return { ...actualCase, turns: (actualCase.turns ?? []).filter((turn) => selectedTurns.has(turn.id)) };
    }) };
  }
  const scored = scoreRun(dataset, run, { stage: options.stage ?? 'full' });
  const report = {
    schemaVersion: 1, benchmarkId: dataset.id, datasetHash: sha256(fixtureBytes), source,
    inputHash: sha256(run), referenceInstant: dataset.referenceInstant, execution: dataset.execution, subset: options.subset ?? 'all', stage: options.stage ?? 'full',
    provenance: { ...run.provenance, scorer: await gitProvenance() },
    acceptance: dataset.acceptance, result: scored,
  };
  if (options.output) await createOnly(options.output, report);
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const report = await runBenchmark(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
    if (!report.result.pass) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 2; }
}
