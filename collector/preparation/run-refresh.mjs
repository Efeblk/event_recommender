import { randomUUID,createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRefreshStore,runPublicationRefresh } from './refresh-consumer.mjs';
import { assertOwned,work } from './db.mjs';

await assertOwned();
const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
const summary=await runPublicationRefresh({store:createRefreshStore(),workerId:`refresh-local-${randomUUID()}`,
  maxRequests:Number(process.env.CATALOG_REFRESH_MAX_REQUESTS ?? 8),timeBudgetMs:Number(process.env.CATALOG_REFRESH_TIME_MS ?? 30000),signal:controller.signal});
const sourceHashes={};
for(const path of ['refresh-consumer.mjs','run-refresh.mjs','migrations/004-publication-refresh.sql'])
  sourceHashes[`collector/preparation/${path}`]=createHash('sha256').update(await readFile(resolve(import.meta.dirname,path))).digest('hex');
const receipt={at:new Date().toISOString(),runtime:process.version,
  baseRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
  dirtyWorkingTree:execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim().length>0,
  sourceHashes,summary,aiCalls:0,cloudChanges:false};
await writeFile(resolve(work,`refresh-run-${Date.now()}.json`),JSON.stringify(receipt,null,2));
console.log(JSON.stringify(summary));if(summary.failures.length || summary.blocked) process.exitCode=1;
