import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  stagingPromotionReady,
  successfulCoreChecks,
  validStagingSource,
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

await test('requires a successful staging deployment run for production', () => {
  const revision = 'a'.repeat(40);
  const run = {
    id: 123,
    event: 'workflow_dispatch',
    conclusion: 'success',
    // workflow_dispatch head_sha identifies the dispatch ref and can differ
    // from the exact commit_sha explicitly checked out by the workflow.
    head_sha: 'b'.repeat(40),
    repository: { full_name: 'owner/repo' },
    path: '.github/workflows/deploy.yml@refs/heads/master',
  };
  const marker = { environment: 'staging', revision, runId: 123 };
  const expected = { repository: 'owner/repo', revision, runId: '123' };
  assert.equal(validStagingSource(run, marker, expected), true);
  assert.equal(validStagingSource({ ...run, conclusion: 'failure' }, marker, expected), false);
  assert.equal(validStagingSource(run, { ...marker, environment: 'production' }, expected), false);
  assert.equal(validStagingSource(run, { ...marker, revision: 'c'.repeat(40) }, expected), false);
  assert.equal(validStagingSource(run, marker, { ...expected, runId: '' }), false);
});

await test('requires ready staging on the exact candidate revision', () => {
  const revision = 'a'.repeat(40);
  const health = { status: 'ok', deployment: { environment: 'staging', revision } };
  assert.equal(stagingPromotionReady(health, { ready: true }, revision), true);
  assert.equal(stagingPromotionReady(health, { ready: false }, revision), false);
  assert.equal(stagingPromotionReady(health, { ready: true }, 'b'.repeat(40)), false);
  assert.equal(stagingPromotionReady({ ...health, deployment: { ...health.deployment, environment: 'production' } }, { ready: true }, revision), false);
});
