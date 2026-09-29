import assert from 'node:assert/strict';
import test from 'node:test';
import { createBatchStore } from '../preparation/batch-store.mjs';
import { runBatchPreparation, runBatchPublication } from '../preparation/batch-worker.mjs';

const input = { revisionId: 'revision', sessionId: 'session', dependencyHash: 'dependency', facts: { title: 'Oyun', category: 'Tiyatro', venue: 'Sahne', description: 'Açıklama' } };
function memory(count = 2) { const jobs = Array.from({ length: count }, (_, i) => ({ id: `job-${i}`, fencing_token: '1' })), calls = [];
  return { calls, claimJobs: async (_b, _w, limit) => { calls.push(['claim', limit]); return jobs.length ? [jobs.shift()] : []; }, input: async () => input,
    complete: async job => { calls.push(['complete', job.id]); return { status: 'completed' }; }, fail: async () => ({ status: 'failed' }),
    claimPublication: async () => null, activePublication: async () => 'base', publish: async () => ({ status: 'published' }) }; }

test('preparation claims one at a time, stays bounded, and never touches publication', async () => {
  const store = memory(3), result = await runBatchPreparation({ store, batchId: 'batch', workerId: 'worker', maxJobs: 2 });
  assert.equal(result.completed, 2); assert.equal(result.stopped, 'item_limit');
  assert.deepEqual(store.calls, [['claim', 1], ['complete', 'job-0'], ['claim', 1], ['complete', 'job-1']]);
});
test('interruption before completion fails the lease and never publishes', async () => {
  const store = memory(1), controller = new AbortController(); let failed = 0; store.fail = async () => { failed++; return { status: 'pending' }; };
  const result = await runBatchPreparation({ store, batchId: 'batch', workerId: 'worker', signal: controller.signal, prepare: value => { controller.abort(); return value; } });
  assert.equal(result.completed, 0); assert.equal(result.failures[0].persistence, 'retry_scheduled'); assert.equal(failed, 1);
});
test('publication remains not-ready without a publication lease and switches once when claimed', async () => {
  const store = memory(0); assert.equal((await runBatchPublication({ store, batchId: 'batch', workerId: 'worker' })).published, 0);
  store.claimPublication = async () => ({ id: 'publish-job', fencing_token: '7' }); let calls = 0;
  store.publish = async (_b, _j, _w, base) => { calls++; assert.equal(base, 'base'); return { status: 'published', publicationId: 'next' }; };
  const result = await runBatchPublication({ store, batchId: 'batch', workerId: 'worker' }); assert.equal(result.published, 1); assert.equal(calls, 1);
});
test('publication failure is persisted through the same fenced job boundary', async () => {
  const store = memory(0); store.claimPublication = async () => ({ id: 'publish-job', fencing_token: '4' });
  store.publish = async () => { throw new Error('active publication guard failed'); }; let failed = 0;
  store.fail = async (_job, _worker, detail) => { failed++; assert.equal(detail.retryable, true); return { status: 'pending' }; };
  const result = await runBatchPublication({ store, batchId: 'batch', workerId: 'worker' });
  assert.equal(result.published, 0); assert.equal(result.failures[0].persistence, 'retry_scheduled'); assert.equal(failed, 1);
});
test('SQL adapter rejects lossy fences before query execution', () => {
  const store = createBatchStore(() => { throw new Error('query must not execute'); });
  assert.throws(() => store.complete({ id: 'job', fencing_token: Number('9007199254740993') }, 'worker', {}), /Unsafe/);
});
test('SQL adapter escapes quotes and backslashes and rejects zero bytes before an injected query', async () => {
  const statements = [], store = createBatchStore(async statement => { statements.push(statement); return '{"status":"canceled"}'; });
  await store.cancel("batch\\path'quoted", "reason\\path'quoted");
  assert.match(statements[0], /E'batch\\\\path''quoted'/); assert.match(statements[0], /E'reason\\\\path''quoted'/);
  assert.throws(() => store.cancel('batch\0invalid', 'reason'), /zero byte/i);
});
