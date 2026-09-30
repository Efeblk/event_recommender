import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertOwned, container, docker, literal, work } from './db.mjs';
import { adaptCanonicalRecord, canonicalRequestId } from './canonical-adapter.mjs';
import { createCanonicalStore } from './canonical-store.mjs';
import { runCanonicalWorker } from './canonical-worker.mjs';
import { createBatchStore } from './batch-store.mjs';
import { runBatchPreparation, runBatchPublication } from './batch-worker.mjs';
import { createSqlPublicationRepository } from '../../web/lib/publication-repository.ts';
import { preparePublicationCandidates } from '../../web/lib/prepared-publication-search.ts';
import { postgresPublicationAvailabilitySql } from '../../web/lib/postgres-catalog.node.ts';
import { emptyFilters } from '../../web/lib/types.ts';

const suffix = randomBytes(6).toString('hex'), database = `biplan_serving_${suffix}`, admin = `biplan_serving_${suffix}_admin`;
const roles = Object.fromEntries(['owner','reader','prepare','web','preparer'].map(k => [k, `biplan_serving_${suffix}_${k}`]));
const migrations = ['schema.sql','migrations/002-offer-revisions.sql','migrations/003-workers.sql','migrations/004-publication-refresh.sql',
  'migrations/005-canonical-preparation.sql','migrations/006-batched-publication.sql','migrations/007-page-receipts.sql',
  'migrations/008-offer-evidence-projections.sql','migrations/009-offer-identity-provider-session.sql',
  'migrations/010-offer-identity-session-index.sql','migrations/011-publication-serving-artifacts.sql'];
const paths = [...migrations,'roles.sql','verify-serving-artifacts.mjs','../../web/lib/postgres-catalog.node.ts'];
const sha = value => createHash('sha256').update(value).digest('hex');
const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async p => [p,sha(await readFile(resolve(import.meta.dirname,p)))])));
const sourceHashes = await hashes(), startedAt = new Date().toISOString(), checks = [];
let created = false, adminCreated = false, databaseDropped = false, rolesDropped = false, problem;
const psql = async (user, db, statement) => {
  await assertOwned();
  return docker(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',user,'-d',db],
    `SET statement_timeout='30s'; SET timezone='UTC';\n${statement}`);
};
const control = statement => psql('postgres','postgres',statement);
const query = statement => psql(admin,database,statement);
const prep = statement => psql(roles.preparer,database,statement);
const web = statement => psql(roles.web,database,statement);
const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const invoke = (name,...args) => prep(`SELECT biplan.${name}(${args.join(',')})::text;`).then(x => x ? JSON.parse(x) : null);
const check = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
const denied = (run, statement) => assert.rejects(run(statement), /permission denied|read-only transaction|not permitted/);
const begin = id => invoke('begin_publication_serving_export',literal(id),literal('biplan-serving-local-fixture'));
const claim = (id, worker='exporter') => invoke('claim_publication_serving_export',literal(id),literal(worker),'300');
const jobArgs = (job, worker='exporter') => [literal(job.id),literal(worker),job.fencing_token];
const readReady = id => web(`SELECT biplan.read_publication_serving_artifact(${literal(id)})::text;`).then(x => x ? JSON.parse(x) : null);
const complete = (job, receipt, worker='exporter') => invoke('complete_publication_serving_export',...jobArgs(job,worker),json(receipt));
const repository = createSqlPublicationRepository(web,{compact:true});
const canonical = createCanonicalStore(prep), batch = createBatchStore(prep);
const now = Date.now(), stamp = new Date(now-60000).toISOString();
const event = i => ({ id:`serving-${i}`,source:'bubilet',sourceSessionIds:[`serving-${i}`],title:`Serving Play ${i}`,
  description:'Source verified performance.\nUTF8 İstanbul evidence.',category:'Tiyatro',venue:'Serving Venue',district:'Kadikoy',
  address:'Serving Street',city:'İstanbul',startsAt:new Date(now+86400000*(i+1)).toISOString(),checkedAt:stamp,
  attendanceTiming:null,price:100+i,currency:'TRY',availability:'available',imageUrl:'',url:`https://www.bubilet.com.tr/istanbul/etkinlik/serving-${i}` });
let legacyId, projectedId, legacyBinding, legacyJob, legacyObject, legacyRead;
async function exportRows(id, binding, job, worker='exporter') {
  const lines = []; let after = '';
  for (let pages=0;pages<20;pages++) {
    const page = await invoke('read_publication_serving_export_page',...jobArgs(job,worker),literal(after),'1');
    for (const row of page.rows) { assert.ok(row.sessionId>after); after=row.sessionId; lines.push(row.rawRowText); }
    assert.equal(page.nextAfter,after);
    if(page.done) break;
    assert.ok(pages<19,'bounded fixture page iteration');
  }
  const root = sha('biplan-serving-rows-v1\n'+lines.map(line=>`${sha(line)}\n`).join(''));
  assert.equal(root,binding.contentRoot);
  const raw = Buffer.from(binding.headerText+'\n'+lines.map(line=>line+'\n').join(''));
  assert.equal(raw.length,binding.uncompressedBytes);
  const sessions = lines.map(line=>JSON.parse(line));
  const reference = await repository.readPublication(id);
  assert.deepEqual(sessions,reference.sessions);
  assert.equal(sessions.length,binding.header.sessionCount);
  assert.equal(sessions.reduce((n,s)=>n+s.pinnedOfferTerms.length,0),binding.header.offerCount);
  assert.deepEqual(preparePublicationCandidates({...reference,sessions},emptyFilters,new Date(now)),
    preparePublicationCandidates(reference,emptyFilters,new Date(now)));
  const compressed = gzipSync(raw), compressedSha256=sha(compressed);
  return { rows:sessions, reference, raw, compressed, receipt:{ bucket:binding.bucket,
    objectName:`staging/preparation/serving/v1/${sha(id)}/${compressedSha256}.ndjson.gz`,generation:'1234567890123456789',encoding:'gzip',
    compressedSha256,uncompressedSha256:sha(raw),compressedBytes:compressed.length,uncompressedBytes:raw.length } };
}

try {
  assert.match(database,/^biplan_serving_[a-f0-9]{12}$/); await assertOwned();
  await control(`CREATE ROLE ${admin} LOGIN NOSUPERUSER CREATEDB CREATEROLE;`); adminCreated=true;
  await control(`CREATE DATABASE ${database} OWNER ${admin};`); created=true;
  await psql('postgres',database,'CREATE EXTENSION postgis; CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;');
  for(const path of migrations) await query(await readFile(resolve(import.meta.dirname,path),'utf8'));
  const roleSql=(await readFile(resolve(import.meta.dirname,'roles.sql'),'utf8')).replace(/\bbiplan_(owner|reader|prepare|web|preparer)\b/g,(_,k)=>roles[k]);
  await check('non-superuser migration and role replay need no pgcrypto or elevated app role',async()=>{
    await query(roleSql); await query(await readFile(resolve(import.meta.dirname,migrations.at(-1)),'utf8')); await query(roleSql);
    assert.equal(await query("SELECT count(*) FROM pg_extension WHERE extname='pgcrypto';"),'0');
    assert.equal(await query(`SELECT bool_or(rolsuper OR rolcreatedb OR rolcreaterole) FROM pg_roles WHERE rolname IN (${Object.values(roles).map(literal).join(',')});`),'f');
    assert.equal(await query(`SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner)))a
      WHERE p.pronamespace='biplan'::regnamespace AND p.proname LIKE '%serving%' AND a.grantee=0 AND a.privilege_type='EXECUTE';`),'0');
  });
  await check('reader and preparer cannot replace binding or call private export helpers',async()=>{
    for(const run of [prep,web]) {
      await denied(run,'DELETE FROM biplan.publication_serving_artifacts;');
      await denied(run,"SELECT biplan.publication_serving_binding('missing');");
      await denied(run,"SELECT * FROM biplan.publication_serving_rows('missing','',1);");
    }
    await denied(web,"SELECT biplan.begin_publication_serving_export('missing','fixture-bucket');");
    assert.equal(await readReady('missing'),null);
  });
  for(const i of [1,2]) {
    const record=event(i), adapted=adaptCanonicalRecord(record,await canonical.findHeads(record));
    assert.equal(adapted.status,'ready'); await canonical.accept(adapted.payload);
  }
  const prepared=await runCanonicalWorker({store:canonical,workerId:'fixture-canonical',maxJobs:4});
  assert.deepEqual(prepared.failures,[]);
  legacyId=await web('SELECT publication_id FROM biplan.active_publication WHERE singleton;');
  await check('actual SQL admission requires scheduled future sessions, fresh observations and current revision heads',async()=>{
    const admission=postgresPublicationAvailabilitySql(legacyId,new Date(now));
    const sessionSet=`SELECT session_id FROM biplan.published_sessions WHERE publication_id=${literal(legacyId)}`;
    assert.equal(await web(admission),'t','restricted reader admits the fresh fixture');
    const rejectedInRollback=async (change,sql=admission)=>{
      assert.equal(await query(`BEGIN; ${change} ${sql} ROLLBACK;`),'f');
      assert.equal(await web(admission),'t','rollback restores admission without changing canonical state');
    };
    await rejectedInRollback(`UPDATE biplan.sessions SET status='canceled' WHERE id IN(${sessionSet});`);
    await rejectedInRollback(`UPDATE biplan.sessions SET starts_at=${literal(new Date(now-86400000).toISOString())}::timestamptz WHERE id IN(${sessionSet});`);
    await rejectedInRollback(`UPDATE biplan.sessions SET starts_at=${literal(new Date(now+10*86400000).toISOString())}::timestamptz WHERE id IN(${sessionSet});`,
      postgresPublicationAvailabilitySql(legacyId,new Date(now+73*3600000)));
    await rejectedInRollback(`UPDATE biplan.offer_identities SET current_revision_id=NULL WHERE session_id IN(${sessionSet});`);
  });
  await check('legacy export pins authoritative row bytes and matches exact compact reader including source evidence',async()=>{
    legacyBinding=await begin(legacyId); assert.equal(legacyBinding.state,'pending'); assert.equal(await readReady(legacyId),null);
    assert.deepEqual(await begin(legacyId),legacyBinding); legacyJob=await claim(legacyId); assert.equal(typeof legacyJob.fencing_token,'string');
    assert.equal(await claim(legacyId,'competing'),null);
    const result=await exportRows(legacyId,legacyBinding,legacyJob); legacyObject=result.receipt; legacyRead=result.reference;
    assert.equal(legacyBinding.header.offerProjectionVersion,null);
    await mkdir(work,{recursive:true});
    await writeFile(resolve(work,'serving-artifact-local-fixture.ndjson.gz'),result.compressed);
    await writeFile(resolve(work,'serving-artifact-local-binding.json'),JSON.stringify({...legacyBinding,...legacyObject,state:'ready'},null,2));
  });
  await check('stale fences, wrong sizes, numeric generation and cross-prefix receipts cannot complete',async()=>{
    await assert.rejects(invoke('checkpoint_publication_serving_export',literal(legacyJob.id),literal('wrong'),legacyJob.fencing_token,json({})),/stale/);
    for(const bad of [{uncompressedBytes:legacyObject.uncompressedBytes+1},{compressedBytes:33554433},
      {generation:123},{objectName:'staging/preparation/sources/forged.gz'},{encoding:'identity'},{header:{fake:true}}])
      await assert.rejects(complete(legacyJob,{...legacyObject,...bad}),/invalid|differ|outside/);
    assert.equal(await readReady(legacyId),null);
  });
  await check('verified upload checkpoint survives explicit failed-attempt retry and prevents stale completion',async()=>{
    const checkpoint={stage:'uploaded-verified',uploadedObject:legacyObject};
    await invoke('checkpoint_publication_serving_export',...jobArgs(legacyJob),json(checkpoint));
    await invoke('fail_publication_serving_export',...jobArgs(legacyJob),json({code:'fixture_interruption'}));
    const retry=await claim(legacyId,'resumer'); assert.deepEqual(retry.checkpoint,checkpoint);
    assert.notEqual(retry.fencing_token,legacyJob.fencing_token);
    await assert.rejects(complete(legacyJob,legacyObject),/stale/);
    const ready=await complete(retry,legacyObject,'resumer'); assert.equal(ready.state,'ready');
    assert.deepEqual(await complete(retry,legacyObject,'resumer'),ready);
    assert.deepEqual(await readReady(legacyId),ready); assert.equal(await claim(legacyId),null);
    await assert.rejects(complete(retry,{...legacyObject,generation:'2'},'resumer'),/stale/);
    await assert.rejects(query(`UPDATE biplan.publication_serving_artifacts SET object_receipt=object_receipt WHERE publication_id=${literal(legacyId)};`),/immutable/);
    await assert.rejects(query(`DELETE FROM biplan.publication_serving_artifacts WHERE publication_id=${literal(legacyId)};`),/immutable/);
  });
  await query('INSERT INTO biplan.preparation_storage_limits VALUES(true,1073741824,67108864,20000,1048576);');
  const h={schemaVersion:2,batchId:'serving-projection',collectionRunId:'serving-projection',inputHash:sha('serving-projection'),scope:'incremental',providers:['bubilet'],
    startedAt:new Date(now-40000).toISOString(),horizonStart:new Date(now).toISOString(),horizonEnd:new Date(now+10*86400000).toISOString(),
    scopeEvidence:{geography:'Istanbul',listingConfigHash:sha('listings')}};
  const record={...event(1),checkedAt:new Date(now-20000).toISOString()};
  const page={pageId:'serving-projection-page',provider:'bubilet',url:record.url,observedAt:record.checkedAt,sourceUpdatedAt:null,
    evidenceHash:sha('serving-page'),evidenceKind:'normalized_page',parserVersion:'fixture-v1',status:'verified',origin:'current_run',originRunId:h.batchId,
    records:[{requestId:canonicalRequestId(record),sourceRecordId:record.id}],complete:true};
  await invoke('begin_preparation_batch_v2',json(h));
  await invoke('record_batch_page',literal(h.batchId),json(page));
  const adapted=adaptCanonicalRecord(record,await canonical.findHeads(record)); await batch.accept(h.batchId,adapted.payload);
  const urlHash=sha(`bubilet\t${record.url}\n`);
  const coverage={schemaVersion:2,complete:false,finishedAt:new Date().toISOString(),
    discovery:{unit:'detail_url',listingConfigHash:sha('listings'),inventoryHash:urlHash,urls:[{provider:'bubilet',url:record.url}],exhausted:false},
    inventory:[{provider:'bubilet',known:1,attemptedThisRun:1,verifiedThisRun:1,retiredThisRun:0,failedThisRun:0,quarantinedThisRun:0,unattemptedThisRun:0,neverVisited:0,stale:0,outstandingFailures:0}],
    records:{unit:'event_record',submitted:1,currentRun:1,recovered:0,carried:0,sourceQuarantined:0},
    freshness:{maxSourceAgeMs:86400000,oldestResolvedAt:null,validUntil:null}};
  assert.equal((await invoke('seal_preparation_batch_v2',literal(h.batchId),json({inputHash:h.inputHash,recordCount:1,pageCount:1,collectorCoverage:coverage}))).status,'sealed');
  const batchPrepared=await runBatchPreparation({store:batch,batchId:h.batchId,workerId:'serving-prepare',maxJobs:4}); assert.deepEqual(batchPrepared.failures,[]);
  const published=await runBatchPublication({store:batch,batchId:h.batchId,workerId:'serving-publish'}); assert.deepEqual(published.failures,[]);
  projectedId=published.receipt.resultPublicationId;
  await check('projection-v1 exports preserve supported and held legacy terms and superseded ready bindings',async()=>{
    const binding=await begin(projectedId), job=await claim(projectedId); assert.equal(binding.header.offerProjectionVersion,1);
    const result=await exportRows(projectedId,binding,job);
    const terms=result.rows.flatMap(row=>row.pinnedOfferTerms);
    assert.ok(terms.some(t=>t.evidenceStatus==='supported')); assert.ok(terms.some(t=>t.evidenceStatus==='unsupported'));
    await complete(job,result.receipt);
    assert.ok(await readReady(legacyId)); assert.ok(await readReady(projectedId));
    // Current canonical changes remain authoritative after immutable artifact creation.
    const sid=result.rows[0].sessionId;
    await query(`UPDATE biplan.sessions SET status='canceled' WHERE id=${literal(sid)};`);
    const status=await repository.revalidatePublication(projectedId,[sid],new Date().toISOString(),72*3600000);
    assert.equal(status[0].canonicalSessionUsable,false);
    assert.ok(await readReady(projectedId));
  });
  await check('expired claims are fenced and manual attempts stop at three',async()=>{
    // Independent empty sealed publication keeps the durability test small.
    await query("INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count) VALUES('serving-empty','{}','serving-empty',0,0); UPDATE biplan.publications SET state='validated',validation_hash='serving-empty' WHERE id='serving-empty';");
    const empty=await begin('serving-empty');
    assert.equal(empty.contentRoot,sha('biplan-serving-rows-v1\n'));
    assert.equal(empty.uncompressedBytes,Buffer.byteLength(empty.headerText+'\n'));
    let previous;
    for(let i=1;i<=3;i++) {
      const job=await claim('serving-empty'); assert.equal(job.fencing_token,String(i));
      if(previous) await assert.rejects(invoke('read_publication_serving_export_page',...jobArgs(previous),literal(''),'1'),/stale/);
      await query(`UPDATE biplan.preparation_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${literal(job.id)};`);
      previous=job;
    }
    assert.equal(await claim('serving-empty'),null); assert.equal(await readReady('serving-empty'),null);
    assert.equal(await query("SELECT count(*) FROM biplan.job_attempts WHERE job_id LIKE 'serving-export:%' AND outcome='stale';"),'3');
  });
  await check('unknown versions, declared over-cap catalogs and oversized immutable lines fail before binding',async()=>{
    await query("INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count) VALUES('serving-over-count','{}','serving-over-count',20001,0); UPDATE biplan.publications SET state='validated',validation_hash='serving-over-count' WHERE id='serving-over-count';");
    await assert.rejects(begin('serving-over-count'),/not exportable/);
    await query("INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count) VALUES('serving-unknown-version','{\"offerProjectionVersion\":99}','serving-unknown-version',0,0); UPDATE biplan.publications SET state='validated',validation_hash='serving-unknown-version' WHERE id='serving-unknown-version';");
    await assert.rejects(begin('serving-unknown-version'),/not exportable/);
    const sizedPublication = async (id, rowBytes) => {
      await query(`INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count)
        VALUES(${literal(id)},'{}',${literal(id)},${legacyRead.sessions.length},${legacyRead.sessions.length});
        INSERT INTO biplan.published_sessions SELECT ${literal(id)},s.session_id,s.production_id,s.venue_id,s.search_document_id,s.snapshot_hash,
          s.eligibility_snapshot||jsonb_build_object('unusedPadding',repeat('x',${rowBytes}-octet_length((x.raw_row_text::jsonb||
            jsonb_build_object('snapshot',(x.raw_row_text::jsonb->'snapshot')||'{"unusedPadding":""}'::jsonb))::text)))
          FROM biplan.published_sessions s JOIN biplan.publication_serving_rows(${literal(legacyId)},'',20001)x ON x.session_id=s.session_id
          WHERE s.publication_id=${literal(legacyId)};
        INSERT INTO biplan.publication_offers SELECT ${literal(id)},session_id,offer_revision_id FROM biplan.publication_offers WHERE publication_id=${literal(legacyId)};
        UPDATE biplan.publications SET state='validated',validation_hash=${literal(id)} WHERE id=${literal(id)};`);
      assert.equal(await query(`SELECT bool_and(octet_length(raw_row_text)=${rowBytes}) FROM biplan.publication_serving_rows(${literal(id)},'',20001);`),'t');
    };
    await sizedPublication('serving-at-line-limit',1048575);
    assert.equal((await begin('serving-at-line-limit')).state,'pending','1 MiB including LF is accepted');
    await sizedPublication('serving-over-line',1048576);
    await assert.rejects(begin('serving-over-line'),/line size/);
    assert.equal(await query("SELECT count(*) FROM biplan.publication_serving_artifacts WHERE publication_id IN('serving-over-count','serving-over-line','serving-unknown-version');"),'0');
  });
  await check('invalid publication state removes artifact authority without mutating preserved binding',async()=>{
    await query(`UPDATE biplan.publications SET state='invalid' WHERE id=${literal(projectedId)};`);
    assert.equal(await readReady(projectedId),null); await assert.rejects(begin(projectedId),/not exportable/);
  });
  assert.deepEqual(await hashes(),sourceHashes,'SQL/verifier sources changed during verification');
} catch(error) { problem={message:error.message,stack:error.stack}; }
finally {
  if(created) { try { await control(`DROP DATABASE ${database} WITH (FORCE);`); databaseDropped=true; } catch(error) { problem??={message:error.message}; } }
  if(databaseDropped || !created) {
    try { for(const role of Object.values(roles)) await control(`DROP ROLE IF EXISTS ${role};`);
      if(adminCreated) await control(`DROP ROLE ${admin};`); rolesDropped=true;
    } catch(error) { problem??={message:error.message}; }
  }
  await mkdir(work,{recursive:true});
  const receipt={startedAt,finishedAt:new Date().toISOString(),passed:!problem,sourceHashes,checks,databaseDropped,rolesDropped,problem,
    aiCalls:0,externalCalls:0,limitations:['Local PostgreSQL only; local superuser installed extensions, installer/application roles are not superusers. No GCS or managed deployment verified.']};
  await writeFile(resolve(work,`serving-artifact-verification-${Date.now()}.json`),JSON.stringify(receipt,null,2));
  await writeFile(resolve(work,'serving-artifact-verification-latest.json'),JSON.stringify(receipt,null,2));
}
if(problem) throw new Error(problem.message);
console.log(JSON.stringify({passed:checks.length,databaseDropped,rolesDropped,aiCalls:0,externalCalls:0}));
