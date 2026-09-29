import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createCanonicalStore } from './canonical-store.mjs';
import { runCanonicalWorker } from './canonical-worker.mjs';
import { assertOwned, work } from './db.mjs';

await assertOwned();
const controller = new AbortController(); process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
const summary = await runCanonicalWorker({ store: createCanonicalStore(), workerId: `canonical-local-${randomUUID()}`,
  maxJobs: Number(process.env.CATALOG_CANONICAL_MAX_JOBS ?? 8), timeBudgetMs: Number(process.env.CATALOG_CANONICAL_TIME_MS ?? 30000), signal: controller.signal });
const sourceHashes = {};
for (const path of ['canonical-adapter.mjs', 'canonical-store.mjs', 'canonical-worker.mjs', 'run-canonical.mjs', 'migrations/005-canonical-preparation.sql'])
  sourceHashes[`collector/preparation/${path}`] = createHash('sha256').update(await readFile(resolve(import.meta.dirname, path))).digest('hex');
const receipt = { at: new Date().toISOString(), runtime: process.version, baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
  dirtyWorkingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim().length > 0,
  sourceHashes, summary, aiCalls: 0, cloudChanges: false };
await mkdir(work, { recursive: true }); await writeFile(resolve(work, `canonical-run-${Date.now()}.json`), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(summary)); if (summary.failures.length) process.exitCode = 1;
