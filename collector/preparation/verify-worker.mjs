import assert from 'node:assert/strict';
import { randomBytes,createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertOwned,docker,sql,literal,container,work } from './db.mjs';
import { createWorkerStore } from './worker-store.mjs';
import { deriveOfferFacts,runPreparationWorker } from './worker.mjs';

const database=`biplan_worker_verify_${randomBytes(6).toString('hex')}`;
assert.match(database,/^biplan_worker_verify_[0-9a-f]{12}$/);
const paths=['schema.sql','migrations/002-offer-revisions.sql','migrations/003-workers.sql','worker.mjs','worker-store.mjs','verify-worker.mjs'];
async function hashes() {
  const result={};
  for(const path of paths) result[`collector/preparation/${path}`]=createHash('sha256').update(await readFile(resolve(import.meta.dirname,path))).digest('hex');
  return result;
}
const sourceHashes=await hashes();
const checks=[],timings=[],worker='verify-worker';
let created=false,problem;
const query=async statement=>{
  await assertOwned();
  return docker(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],
    `SET statement_timeout='20s';\n${statement}`);
};
const store=createWorkerStore(query);
async function verify(name,run) {
  const started=performance.now(); await run(); checks.push(name);timings.push({name,ms:Math.round(performance.now()-started)});console.log(`PASS ${name}`);
}
const payload=(name,revision,offset,price='70000')=>({revisionId:revision,offerId:name,sessionId:'fixture-session',provider:'fixture-provider',
  providerRecordId:name,observedAt:new Date(Date.UTC(2026,8,30,0,offset)).toISOString(),sourceUpdatedAt:new Date(Date.UTC(2026,8,30,0,offset)).toISOString(),
  contentHash:`facts-${price}`,sourcePayload:{id:name,priceMinor:price},priceMinor:price,feeMinor:null,currency:'TRY',priceKind:'starting_at',availability:'available'});
const accept=async(p,expected)=>JSON.parse(await query(`SELECT biplan.accept_offer_revision(${literal(JSON.stringify(p))}::jsonb,${expected===null?'NULL':literal(expected)})::text;`));
const count=async(table,where='true')=>Number(await query(`SELECT count(*) FROM biplan.${table} WHERE ${where};`));
const drain=()=>runPreparationWorker({store,workerId:worker,maxJobs:20,maxEvents:20,timeBudgetMs:30000});
const failError={code:'fixture_failure',retryable:false,message:'Controlled local failure'};
try {
  await assertOwned(); await sql(`CREATE DATABASE ${database};`);created=true;
  for (const path of ['schema.sql','migrations/002-offer-revisions.sql','migrations/003-workers.sql'])
    await query(await readFile(resolve(import.meta.dirname,path),'utf8'));
  await query(await readFile(resolve(import.meta.dirname,'migrations/003-workers.sql'),'utf8'));
  await query(`INSERT INTO biplan.productions(id,title,content_hash) VALUES('fixture-production','Fixture production','fixture');
    INSERT INTO biplan.sessions(id,production_id,starts_at,status,content_hash) VALUES('fixture-session','fixture-production','2026-10-01T18:00:00Z','scheduled','fixture');
    INSERT INTO biplan.preparation_jobs(id,stage,stage_version,subject_type,subject_id,input_hash) VALUES('unsupported-job','other-stage','1','offer','fixture','unknown'),('future-version-job','offer_revision_accepted','2','offer','fixture','unknown');
    INSERT INTO biplan.outbox(id,topic,aggregate_type,aggregate_id,payload,idempotency_key) VALUES('unsupported-event','other-topic','offer','fixture','{}','unsupported');`);

  await verify('real worker handles A-B-A with two cached derivations and three distinct pending refresh requests',async()=>{
    await accept(payload('offer-aba','revision-A',1,'0'),null);
    await accept(payload('offer-aba','revision-B',2,'9007199254740993'),'revision-A');
    await accept(payload('offer-aba','revision-A-return',3,'0'),'revision-B');
    const result=await drain();
    assert.equal(result.completedJobs,2);assert.equal(result.deliveredEvents,3);assert.deepEqual(result.failures,[]);
    assert.equal(await count('offer_derivations'),2);assert.equal(await count('publication_refresh_requests',"state='pending'"),3);
    assert.equal(await count('job_attempts',"outcome='succeeded' AND cost_units=0"),2);
    assert.equal(await count('outbox_attempts',"outcome='delivered' AND cost_units=0"),3);
    assert.equal(await count('preparation_jobs',"id IN ('unsupported-job','future-version-job') AND state='pending' AND attempt_count=0"),2);
    assert.equal(await count('outbox',"id='unsupported-event' AND state='pending' AND attempt_count=0"),1);
    assert.equal(await count('active_publication'),0);
    const rows=JSON.parse(await query("SELECT jsonb_agg(normalized_facts)::text FROM biplan.offer_derivations;"));
    assert.ok(rows.every(row=>row.exactCheckoutPriceMinor===null && row.feeMinor===null));
    assert.ok(rows.some(row=>row.basePriceMinor==='0'));assert.ok(rows.some(row=>row.basePriceMinor==='9007199254740993'));
  });

  await verify('lost replies replay only exact successful completion/delivery for the original worker',async()=>{
    const jobs=JSON.parse(await query("SELECT jsonb_agg(to_jsonb(j)||jsonb_build_object('fencing_token',fencing_token::text))::text FROM biplan.preparation_jobs j WHERE state='succeeded';"));
    const job=jobs[0],result=JSON.parse(await query(`SELECT result::text FROM biplan.offer_derivations WHERE offer_id=${literal(job.subject_id)} AND input_hash=${literal(job.input_hash)};`));
    assert.equal((await store.finishJob(job,worker,result)).idempotent,true);
    await assert.rejects(()=>store.finishJob(job,'wrong-worker',result),/stale|invalid/i);
    await assert.rejects(()=>store.finishJob(job,worker,{...result,facts:{...result.facts,basePriceMinor:'1'}}),/stale|invalid|conflict/i);
    const event=JSON.parse(await query("SELECT (to_jsonb(e)||jsonb_build_object('fencing_token',fencing_token::text))::text FROM biplan.outbox e WHERE state='delivered' LIMIT 1;"));
    assert.equal((await store.deliverEvent(event,worker)).idempotent,true);
    await assert.rejects(()=>store.deliverEvent(event,'wrong-worker'),/stale|invalid/i);
    assert.equal(await count('publication_refresh_requests'),3);
    await assert.rejects(()=>query("UPDATE biplan.offer_derivations SET price_minor=1;"),/immutable/i);
  });

  await verify('SQL and worker agree on null prices/currency, normalized currency and zero/exact versus starting prices',async()=>{
    const cases=[{id:'zero',currency:' try ',priceMinor:'0',feeMinor:'0',priceKind:'exact',total:'0',status:'exact'},
      {id:'no-currency',currency:null,priceMinor:'70000',feeMinor:'0',priceKind:'exact',total:null,status:'unknown'},
      {id:'no-price',currency:'TRY',priceMinor:null,feeMinor:'0',priceKind:'exact',total:null,status:'unknown'},
      {id:'starting',currency:'TRY',priceMinor:'70000',feeMinor:'0',priceKind:'starting_at',total:null,status:'starting_at'}];
    for(const item of cases) await accept({...payload(`offer-${item.id}`,`revision-${item.id}`,1),currency:item.currency,priceMinor:item.priceMinor,feeMinor:item.feeMinor,priceKind:item.priceKind},null);
    const result=await drain();assert.equal(result.completedJobs,4);assert.deepEqual(result.failures,[]);
    for(const item of cases) {
      const facts=JSON.parse(await query(`SELECT normalized_facts::text FROM biplan.offer_derivations WHERE offer_id=${literal(`offer-${item.id}`)};`));
      assert.equal(facts.exactCheckoutPriceMinor,item.total);assert.equal(facts.priceStatus,item.status);
    }
  });

  await verify('interruption schedules unfinished local work for a later invocation without immediate retry',async()=>{
    await accept(payload('offer-interrupted','revision-interrupted',1),null);
    const controller=new AbortController();
    const first=await runPreparationWorker({store,workerId:worker,maxJobs:1,maxEvents:0,signal:controller.signal,
      derive:(revision,job)=>{controller.abort();return deriveOfferFacts(revision,job);}});
    assert.equal(first.completedJobs,0);assert.equal(first.stopped,'interrupted');assert.equal(first.failures[0].persistence,'retry_scheduled');
    assert.equal(await count('preparation_jobs',"subject_id='offer-interrupted' AND state='pending' AND attempt_count=1"),1);
    const later=await drain();assert.equal(later.completedJobs,1);assert.deepEqual(later.failures,[]);
    assert.equal(await count('preparation_jobs',"subject_id='offer-interrupted' AND state='succeeded' AND fencing_token=2"),1);
  });

  await verify('derivation failure rolls back result and completion; fenced failure preserves checkpoint',async()=>{
    await accept(payload('offer-failure','revision-failure',1),null);
    const [job]=await store.claimJobs(worker,1,60),result=deriveOfferFacts(await store.revisionForJob(job),job);
    await store.checkpointJob(job,worker,{phase:'before-write'});
    await query(`CREATE FUNCTION biplan.fixture_fail_derivation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture derivation failure'; END $$;
      CREATE TRIGGER fixture_failure BEFORE INSERT ON biplan.offer_derivations FOR EACH ROW EXECUTE FUNCTION biplan.fixture_fail_derivation();`);
    await assert.rejects(()=>store.finishJob(job,worker,result),/fixture derivation failure/);
    assert.equal(await count('offer_derivations',"offer_id='offer-failure'"),0);
    assert.equal(await count('preparation_jobs',`id=${literal(job.id)} AND state='leased'`),1);
    await query('DROP TRIGGER fixture_failure ON biplan.offer_derivations; DROP FUNCTION biplan.fixture_fail_derivation();');
    await store.failJob(job,worker,failError);
    assert.equal(await count('preparation_jobs',`id=${literal(job.id)} AND state='failed' AND checkpoint->>'phase'='before-write'`),1);
    await drain();
  });

  await verify('expired derivation lease reclaims with a new fence and rejects stale checkpoint/failure/result',async()=>{
    await accept(payload('offer-reclaim','revision-reclaim',1),null);
    const [old]=await store.claimJobs('old-worker',1,60);await store.checkpointJob(old,'old-worker',{phase:'checkpoint-retained'});
    await query(`UPDATE biplan.preparation_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${literal(old.id)};`);
    const [current]=await store.claimJobs('new-worker',1,60);
    assert.equal(current.fencing_token,'2');assert.equal(current.checkpoint.phase,'checkpoint-retained');
    const result=deriveOfferFacts(await store.revisionForJob(current),current);
    await assert.rejects(()=>store.checkpointJob(old,'old-worker',{}),/stale/i);
    await assert.rejects(()=>store.failJob(old,'old-worker',failError),/stale/i);
    await assert.rejects(()=>store.finishJob(old,'old-worker',result),/stale/i);
    await store.finishJob(current,'new-worker',result);
    assert.equal(await count('job_attempts',`job_id=${literal(old.id)} AND fencing_token=1 AND outcome='stale' AND finished_at IS NOT NULL`),1);
    await drain();
  });

  await verify('explicit bounded retry preserves checkpoint, closes the failed attempt and increments fencing',async()=>{
    await accept(payload('offer-retry','revision-retry',1),null);
    const [first]=await store.claimJobs('retry-worker',1,60);await store.checkpointJob(first,'retry-worker',{phase:'retry-progress'});
    await query(`SELECT biplan.fail_offer_preparation_job(${literal(first.id)},'retry-worker',${first.fencing_token},'{"code":"controlled_retry","retryable":true}',interval '0 seconds');`);
    const [next]=await store.claimJobs('retry-worker',1,60);assert.equal(next.fencing_token,'2');assert.equal(next.checkpoint.phase,'retry-progress');
    await store.finishJob(next,'retry-worker',deriveOfferFacts(await store.revisionForJob(next),next));
    assert.equal(await count('job_attempts',`job_id=${literal(first.id)} AND outcome='failed' AND cost_units=0`),1);
    await drain();
  });

  await verify('outbox delivery failure rolls back refresh insertion and delivery; stale delivery/failure are fenced',async()=>{
    await accept(payload('offer-outbox','revision-outbox',1),null);
    const [old]=await store.claimEvents('event-old',1,60);
    await query(`UPDATE biplan.outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${literal(old.id)};`);
    const [event]=await store.claimEvents('event-new',1,60);assert.equal(event.fencing_token,'2');
    await assert.rejects(()=>store.deliverEvent(old,'event-old'),/stale/i);
    await assert.rejects(()=>store.failEvent(old,'event-old',failError),/stale/i);
    await query(`CREATE FUNCTION biplan.fixture_fail_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture delivery failure'; END $$;
      CREATE TRIGGER fixture_delivery_failure BEFORE UPDATE ON biplan.outbox_attempts FOR EACH ROW EXECUTE FUNCTION biplan.fixture_fail_delivery();`);
    await assert.rejects(()=>store.deliverEvent(event,'event-new'),/fixture delivery failure/);
    assert.equal(await count('publication_refresh_requests',`outbox_event_id=${literal(event.id)}`),0);
    assert.equal(await count('outbox',`id=${literal(event.id)} AND state='leased'`),1);
    await query('DROP TRIGGER fixture_delivery_failure ON biplan.outbox_attempts; DROP FUNCTION biplan.fixture_fail_delivery();');
    await store.deliverEvent(event,'event-new');await drain();
  });

  await verify('expired final-attempt jobs/events become terminal without stranded leases',async()=>{
    await accept(payload('offer-exhausted','revision-exhausted',1),null);
    await query("UPDATE biplan.preparation_jobs SET max_attempts=1 WHERE subject_id='offer-exhausted'; UPDATE biplan.outbox SET max_attempts=1 WHERE aggregate_id='offer-exhausted';");
    const [job]=await store.claimJobs('last-worker',1,60),[event]=await store.claimEvents('last-worker',1,60);
    await query(`UPDATE biplan.preparation_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${literal(job.id)};
      UPDATE biplan.outbox SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${literal(event.id)};`);
    assert.deepEqual(await store.claimJobs(worker,1,60),[]);assert.deepEqual(await store.claimEvents(worker,1,60),[]);
    assert.equal(await count('preparation_jobs',`id=${literal(job.id)} AND state='failed' AND lease_owner IS NULL`),1);
    assert.equal(await count('outbox',`id=${literal(event.id)} AND state='failed' AND lease_owner IS NULL`),1);
    assert.equal(await count('job_attempts',`job_id=${literal(job.id)} AND outcome='stale' AND finished_at IS NOT NULL`),1);
    assert.equal(await count('outbox_attempts',`event_id=${literal(event.id)} AND outcome='stale' AND finished_at IS NOT NULL`),1);
  });

  await verify('actual worker item cap leaves remaining supported work available to a later invocation',async()=>{
    await accept(payload('offer-bound-1','revision-bound-1',1),null);await accept(payload('offer-bound-2','revision-bound-2',1),null);
    const result=await runPreparationWorker({store,workerId:worker,maxJobs:1,maxEvents:1});
    assert.equal(result.completedJobs,1);assert.equal(result.deliveredEvents,1);assert.equal(result.stopped,'item_limit');
    assert.equal(await count('preparation_jobs',"stage='offer_revision_accepted' AND stage_version='1' AND state='pending'"),1);
    assert.equal(await count('outbox',"topic='offer.revision.accepted' AND state='pending'"),1);
    const remaining=await drain();assert.equal(remaining.completedJobs,1);assert.equal(remaining.deliveredEvents,1);
  });

  await verify('bounded frozen-backfill enqueue is replay-safe and never creates a revision notification',async()=>{
    await accept(payload('offer-enqueue','revision-enqueue',1),null);
    await query("DELETE FROM biplan.preparation_jobs WHERE subject_id='offer-enqueue';");
    const before=await count('outbox');
    assert.equal(await query('SELECT biplan.enqueue_missing_offer_preparation_jobs(1);'),'1');
    assert.equal(await query('SELECT biplan.enqueue_missing_offer_preparation_jobs(1);'),'0');
    assert.equal(await count('outbox'),before);
    assert.equal(await query("SELECT current_revision_id FROM biplan.offer_identities WHERE id='offer-enqueue';"),'revision-enqueue');
    await assert.rejects(()=>query('SELECT biplan.enqueue_missing_offer_preparation_jobs(101);'),/invalid|bounded/i);
    const completed=await drain();assert.equal(completed.completedJobs,1);assert.deepEqual(completed.failures,[]);
  });

  await verify('offer-only mutation APIs reject unsupported versions even if another generic worker leased them',async()=>{
    await query(`BEGIN;
      UPDATE biplan.preparation_jobs SET state='leased',lease_owner='unsupported-worker',lease_expires_at=clock_timestamp()+interval '1 minute',fencing_token=1,attempt_count=1 WHERE id='future-version-job';
      INSERT INTO biplan.job_attempts(job_id,fencing_token,attempt_number,worker_id) VALUES('future-version-job',1,1,'unsupported-worker');
      DO $$ BEGIN
        BEGIN PERFORM biplan.checkpoint_offer_preparation_job('future-version-job','unsupported-worker',1,'{}'); RAISE EXCEPTION 'test expected unsupported checkpoint rejection';
        EXCEPTION WHEN OTHERS THEN IF SQLERRM !~ 'stale' THEN RAISE; END IF; END;
        BEGIN PERFORM biplan.finish_offer_preparation_job('future-version-job','unsupported-worker',1,'{}'); RAISE EXCEPTION 'test expected unsupported completion rejection';
        EXCEPTION WHEN OTHERS THEN IF SQLERRM !~ 'stale' THEN RAISE; END IF; END;
        BEGIN PERFORM biplan.fail_offer_preparation_job('future-version-job','unsupported-worker',1,'{"code":"fixture","retryable":false}'); RAISE EXCEPTION 'test expected unsupported failure rejection';
        EXCEPTION WHEN OTHERS THEN IF SQLERRM !~ 'stale' THEN RAISE; END IF; END;
      END $$;
      ROLLBACK;`);
  });
} catch(error) {problem=error;} finally {
  if (created) {
    await assertOwned();await sql(`DROP DATABASE ${database} WITH (FORCE);`);
  }
  const sourcesUnchanged=JSON.stringify(sourceHashes)===JSON.stringify(await hashes());
  if(!sourcesUnchanged && !problem) problem=new Error('Tested sources changed during verification');
  const receipt={at:new Date().toISOString(),runtime:process.version,
    baseRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
    dirtyWorkingTree:execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim().length>0,
    sourceHashes,sourcesUnchanged,checks,timings,dataset:'synthetic immutable offer revisions; one disposable local database',
    temporaryDatabaseRemoved:created,passed:!problem,error:problem?.message,aiCalls:0,cloudChanges:false,
    limitations:['local acceptance; no live source adapter, publication refresh consumer, cloud or production capacity evidence']};
  await writeFile(resolve(work,`worker-verification-${Date.now()}.json`),JSON.stringify(receipt,null,2));
  await writeFile(resolve(work,'worker-verification.json'),JSON.stringify(receipt,null,2));
}
if (problem) throw problem;
console.log(JSON.stringify({passed:checks.length,receipt:'web/work/catalog-foundation/worker-verification.json'}));
