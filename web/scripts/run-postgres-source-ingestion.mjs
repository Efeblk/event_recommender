import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const integer = (value, fallback, minimum, maximum, name) => {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Invalid ${name}`);
  return parsed;
};
const identifier = (value, name, maximum = 250) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || value.length > maximum) throw new Error(`Invalid ${name}`);
  return value;
};

export function sourceIngestionJobConfig(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 4) throw new Error('Usage: run-postgres-source-ingestion.mjs BATCH_ID OBJECT_KEY GENERATION SHA256');
  const bucket = env.GCP_STORAGE_BUCKET?.trim();
  if (!bucket || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket)) throw new Error('Invalid source artifact bucket');
  if (!/^[1-9]\d*$/.test(argv[2])) throw new Error('Invalid source artifact generation');
  if (!/^[a-f0-9]{64}$/.test(argv[3])) throw new Error('Invalid source artifact SHA-256');
  const objectKey = argv[1];
  if (objectKey !== `staging/preparation/sources/${argv[3]}.json`) throw new Error('Invalid source artifact key');
  return { batchId: identifier(argv[0], 'batch id'), objectKey, generation: argv[2], expectedSha256: argv[3], bucket,
    limit: integer(env.CATALOG_SOURCE_LIMIT, 8, 1, 100, 'source limit'),
    maxArtifactBytes: integer(env.CATALOG_SOURCE_MAX_BYTES, 32 * 1024 * 1024, 1, 32 * 1024 * 1024, 'source artifact byte limit'),
    storageRequestTimeoutMs: integer(env.CATALOG_SOURCE_GCS_TIMEOUT_MS, 20000, 1000, 30000, 'source storage request timeout'),
    processDeadlineMs: integer(env.CATALOG_PROCESS_DEADLINE_MS, 90000, 5000, 300000, 'process deadline'),
    pgPoolMax: 2, pgStatementTimeoutMs: 30000 };
}

export const sourceStorageOptions = (projectId, requestTimeoutMs) => ({ projectId, timeout: requestTimeoutMs,
  retryOptions: { autoRetry: false, maxRetries: 0 } });
export const sourcePostgresEnv = (env, config) => ({ ...env, BIPLAN_PG_POOL_MAX: String(config.pgPoolMax),
  BIPLAN_PG_STATEMENT_TIMEOUT_MS: String(config.pgStatementTimeoutMs) });

export function sourceIngestionOutcome(result) {
  if (result?.interrupted === true) return { status: 'interrupted', exitCode: 1 };
  if (result?.remaining > 0) return { status: 'bounded_stop', exitCode: 2 };
  if (result?.remaining === 0 && result.begin?.status === 'published' && result.seal?.status === 'completed' &&
      result.seal.idempotent === true && typeof result.seal.resultPublicationId === 'string' && result.seal.resultPublicationId)
    return { status: 'already_completed', exitCode: 0 };
  if (result?.seal?.status === 'sealed' && result.sealed === true) return { status: 'completed', exitCode: 0 };
  if (result?.seal?.status === 'blocked') return { status: 'blocked', exitCode: 2 };
  return { status: 'not_ready', exitCode: 2 };
}

export async function runSourceIngestionJob({ config, dependencies, signal }) {
  let client;
  try {
    const body = await dependencies.loadArtifact({ storage: dependencies.storage, bucket: config.bucket, key: config.objectKey,
      generation: config.generation, expectedSha256: config.expectedSha256, maxBytes: config.maxArtifactBytes, signal });
    let envelope;
    try { envelope = JSON.parse(body); } catch { throw new Error('Source artifact is not valid JSON'); }
    if (envelope?.header?.batchId !== config.batchId) throw new Error('Source artifact batch ID mismatch');
    dependencies.validateEnvelope(envelope);
    if (signal?.aborted) throw new Error('Source ingestion interrupted before database access');
    client = dependencies.createClient();
    return await dependencies.ingest(envelope, { store: dependencies.createStore(client.queryText),
      canonicalStore: dependencies.createCanonicalStore(client.queryText), limit: config.limit, signal });
  } finally { await client?.close(); }
}

const sanitize = (value, env) => {
  let result = String(value?.message ?? value).slice(0, 1000);
  for (const secret of [env.BIPLAN_PG_PASSWORD, env.BIPLAN_PG_CA].filter(Boolean)) result = result.replaceAll(secret, '[redacted]');
  return result.replace(/(password|secret|token|key)=\S+/gi, '$1=[redacted]');
};

async function productionDependencies(env, config) {
  const [{ Storage }, { loadPinnedGcsArtifact }, { createPostgresClient }, source, sourceStore, canonicalStore] = await Promise.all([
    import('@google-cloud/storage'), import('../lib/gcs-artifact-loader.node.mjs'), import('../lib/postgres-client.node.ts'),
    import('../../collector/preparation/page-batch-source.mjs'), import('../../collector/preparation/page-batch-source-store.mjs'),
    import('../../collector/preparation/canonical-store.mjs'),
  ]);
  return { storage: new Storage(sourceStorageOptions(env.BIPLAN_GCP_PROJECT, config.storageRequestTimeoutMs)), loadArtifact: loadPinnedGcsArtifact,
    validateEnvelope: source.validatePageBatchEnvelope, ingest: source.ingestPageBatchSource,
    createClient: () => createPostgresClient(sourcePostgresEnv(env, config)), createStore: sourceStore.createPageBatchSourceStore,
    createCanonicalStore: canonicalStore.createCanonicalStore };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let config;
  try { config = sourceIngestionJobConfig(argv, env); }
  catch (error) { console.error(JSON.stringify({ status: 'rejected', error: sanitize(error, env) })); return 2; }
  const controller = new AbortController(), interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const deadline = setTimeout(interrupt, config.processDeadlineMs);
  try {
    const result = await runSourceIngestionJob({ config, dependencies: await productionDependencies(env, config), signal: controller.signal });
    const outcome = sourceIngestionOutcome(result);
    console.log(JSON.stringify({ status: outcome.status, batchId: result.batchId,
      processed: result.processed, replayed: result.replayed, remaining: result.remaining,
      sealed: result.seal?.status === 'sealed', aiCalls: 0 }));
    return outcome.exitCode;
  } catch (error) {
    console.error(JSON.stringify({ status: controller.signal.aborted ? 'interrupted' : 'failed', batchId: config.batchId, error: sanitize(error, env) }));
    return 1;
  } finally { clearTimeout(deadline); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exitCode = await main();
