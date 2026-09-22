import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  deploymentEnvironment,
  deploymentSecrets,
  publicDeploymentVariables,
  validateDeploymentConfig,
  deploymentMatches,
} from '../scripts/deploy-config.mjs';

const names = [
  'DEPLOY_TARGET',
  'DEPLOYMENT_SHA',
  'CLOUDFLARE_ACCOUNT_ID',
  'CF_WORKER_NAME',
  'CF_D1_DATABASE_NAME',
  'CF_D1_DATABASE_ID',
  'CF_R2_BUCKET_NAME',
  'CF_PUBLIC_URL',
  'CLOUDFLARE_API_TOKEN',
  'SYNC_TOKEN',
  'TYPESAFE_API_KEY',
  'TYPESAFE_MODEL',
  'AI_DAILY_LIMIT',
];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    DEPLOY_TARGET: 'staging',
    DEPLOYMENT_SHA: '0123456789abcdef0123456789abcdef01234567',
    CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    CF_WORKER_NAME: 'biplan-staging',
    CF_D1_DATABASE_NAME: 'biplan-staging',
    CF_D1_DATABASE_ID: '00000000-0000-4000-8000-000000000001',
    CF_R2_BUCKET_NAME: 'biplan-staging-state',
    CF_PUBLIC_URL: 'https://biplan-staging.example.workers.dev',
    CLOUDFLARE_API_TOKEN: 'token',
    SYNC_TOKEN: 'sync-token',
  });
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved))
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
});

await test('accepts a separated, complete environment configuration', () => {
  assert.doesNotThrow(() =>
    validateDeploymentConfig({ requireSecrets: true, environment: 'staging' }),
  );
});

await test('rejects conflicting environment selectors', () => {
  assert.throws(
    () => deploymentEnvironment(['--env', 'production']),
    /must match/,
  );
});

await test('rejects resource names that could collide across environments', () => {
  process.env.CF_WORKER_NAME = 'biplan';
  assert.throws(
    () => validateDeploymentConfig({ environment: 'staging' }),
    /must include/,
  );
});

await test('rejects names containing the other environment', () => {
  process.env.CF_WORKER_NAME = 'biplan-staging-production';
  assert.throws(
    () => validateDeploymentConfig({ environment: 'staging' }),
    /exclude "production"/,
  );
});

await test('rejects non-canonical D1 IDs and deployment revisions', () => {
  process.env.CF_D1_DATABASE_ID = '00000000000040008000000000000001';
  assert.throws(
    () => validateDeploymentConfig({ environment: 'staging' }),
    /canonical UUID/,
  );
  process.env.CF_D1_DATABASE_ID = '00000000-0000-4000-8000-000000000001';
  process.env.DEPLOYMENT_SHA = 'ABC';
  assert.throws(
    () => validateDeploymentConfig({ environment: 'staging' }),
    /40-character commit SHA/,
  );
});

await test('requires an exact revision for an actual deployment', () => {
  delete process.env.DEPLOYMENT_SHA;
  assert.throws(
    () =>
      validateDeploymentConfig({
        environment: 'staging',
        requireRevision: true,
      }),
    /DEPLOYMENT_SHA/,
  );
});

await test('requires a workers.dev origin to belong to the selected Worker', () => {
  process.env.CF_PUBLIC_URL = 'https://another-worker.example.workers.dev';
  assert.throws(
    () => validateDeploymentConfig({ environment: 'staging' }),
    /must start with CF_WORKER_NAME/,
  );
});

await test('matches liveness only to the deployed environment and revision', () => {
  const body = {
    status: 'ok',
    deployment: {
      environment: 'staging',
      revision: process.env.DEPLOYMENT_SHA,
    },
  };
  assert.equal(
    deploymentMatches(body, 'staging', process.env.DEPLOYMENT_SHA),
    true,
  );
  assert.equal(
    deploymentMatches(body, 'production', process.env.DEPLOYMENT_SHA),
    false,
  );
  assert.equal(deploymentMatches(body, 'staging', 'f'.repeat(40)), false);
});

await test('rejects multiline secrets before creating a secrets file', () => {
  process.env.SYNC_TOKEN = 'first\nsecond';
  assert.throws(
    () =>
      validateDeploymentConfig({
        requireSecrets: true,
        environment: 'staging',
      }),
    /single-line/,
  );
});

await test('uses safe Jev deployment defaults without requiring a key', () => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_MODEL;
  delete process.env.AI_DAILY_LIMIT;
  const variables = publicDeploymentVariables('staging');
  assert.equal(variables.TYPESAFE_MODEL, 'jev-1.13.0');
  assert.equal(variables.AI_DAILY_LIMIT, '100');
  assert.deepEqual(deploymentSecrets(), { SYNC_TOKEN: 'sync-token' });
});

await test('keeps Jev secrets out of public deployment variables', () => {
  process.env.TYPESAFE_API_KEY = 'private-jev-key';
  process.env.TYPESAFE_MODEL = 'jev-1.13.0';
  process.env.AI_DAILY_LIMIT = '250';
  const variables = publicDeploymentVariables('staging');
  assert.equal(JSON.stringify(variables).includes('private-jev-key'), false);
  assert.equal(variables.TYPESAFE_MODEL, 'jev-1.13.0');
  assert.equal(variables.AI_DAILY_LIMIT, '250');
  assert.deepEqual(deploymentSecrets(), {
    SYNC_TOKEN: 'sync-token',
    TYPESAFE_API_KEY: 'private-jev-key',
  });
});

await test('rejects invalid Jev public deployment settings', () => {
  process.env.AI_DAILY_LIMIT = '10001';
  assert.throws(
    () => validateDeploymentConfig({ environment: 'staging' }),
    /AI_DAILY_LIMIT/,
  );
  process.env.AI_DAILY_LIMIT = '100';
  process.env.TYPESAFE_MODEL = 'other-model';
  assert.throws(
    () => validateDeploymentConfig({ environment: 'staging' }),
    /TYPESAFE_MODEL/,
  );
});
