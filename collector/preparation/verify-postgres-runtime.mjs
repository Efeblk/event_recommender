import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assertOwned,work } from './db.mjs';
import { createPostgresCatalog } from '../../web/lib/postgres-catalog.node.ts';
import { createPostgresClient } from '../../web/lib/postgres-client.node.ts';
import { sqlLiteral } from '../../web/lib/sql-literal.ts';
import { emptyFilters } from '../../web/lib/types.ts';
import { cosine,rankEvents,uniqueEvents } from '../../web/lib/search.ts';

// Read-only frozen-catalog diagnostics; no provider/AI calls or migrations.
await assertOwned();
const settings=Object.fromEntries((await readFile(resolve(work,'postgres.env'),'utf8')).trim().split(/\r?\n/).map(line=>{
  const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];
}));
const env={BIPLAN_PG_HOST:'127.0.0.1',BIPLAN_PG_PORT:'15432',BIPLAN_PG_DATABASE:settings.POSTGRES_DB,
  BIPLAN_PG_USER:'postgres',BIPLAN_PG_PASSWORD:settings.POSTGRES_PASSWORD,BIPLAN_PG_POOL_MAX:'2'};
const paths=['web/lib/postgres-client.node.ts','web/lib/postgres-catalog.node.ts','web/lib/publication-repository.ts','web/lib/prepared-publication-search.ts','web/lib/postgres-readiness.node.ts','web/lib/sql-literal.ts'];
const hashes=async()=>Object.fromEntries(await Promise.all(paths.map(async p=>[p,createHash('sha256').update(await readFile(resolve(import.meta.dirname,'../..',p))).digest('hex')])));
const sourceHashes=await hashes(),catalog=createPostgresCatalog(env),now=new Date(),samples=[];
const target={coldLexicalMs:3000,warmLexicalP95Ms:1000,concurrency4P95Ms:1500,catalogStatusP95Ms:150};
let coldMs,vectorMs,vectorCount,denseMs,denseRecall,publicationId,problem;
const run=async()=>{
  const started=performance.now(),pin=await catalog.pin(now),events=await pin.candidates({...emptyFilters,category:'Workshop'});
  publicationId??=pin.publicationId;assert.equal(pin.publicationId,publicationId);assert.ok(events.length>100);
  const shortlist=uniqueEvents(rankEvents(events,'seramik atölyesi'),16),admitted=await pin.finalize(shortlist);
  assert.equal(admitted.length,shortlist.length);assert.ok(admitted.length>0);
  return {ms:performance.now()-started,eligible:events.length,cards:admitted.length,pin};
};
try {
  const escaping=createPostgresClient(env);
  try {
    const adversarial="quote' slash\\'; SELECT pg_sleep(99); -- İstanbul";
    const encoded=await escaping.queryText(`SET standard_conforming_strings=off; SELECT to_jsonb(${sqlLiteral(adversarial)}::text)::text;`);
    assert.equal(JSON.parse(encoded),adversarial);
  } finally { await escaping.close(); }
  const cold=await run();coldMs=cold.ms;
  for(let i=0;i<10;i++){const r=await run();samples.push({kind:'warm',ms:r.ms,eligible:r.eligible,cards:r.cards});}
  const concurrent=await Promise.all(Array.from({length:4},run));
  samples.push(...concurrent.map(r=>({kind:'concurrent4',ms:r.ms,eligible:r.eligible,cards:r.cards})));
  const events=await cold.pin.candidates({...emptyFilters,category:'Workshop'}),at=performance.now();
  const vectors=await cold.pin.vectors(events,{apiKey:'offline-no-provider-call',model:'voyage-4-large',dimensions:1024});
  vectorMs=performance.now()-at;vectorCount=vectors.size;assert.ok(vectorCount>0);assert.ok(vectorCount<=events.length);
  const config={apiKey:'offline-no-provider-call',model:'voyage-4-large',dimensions:1024},queryVector=[...vectors.values()][0];
  const exact=[...vectors].map(([id,vector])=>({id,score:cosine(queryVector,vector)})).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  const denseStarted=performance.now(),dense=await cold.pin.dense.rank(events,config,queryVector);denseMs=performance.now()-denseStarted;
  assert.equal(await cold.pin.dense.coverage(events,config),vectors.size);
  assert.equal(dense.length,exact.length);assert.equal(new Set(dense).size,dense.length);
  // pgvector stores float32; compare score membership with a tolerance at the
  // exact top-16 boundary rather than inventing an order for numeric ties.
  const cut=exact[Math.min(15,exact.length-1)].score,byId=new Map(exact.map(r=>[r.id,r.score]));
  denseRecall=dense.slice(0,16).filter(id=>byId.get(id)>=cut-1e-6).length/Math.min(16,exact.length);
  assert.equal(denseRecall,1);
  for(let i=0;i<10;i++) {
    const started=performance.now(),status=await catalog.catalogStatus(now);
    assert.equal(status.stored,7719);assert.ok(status.eligible>0&&status.eligible<=status.stored);
    samples.push({kind:'catalogStatus',ms:performance.now()-started,stored:status.stored,eligible:status.eligible});
  }
  assert.deepEqual(await hashes(),sourceHashes);
} catch(error) {problem=error;}
finally {await catalog.close();}
const percentile=(kind,p)=>{const sorted=samples.filter(s=>s.kind===kind).map(s=>s.ms).sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*p)-1)]??null;};
const measured={coldMs,warmP50Ms:percentile('warm',.5),warmP95Ms:percentile('warm',.95),concurrency4P95Ms:percentile('concurrent4',.95),vectorReadMs:vectorMs,vectorCount,exactDenseMs:denseMs,exactBaselineRecallAt16:denseRecall,catalogStatusP95Ms:percentile('catalogStatus',.95)};
const receipt={at:new Date().toISOString(),runtime:process.version,baseRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),dirtyWorkingTree:true,
  sourceHashes,passed:!problem,publicationId,target,measured,samples,
  targetsMet:!problem&&coldMs<=target.coldLexicalMs&&measured.warmP95Ms<=target.warmLexicalP95Ms&&measured.concurrency4P95Ms<=target.concurrency4P95Ms&&measured.catalogStatusP95Ms<=target.catalogStatusP95Ms,
  error:problem?.message,aiCalls:0,cloudChanges:false,qualification:'Loopback PostgreSQL, local frozen data, lexical query, 10 warm/4 concurrent samples. Excludes interpreter, query embedding, Jev, WAN and Cloud Run.'};
const path=resolve(work,`postgres-runtime-verification-${Date.now()}.json`);await writeFile(path,JSON.stringify(receipt,null,2));
console.log(JSON.stringify({passed:receipt.passed,targetsMet:receipt.targetsMet,measured,receipt:path}));
if(problem) throw problem;
