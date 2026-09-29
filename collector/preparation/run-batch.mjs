import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createBatchStore } from './batch-store.mjs';
import { runBatchPreparation, runBatchPublication } from './batch-worker.mjs';
import { assertOwned, work } from './db.mjs';

const batchId = process.argv[2]; if (!batchId) throw new Error('usage: node run-batch.mjs BATCH_ID'); await assertOwned();
const controller = new AbortController(); process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
const store = createBatchStore(), workerId = `batch-local-${randomUUID()}`;
const preparation = await runBatchPreparation({ store, batchId, workerId, maxJobs: Number(process.env.CATALOG_BATCH_MAX_JOBS ?? 100),
  timeBudgetMs: Number(process.env.CATALOG_BATCH_TIME_MS ?? 30000), signal: controller.signal });
const publication = preparation.failures.length || preparation.stopped === 'interrupted' ? null : await runBatchPublication({ store, batchId, workerId, signal: controller.signal });
const sourceHashes = {}; for (const path of ['batch-store.mjs', 'batch-worker.mjs', 'run-batch.mjs', 'migrations/006-batched-publication.sql'])
  sourceHashes[`collector/preparation/${path}`] = createHash('sha256').update(await readFile(resolve(import.meta.dirname, path))).digest('hex');
const receipt = { at: new Date().toISOString(), runtime: process.version, baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  dirtyWorkingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim().length > 0,
  sourceHashes, preparation, publication, aiCalls: 0, cloudChanges: false };
await mkdir(work, { recursive: true }); await writeFile(resolve(work, `batch-run-${batchId}-${Date.now()}.json`), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify({ preparation, publication })); if (preparation.failures.length || publication?.failures.length) process.exitCode = 1;
