import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { loadPinnedGcsArtifact } from '../lib/gcs-artifact-loader.node.mjs';
import { sourceStorageOptions } from './run-postgres-source-ingestion.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
const APPROVED_PROJECT = 'biplan-staging-efeblk';
const APPROVED_BUCKET = 'biplan-staging-efeblk-biplan-staging-data';
const sha = body => createHash('sha256').update(body).digest('hex');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,249}$/.test(value);

export function sourceUploadConfig(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 2 || !identifier(argv[1])) throw new Error('Usage: upload-postgres-source.mjs ENVELOPE_JSON BATCH_ID');
  if (env.DEPLOYMENT_ENV !== 'staging') throw new Error('Source artifact upload requires explicit staging environment');
  const projectId = env.BIPLAN_GCP_PROJECT?.trim(), bucket = env.GCP_STORAGE_BUCKET?.trim();
  if (projectId !== APPROVED_PROJECT) throw new Error('Unapproved staging project');
  if (bucket !== APPROVED_BUCKET) throw new Error('Unapproved staging bucket');
  const timeout = env.CATALOG_SOURCE_GCS_TIMEOUT_MS === undefined ? 20000 : Number(env.CATALOG_SOURCE_GCS_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 30000) throw new Error('Invalid source storage request timeout');
  return { path: resolve(argv[0]), batchId: argv[1], projectId, bucket, requestTimeoutMs: timeout, maxBytes: MAX_BYTES };
}

export async function readSourceEnvelope(path, maxBytes = MAX_BYTES) {
  const info = await stat(path);
  if (!info.isFile() || !Number.isSafeInteger(info.size) || info.size < 1 || info.size > maxBytes) throw new Error('Source envelope file size is invalid');
  const body = await readFile(path);
  if (body.length !== info.size || body.length > maxBytes) throw new Error('Source envelope file changed while reading');
  return body;
}

const safeMetadata = metadata => ({ generation: String(metadata?.generation ?? ''), size: Number(metadata?.size),
  sha256: metadata?.metadata?.biplanSha256, contentType: metadata?.contentType });

async function abortable(operation, signal, message) {
  if (!signal) return operation;
  if (signal.aborted) throw new Error(message);
  let remove = () => {};
  const interrupted = new Promise((_, reject) => {
    const abort = () => reject(new Error(message));
    signal.addEventListener('abort', abort, { once: true });
    remove = () => signal.removeEventListener('abort', abort);
  });
  try { return await Promise.race([operation, interrupted]); }
  finally { remove(); }
}

async function verifyStored({ storage, config, key, expectedSha256, expectedSize, validateEnvelope, signal }) {
  if (signal?.aborted) throw new Error('Source artifact upload interrupted');
  let metadata;
  try { [metadata] = await abortable(storage.bucket(config.bucket).file(key).getMetadata(), signal, 'Source artifact upload interrupted'); }
  catch (error) {
    if (signal?.aborted || error?.message === 'Source artifact upload interrupted') throw new Error('Source artifact upload interrupted');
    throw new Error('Source artifact verification failed');
  }
  const checked = safeMetadata(metadata);
  if (!/^[1-9]\d*$/.test(checked.generation) || checked.size !== expectedSize || checked.sha256 !== expectedSha256 ||
      checked.contentType !== 'application/json') throw new Error('Stored source artifact metadata mismatch');
  const body = await loadPinnedGcsArtifact({ storage, bucket: config.bucket, key, generation: checked.generation,
    expectedSha256, maxBytes: config.maxBytes, signal });
  let envelope;
  try { envelope = JSON.parse(body); } catch { throw new Error('Stored source artifact JSON is invalid'); }
  if (envelope?.header?.batchId !== config.batchId) throw new Error('Stored source artifact batch mismatch');
  validateEnvelope(envelope);
  return checked.generation;
}

export async function uploadSourceArtifact({ config, dependencies, signal }) {
  const body = await dependencies.readLocal(config.path, config.maxBytes);
  let envelope;
  try { envelope = JSON.parse(body); } catch { throw new Error('Source envelope is not valid JSON'); }
  if (envelope?.header?.batchId !== config.batchId) throw new Error('Source envelope batch ID mismatch');
  dependencies.validateEnvelope(envelope);
  if (signal?.aborted) throw new Error('Source artifact upload interrupted');
  const expectedSha256 = sha(body), key = `staging/preparation/sources/${expectedSha256}.json`;
  const storage = dependencies.createStorage(config.projectId, config.requestTimeoutMs);
  let reused = false;
  try {
    await abortable(storage.bucket(config.bucket).file(key).save(body, { resumable: false, validation: 'crc32c',
      preconditionOpts: { ifGenerationMatch: 0 }, contentType: 'application/json',
      metadata: { contentType: 'application/json', metadata: { biplanSha256: expectedSha256 } } }), signal,
    'Source artifact upload interrupted');
  } catch {
    if (signal?.aborted) throw new Error('Source artifact upload interrupted');
    reused = true;
  }
  const generation = await verifyStored({ storage, config, key, expectedSha256, expectedSize: body.length,
    validateEnvelope: dependencies.validateEnvelope, signal });
  return { batchId: config.batchId, key, generation, sha256: expectedSha256, bytes: body.length, reused };
}

const sanitized = value => String(value?.message ?? value).slice(0, 500).replace(/(authorization|password|secret|token|key)=\S+/gi, '$1=[redacted]');

export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const config = sourceUploadConfig(argv, env);
    const [{ Storage }, source] = await Promise.all([import('@google-cloud/storage'), import('../../collector/preparation/page-batch-source.mjs')]);
    const receipt = await uploadSourceArtifact({ config, signal: AbortSignal.timeout(60000), dependencies: {
      readLocal: readSourceEnvelope, validateEnvelope: source.validatePageBatchEnvelope,
      createStorage: (projectId, timeout) => new Storage(sourceStorageOptions(projectId, timeout)),
    } });
    console.log(JSON.stringify({ status: receipt.reused ? 'verified_existing' : 'uploaded', ...receipt })); return 0;
  } catch (error) { console.error(JSON.stringify({ status: 'failed', error: sanitized(error) })); return 1; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main();
