import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  successfulCoreChecks,
} from '../scripts/deploy-gates.mjs';

const names = [
  'test',
  'collector (ubuntu-latest)',
  'collector (windows-latest)',
  'verify (ubuntu-latest)',
  'verify (windows-latest)',
];

await test('requires every successful core CI check', () => {
  const check_runs = names.map((name) => ({
    id: 1,
    name,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-09-26T10:00:00Z',
    app: { slug: 'github-actions' },
  }));
  assert.equal(successfulCoreChecks({ check_runs }), true);
  check_runs[2].conclusion = 'failure';
  assert.equal(successfulCoreChecks({ check_runs }), false);
  assert.equal(successfulCoreChecks({ check_runs: check_runs.slice(1) }), false);
});

await test('rejects an older green check when the latest attempt is not green', () => {
  const base = names.map((name, index) => ({
    id: index + 1,
    name,
    status: 'completed',
    conclusion: 'success',
    started_at: '2026-09-26T10:00:00Z',
    app: { slug: 'github-actions' },
  }));
  const olderGreen = base.find((check) => check.name === 'test');
  const newerFailure = {
    ...olderGreen,
    id: 100,
    conclusion: 'failure',
    started_at: '2026-09-26T11:00:00Z',
  };
  assert.equal(successfulCoreChecks({ check_runs: [...base, newerFailure] }), false);
  const newestPending = {
    ...newerFailure,
    id: 101,
    status: 'in_progress',
    conclusion: null,
    started_at: '2026-09-26T12:00:00Z',
  };
  assert.equal(
    successfulCoreChecks({ check_runs: [...base, newerFailure, newestPending] }),
    false,
  );
});
