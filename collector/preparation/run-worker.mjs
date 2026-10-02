import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorkerStore } from './worker-store.mjs';
import { runPreparationWorker } from './worker.mjs';
import { work, assertOwned,sql } from './db.mjs';

await assertOwned();
const enqueueLimit=Number(process.env.CATALOG_WORKER_ENQUEUE ?? 0);
if (!Number.isInteger(enqueueLimit) || enqueueLimit<0 || enqueueLimit>100) throw new Error('Invalid bounded enqueue limit');
const publicationBefore=await sql('SELECT publication_id FROM biplan.active_publication WHERE singleton;');
const enqueued=enqueueLimit>0 ? Number(await sql(`SELECT biplan.enqueue_missing_offer_preparation_jobs(${enqueueLimit});`)) : 0;
const signal=new AbortController();
process.once('SIGINT',()=>signal.abort()); process.once('SIGTERM',()=>signal.abort());
const summary=await runPreparationWorker({store:createWorkerStore(),workerId:`local-${randomUUID()}`,
  maxJobs:Number(process.env.CATALOG_WORKER_MAX_JOBS ?? 8),maxEvents:Number(process.env.CATALOG_WORKER_MAX_EVENTS ?? 8),
  timeBudgetMs:Number(process.env.CATALOG_WORKER_TIME_MS ?? 30000),signal:signal.signal});
const sourceHashes={};
for (const path of ['worker.mjs','worker-store.mjs','run-worker.mjs','migrations/003-workers.sql'])
  sourceHashes[`collector/preparation/${path}`]=createHash('sha256').update(await readFile(resolve(import.meta.dirname,path))).digest('hex');
const receipt={at:new Date().toISOString(),runtime:process.version,
  baseRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
  dirtyWorkingTree:execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim().length>0,
  sourceHashes,summary,enqueued,aiCalls:0,cloudChanges:false,
  publicationBefore,publicationAfter:await sql('SELECT publication_id FROM biplan.active_publication WHERE singleton;')};
await writeFile(resolve(work,`worker-run-${Date.now()}.json`),JSON.stringify(receipt,null,2));
console.log(JSON.stringify({...summary,enqueued}));
if (summary.failures.length) process.exitCode=1;
