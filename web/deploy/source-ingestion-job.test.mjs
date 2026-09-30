import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadPinnedGcsArtifact } from '../lib/gcs-artifact-loader.node.mjs';
import { runSourceIngestionJob, sourceIngestionFailure, sourceIngestionJobConfig, sourceIngestionOutcome,
  sourcePostgresEnv, sourceStorageOptions } from '../scripts/run-postgres-source-ingestion.mjs';

const env = { GCP_STORAGE_BUCKET: 'biplan-staging-artifacts' };
const key = sha => `staging/preparation/sources/${sha}.json`;
const config = sourceIngestionJobConfig(['batch-1', key('a'.repeat(64)), '42', 'a'.repeat(64)], env);

await test('configuration enforces exact references and the 1..100 work bound', () => {
  assert.equal(sourceIngestionJobConfig(['batch-1', key('b'.repeat(64)), '1', 'b'.repeat(64)], { ...env, CATALOG_SOURCE_LIMIT: '100' }).limit, 100);
  assert.throws(() => sourceIngestionJobConfig(['batch-1', key('b'.repeat(64)), '1', 'b'.repeat(64)], { ...env, CATALOG_SOURCE_LIMIT: '101' }), /source limit/);
  assert.throws(() => sourceIngestionJobConfig(['batch-1', '../e.json', '1', 'b'.repeat(64)], env), /artifact key/);
  assert.throws(() => sourceIngestionJobConfig(['batch-1', key('b'.repeat(64)), '0', 'b'.repeat(64)], env), /generation/);
  assert.deepEqual(sourceStorageOptions('project', config.storageRequestTimeoutMs), { projectId: 'project', timeout: 20000,
    retryOptions: { autoRetry: false, maxRetries: 0 } });
  assert.equal(config.pgPoolMax, 2); assert.equal(config.pgStatementTimeoutMs, 30000);
  assert.deepEqual(sourcePostgresEnv({ BIPLAN_PG_POOL_MAX: '99', BIPLAN_PG_STATEMENT_TIMEOUT_MS: '999999' }, config),
    { BIPLAN_PG_POOL_MAX: '2', BIPLAN_PG_STATEMENT_TIMEOUT_MS: '30000' });
});

function storage(body, metadata = {}) {
  return { bucket: () => ({ file: (_key, options) => ({
    getMetadata: async () => [{ generation: '42', size: Buffer.byteLength(body), ...metadata }],
    createReadStream: () => { assert.equal(options.generation, '42'); return Readable.from([Buffer.from(body)]); },
  }) }) };
}

await test('loader pins generation, size and SHA before returning bytes', async () => {
  const body = '{"ok":true}', expectedSha256 = createHash('sha256').update(body).digest('hex');
  assert.equal(await loadPinnedGcsArtifact({ storage: storage(body), bucket: config.bucket, key: key(expectedSha256),
    generation: '42', expectedSha256, maxBytes: 100 }), body);
  await assert.rejects(loadPinnedGcsArtifact({ storage: storage(body, { generation: '43' }), bucket: config.bucket,
    key: key(expectedSha256), generation: '42', expectedSha256, maxBytes: 100 }), /generation mismatch/);
  await assert.rejects(loadPinnedGcsArtifact({ storage: storage(body), bucket: config.bucket, key: key('0'.repeat(64)),
    generation: '42', expectedSha256: '0'.repeat(64), maxBytes: 100 }), /SHA-256 mismatch/);
});

await test('artifact and envelope failures make zero database calls', async () => {
  let clients = 0;
  const dependencies = { storage: {}, loadArtifact: async () => '{"header":{"batchId":"wrong"}}',
    validateEnvelope: () => { throw new Error('must not validate mismatched batch'); }, createClient: () => { clients++; } };
  await assert.rejects(runSourceIngestionJob({ config, dependencies, signal: new AbortController().signal }), /batch ID mismatch/);
  assert.equal(clients, 0);
  dependencies.loadArtifact = async () => JSON.stringify({ header: { batchId: config.batchId } });
  dependencies.validateEnvelope = () => { throw new Error('invalid envelope'); };
  await assert.rejects(runSourceIngestionJob({ config, dependencies, signal: new AbortController().signal }), /invalid envelope/);
  assert.equal(clients, 0);
  dependencies.loadArtifact = async () => '{';
  await assert.rejects(runSourceIngestionJob({ config, dependencies, signal: new AbortController().signal }), /valid JSON/);
  assert.equal(clients, 0);
});

await test('size, hash and metadata interruption failures occur before PostgreSQL', async () => {
  let clients = 0;
  const base = { ...config, expectedSha256: '0'.repeat(64), objectKey: key('0'.repeat(64)), maxArtifactBytes: 100 };
  const dependencies = { loadArtifact: loadPinnedGcsArtifact, validateEnvelope: () => {}, createClient: () => { clients++; } };
  dependencies.storage = storage('oversized', { size: 2 });
  await assert.rejects(runSourceIngestionJob({ config: base, dependencies, signal: new AbortController().signal }), /size/);
  dependencies.storage = storage('hash-mismatch');
  await assert.rejects(runSourceIngestionJob({ config: base, dependencies, signal: new AbortController().signal }), /SHA-256/);
  const controller = new AbortController();
  dependencies.storage = { bucket: () => ({ file: () => ({ getMetadata: () => new Promise(resolve => setTimeout(() => resolve([{ generation: '42', size: 1 }]), 50)) }) }) };
  const pending = runSourceIngestionJob({ config: base, dependencies, signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /interrupted/);
  assert.equal(clients, 0);
});

await test('bounded ingestion receives injected stores and always closes PostgreSQL', async () => {
  let closed = 0, received;
  const envelope = { header: { batchId: config.batchId } };
  const dependencies = { storage: {}, loadArtifact: async () => JSON.stringify(envelope), validateEnvelope: value => assert.deepEqual(value, envelope),
    createClient: () => ({ queryText: async () => '', close: async () => { closed++; } }),
    createStore: query => ({ kind: 'page', query }), createCanonicalStore: query => ({ kind: 'canonical', query }),
    ingest: async (value, options) => { received = { value, options }; return { batchId: config.batchId, processed: 1, replayed: 0, remaining: 2, sealed: false }; } };
  const result = await runSourceIngestionJob({ config: { ...config, limit: 1 }, dependencies, signal: new AbortController().signal });
  assert.equal(result.remaining, 2); assert.equal(received.options.limit, 1);
  assert.equal(received.options.store.kind, 'page'); assert.equal(received.options.canonicalStore.kind, 'canonical');
  assert.equal(closed, 1);
});

await test('database stage failures identify the operation and timing without exposing SQL, parameters, or secrets', async () => {
  const envelope = { header: { batchId: config.batchId } };
  const cases = [
    { stage: 'find_heads', code: '57014', invoke: options => options.canonicalStore.findHeads({ id: 'record' }) },
    { stage: 'accept_batch', code: '23505', invoke: options => options.store.accept('batch-1', { private: 'parameter' }) },
    { stage: 'record_page', code: 'XX001', invoke: options => options.store.recordPage('batch-1', { private: 'parameter' }) },
    { stage: 'seal', code: '08006', invoke: options => options.store.sealV2('batch-1', { private: 'parameter' }) },
  ];
  for (const fixture of cases) {
    let closed = 0; const times = [100, 112];
    const failure = Object.assign(new Error('SELECT private_sql password=top-secret parameter=private'),
      { code: fixture.code, query: 'SELECT private_sql', parameters: ['private'] });
    const reject = async () => { throw failure; };
    const dependencies = { storage: {}, loadArtifact: async () => JSON.stringify(envelope), validateEnvelope: () => {},
      createClient: () => ({ queryText: async () => '', close: async () => { closed++; } }),
      createStore: () => ({ beginV2: async () => {}, checkpoints: async () => {}, recordPage: reject, accept: reject,
        quarantine: async () => {}, sealV2: reject }),
      createCanonicalStore: () => ({ findHeads: reject }), monotonicNow: () => times.shift(),
      ingest: async (_value, options) => fixture.invoke(options) };
    let caught; try { await runSourceIngestionJob({ config, dependencies, signal: new AbortController().signal }); }
    catch (error) { caught = error; }
    assert.ok(caught); assert.equal(caught.cause, failure); assert.equal(closed, 1);
    const output = sourceIngestionFailure(caught, { BIPLAN_PG_PASSWORD: 'top-secret' });
    assert.deepEqual(output, { error: 'Source ingestion database stage failed', stage: fixture.stage, elapsedMs: 12, driverCode: fixture.code });
    assert.doesNotMatch(JSON.stringify(output), /SELECT|private|top-secret|password/i);
  }
  const untrusted = sourceIngestionFailure({ sourceIngestionDiagnostic: { stage: 'private_stage', elapsedMs: -1,
    driverCode: 'password=top-secret', sql: 'SELECT private_sql' } });
  assert.deepEqual(untrusted, { error: 'Source ingestion database stage failed', stage: 'unknown', elapsedMs: 0, driverCode: 'unknown' });
  assert.doesNotMatch(JSON.stringify(untrusted), /SELECT|private|top-secret|password/i);
});

await test('only a coherent sealed result succeeds', () => {
  assert.deepEqual(sourceIngestionOutcome({ remaining: 0, sealed: true, seal: { status: 'sealed', idempotent: true } }), { status: 'completed', exitCode: 0 });
  assert.deepEqual(sourceIngestionOutcome({ remaining: 0, sealed: true, seal: { status: 'blocked' } }), { status: 'blocked', exitCode: 2 });
  assert.deepEqual(sourceIngestionOutcome({ remaining: 0, interrupted: true, sealed: false }), { status: 'interrupted', exitCode: 1 });
  const completed = { remaining: 0, begin: { status: 'published' }, seal: { status: 'completed', idempotent: true, resultPublicationId: 'retained-publication' } };
  assert.deepEqual(sourceIngestionOutcome(completed), { status: 'already_completed', exitCode: 0 });
  assert.deepEqual(sourceIngestionOutcome({ ...completed, seal: { ...completed.seal, idempotent: false } }), { status: 'not_ready', exitCode: 2 });
});

await test('source ingestion has a separate nonroot image with pinned runtime dependencies', async () => {
  const docker = await readFile(new URL('./Dockerfile.source-ingestion', import.meta.url), 'utf8');
  for (const required of ['node:22-bookworm-slim@sha256:', "'@google-cloud/storage'", 'page-batch-source.mjs', 'USER node'])
    assert.match(docker, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(docker, /run-postgres-preparation/);
  const ignore = await readFile(new URL('./Dockerfile.source-ingestion.dockerignore', import.meta.url), 'utf8');
  assert.match(ignore, /^\*\*/); assert.doesNotMatch(ignore, /web\/work|\.env/);
});
