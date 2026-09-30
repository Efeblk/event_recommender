import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { preparationJobConfig, preparationJobOutcome, runPreparationJob } from '../scripts/run-postgres-preparation.mjs';

const base = { mode: 'prepare', batchId: 'sealed-batch', workerId: 'worker', maxJobs: 2, leaseSeconds: 30, timeBudgetMs: 1000, processDeadlineMs: 5000 };
function fake(overrides = {}) {
  const calls = []; let closed = 0;
  const dependencies = {
    createClient: () => ({ queryText: async () => '', close: async () => { closed++; } }),
    batchState: async () => ({ state: 'sealed', schemaVersion: 2 }), createStore: () => ({ marker: true }),
    runPreparation: async (options) => { calls.push(options); return { batchId: options.batchId, workerId: options.workerId, claimed: 2, completed: 2, failures: [], stopped: 'item_limit', elapsedMs: 4 }; },
    runPublication: async (options) => { calls.push(options); return { batchId: options.batchId, workerId: options.workerId, claimed: 1, published: 1, failures: [], stopped: 'completed' }; },
    ...overrides,
  };
  return { dependencies, calls, closed: () => closed };
}

await test('requires an explicit bounded mode and sealed batch identifier', () => {
  assert.throws(() => preparationJobConfig([], {}), /Usage/);
  assert.throws(() => preparationJobConfig(['prepare', '../batch'], {}), /batch id/);
  assert.throws(() => preparationJobConfig(['prepare', 'batch'], { CATALOG_BATCH_MAX_JOBS: '1001' }), /job limit/);
  assert.throws(() => preparationJobConfig(['prepare', 'batch'], { CATALOG_BATCH_TIME_MS: '0' }), /time budget/);
  assert.equal(preparationJobConfig(['publish', 'batch-1'], {}).mode, 'publish');
});

await test('passes finite preparation bounds and always closes the client', async () => {
  const harness = fake(); const controller = new AbortController();
  const result = await runPreparationJob({ config: base, dependencies: harness.dependencies, signal: controller.signal });
  assert.equal(result.completed, 2); assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].maxJobs, 2); assert.equal(harness.calls[0].leaseSeconds, 30);
  assert.equal(harness.calls[0].timeBudgetMs, 1000); assert.equal(harness.closed(), 1);
});

await test('refuses non-sealed batches before claims and closes on failure', async () => {
  const harness = fake({ batchState: async () => ({ state: 'collecting', schemaVersion: 2 }) });
  await assert.rejects(runPreparationJob({ config: base, dependencies: harness.dependencies, signal: new AbortController().signal }), /not sealed/);
  assert.equal(harness.calls.length, 0); assert.equal(harness.closed(), 1);
});

await test('production Job refuses a legacy records-only batch before claiming work', async () => {
  const harness = fake({ batchState: async () => ({ state: 'sealed', schemaVersion: 1 }) });
  await assert.rejects(runPreparationJob({ config: base, dependencies: harness.dependencies, signal: new AbortController().signal }), /version 2/);
  assert.equal(harness.calls.length, 0); assert.equal(harness.closed(), 1);
});

await test('repeat execution reports durable publication without claims or pointer activation', async () => {
  for (const mode of ['prepare','publish']) {
    const harness=fake({batchState:async()=>({state:'published',schemaVersion:2,publicationId:'older-retained-publication'})});
    const result=await runPreparationJob({config:{...base,mode},dependencies:harness.dependencies,signal:new AbortController().signal});
    assert.equal(result.idempotent,true);assert.equal(result.publicationId,'older-retained-publication');
    assert.equal(result.claimed,0);assert.equal(result.published,0);assert.equal(harness.calls.length,0);assert.equal(harness.closed(),1);
    assert.deepEqual(preparationJobOutcome(mode,result),{status:'completed',exitCode:0});
  }
});

await test('propagates interruption fencing and exposes no detailed receipts', async () => {
  const controller = new AbortController(); controller.abort(); const harness = fake({
    runPreparation: async (options) => ({ batchId: options.batchId, workerId: options.workerId, claimed: 0, completed: 0, failures: [], receipts: [{ secret: 'hidden' }], stopped: options.signal.aborted ? 'interrupted' : 'drained' }),
  });
  const result = await runPreparationJob({ config: base, dependencies: harness.dependencies, signal: controller.signal });
  assert.equal(result.stopped, 'interrupted'); assert.equal('receipts' in result, false); assert.equal(harness.closed(), 1);
});

await test('exit semantics distinguish completion, resumable bounds, not-ready, and failure', () => {
  const result = (stopped, extra = {}) => ({ failures: [], stopped, ...extra });
  assert.deepEqual(preparationJobOutcome('prepare', result('drained')), { status: 'completed', exitCode: 0 });
  assert.deepEqual(preparationJobOutcome('prepare', result('item_limit')), { status: 'bounded_stop', exitCode: 2 });
  assert.deepEqual(preparationJobOutcome('prepare', result('time_budget')), { status: 'bounded_stop', exitCode: 2 });
  assert.deepEqual(preparationJobOutcome('publish', result('not_ready', { published: 0 })), { status: 'not_ready', exitCode: 2 });
  assert.deepEqual(preparationJobOutcome('publish', result('completed', { published: 1 })), { status: 'completed', exitCode: 0 });
  assert.deepEqual(preparationJobOutcome('prepare', result('error', { failures: [{ code: 'batch_error' }] })), { status: 'failed', exitCode: 1 });
});

await test('image is non-root, lockfile-based, minimal, and cannot default to mutation', async () => {
  const docker = await readFile(new URL('./Dockerfile.preparation', import.meta.url), 'utf8');
  assert.match(docker, /FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/);
  assert.match(docker, /BIPLAN_PG_STATEMENT_TIMEOUT_MS=30000/);
  assert.match(docker, /npm ci --omit=dev --ignore-scripts/); assert.match(docker, /USER node/);
  assert.match(docker, /p\.dependencies=\{pg:p\.dependencies\.pg\}/);
  assert.match(docker, /ENTRYPOINT \["node", "--experimental-strip-types"/);
  assert.doesNotMatch(docker, /COPY (?:\. |web\/work|collector\/work|\.env)/);
  assert.doesNotMatch(docker, /CMD \["(?:prepare|publish)/);
  const store = await readFile(new URL('../../collector/preparation/batch-store.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(store, /from ['"]\.\/db\.mjs['"]/, 'Cloud packaging requires the shared safe SQL literal and no Docker helper import');
  const ignore = await readFile(new URL('./Dockerfile.preparation.dockerignore', import.meta.url), 'utf8');
  for (const forbidden of ['web/work', 'node_modules', '.env', '.git']) assert.equal(ignore.includes(`!${forbidden}`), false);
  for (const required of ['web/package-lock.json', 'web/scripts/run-postgres-preparation.mjs', 'web/lib/postgres-client.node.ts', 'collector/preparation/batch-worker.mjs'])
    assert.ok(ignore.includes(`!${required}`));
});
