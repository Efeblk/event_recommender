import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

export const PUBLICATION_QUERY_LIMIT_MS = 65000;
export const PUBLICATION_FAILURE_RESERVE_MS = 30000;
export const PUBLICATION_ADMISSION_MS = PUBLICATION_QUERY_LIMIT_MS + PUBLICATION_FAILURE_RESERVE_MS;
export const PUBLICATION_SETUP_RESERVE_MS = 15000;
export const PUBLICATION_PRECHECK_MS = PUBLICATION_ADMISSION_MS + PUBLICATION_SETUP_RESERVE_MS;

const integer = (value, fallback, minimum, maximum, name) => {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new Error(`Invalid ${name}`);
  return parsed;
};
const identifier = (value, name, maximum = 250) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || value.length > maximum)
    throw new Error(`Invalid ${name}`);
  return value;
};

export function preparationJobConfig(argv = process.argv.slice(2), env = process.env) {
  if (argv.length !== 2 || !['prepare', 'publish'].includes(argv[0]))
    throw new Error('Usage: run-postgres-preparation.mjs prepare|publish SEALED_BATCH_ID');
  const mode = argv[0], batchId = identifier(argv[1], 'sealed batch id');
  const config = {
    mode, batchId,
    workerId: identifier(env.CATALOG_BATCH_WORKER_ID || `cloud-run-${mode}-${randomUUID()}`, 'batch worker id', 200),
    maxJobs: integer(env.CATALOG_BATCH_MAX_JOBS, 100, 1, 1000, 'batch job limit'),
    leaseSeconds: integer(env.CATALOG_BATCH_LEASE_SECONDS, 120, 15, 900, 'batch lease'),
    timeBudgetMs: integer(env.CATALOG_BATCH_TIME_MS, 30000, 1000, 60000, 'batch time budget'),
    processDeadlineMs: integer(env.CATALOG_PROCESS_DEADLINE_MS, mode === 'publish' ? 120000 : 90000, 5000, 300000, 'process deadline'),
  };
  if (mode === 'publish' && (config.leaseSeconds * 1000 < PUBLICATION_PRECHECK_MS || config.processDeadlineMs < PUBLICATION_PRECHECK_MS))
    throw new Error('Publication lease and process deadline must cover the bounded publication operation');
  return config;
}

const safeSummary = (result) => ({
  batchId: result.batchId, workerId: result.workerId, claimed: result.claimed,
  ...(result.completed !== undefined ? { completed: result.completed } : {}),
  ...(result.published !== undefined ? { published: result.published } : {}),
  failures: result.failures?.map((failure) => ({ id: failure.id, code: failure.code, retryable: failure.retryable, persistence: failure.persistence })) ?? [],
  stopped: result.stopped, elapsedMs: result.elapsedMs,
  ...(Number.isFinite(result.publicationSqlMs) ? { publicationSqlMs: result.publicationSqlMs } : {}),
  ...(result.idempotent ? { idempotent: true, publicationId: result.publicationId } : {}),
});

const publicationBudgetError = () => Object.assign(new Error('Insufficient bounded publication budget'), { code: 'publication_budget' });

export async function runPreparationJob({ config, dependencies, signal, now = () => performance.now(), processStartedAt }) {
  const started = processStartedAt ?? now();
  let client;
  try {
    client = dependencies.createClient(config);
    const batch = await dependencies.batchState(client, config.batchId);
    if (batch?.schemaVersion === 2 && batch.state === 'published' && typeof batch.publicationId === 'string' && batch.publicationId) {
      // A lost response can lead to an explicit repeat execution. Report the
      // durable completion without reclaiming work or reactivating an old version.
      return safeSummary({ batchId: config.batchId, workerId: config.workerId, claimed: 0,
        completed: 0, published: 0, failures: [], stopped: 'already_completed',
        idempotent: true, publicationId: batch.publicationId });
    }
    if (batch?.state !== 'sealed') throw new Error('Requested preparation batch is not sealed');
    if (batch.schemaVersion !== 2) throw new Error('Preparation Job requires a version 2 page/record receipt');
    if (config.mode === 'publish') {
      if (signal?.aborted) return safeSummary({ batchId: config.batchId, workerId: config.workerId, claimed: 0,
        published: 0, failures: [], stopped: 'interrupted' });
      if (config.processDeadlineMs - (now() - started) < PUBLICATION_PRECHECK_MS)
        return safeSummary({ batchId: config.batchId, workerId: config.workerId, claimed: 0,
          published: 0, failures: [], stopped: 'time_budget' });
    }
    const store = dependencies.createStore(client.queryText, { publishQuery: client.publishQuery ?? client.queryText });
    const result = config.mode === 'prepare'
      ? await dependencies.runPreparation({
        store, batchId: config.batchId, workerId: config.workerId,
        maxJobs: config.maxJobs, leaseSeconds: config.leaseSeconds,
        timeBudgetMs: config.timeBudgetMs, signal,
      })
      : await dependencies.runPublication({
        store, batchId: config.batchId, workerId: config.workerId,
        leaseSeconds: config.leaseSeconds, signal, now,
        beforePublish: ({ phase, leaseRemainingMs, signal: currentSignal }) => {
          if (currentSignal?.aborted) throw Object.assign(new Error('Batch publication interrupted before activation'), { code: 'worker_interrupted' });
          const required = phase === 'after_setup' ? PUBLICATION_ADMISSION_MS : PUBLICATION_PRECHECK_MS;
          if (leaseRemainingMs < required || config.processDeadlineMs - (now() - started) < required)
            throw publicationBudgetError();
        },
      });
    return safeSummary(result);
  } finally {
    await client?.close();
  }
}

export function preparationJobOutcome(mode, result) {
  if (result.failures.length) return { status: 'failed', exitCode: 1 };
  if (result.stopped === 'interrupted') return { status: 'interrupted', exitCode: 1 };
  if (result.stopped === 'already_completed' && result.idempotent === true && result.publicationId)
    return { status: 'completed', exitCode: 0 };
  if (mode === 'prepare')
    return result.stopped === 'drained'
      ? { status: 'completed', exitCode: 0 }
      : { status: 'bounded_stop', exitCode: 2 };
  if (result.stopped === 'time_budget') return { status: 'bounded_stop', exitCode: 2 };
  if (result.published === 1 && result.stopped === 'completed') return { status: 'completed', exitCode: 0 };
  if (result.stopped === 'not_ready') return { status: 'not_ready', exitCode: 2 };
  return { status: 'failed', exitCode: 1 };
}

async function productionDependencies(env) {
  const [{ createPostgresClient }, { createPostgresPublicationClient }, { createBatchStore }, workers] = await Promise.all([
    import('../lib/postgres-client.node.ts'),
    import('./postgres-publication-client.mjs'),
    import('../../collector/preparation/batch-store.mjs'),
    import('../../collector/preparation/batch-worker.mjs'),
  ]);
  return {
    createClient: config => config.mode === 'publish'
      ? createPostgresPublicationClient(env)
      : createPostgresClient({ ...env, BIPLAN_PG_STATEMENT_TIMEOUT_MS: '30000' }),
    batchState: async (client, batchId) => {
      const response = await client.pool.query("SELECT state,publication_id,header->'schemaVersion' AS schema_version FROM biplan.preparation_batches WHERE id=$1", [batchId]);
      return response.rowCount === 1 ? { state: response.rows[0].state, publicationId: response.rows[0].publication_id, schemaVersion: response.rows[0].schema_version } : null;
    },
    createStore: createBatchStore,
    runPreparation: workers.runBatchPreparation,
    runPublication: workers.runBatchPublication,
  };
}

const sanitize = (value, env) => {
  let result = String(value?.message ?? value).slice(0, 1000);
  for (const secret of [env.BIPLAN_PG_PASSWORD, env.BIPLAN_PG_CA].filter(Boolean)) result = result.replaceAll(secret, '[redacted]');
  return result.replace(/(password|secret|token|key)=\S+/gi, '$1=[redacted]');
};

async function packagedSourceHashes() {
  const paths = [
    ['web/scripts/run-postgres-preparation.mjs', resolve(import.meta.dirname, 'run-postgres-preparation.mjs')],
    ['web/scripts/postgres-publication-client.mjs', resolve(import.meta.dirname, 'postgres-publication-client.mjs')],
    ['web/lib/postgres-client.node.ts', resolve(import.meta.dirname, '../lib/postgres-client.node.ts')],
    ['web/lib/sql-literal.ts', resolve(import.meta.dirname, '../lib/sql-literal.ts')],
    ['web/package-lock.json', resolve(import.meta.dirname, '../package-lock.json')],
    ['collector/preparation/batch-store.mjs', resolve(import.meta.dirname, '../../collector/preparation/batch-store.mjs')],
    ['collector/preparation/batch-worker.mjs', resolve(import.meta.dirname, '../../collector/preparation/batch-worker.mjs')],
    ['collector/preparation/canonical-worker.mjs', resolve(import.meta.dirname, '../../collector/preparation/canonical-worker.mjs')],
  ];
  return Object.fromEntries(await Promise.all(paths.map(async ([name, path]) =>
    [name, createHash('sha256').update(await readFile(path)).digest('hex')],
  )));
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const processStartedAt = performance.now();
  let config;
  try { config = preparationJobConfig(argv, env); }
  catch (error) { console.error(JSON.stringify({ status: 'rejected', error: sanitize(error, env) })); return 2; }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const deadline = setTimeout(interrupt, config.processDeadlineMs);
  try {
    const result = await runPreparationJob({ config, dependencies: await productionDependencies(env), signal: controller.signal, processStartedAt });
    const outcome = preparationJobOutcome(config.mode, result);
    console.log(JSON.stringify({ status: outcome.status, mode: config.mode, ...result,
      sourceHashes: await packagedSourceHashes(), aiCalls: 0 }));
    return outcome.exitCode;
  } catch (error) {
    console.error(JSON.stringify({ status: controller.signal.aborted ? 'interrupted' : 'failed', mode: config.mode, batchId: config.batchId, error: sanitize(error, env) }));
    return 1;
  } finally {
    clearTimeout(deadline); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
  process.exitCode = await main();
