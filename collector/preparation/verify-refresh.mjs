import assert from 'node:assert/strict';
import { randomBytes,createHash } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertOwned,docker,sql,literal,container,work } from './db.mjs';
import { createWorkerStore } from './worker-store.mjs';
import { createRefreshStore,runPublicationRefresh } from './refresh-consumer.mjs';

const database=`biplan_refresh_verify_${randomBytes(6).toString('hex')}`;
assert.match(database,/^biplan_refresh_verify_[0-9a-f]{12}$/);
const paths=['schema.sql','migrations/002-offer-revisions.sql','migrations/003-workers.sql','migrations/004-publication-refresh.sql','refresh-consumer.mjs','verify-refresh.mjs'];
const hashes=async()=>{
  const result={};for(const path of paths) result[`collector/preparation/${path}`]=createHash('sha256').update(await readFile(resolve(import.meta.dirname,path))).digest('hex');return result;
};
const sourceHashes=await hashes(),checks=[],timings=[],runs=[],worker='refresh-verifier';
let created=false,problem;
const query=async statement=>{await assertOwned();return docker(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],`SET statement_timeout='20s';\n${statement}`);};
const store=createRefreshStore(query),offers=createWorkerStore(query);
const json=value=>`${literal(JSON.stringify(value))}::jsonb`;
const at=offset=>new Date(Date.now()-3600000+offset*1000).toISOString();
const start=new Date(Date.now()+172800000).toISOString();
const raw=id=>({providerObject:id,priceText:'provider evidence',untouched:{raw:true}});
const baseline=(id,session,price)=>({id,title:`Fixture ${session}`,description:'Fixture description',startsAt:start,venue:'Fixture venue',city:'İstanbul',district:'Beyoğlu',address:'Fixture address',
  price,currency:'TRY',url:`https://example.invalid/${id}`,imageUrl:'',category:'Stand-up',availability:'available',checkedAt:at(0),offers:[],
  preparedSearch:{version:1,documentText:'Fixture description',documentHash:'fixture-document-hash',lexicalTokens:['fixture']}});
const payload=(id,revision,offset,price,availability='available',session='session-one')=>({revisionId:revision,offerId:id,sessionId:session,provider:'fixture-provider',providerRecordId:id,
  sourceUrl:`https://example.invalid/${id}`,observedAt:at(offset),sourceUpdatedAt:at(offset),currency:'TRY',price,priceMinor:price===null?null:String(Math.round(price*100)),feeMinor:null,
  priceKind:price===null?'unknown':'starting_at',availability,contentHash:createHash('sha256').update(JSON.stringify(raw(id))).digest('hex'),sourcePayload:raw(id)});
const accept=async(p,previous)=>JSON.parse(await query(`SELECT biplan.accept_offer_revision(${json(p)},${previous===null?'NULL':literal(previous)})::text;`));
const count=async(table,where='true')=>Number(await query(`SELECT count(*) FROM biplan.${table} WHERE ${where};`));
const active=()=>store.active();
const snapshot=async(publication,session='session-one')=>JSON.parse(await query(`SELECT eligibility_snapshot::text FROM biplan.published_sessions WHERE publication_id=${literal(publication)} AND session_id=${literal(session)};`));
async function deliverAll() {for(let i=0;i<30;i++){const [event]=await offers.claimEvents('outbox-verifier',1,60);if(!event) return;await offers.deliverEvent(event,'outbox-verifier');}throw new Error('Fixture outbox exceeded bounded drain');}
const run=async()=>{const result=await runPublicationRefresh({store,workerId:worker,maxRequests:20,timeBudgetMs:60000});runs.push(result);
  if(result.failures.length) throw new Error(`Refresh invocation failed: ${JSON.stringify(result.failures)}`);return result;};
async function verify(name,fn){const started=performance.now();await fn();checks.push(name);timings.push({name,ms:Math.round(performance.now()-started)});console.log(`PASS ${name}`);}

try {
  await assertOwned();await sql(`CREATE DATABASE ${database};`);created=true;
  for(const path of paths.slice(0,3)) await query(await readFile(resolve(import.meta.dirname,path),'utf8'));
  const one=baseline('session-one','session-one',100),two=baseline('session-two','session-two',200);
  one.offers=[raw('cheap'),raw('expensive')];two.offers=[raw('unaffected')];
  await query(`INSERT INTO biplan.productions(id,title,content_hash) VALUES('production-one','Fixture one','one'),('production-two','Fixture two','two');
    INSERT INTO biplan.venues(id,name,content_hash) VALUES('venue','Fixture venue','venue');
    INSERT INTO biplan.sessions(id,production_id,venue_id,starts_at,status,content_hash) VALUES('session-one','production-one','venue',${literal(start)},'scheduled','one'),('session-two','production-two','venue',${literal(start)},'scheduled','two');
    INSERT INTO biplan.provider_offers(id,session_id,provider,provider_record_id,source_url,currency,price,price_minor,price_kind,availability,observed_at,content_hash,source_payload)
      VALUES('cheap','session-one','fixture-provider','cheap','https://example.invalid/cheap','TRY',100,10000,'starting_at','available',${literal(at(0))},'raw-cheap',${json(raw('cheap'))}),
      ('expensive','session-one','fixture-provider','expensive','https://example.invalid/expensive','TRY',300,30000,'starting_at','available',${literal(at(0))},'raw-expensive',${json(raw('expensive'))}),
      ('unaffected','session-two','fixture-provider','unaffected','https://example.invalid/unaffected','TRY',200,20000,'starting_at','available',${literal(at(0))},'raw-unaffected',${json(raw('unaffected'))});
    INSERT INTO biplan.search_documents(id,subject_type,subject_id,document_profile,document_text,document_hash,dependency_hash)
      VALUES('document-one','session','session-one','event-title-category-venue-description-v1','Fixture description','one','one'),('document-two','session','session-two','event-title-category-venue-description-v1','Fixture description','two','two');
    INSERT INTO biplan.evaluations(id,subject_type,subject_id,evaluation_type,status,components,rubric_version,input_hash)
      VALUES('pending-evaluation','production','production-one','comparative_value','pending','{"score":null}','fixture','pending'),('completed-value','production','production-one','comparative_value','complete','{"score":0.8}','fixture','completed');`);
  await query(await readFile(resolve(import.meta.dirname,paths[1]),'utf8'));
  await query(await readFile(resolve(import.meta.dirname,paths[3]),'utf8'));
  await query(await readFile(resolve(import.meta.dirname,paths[3]),'utf8'));
  await query(`BEGIN;
    INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count)
      VALUES('publication-base','{"version":3,"requiredOfferCount":3,"requiredEvaluationCount":2}','fixture-base',2,2);
    INSERT INTO biplan.published_sessions(publication_id,session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot)
      VALUES('publication-base','session-one','production-one','venue','document-one','one',${json(one)}),('publication-base','session-two','production-two','venue','document-two','two',${json(two)});
    INSERT INTO biplan.publication_offers VALUES('publication-base','session-one','cheap'),('publication-base','session-one','expensive'),('publication-base','session-two','unaffected');
    INSERT INTO biplan.publication_evaluations VALUES('publication-base','pending-evaluation'),('publication-base','completed-value');
    UPDATE biplan.publications SET state='validated',validated_at=clock_timestamp(),validation_hash='base' WHERE id='publication-base';
    SELECT biplan.activate_publication('publication-base',NULL);COMMIT;`);

  await verify('sold-out cheap offer publishes available expensive price, preserves raw evidence/documents and invalidates completed value score',async()=>{
    await accept(payload('cheap','cheap-sold-out',1,100,'sold_out'),'cheap');await deliverAll();
    const result=await run();assert.equal(result.completed,1);assert.equal(result.published,1);assert.deepEqual(result.failures,[]);
    const current=await active(),event=await snapshot(current),old=await snapshot('publication-base');
    assert.equal(event.offerTermsVersion,1);assert.equal(event.offerSummary.displayPriceMinor,'30000');assert.equal(event.price,300);
    assert.equal(event.offerSummary.verifiedTotalEligible,false);assert.equal(event.offerTerms.find(term=>term.offerId==='cheap').availability,'sold_out');
    assert.deepEqual(event.offers,[raw('cheap'),raw('expensive')]);assert.deepEqual(old,one);
    assert.deepEqual(await snapshot(current,'session-two'),two);
    assert.equal(await count('publication_evaluations',`publication_id=${literal(current)} AND evaluation_id='pending-evaluation'`),1);
    assert.equal(await count('publication_evaluations',`publication_id=${literal(current)} AND evaluation_id='completed-value'`),0);
    assert.equal(await count('evaluations',"id='completed-value' AND status='complete'"),1);
    assert.equal(await query(`SELECT search_document_id FROM biplan.published_sessions WHERE publication_id=${literal(current)} AND session_id='session-one';`),'document-one');
    const status=await store.revalidate(current,'session-one',new Date().toISOString());assert.equal(status.usable,true);assert.equal(status.verifiedTotalEligible,false);
    assert.equal((await store.revalidate('publication-base','session-one',new Date().toISOString())).usable,false);
  });

  await verify('late requests coalesce current B-A heads, replay cannot rewind a newer publication and added identities are included',async()=>{
    await accept(payload('cheap','cheap-B',2,125,'available'),'cheap-sold-out');
    await accept(payload('cheap','cheap-A-return',3,100,'available'),'cheap-B');
    await accept(payload('new-offer','new-offer-first',4,50,'available'),null);await deliverAll();
    const [request]=await store.claim(worker,1,60),base=await active();
    const receipt=await store.refresh(request,worker,base),published=receipt.resultPublicationId;
    const event=await snapshot(published);assert.equal(event.price,50);assert.equal(event.offerTerms.length,3);
    assert.equal(event.offerTerms.find(term=>term.offerId==='cheap').revisionId,'cheap-A-return');
    await accept(payload('cheap','cheap-latest',5,75,'available'),'cheap-A-return');await deliverAll();await run();
    const latest=await active();assert.notEqual(latest,published);
    const replay=await store.refresh(request,worker,base);assert.equal(replay.idempotent,true);assert.equal(replay.resultPublicationId,published);assert.deepEqual(replay.capturedOfferHeads,receipt.capturedOfferHeads);
    assert.equal(await active(),latest);await assert.rejects(()=>store.refresh(request,'wrong-worker',base),/stale|invalid/i);
  });

  await verify('old pinned publications reject changed heads/canonical timing; untouched queued sessions stay frozen and are marked stale',async()=>{
    const base=await active();await accept(payload('unaffected','unaffected-new',10,250,'available','session-two'),'unaffected');
    assert.equal((await store.revalidate(base,'session-two',new Date().toISOString())).usable,false);
    await accept(payload('cheap','cheap-refresh-other',6,90,'available'),'cheap-latest');
    const events=await offers.claimEvents('bounded-two-events',2,60);
    const firstEvent=events.find(event=>event.aggregate_id==='cheap'),laterEvent=events.find(event=>event.aggregate_id==='unaffected');
    assert.ok(firstEvent);assert.ok(laterEvent);await offers.deliverEvent(firstEvent,'bounded-two-events');
    const [first]=await store.claim(worker,1,60);await store.refresh(first,worker,await active());
    const partial=await active();assert.deepEqual(await snapshot(partial,'session-two'),two);
    assert.equal((await store.revalidate(partial,'session-two',new Date().toISOString())).usable,false);
    await offers.deliverEvent(laterEvent,'bounded-two-events');await run();
    const current=await active();await query("UPDATE biplan.sessions SET starts_at=starts_at+interval '1 hour' WHERE id='session-one';");
    assert.equal((await store.revalidate(current,'session-one',new Date().toISOString())).usable,false);
    await query(`UPDATE biplan.sessions SET starts_at=${literal(start)} WHERE id='session-one';`);
    await query("UPDATE biplan.sessions SET status='postponed' WHERE id='session-one';");
    assert.equal((await store.revalidate(current,'session-one',new Date().toISOString())).usable,false);
    await query("UPDATE biplan.sessions SET status='scheduled' WHERE id='session-one';");
  });

  await verify('unknown currency/price/fees and expired/future evidence never inherit the older display price or verified total',async()=>{
    const updates=[{id:'cheap',prev:'cheap-refresh-other',rev:'cheap-unknown',price:null,currency:null},
      {id:'expensive',prev:'expensive',rev:'expensive-expired',price:300,validUntil:new Date(Date.now()-1000).toISOString()},
      {id:'new-offer',prev:'new-offer-first',rev:'new-offer-future',price:50,observedAt:new Date(Date.now()+3600000).toISOString()}];
    for(const item of updates) await accept({...payload(item.id,item.rev,20,item.price),...Object.fromEntries(Object.entries(item).filter(([key])=>['currency','validUntil','observedAt'].includes(key)))},item.prev);
    await deliverAll();const result=await run();assert.deepEqual(result.failures,[]);
    const event=await snapshot(await active());assert.equal(event.price,null);assert.equal(event.offerSummary.verifiedTotalEligible,false);
    const status=await store.revalidate(await active(),'session-one',new Date().toISOString());assert.equal(status.verifiedTotalEligible,false);
    assert.equal((await store.revalidate(await active(),'session-two',new Date(Date.now()+604800000).toISOString())).usable,false);
  });

  await verify('stale worker and changed-base guards reject commits without changing publication; checkpoint survives explicit retry',async()=>{
    await accept(payload('cheap','cheap-lease',30,150,'available'),'cheap-unknown');await deliverAll();
    const [old]=await store.claim('old-refresh',1,60);await store.checkpoint(old,'old-refresh',{phase:'saved'});
    await query(`UPDATE biplan.publication_refresh_requests SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${literal(old.id)};`);
    const [current]=await store.claim('new-refresh',1,60);assert.equal(current.fencing_token,'2');assert.equal(current.checkpoint.phase,'saved');
    const base=await active();await assert.rejects(()=>store.refresh(old,'old-refresh',base),/stale|invalid/i);
    await assert.rejects(()=>store.checkpoint(old,'old-refresh',{}),/stale/i);await assert.rejects(()=>store.fail(old,'old-refresh',{code:'fixture',retryable:false}),/stale/i);
    await assert.rejects(()=>store.refresh(current,'new-refresh','wrong-base'),/guard|changed|base/i);assert.equal(await active(),base);
    await store.refresh(current,'new-refresh',base);
    assert.equal(await count('publication_refresh_attempts',`request_id=${literal(old.id)} AND fencing_token=1 AND outcome='stale' AND finished_at IS NOT NULL`),1);
  });

  await verify('injected completion failure rolls back publication activation, snapshots and request completion together',async()=>{
    await accept(payload('cheap','cheap-rollback',31,175,'available'),'cheap-lease');await deliverAll();
    const [request]=await store.claim(worker,1,60),base=await active(),before=await count('publications');
    await query(`CREATE FUNCTION biplan.fixture_fail_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.outcome='completed' THEN RAISE EXCEPTION 'fixture completion failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_failure BEFORE UPDATE ON biplan.publication_refresh_attempts FOR EACH ROW EXECUTE FUNCTION biplan.fixture_fail_completion();`);
    await assert.rejects(()=>store.refresh(request,worker,base),/fixture completion failure/);assert.equal(await active(),base);assert.equal(await count('publications'),before);
    assert.equal(await count('publication_refresh_requests',`id=${literal(request.id)} AND state='processing'`),1);
    await query('DROP TRIGGER fixture_failure ON biplan.publication_refresh_attempts; DROP FUNCTION biplan.fixture_fail_completion();');
    await store.refresh(request,worker,base);
  });

  await verify('identical raw objects remain distinct typed offers, exact zero survives and commercial/version tampering fails validation',async()=>{
    await accept({...payload('same-raw-one','same-raw-one-first',35,0),feeMinor:'0',priceKind:'exact',sourcePayload:{same:'raw'}},null);
    await accept({...payload('same-raw-two','same-raw-two-first',36,100),sourcePayload:{same:'raw'}},null);await deliverAll();await run();
    const current=await active(),event=await snapshot(current);
    assert.equal(event.price,0);assert.equal(event.offerSummary.verifiedTotalMinor,'0');assert.equal(event.offerSummary.verifiedTotalEligible,true);
    assert.equal(event.offers.filter(offer=>offer.same==='raw').length,2);
    await query(`SELECT biplan.validate_publication_offers(${literal(current)});`);
    const invalid=expression=>`BEGIN;
      INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count,required_embedding_profile)
        SELECT 'fixture-tampered',manifest,'fixture-tampered',required_session_count,required_document_count,required_embedding_profile FROM biplan.publications WHERE id=${literal(current)};
      INSERT INTO biplan.published_sessions SELECT 'fixture-tampered',session_id,production_id,venue_id,search_document_id,snapshot_hash,
        CASE WHEN session_id='session-one' THEN ${expression} ELSE eligibility_snapshot END FROM biplan.published_sessions WHERE publication_id=${literal(current)};
      INSERT INTO biplan.publication_offers SELECT 'fixture-tampered',session_id,offer_revision_id FROM biplan.publication_offers WHERE publication_id=${literal(current)};
      SELECT biplan.validate_publication_offers('fixture-tampered');ROLLBACK;`;
    await assert.rejects(()=>query(invalid(`jsonb_set(eligibility_snapshot,'{offerTerms,0,priceMinor}','"1"'::jsonb)`)),/term|pin|offer/i);
    await assert.rejects(()=>query(invalid(`jsonb_set(eligibility_snapshot,'{offerTermsVersion}','2'::jsonb)`)),/version|unsupported/i);
  });

  await verify('current-head table guard blocks insert phantoms, and a lease expiring during candidate build cannot activate',async()=>{
    await accept(payload('cheap','cheap-phantom',37,176,'available'),'cheap-rollback');await deliverAll();
    await query(`CREATE FUNCTION biplan.fixture_pause_build() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2); RETURN NEW; END $$;
      CREATE TRIGGER fixture_pause BEFORE INSERT ON biplan.publications FOR EACH ROW EXECUTE FUNCTION biplan.fixture_pause_build();`);
    const [request]=await store.claim(worker,1,60),base=await active();
    const guarded=createRefreshStore(statement=>query(`SET application_name='refresh-phantom-holder';\n${statement}`));
    const running=guarded.refresh(request,worker,base);
    try {
      let paused=false;
      for(let attempt=0;attempt<20;attempt++) {
        paused=await query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='refresh-phantom-holder' AND wait_event='PgSleep');")==='t';
        if(paused) break;await new Promise(done=>setTimeout(done,30));
      }
      assert.ok(paused,'candidate build did not reach guarded pause');
      await assert.rejects(()=>query(`SET lock_timeout='300ms'; SELECT biplan.accept_offer_revision(${json(payload('phantom-offer','phantom-first',38,20))},NULL);`),/lock timeout/i);
    }finally{await running;}
    assert.equal(await count('offer_identities',"id='phantom-offer'"),0);
    await accept(payload('cheap','cheap-expired-during-build',39,177,'available'),'cheap-phantom');await deliverAll();
    const [short]=await store.claim('short-lease',1,1),before=await active();
    await assert.rejects(()=>store.refresh(short,'short-lease',before),/lease|stale|expired/i);assert.equal(await active(),before);
    await query('DROP TRIGGER fixture_pause ON biplan.publications; DROP FUNCTION biplan.fixture_pause_build();');
    const [reclaimed]=await store.claim(worker,1,60);assert.equal(reclaimed.fencing_token,'2');await store.refresh(reclaimed,worker,await active());
  });

  await verify('rollback retains original source snapshots while mandatory revalidation rejects historical prices',async()=>{
    const current=await active();
    await query(`BEGIN; UPDATE biplan.publications SET state='validated' WHERE id='publication-base';
      SELECT biplan.activate_publication('publication-base',${literal(current)});COMMIT;`);
    assert.equal(await active(),'publication-base');assert.deepEqual(await snapshot('publication-base'),one);
    assert.equal((await store.revalidate('publication-base','session-one',new Date().toISOString())).usable,false);
    await query(`BEGIN; UPDATE biplan.publications SET state='validated' WHERE id=${literal(current)};
      SELECT biplan.activate_publication(${literal(current)},'publication-base');COMMIT;`);
    assert.equal(await active(),current);
  });

  await verify('missing newly discovered session is blocked explicitly and exhausted leases become terminal',async()=>{
    await query(`INSERT INTO biplan.sessions(id,production_id,starts_at,status,content_hash) VALUES('session-new','production-one',${literal(start)},'scheduled','new');`);
    await accept(payload('missing-offer','missing-first',40,100,'available','session-new'),null);await deliverAll();
    const result=await run();assert.equal(result.blocked,1);assert.equal(result.published,0);
    await accept(payload('cheap','cheap-exhausted',41,180,'available'),'cheap-expired-during-build');await deliverAll();
    await query("UPDATE biplan.publication_refresh_requests SET max_attempts=1 WHERE state='pending';");
    const [request]=await store.claim('last-refresh',1,60);
    await query(`UPDATE biplan.publication_refresh_requests SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${literal(request.id)};`);
    assert.deepEqual(await store.claim(worker,1,60),[]);
    assert.equal(await count('publication_refresh_requests',`id=${literal(request.id)} AND state='failed' AND lease_owner IS NULL`),1);
    assert.equal(await count('publication_refresh_attempts',`request_id=${literal(request.id)} AND outcome='stale' AND finished_at IS NOT NULL`),1);
  });
}catch(error){problem=error;}finally{
  if(created){await assertOwned();await sql(`DROP DATABASE ${database} WITH (FORCE);`);}
  const sourcesUnchanged=JSON.stringify(sourceHashes)===JSON.stringify(await hashes());if(!sourcesUnchanged && !problem) problem=new Error('Refresh sources changed during verification');
  const receipt={at:new Date().toISOString(),runtime:process.version,baseRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),
    dirtyWorkingTree:execFileSync('git',['status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim().length>0,sourceHashes,sourcesUnchanged,checks,timings,runs,
    passed:!problem,error:problem?.message,temporaryDatabaseRemoved:created,aiCalls:0,cloudChanges:false,
    dataset:'synthetic offer revisions, two initial sessions, one missing new session; disposable local PostgreSQL',
    limitations:['no live search integration, source adapters or cloud qualification']};
  await writeFile(resolve(work,`refresh-verification-${Date.now()}.json`),JSON.stringify(receipt,null,2));await writeFile(resolve(work,'refresh-verification.json'),JSON.stringify(receipt,null,2));
}
if(problem) throw problem;console.log(JSON.stringify({passed:checks.length,receipt:'web/work/catalog-foundation/refresh-verification.json'}));
