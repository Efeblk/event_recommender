import { readFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkRequirements,
  deriveRequirements,
} from '../lib/requirements.ts';
import { normalize, todayInIstanbul } from '../lib/search.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '..');
const reportsRoot = resolve(webRoot, 'evals/reports');
const fixturePath = resolve(
  webRoot,
  'evals/cases/2026-09-24-release-holdout.json',
);

function usage() {
  return 'Usage: node --experimental-strip-types web/scripts/check-release-results.mjs --report web/evals/reports/report.json';
}

function reportPath(argv) {
  if (argv.length !== 2 || argv[0] !== '--report') throw new Error(usage());
  const value = argv[1];
  if (!value || value.startsWith('/') || !value.endsWith('.json'))
    throw new Error('--report must be a repo-relative JSON file.');
  const path = resolve(repoRoot, value);
  if (!path.startsWith(`${reportsRoot}${sep}`))
    throw new Error('--report must stay under web/evals/reports.');
  return path;
}

function localTime(startsAt) {
  const parsed = new Date(startsAt);
  if (!Number.isFinite(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Istanbul',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(parsed);
}

function districtMatches(event, requested) {
  const wanted = normalize(requested);
  const fields = [event.district, event.address, event.venue]
    .filter((value) => typeof value === 'string')
    .map(normalize);
  return fields.some((value) => new RegExp(`\\b${wanted}\\b`).test(value));
}

function eventKey(event) {
  return [
    normalize(event.title ?? ''),
    normalize(event.venue ?? ''),
    event.startsAt ?? '',
  ].join('|');
}

function addCardFailure(failures, testCase, event, message) {
  failures.push(`${testCase.id}/${event.id ?? event.title ?? 'unknown-card'}: ${message}`);
}

const path = reportPath(process.argv.slice(2));
const [fixture, report] = await Promise.all([
  readFile(fixturePath, 'utf8').then(JSON.parse),
  readFile(path, 'utf8').then(JSON.parse),
]);
const caseById = new Map(fixture.cases.map((item) => [item.id, item]));
const resultById = new Map();
const failures = [];
const emptyCases = [];
const nonemptyCases = [];
const relevanceUnresolved = [];

if (!Array.isArray(report.results)) throw new Error('Report results are missing.');
for (const result of report.results) {
  if (!result || typeof result.id !== 'string' || resultById.has(result.id))
    throw new Error(`Invalid or duplicate report result ID: ${result?.id}`);
  resultById.set(result.id, result);
}
for (const testCase of fixture.cases) {
  const result = resultById.get(testCase.id);
  if (!result) {
    failures.push(`${testCase.id}: missing report result`);
    continue;
  }
  if (result.input?.message !== testCase.message)
    failures.push(`${testCase.id}: report message differs from frozen fixture`);
  if (result.error) failures.push(`${testCase.id}: request error ${result.error}`);
  if (result.httpStatus !== 200)
    failures.push(`${testCase.id}: expected HTTP 200, got ${result.httpStatus}`);

  const body = result.body ?? {};
  const recommendations = Array.isArray(body.recommendations)
    ? body.recommendations
    : [];
  const expected = testCase.expected;
  if (expected.status === 'unsupported_location') {
    if (body.status !== 'unsupported_location')
      failures.push(`${testCase.id}: expected unsupported_location, got ${body.status}`);
    if (recommendations.length)
      failures.push(`${testCase.id}: unsupported location returned cards`);
    continue;
  }
  if (!['results', 'empty'].includes(body.status))
    failures.push(`${testCase.id}: unexpected status ${body.status}`);

  const filters = body.filters ?? {};
  for (const key of ['dateFrom', 'dateTo', 'maxPrice', 'partySize', 'totalBudget'])
    if (Object.hasOwn(expected, key) && filters[key] !== expected[key])
      failures.push(`${testCase.id}: filter ${key}=${filters[key]} expected ${expected[key]}`);
  if (expected.district && normalize(filters.district ?? '') !== normalize(expected.district))
    failures.push(`${testCase.id}: district correction was not retained`);
  const actualCategories = new Set(
    filters.categories ?? (filters.category ? [filters.category] : []),
  );
  if (
    expected.categories &&
    (actualCategories.size !== expected.categories.length ||
      expected.categories.some((category) => !actualCategories.has(category)))
  )
    failures.push(`${testCase.id}: category filters differ from expectation`);
  if (expected.timeAfter && filters.startTimeFrom !== expected.timeAfter)
    failures.push(`${testCase.id}: lower time bound differs from expectation`);
  if (expected.timeBefore && filters.startTimeTo !== expected.timeBefore)
    failures.push(`${testCase.id}: upper time bound differs from expectation`);
  if (expected.timeBoundary === 'strict' && expected.timeAfter && !filters.startTimeFromExclusive)
    failures.push(`${testCase.id}: lower time bound is not strict`);
  if (expected.timeBoundary === 'strict' && expected.timeBefore && !filters.startTimeToExclusive)
    failures.push(`${testCase.id}: upper time bound is not strict`);

  if (!recommendations.length) {
    emptyCases.push({ id: testCase.id, status: body.status, notice: body.notice ?? null });
    continue;
  }
  nonemptyCases.push(testCase.id);

  const parent = testCase.parent ? resultById.get(testCase.parent) : null;
  const history = Array.isArray(result.input?.history)
    ? result.input.history
    : parent?.nextHistory ?? [];
  const requirements = deriveRequirements(testCase.message, history);
  const duplicateIds = new Set();
  const duplicateSessions = new Set();
  const duplicateShows = new Set();
  for (const recommendation of recommendations) {
    const event = recommendation?.event;
    if (!event || typeof event !== 'object') {
      failures.push(`${testCase.id}: malformed recommendation card`);
      continue;
    }
    if (duplicateIds.has(event.id)) addCardFailure(failures, testCase, event, 'duplicate event ID');
    duplicateIds.add(event.id);
    const sessionKey = eventKey(event);
    if (duplicateSessions.has(sessionKey))
      addCardFailure(failures, testCase, event, 'duplicate title/venue/session card');
    duplicateSessions.add(sessionKey);
    if (event.canonicalShowKey) {
      if (duplicateShows.has(event.canonicalShowKey))
        addCardFailure(failures, testCase, event, 'duplicate canonical show card');
      duplicateShows.add(event.canonicalShowKey);
    }

    if (event.city !== 'İstanbul') addCardFailure(failures, testCase, event, 'non-Istanbul card');
    if (event.availability !== 'available')
      addCardFailure(failures, testCase, event, `availability is ${event.availability}`);
    const instant = new Date(event.startsAt);
    if (!Number.isFinite(instant.getTime())) {
      addCardFailure(failures, testCase, event, 'invalid start timestamp');
      continue;
    }
    const day = todayInIstanbul(instant);
    if (expected.dateFrom && day < expected.dateFrom)
      addCardFailure(failures, testCase, event, `date ${day} precedes ${expected.dateFrom}`);
    if (expected.dateTo && day > expected.dateTo)
      addCardFailure(failures, testCase, event, `date ${day} follows ${expected.dateTo}`);
    if (expected.district && !districtMatches(event, expected.district))
      addCardFailure(failures, testCase, event, `no source location evidence for ${expected.district}`);
    if (expected.maxPrice !== undefined &&
        (typeof event.price !== 'number' || event.currency !== 'TRY' || event.price > expected.maxPrice))
      addCardFailure(failures, testCase, event, `price is not known TRY <= ${expected.maxPrice}`);
    if (expected.pricePolicy === 'known_zero_only' && event.price !== 0)
      addCardFailure(failures, testCase, event, 'free-only case contains a nonzero or unknown price');
    if (expected.categories && !expected.categories.includes(event.category))
      addCardFailure(failures, testCase, event, `category ${event.category} is outside the requested set`);
    if ((expected.excludedCategories ?? []).includes(event.category))
      addCardFailure(failures, testCase, event, `forbidden category ${event.category}`);

    const time = localTime(event.startsAt);
    if (expected.timeAfter &&
        (!time || (expected.timeBoundary === 'strict' ? time <= expected.timeAfter : time < expected.timeAfter)))
      addCardFailure(failures, testCase, event, `local start ${time} violates lower bound`);
    if (expected.timeBefore &&
        (!time || (expected.timeBoundary === 'strict' ? time >= expected.timeBefore : time > expected.timeBefore)))
      addCardFailure(failures, testCase, event, `local start ${time} violates upper bound`);

    for (const check of checkRequirements(event, requirements))
      if (check.status !== 'supported')
        addCardFailure(
          failures,
          testCase,
          event,
          `${check.requirement.policy} ${check.requirement.value} is ${check.status}`,
        );
  }
  relevanceUnresolved.push({
    id: testCase.id,
    cards: recommendations.length,
    note: 'Hard constraints and explicit source-evidence requirements checked; comparative relevance and recall require review.',
  });
}

for (const id of resultById.keys())
  if (!caseById.has(id)) failures.push(`${id}: report contains an unknown case`);

const summary = {
  status: failures.length ? 'fail' : emptyCases.length ? 'needs_review' : 'hard_constraints_pass',
  fixtureCases: fixture.cases.length,
  reportResults: report.results.length,
  nonemptyCases: nonemptyCases.length,
  emptyCases,
  relevanceUnresolved,
  hardConstraintFailures: failures,
  note: 'Empty cases are safe from false-positive cards but are not counted as relevance or recall passes.',
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exitCode = 1;
