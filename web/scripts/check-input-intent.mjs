#!/usr/bin/env node
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = resolve(webRoot, 'fixtures/input-intent-v1.json');
const args = parseArgs(process.argv.slice(2));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const schemaFailures = validateFixture(fixture);

if (schemaFailures.length) fail('Fixture validation failed', schemaFailures);

if (args.selfTest) runEvaluatorSelfTests();
else if (args.live) await runLive(fixture, args);
else if (args.replay) await runReplay(fixture, args.replay);
else {
  const interpreter = await loadInterpreter();
  for (const name of ['buildInputInterpreterRequest', 'parseInputInterpreterResponse', 'interpretInput'])
    if (typeof interpreter[name] !== 'function') throw new Error(`Input interpreter must export ${name}().`);
  const contractInput = {
    message: fixture.cases[0].message,
    previous: emptyPrevious(),
    now: new Date(`${fixture.referenceDate}T12:00:00+03:00`),
  };
  const request = interpreter.buildInputInterpreterRequest('jev-contract-check', contractInput);
  if (!request || typeof request !== 'object') throw new Error('buildInputInterpreterRequest() must return an object.');
  console.log(
    JSON.stringify(
      {
        status: 'pass',
        mode: 'schema-and-contract',
        fixture: relative(webRoot, fixturePath).replaceAll('\\', '/'),
        cases: fixture.cases.length,
        liveRequests: 0,
        note: 'Deterministic fixture/export/request contract validation only; this is not semantic model accuracy.',
      },
      null,
      2,
    ),
  );
}

function parseArgs(argv) {
  const parsed = { caseIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') parsed.live = true;
    else if (arg === '--self-test') parsed.selfTest = true;
    else if (arg === '--case-id') parsed.caseIds.push(requireValue(argv, ++index, arg));
    else if (arg === '--max-calls') parsed.maxCalls = Number(requireValue(argv, ++index, arg));
    else if (arg === '--pace-ms') parsed.paceMs = Number(requireValue(argv, ++index, arg));
    else if (arg === '--evidence-dir') parsed.evidenceDir = requireValue(argv, ++index, arg);
    else if (arg === '--replay') parsed.replay = requireValue(argv, ++index, arg);
    else if (arg === '--help') {
      console.log('Usage: node --experimental-strip-types scripts/check-input-intent.mjs [--replay FILE | --live --case-id ID... --max-calls N --evidence-dir outputs/input-intent/RUN] [--pace-ms 1200]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if ([parsed.live, Boolean(parsed.replay), parsed.selfTest].filter(Boolean).length > 1)
    throw new Error('--live, --replay, and --self-test are mutually exclusive.');
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

function validateFixture(value) {
  const failures = [];
  if (!value || typeof value !== 'object') return ['root must be an object'];
  if (value.schemaVersion !== 1) failures.push('schemaVersion must be 1');
  if (value.referenceDate !== '2026-09-28') failures.push('referenceDate must remain frozen at 2026-09-28');
  if (value.timeZone !== 'Europe/Istanbul') failures.push('timeZone must be Europe/Istanbul');
  if (!Array.isArray(value.cases) || value.cases.length < 40 || value.cases.length > 60)
    failures.push('cases must contain 40-60 entries');
  const ids = new Set();
  const allowedStatuses = new Set(['ok', 'clarify', 'unsupported_location', 'alternatives', 'reset', 'reset_with_input']);
  const allowedExpectedKeys = new Set(['status', 'filters', 'requirements', 'soft', 'clarification', 'clearedFilters', 'safety']);
  const nestedExpectedKeys = {
    requirements: new Set(['add', 'retain', 'remove', 'addExclusions', 'clearAll']),
    soft: new Set(['queryIncludes', 'queryExcludes', 'mood', 'companion', 'clearAll']),
    clarification: new Set(['reason']),
    safety: new Set(['mustNotReset', 'mustNotClearConstraints', 'mustNotExcludeCategories']),
  };
  for (const [index, testCase] of (value.cases ?? []).entries()) {
    const at = `cases[${index}]`;
    if (!testCase || typeof testCase !== 'object') { failures.push(`${at} must be an object`); continue; }
    if (!/^[a-z0-9-]+$/.test(testCase.id ?? '')) failures.push(`${at}.id is invalid`);
    if (ids.has(testCase.id)) failures.push(`${at}.id is duplicated: ${testCase.id}`);
    if (testCase.parent && !ids.has(testCase.parent)) failures.push(`${testCase.id}.parent must refer to an earlier case`);
    ids.add(testCase.id);
    if (!['tr', 'en', 'mixed'].includes(testCase.language)) failures.push(`${testCase.id}.language is invalid`);
    if (typeof testCase.message !== 'string' || !testCase.message.trim()) failures.push(`${testCase.id}.message is empty`);
    if (!testCase.expected || !allowedStatuses.has(testCase.expected.status)) failures.push(`${testCase.id}.expected.status is invalid`);
    for (const key of Object.keys(testCase.expected ?? {}))
      if (!allowedExpectedKeys.has(key)) failures.push(`${testCase.id}.expected has unknown key: ${key}`);
    for (const [section, allowed] of Object.entries(nestedExpectedKeys))
      for (const key of Object.keys(testCase.expected?.[section] ?? {}))
        if (!allowed.has(key)) failures.push(`${testCase.id}.expected.${section} has unknown key: ${key}`);
    if (testCase.expected?.status === 'clarify' && !testCase.expected.clarification?.reason)
      failures.push(`${testCase.id} clarification must name a reason`);
  }
  return failures;
}

async function loadInterpreter() {
  try {
    return await import('../lib/input-interpreter.ts');
  } catch (error) {
    throw new Error(`Could not load input interpreter: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runReplay(fixtureValue, replayPath) {
  const value = JSON.parse(await readFile(resolve(replayPath), 'utf8'));
  const records = Array.isArray(value) ? value : value.records;
  if (!Array.isArray(records)) throw new Error('Replay must be an array or an object with a records array.');
  if (!records.length) throw new Error('Replay contains no records.');
  const knownIds = new Set(fixtureValue.cases.map((testCase) => testCase.id));
  const byId = new Map();
  for (const record of records) {
    if (!knownIds.has(record.caseId)) throw new Error(`Replay contains unknown case ID: ${record.caseId}`);
    if (byId.has(record.caseId)) throw new Error(`Replay contains duplicate case ID: ${record.caseId}`);
    byId.set(record.caseId, record);
  }
  const expectedStates = materializeExpectedStates(fixtureValue);
  const evaluations = fixtureValue.cases
    .filter((testCase) => byId.has(testCase.id))
    .map((testCase) => {
      const record = byId.get(testCase.id);
      if (record.result?.issue && !record.previous)
        return { caseId: testCase.id, expected: testCase.expected, pass: false, mismatches: ['issue record is missing previous state snapshot'] };
      return evaluate(testCase, record.result, expectedStates.get(testCase.id), record.previous ?? expectedStates.get(testCase.parent));
    });
  reportEvaluation('replay', evaluations, 0, undefined, fixtureValue.cases.length);
}

async function runLive(fixtureValue, options) {
  if (!options.caseIds.length) throw new Error('--live requires at least one explicit --case-id.');
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 12)
    throw new Error('--live requires --max-calls between 1 and 12.');
  if (options.caseIds.length > options.maxCalls)
    throw new Error('Selected case count exceeds --max-calls; no request was made.');
  if (!options.evidenceDir) throw new Error('--live requires --evidence-dir under web/outputs/.');
  const evidenceDir = resolve(options.evidenceDir);
  const allowedRoot = resolve(webRoot, 'outputs');
  if (evidenceDir !== allowedRoot && !evidenceDir.startsWith(`${allowedRoot}\\`) && !evidenceDir.startsWith(`${allowedRoot}/`))
    throw new Error('--evidence-dir must resolve under ignored web/outputs/.');
  const apiKey = process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) throw new Error('TYPESAFE_API_KEY must be set in the process environment; no secret files are auto-discovered and no request was made.');
  const model = process.env.TYPESAFE_MODEL?.trim() || 'jev-1.13.0';
  if (!/^jev-[a-z0-9.-]+$/.test(model)) throw new Error('TYPESAFE_MODEL is invalid; no request was made.');
  const selected = options.caseIds.map((id) => {
    const found = fixtureValue.cases.find((testCase) => testCase.id === id);
    if (!found) throw new Error(`Unknown --case-id: ${id}`);
    return found;
  });
  const interpreter = await loadInterpreter();
  const expectedStates = materializeExpectedStates(fixtureValue);
  const records = [];
  const states = new Map();
  const pending = new Map();
  const paceMs = options.paceMs === undefined ? 1200 : options.paceMs;
  if (!Number.isInteger(paceMs) || paceMs < 250) throw new Error('--pace-ms must be an integer of at least 250.');
  await mkdir(evidenceDir, { recursive: true });
  const outputPath = resolve(evidenceDir, `input-intent-${new Date().toISOString().replaceAll(':', '-')}.json`);
  const provenance = await buildProvenance(fixtureValue, model);
  let liveRequests = 0;
  let remainingInputTokens = process.env.BIPLAN_LIVE_REMAINING_INPUT_TOKENS === undefined
    ? Infinity
    : Number(process.env.BIPLAN_LIVE_REMAINING_INPUT_TOKENS);
  if (!(remainingInputTokens >= 64_000)) throw new Error('Insufficient interpretation token allowance; no provider request was made.');

  for (const [index, testCase] of selected.entries()) {
    const previous = testCase.parent ? states.get(testCase.parent) : undefined;
    if (testCase.parent && !previous)
      throw new Error(`${testCase.id} requires parent ${testCase.parent}; select it earlier in this run.`);
    const input = {
      message: testCase.message,
      previous: previous ?? emptyPrevious(),
      now: new Date(`${fixtureValue.referenceDate}T12:00:00+03:00`),
      ...(testCase.parent && pending.has(testCase.parent)
        ? { unresolvedRequest: pending.get(testCase.parent) }
        : {}),
    };
    let rawRequest;
    let rawResponse;
    let responseStatus;
    const fetcher = async (url, init) => {
      // Reserve the provider's full request context before each attempted call.
      // Missing usage is conservatively charged the entire reservation.
      if (remainingInputTokens < 64_000) throw new Error('Interpretation token allowance reached.');
      remainingInputTokens -= 64_000;
      liveRequests += 1;
      rawRequest = redactRequest(url, init);
      const response = await fetch(url, init);
      responseStatus = response.status;
      const text = await readLimitedResponse(response, 1_000_000);
      rawResponse = safeJson(text);
      const billed = rawResponse?.usage?.input_tokens;
      if (Number.isInteger(billed) && billed >= 0 && billed <= 64_000)
        remainingInputTokens += 64_000 - billed;
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const startedAt = new Date();
    const before = performance.now();
    let result;
    let error;
    try {
      result = await interpreter.interpretInput(input, { config: { apiKey, model }, fetcher, timeoutMs: 8000 });
      states.set(testCase.id, result.state);
      if (result.issue)
        pending.set(testCase.id, result.action === 'reset' || !input.unresolvedRequest
          ? input.message
          : `${input.unresolvedRequest}\n${input.message}`);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    records.push({
      caseId: testCase.id,
      previous: input.previous,
      unresolvedRequest: input.unresolvedRequest ?? null,
      startedAt: startedAt.toISOString(),
      latencyMs: Math.round(performance.now() - before),
      provenance,
      request: rawRequest,
      response: rawResponse,
      responseStatus,
      usage: extractUsage(rawResponse),
      result,
      error,
    });
    await writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, complete: false, records }, null, 2)}\n`);
    if (index + 1 < selected.length) await new Promise((done) => setTimeout(done, paceMs));
  }
  await writeFile(outputPath, `${JSON.stringify({ schemaVersion: 1, complete: true, records }, null, 2)}\n`);
  const evaluations = selected.map((testCase) => {
    const record = records.find((item) => item.caseId === testCase.id);
    return record.result ? evaluate(testCase, record.result, expectedStates.get(testCase.id), record.previous) : { caseId: testCase.id, expected: testCase.expected, pass: false, mismatches: [`call error: ${record.error}`] };
  });
  reportEvaluation('live', evaluations, liveRequests, outputPath, fixtureValue.cases.length);
}

async function readLimitedResponse(response, limit) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new Error(`Provider response exceeded ${limit} bytes.`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new Error(`Provider response exceeded ${limit} bytes.`); }
    chunks.push(value);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

async function buildProvenance(fixtureValue, model) {
  const sourcePaths = [
    fixturePath,
    resolve(webRoot, 'scripts/check-input-intent.mjs'),
    resolve(webRoot, 'lib/input-interpreter.ts'),
    resolve(webRoot, 'lib/input-literals.ts'),
    resolve(webRoot, 'lib/input-candidates.ts'),
    resolve(webRoot, 'lib/input-state.ts'),
  ];
  const hash = createHash('sha256');
  for (const path of sourcePaths) hash.update(await readFile(path));
  return {
    fixture: 'input-intent-v1', referenceDate: fixtureValue.referenceDate,
    timeZone: fixtureValue.timeZone, model, mode: 'live', retries: 0,
    gitSha: await readGitSha(), dirtyFileHash: hash.digest('hex'),
  };
}

async function readGitSha() {
  try {
    const dotGit = (await readFile(resolve(webRoot, '..', '.git'), 'utf8')).trim();
    const gitDir = dotGit.startsWith('gitdir:') ? resolve(webRoot, '..', dotGit.slice(7).trim()) : resolve(webRoot, '..', '.git');
    const head = (await readFile(resolve(gitDir, 'HEAD'), 'utf8')).trim();
    if (!head.startsWith('ref:')) return head;
    const ref = head.slice(5).trim();
    try { return (await readFile(resolve(gitDir, ref), 'utf8')).trim(); }
    catch {
      const commonDir = (await readFile(resolve(gitDir, 'commondir'), 'utf8')).trim();
      return (await readFile(resolve(gitDir, commonDir, ref), 'utf8')).trim();
    }
  } catch { return 'unavailable'; }
}

function emptyPrevious() {
  return {
    version: 1,
    filters: { dateFrom: null, dateTo: null, maxPrice: null, category: null },
    requirements: [],
    preferences: { mood: null, companion: null, interests: [] },
  };
}

function redactRequest(url, init) {
  const headers = new Headers(init?.headers);
  for (const name of ['authorization', 'x-api-key']) if (headers.has(name)) headers.set(name, '[REDACTED]');
  return { url: String(url), method: init?.method ?? 'GET', headers: Object.fromEntries(headers), body: safeJson(init?.body) };
}

function safeJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

function extractUsage(value) {
  if (!value || typeof value !== 'object') return null;
  return value.usage ?? value.meta?.usage ?? null;
}

function evaluate(testCase, actual, expectedState = materializeSingleExpected(testCase), previousState = emptyPrevious()) {
  const normalized = normalizeActual(actual);
  const mismatches = [];
  const expected = testCase.expected;
  compareSubset(expected.status, normalized.status, 'expected.status', mismatches);
  compareExact(expectedState.filters, normalized.filters, 'expected.state.filters', mismatches);
  compareExact(expectedState.requirements, normalized.requirements, 'expected.state.requirements', mismatches);
  checkPreferences(expectedState.preferences, normalized.preferences, expected.soft, mismatches);
  if (expected.clarification) compareSubset(expected.clarification, normalized.clarification, 'expected.clarification', mismatches);
  checkSafety(expected.safety, normalized, mismatches);
  if (actual?.issue && actual.issue !== null)
    compareExact(canonicalState(previousState), canonicalState(actual.state), 'atomic issue state', mismatches);
  return { caseId: testCase.id, pass: mismatches.length === 0, expected: testCase.expected, actual: normalized, mismatches };
}

function normalizeActual(actual) {
  const issueStatus = {
    budget_ambiguous: 'clarify', date_ambiguous: 'clarify', constraint_ambiguous: 'clarify',
    unsupported_constraint: 'clarify', unsupported_location: 'unsupported_location',
    interpreter_unavailable: 'interpreter_unavailable',
  };
  const actionStatus = { alternatives: 'alternatives', reset: 'reset' };
  const state = actual?.state ?? actual ?? {};
  let status = issueStatus[actual?.issue] ?? actionStatus[actual?.action] ?? 'ok';
  const requirements = canonicalRequirements(state.requirements ?? []);
  const filters = canonicalFilters(state.filters ?? {});
  if (filters.category && !filters.categories) filters.categories = [filters.category];
  if (status === 'reset' && hasConstraint(filters)) status = 'reset_with_input';
  return {
    status,
    filters,
    requirements,
    preferences: state.preferences ?? { mood: null, companion: null, interests: [] },
    clarification: actual?.clarification ?? state.clarification ?? (actual?.issue ? { reason: issueReason(actual.issue) } : undefined),
    action: actual?.action,
  };
}

function checkPreferences(expected, actual, directive, failures) {
  if ((directive?.mood !== undefined || expected.mood !== null) && actual.mood !== expected.mood)
    failures.push(`expected.state.preferences.mood: expected ${JSON.stringify(expected.mood)}, got ${JSON.stringify(actual.mood)}`);
  if ((directive?.companion !== undefined || expected.companion !== null) && actual.companion !== expected.companion)
    failures.push(`expected.state.preferences.companion: expected ${JSON.stringify(expected.companion)}, got ${JSON.stringify(actual.companion)}`);
  for (const interest of expected.interests ?? [])
    if (!(actual.interests ?? []).some((item) => textContains(item, interest))) failures.push(`expected.state.preferences.interests: missing ${JSON.stringify(interest)}`);
  for (const interest of directive?.queryExcludes ?? [])
    if ((actual.interests ?? []).some((item) => textContains(item, interest))) failures.push(`expected.state.preferences.interests: excluded value remains ${JSON.stringify(interest)}`);
  if (directive?.clearAll && (actual.mood || actual.companion || actual.interests?.length))
    failures.push(`expected.state.preferences: expected cleared, got ${JSON.stringify(actual)}`);
}

function checkSafety(expected, actual, failures) {
  if (!expected) return;
  if (expected.mustNotReset && ['reset', 'reset_with_input'].includes(actual.status)) failures.push('expected.safety.mustNotReset: reset occurred');
  if (expected.mustNotClearConstraints && !hasConstraint(actual.filters)) failures.push('expected.safety.mustNotClearConstraints: constraints were cleared');
  if (expected.mustNotExcludeCategories && actual.filters.excludedCategories?.length) failures.push('expected.safety.mustNotExcludeCategories: category exclusion was added');
}

function issueReason(issue) {
  return ({ budget_ambiguous: 'budget_basis', date_ambiguous: 'date', constraint_ambiguous: 'constraint', unsupported_location: 'unsupported_location', unsupported_constraint: 'unsupported_constraint' })[issue] ?? issue;
}

function materializeExpectedStates(fixtureValue) {
  const states = new Map();
  for (const testCase of fixtureValue.cases) {
    const previous = testCase.parent ? states.get(testCase.parent) : emptyPrevious();
    states.set(testCase.id, materializeSingleExpected(testCase, previous));
  }
  return states;
}

function materializeSingleExpected(testCase, prior = emptyPrevious()) {
  const expected = testCase.expected;
  if (['clarify', 'unsupported_location'].includes(expected.status)) return canonicalState(prior);
  const state = expected.status === 'reset' || expected.status === 'reset_with_input'
    ? emptyPrevious()
    : structuredClone(prior);
  const nextFilters = { ...state.filters, ...expected.filters };
  for (const key of expected.clearedFilters ?? []) delete nextFilters[key];
  if (nextFilters.totalBudget != null && nextFilters.partySize != null)
    nextFilters.maxPrice = nextFilters.totalBudget / nextFilters.partySize;
  state.filters = canonicalFilters(nextFilters);
  if (expected.requirements?.clearAll) state.requirements = [];
  for (const entry of expected.requirements?.add ?? [])
    state.requirements.push(parseExpectedRequirement(entry, 'require_support'));
  for (const entry of expected.requirements?.addExclusions ?? [])
    state.requirements.push(parseExpectedRequirement(entry, 'exclude_positive_evidence'));
  for (const entry of expected.requirements?.remove ?? []) {
    const target = parseExpectedRequirement(entry, null);
    state.requirements = state.requirements.filter((item) =>
      !(item.kind === target.kind && item.value.split('|').some((part) => target.value.split('|').includes(part))),
    );
  }
  if (expected.soft?.clearAll) state.preferences = { mood: null, companion: null, interests: [] };
  if (expected.soft?.mood !== undefined) state.preferences.mood = expected.soft.mood;
  if (expected.soft?.companion !== undefined) state.preferences.companion = expected.soft.companion;
  for (const interest of expected.soft?.queryIncludes ?? [])
    if (!state.preferences.interests.includes(interest)) state.preferences.interests.push(interest);
  for (const interest of expected.soft?.queryExcludes ?? [])
    state.preferences.interests = state.preferences.interests.filter((item) => !textContains(item, interest));
  return canonicalState(state);
}

function parseExpectedRequirement(entry, policy) {
  const [explicitKind, ...rest] = entry.split(':');
  const aliases = {
    child_suitable: ['audience', 'children'], step_free: ['accessibility', 'step_free'],
    not_step_free: ['accessibility', 'step_free'],
  };
  const [kind, value] = rest.length ? [explicitKind, rest.join(':')] : (aliases[entry] ?? ['activity', entry]);
  return { kind, value, policy: policy ?? 'any' };
}

function canonicalState(state) {
  return {
    version: 1,
    filters: canonicalFilters(state?.filters ?? {}),
    requirements: canonicalRequirements(state?.requirements ?? []),
    preferences: {
      mood: state?.preferences?.mood ?? null,
      companion: state?.preferences?.companion ?? null,
      interests: [...(state?.preferences?.interests ?? [])].sort((a, b) => a.localeCompare(b)),
    },
  };
}

function canonicalFilters(value) {
  const aliases = { concert: 'Konser', theatre: 'Tiyatro', standup: 'Stand-up' };
  const filters = {
    dateFrom: value.dateFrom ?? null,
    dateTo: value.dateTo ?? null,
    maxPrice: value.maxPrice ?? null,
    category: null,
  };
  for (const key of ['maxPriceExclusive', 'partySize', 'totalBudget', 'district', 'startTimeFrom', 'startTimeTo', 'startTimeFromExclusive', 'startTimeToExclusive'])
    if (value[key] !== undefined && value[key] !== null && value[key] !== false) filters[key] = value[key];
  const selected = value.categories?.length ? value.categories : (value.category ? [value.category] : []);
  if (selected.length) filters.categories = [...new Set(selected.map((item) => aliases[item] ?? item))].sort((a, b) => a.localeCompare(b));
  if (value.excludedCategories?.length)
    filters.excludedCategories = [...new Set(value.excludedCategories.map((item) => aliases[item] ?? item))].sort((a, b) => a.localeCompare(b));
  return filters;
}

function canonicalRequirements(value) {
  return value.map((item) => ({ kind: item.kind, value: item.value.split('|').sort().join('|'), policy: item.policy }))
    .sort((left, right) => `${left.kind}:${left.value}:${left.policy}`.localeCompare(`${right.kind}:${right.value}:${right.policy}`));
}

function compareExact(expected, actual, path, failures) {
  try { assert.deepEqual(actual, expected); }
  catch { failures.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function compareSubset(expected, actual, path, failures) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) { failures.push(`${path}: expected array, got ${JSON.stringify(actual)}`); return; }
    for (const item of expected)
      if (!actual.some((candidate) => equivalent(candidate, item))) failures.push(`${path}: missing ${JSON.stringify(item)} in ${JSON.stringify(actual)}`);
    return;
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') { failures.push(`${path}: expected object, got ${JSON.stringify(actual)}`); return; }
    for (const [key, value] of Object.entries(expected)) compareSubset(value, actual[key], `${path}.${key}`, failures);
    return;
  }
  if (!equivalent(actual, expected)) failures.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function equivalent(left, right) {
  if (typeof left === 'string' && typeof right === 'string') {
    const aliases = { concert: 'konser', theatre: 'tiyatro', standup: 'stand-up', child_suitable: 'children' };
    const normalize = (value) => aliases[value.toLocaleLowerCase('tr-TR')] ?? value.toLocaleLowerCase('tr-TR');
    return normalize(left) === normalize(right);
  }
  return Object.is(left, right);
}

function textContains(left, right) {
  return String(left).toLocaleLowerCase('tr-TR').includes(String(right).toLocaleLowerCase('tr-TR'));
}

function hasConstraint(filters) {
  return Object.values(filters).some((value) => Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null);
}

function reportEvaluation(mode, evaluations, liveRequests, evidencePath, fixtureCases = evaluations.length) {
  const failed = evaluations.filter((item) => !item.pass);
  const clarificationCases = evaluations.filter((item) => item.expected?.status === 'clarify');
  const clarified = clarificationCases.filter((item) => item.actual?.status === 'clarify').length;
  console.log(JSON.stringify({
    status: failed.length ? 'fail' : 'pass', mode, cases: evaluations.length,
    passed: evaluations.length - failed.length, failed: failed.length,
    coverage: { evaluated: evaluations.length, fixture: fixtureCases, rate: evaluations.length / fixtureCases },
    actualClarificationRate: evaluations.length ? evaluations.filter((item) => item.actual?.status === 'clarify').length / evaluations.length : null,
    expectedClarificationRecall: clarificationCases.length ? clarified / clarificationCases.length : null,
    unexpectedClarifications: evaluations.filter((item) => item.actual?.status === 'clarify' && item.expected?.status !== 'clarify').length,
    missedClarifications: clarificationCases.filter((item) => item.actual?.status !== 'clarify').length,
    acceptedStateMismatches: failed.filter((item) => ['ok', 'alternatives', 'reset', 'reset_with_input'].includes(item.actual?.status) && item.mismatches.some((message) => message.includes('.filters') || message.includes('.requirements'))).length,
    hardConstraintErrors: failed.reduce((sum, item) => sum + item.mismatches.filter((message) => message.includes('.filters') || message.includes('.requirements')).length, 0),
    safetyErrors: failed.reduce((sum, item) => sum + item.mismatches.filter((message) => message.includes('.safety') || message.includes('atomic issue state')).length, 0),
    liveRequests, evidencePath, evaluations,
  }, null, 2));
  if (failed.length) process.exitCode = 1;
}

function runEvaluatorSelfTests() {
  const filters = { dateFrom: null, dateTo: null, maxPrice: null, category: 'Konser' };
  const base = {
    state: { version: 1, filters, requirements: [], preferences: { mood: null, companion: null, interests: [] } },
    action: 'search', issue: null,
  };
  const singular = evaluate({ id: 'singular', expected: { status: 'ok', filters: { categories: ['concert'] } } }, base);
  assert.equal(singular.pass, true, JSON.stringify(singular.mismatches));
  assert.equal(evaluate({ id: 'strict-enum', expected: { status: 'ok', filters: { categories: ['con'] } } }, base).pass, false);
  assert.equal(evaluate({ id: 'unavailable', expected: { status: 'ok', filters: {} } }, { ...base, issue: 'interpreter_unavailable' }).pass, false);
  assert.equal(evaluate({ id: 'removed', expected: { status: 'ok', filters: { categories: ['concert'] }, requirements: { remove: ['step_free'] } } }, base).pass, true);
  assert.equal(evaluate({ id: 'safety', expected: { status: 'ok', filters: {}, safety: { mustNotReset: true } } }, { ...base, action: 'reset' }).pass, false);
  const extraFilter = { ...base, state: { ...base.state, filters: { ...filters, district: 'Kadıköy' } } };
  assert.equal(evaluate({ id: 'extra-filter', expected: { status: 'ok', filters: { categories: ['concert'] } } }, extraFilter).pass, false);
  const extraRequirement = { ...base, state: { ...base.state, requirements: [{ kind: 'genre', value: 'rock', policy: 'require_support' }] } };
  assert.equal(evaluate({ id: 'extra-requirement', expected: { status: 'ok', filters: { categories: ['concert'] } } }, extraRequirement).pass, false);
  const splitOr = { ...base, state: { ...base.state, requirements: [{ kind: 'genre', value: 'rock', policy: 'require_support' }, { kind: 'genre', value: 'jazz', policy: 'require_support' }] } };
  assert.equal(evaluate({ id: 'or-group', expected: { status: 'ok', filters: { categories: ['concert'] }, requirements: { add: ['genre:rock|jazz'] } } }, splitOr).pass, false);
  const mutatedIssue = { ...base, issue: 'budget_ambiguous' };
  assert.equal(evaluate({ id: 'atomic', expected: { status: 'clarify', clarification: { reason: 'budget_basis' }, filters: {} } }, mutatedIssue).pass, false);
  assert.equal(materializeSingleExpected({ expected: { status: 'ok', filters: { partySize: 3, totalBudget: 1000 } } }).filters.maxPrice, 1000 / 3);
  const grouped = { ...base, state: { ...base.state, requirements: [{ kind: 'genre', value: 'jazz|rock', policy: 'require_support' }] } };
  assert.equal(evaluate({ id: 'same-or', expected: { status: 'ok', filters: { categories: ['concert'] }, requirements: { add: ['genre:rock|jazz'] } } }, grouped).pass, true);
  const retainedPreferences = { ...base.state, preferences: { mood: 'calm', companion: 'partner', interests: ['acoustic'] } };
  assert.equal(evaluate({ id: 'retain-soft', expected: { status: 'ok', filters: { categories: ['concert'] } } }, base, retainedPreferences).pass, false);
  console.log(JSON.stringify({ status: 'pass', mode: 'evaluator-self-test', assertions: 12, liveRequests: 0 }, null, 2));
}

function fail(title, failures) {
  console.error(`${title} (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
