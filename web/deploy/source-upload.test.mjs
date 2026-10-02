import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { sourceUploadConfig, uploadSourceArtifact } from '../scripts/upload-postgres-source.mjs';

const env = { DEPLOYMENT_ENV: 'staging', BIPLAN_GCP_PROJECT: 'biplan-staging-efeblk', GCP_STORAGE_BUCKET: 'biplan-staging-efeblk-biplan-staging-data' };
const config = sourceUploadConfig(['fixture.json', 'batch-1'], env);
const body = Buffer.from(JSON.stringify({ header: { batchId: 'batch-1' }, marker: 'complete-v2' }));
const digest = createHash('sha256').update(body).digest('hex'), key = `staging/preparation/sources/${digest}.json`;

function storageHarness({ saveError = null, metadata = {}, stored = body } = {}) {
  const calls = { save: [] };
  const storage = { bucket: () => ({ file: (_key, options) => ({
    save: async (value, settings) => { calls.save.push({ value, settings }); if (saveError) throw saveError; },
    getMetadata: async () => [{ generation: '7', size: stored.length, contentType: 'application/json',
      metadata: { biplanSha256: digest }, ...metadata }],
    createReadStream: () => { assert.equal(options.generation, '7'); return Readable.from([stored]); },
  }) }) };
  return { storage, calls };
}

function dependencies(harness, local = body) {
  return { readLocal: async () => local, validateEnvelope: value => {
    if (value?.marker !== 'complete-v2') throw new Error('invalid complete envelope');
  }, createStorage: () => harness.storage };
}

await test('configuration requires explicit staging project and bucket', () => {
  assert.equal(config.maxBytes, 32 * 1024 * 1024);
  assert.throws(() => sourceUploadConfig(['x', 'batch-1'], { ...env, DEPLOYMENT_ENV: 'production' }), /staging/);
  assert.throws(() => sourceUploadConfig(['x', 'batch-1'], { ...env, BIPLAN_GCP_PROJECT: 'foreign-project' }), /Unapproved staging project/);
  assert.throws(() => sourceUploadConfig(['x', 'batch-1'], { ...env, GCP_STORAGE_BUCKET: 'foreign-bucket' }), /Unapproved staging bucket/);
});

await test('invalid local JSON and envelope make zero Storage clients', async () => {
  let clients = 0;
  const deps = { readLocal: async () => Buffer.from('{'), validateEnvelope: () => {}, createStorage: () => { clients++; } };
  await assert.rejects(uploadSourceArtifact({ config, dependencies: deps }), /valid JSON/); assert.equal(clients, 0);
  deps.readLocal = async () => body; deps.validateEnvelope = () => { throw new Error('invalid envelope'); };
  await assert.rejects(uploadSourceArtifact({ config, dependencies: deps }), /invalid envelope/); assert.equal(clients, 0);
});

await test('upload is create-only and returns only verified generation metadata', async () => {
  const harness = storageHarness();
  const receipt = await uploadSourceArtifact({ config, dependencies: dependencies(harness) });
  assert.deepEqual(receipt, { batchId: 'batch-1', key, generation: '7', sha256: digest, bytes: body.length, reused: false });
  const settings = harness.calls.save[0].settings;
  assert.equal(settings.preconditionOpts.ifGenerationMatch, 0); assert.equal(settings.validation, 'crc32c');
  assert.equal(settings.metadata.metadata.biplanSha256, digest);
});

await test('collision or lost response reports reuse only after complete pinned readback', async () => {
  const harness = storageHarness({ saveError: Object.assign(new Error('lost'), { code: 412 }) });
  const receipt = await uploadSourceArtifact({ config, dependencies: dependencies(harness) });
  assert.equal(receipt.reused, true); assert.equal(receipt.generation, '7');
  const lost = storageHarness({ saveError: new Error('request timeout after commit') });
  assert.equal((await uploadSourceArtifact({ config, dependencies: dependencies(lost) })).reused, true);
  const wrong = storageHarness({ saveError: new Error('timeout'), metadata: { metadata: { biplanSha256: '0'.repeat(64) } } });
  await assert.rejects(uploadSourceArtifact({ config, dependencies: dependencies(wrong) }), /metadata mismatch/);
});

await test('timeout or wrong existing bytes never reports success', async () => {
  const timeout = { storage: { bucket: () => ({ file: () => ({ save: async () => { throw new Error('timeout'); },
    getMetadata: async () => { throw new Error('credential detail must not escape'); } }) }) }, calls: {} };
  await assert.rejects(uploadSourceArtifact({ config, dependencies: dependencies(timeout) }), /verification failed/);
  const wrongBody = Buffer.from(JSON.stringify({ header: { batchId: 'batch-1' }, marker: 'tampered-v2' }));
  const wrong = storageHarness({ saveError: new Error('collision'), stored: wrongBody,
    metadata: { metadata: { biplanSha256: digest } } });
  await assert.rejects(uploadSourceArtifact({ config, dependencies: dependencies(wrong) }), /SHA-256 mismatch/);
});

await test('hung create and metadata verification are interruptible unknown outcomes', async () => {
  const createController = new AbortController();
  const hungCreate = storageHarness(); hungCreate.storage.bucket = () => ({ file: () => ({ save: () => new Promise(() => {}) }) });
  const create = uploadSourceArtifact({ config, dependencies: dependencies(hungCreate), signal: createController.signal });
  createController.abort(); await assert.rejects(create, /interrupted/);

  const metadataController = new AbortController();
  const hungMetadata = storageHarness(); hungMetadata.storage.bucket = () => ({ file: () => ({
    save: async () => {}, getMetadata: () => new Promise(() => {}),
  }) });
  const metadata = uploadSourceArtifact({ config, dependencies: dependencies(hungMetadata), signal: metadataController.signal });
  await new Promise(resolve => setImmediate(resolve)); metadataController.abort();
  await assert.rejects(metadata, /interrupted/);
});
