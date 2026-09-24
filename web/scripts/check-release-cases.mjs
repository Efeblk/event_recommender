import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveRequirements } from '../lib/requirements.ts';
import { interpretConstraints, normalize } from '../lib/search.ts';
import { emptyFilters } from '../lib/types.ts';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = resolve(
  webRoot,
  'evals/cases/2026-09-24-release-holdout.json',
);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const now = new Date(`${fixture.referenceDate}T09:00:00Z`);
const states = new Map();
const failures = [];

const requirementAliases = new Map([['wheelchair_accessible', 'step_free']]);

function expectedCategories(expected) {
  return new Set(expected.categories ?? []);
}

function actualCategories(filters) {
  return new Set(
    filters.categories ?? (filters.category ? [filters.category] : []),
  );
}

function requirementHas(requirements, value, policy) {
  const canonical = requirementAliases.get(value) ?? value;
  return requirements.some(
    (requirement) =>
      requirement.policy === policy &&
      requirement.value.split('|').includes(canonical),
  );
}

function checkCase(testCase, state) {
  const { expected } = testCase;
  const { result, requirements } = state;
  if (expected.status === 'unsupported_location') {
    assert.equal(result.issue, 'unsupported_location');
    return;
  }

  assert.equal(result.issue, null, `unexpected parser issue: ${result.issue}`);
  const filters = result.filters;
  for (const key of [
    'dateFrom',
    'dateTo',
    'maxPrice',
    'partySize',
    'totalBudget',
  ])
    if (Object.hasOwn(expected, key))
      assert.equal(filters[key], expected[key], key);

  if (expected.district)
    assert.equal(
      normalize(filters.district ?? ''),
      normalize(expected.district),
    );
  if (expected.categories) {
    assert.deepEqual(
      [...actualCategories(filters)].sort(),
      [...expectedCategories(expected)].sort(),
      'categories',
    );
  }
  for (const category of expected.excludedCategories ?? []) {
    const allowed = actualCategories(filters);
    assert.ok(
      filters.excludedCategories?.includes(category) ||
        (allowed.size > 0 && !allowed.has(category)),
      `category is not excluded: ${category}`,
    );
  }
  for (const district of expected.forbiddenDistricts ?? [])
    assert.notEqual(normalize(filters.district ?? ''), normalize(district));
  for (const price of expected.forbiddenMaxPrices ?? [])
    assert.notEqual(filters.maxPrice, price);

  if (expected.timeAfter) {
    assert.equal(filters.startTimeFrom, expected.timeAfter);
    assert.equal(
      filters.startTimeFromExclusive,
      expected.timeBoundary === 'strict',
    );
  }
  if (expected.timeBefore) {
    assert.equal(filters.startTimeTo, expected.timeBefore);
    assert.equal(
      filters.startTimeToExclusive,
      expected.timeBoundary === 'strict',
    );
  }
  for (const value of expected.requirements ?? [])
    assert.ok(
      requirementHas(requirements, value, 'require_support'),
      `missing required evidence ${value}`,
    );
  for (const value of expected.exclusions ?? [])
    assert.ok(
      requirementHas(requirements, value, 'exclude_positive_evidence'),
      `missing evidence exclusion ${value}`,
    );
  for (const value of expected.mandatoryEvidence ?? [])
    assert.ok(
      requirementHas(requirements, value, 'require_support'),
      `missing mandatory evidence ${value}`,
    );
  for (const value of expected.removedRequirements ?? []) {
    const canonical = requirementAliases.get(value) ?? value;
    assert.ok(
      !requirements.some((requirement) =>
        requirement.value.split('|').includes(canonical),
      ),
      `requirement was not removed: ${value}`,
    );
  }
  if (expected.pricePolicy === 'known_zero_only')
    assert.equal(filters.maxPrice, 0);
}

for (const testCase of fixture.cases) {
  const parent = testCase.parent ? states.get(testCase.parent) : null;
  if (testCase.parent && !parent) {
    failures.push(
      `${testCase.id}: parent ${testCase.parent} must appear first`,
    );
    continue;
  }
  const history = parent
    ? [...parent.history, { role: 'user', content: parent.message }]
    : [];
  const previous = parent?.result.filters ?? emptyFilters;
  const result = interpretConstraints(testCase.message, previous, now);
  const requirements = deriveRequirements(testCase.message, history);
  const state = { history, message: testCase.message, requirements, result };
  states.set(testCase.id, state);
  try {
    checkCase(testCase, state);
  } catch (error) {
    failures.push(
      `${testCase.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

if (failures.length) {
  console.error(
    `Release case gate failed (${failures.length}/${fixture.cases.length}):`,
  );
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      status: 'pass',
      fixture: fixturePath,
      cases: fixture.cases.length,
      liveRequests: 0,
    }),
  );
}
