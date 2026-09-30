// Local full-catalog acceptance verifier. Requires the preserved frozen archive,
// its SHA-256 receipt, and the exact synthetic managed-source fixture in web/work.
// All database writes are limited to a uniquely named disposable local restore.
import assert from 'node:assert/strict';
import {createHash,randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {readFile,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {assertOwned,container,docker} from './db.mjs';
import {createCanonicalStore} from './canonical-store.mjs';
import {createPageBatchSourceStore} from './page-batch-source-store.mjs';
import {ingestPageBatchSource} from './page-batch-source.mjs';
const dir=resolve(import.meta.dirname,'../../web/work/catalog-foundation/gcp-preflight-20260930'),db=`biplan_bulk_${randomBytes(6).toString('hex')}`,archive=resolve(dir,'biplan-catalog-frozen-20260930T064139Z.dump');
const r={startedAt:new Date().toISOString(),database:db,cloudCalls:0,providerCalls:0,aiCalls:0,statementTimeoutMs:30000,plans:{},cases:[]};
const q=(s)=>docker(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d',db],`\\set VERBOSITY terse\nSET statement_timeout='30s';SET timezone='UTC';\n${s}`);
const control=s=>docker(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],s);
let created=false,roleCreated=false;
const installer=db+'_installer';
const migration=await readFile(resolve(import.meta.dirname,'migrations/012-bulk-seal-integrity.sql'),'utf8');
const proto=migration.split('$bulk_query$')[1];assert.ok(proto);
r.migrationSha256=createHash('sha256').update(migration).digest('hex');
r.sourceHashes={};for(const path of ['verify-bulk-seal-integrity.mjs','migrations/005-canonical-preparation.sql','migrations/008-offer-evidence-projections.sql','migrations/009-offer-identity-provider-session.sql','migrations/010-offer-identity-session-index.sql','migrations/012-bulk-seal-integrity.sql'])r.sourceHashes[path]=createHash('sha256').update(await readFile(resolve(import.meta.dirname,path))).digest('hex');
const old=`SELECT s.id session_id,biplan.session_projection_integrity(s.id,COALESCE(r.facts,ps.eligibility_snapshot)) usable FROM biplan.sessions s LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id LEFT JOIN biplan.canonical_revisions r ON r.id=h.revision_id LEFT JOIN biplan.active_publication a ON a.singleton LEFT JOIN biplan.published_sessions ps ON ps.publication_id=a.publication_id AND ps.session_id=s.id WHERE s.status='scheduled' AND EXISTS(SELECT 1 FROM biplan.offer_identities i WHERE i.session_id=s.id)`;
const results=s=>`SELECT jsonb_object_agg(session_id,usable ORDER BY session_id)::text FROM (${s}) x;`;
const plan=s=>`EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) SELECT count(*) FILTER(WHERE usable),count(*) FILTER(WHERE NOT usable) FROM (${s}) x;`;
try{
 await assertOwned();assert.match(db,/^biplan_bulk_[a-f0-9]{12}$/);
 r.archiveSha256=createHash('sha256').update(await readFile(archive)).digest('hex');r.prototypeSha256=createHash('sha256').update(proto).digest('hex');
 const frozen=JSON.parse(await readFile(resolve(dir,'biplan-catalog-frozen-20260930T064139Z.receipt.json'),'utf8'));assert.equal(r.archiveSha256,frozen.archive.sha256);
 await control(`CREATE DATABASE ${db} TEMPLATE template0;`);created=true;await q('CREATE EXTENSION postgis;CREATE EXTENSION vector;CREATE EXTENSION pg_trgm;');
 await new Promise((ok,bad)=>{const c=spawn('docker',['exec','-i',container,'pg_restore','-U','postgres','-d',db,'--no-owner','--no-privileges','--single-transaction','--exit-on-error'],{windowsHide:true,stdio:['pipe','ignore','pipe']});let err='';c.stderr.on('data',x=>err+=x);c.on('error',bad);c.on('close',code=>code===0?ok():bad(new Error(err.slice(-2000))));c.stdin.on('error',e=>{if(e.code!=='EPIPE')bad(e)});createReadStream(archive).pipe(c.stdin);});
 for(const f of ['009-offer-identity-provider-session.sql','010-offer-identity-session-index.sql'])await q(await readFile(resolve(dir,'../../../../collector/preparation/migrations',f),'utf8'));
 await q(`DO $$ DECLARE x record; BEGIN FOR x IN SELECT tablename FROM pg_tables WHERE schemaname='biplan' LOOP EXECUTE format('ANALYZE biplan.%I',x.tablename); END LOOP; END $$;`);
 r.plans.baseline=JSON.parse(await q(plan(old)));r.plans.prototype=JSON.parse(await q(plan(proto)));
 const before=JSON.parse(await q(results(old))),after=JSON.parse(await q(results(proto)));assert.deepEqual(after,before);
 r.baselineParity={sessions:Object.keys(before).length,rejected:Object.values(before).filter(x=>!x).length,exact:true};
 // A transaction-only fixture override exercises canonical/null/attendance mismatch without persisting canonical changes.
 for(const [name,expression] of [['null-facts','NULL::jsonb'],['changed-title',`jsonb_set(COALESCE(r.facts,ps.eligibility_snapshot),'{title}','"CHANGED CANONICAL TITLE"')`],['json-null-attendance',`jsonb_set(COALESCE(r.facts,ps.eligibility_snapshot),'{attendanceTiming}','null')`]]){
  const subset=`s.id IN (SELECT id FROM biplan.sessions ORDER BY id LIMIT 12) AND s.status='scheduled'`;
  const oldCase=old.replace("s.status='scheduled'",subset).replaceAll('COALESCE(r.facts,ps.eligibility_snapshot)',expression);
  const newCase=proto.replace("s.status='scheduled'",subset).replaceAll('COALESCE(r.facts,snapshot_row.eligibility_snapshot)',expression.replaceAll('ps.','snapshot_row.'));
  const a=JSON.parse(await q(results(oldCase))),b=JSON.parse(await q(results(newCase)));assert.deepEqual(b,a);r.cases.push({name,sessions:Object.keys(a).length,rejected:Object.values(a).filter(x=>!x).length,exact:true});
 }
 await control(`CREATE ROLE ${installer} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;`);roleCreated=true;
 await q(`GRANT USAGE,CREATE ON SCHEMA biplan TO ${installer};GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA biplan TO ${installer};ALTER FUNCTION biplan.seal_preparation_batch_v2(text,jsonb) OWNER TO ${installer};`);
 const install=()=>q(`SET ROLE ${installer};${migration.replaceAll('\n','\r\n')}`);
 const beforeDefinition=(await q("SELECT pg_get_functiondef('biplan.seal_preparation_batch_v2(text,jsonb)'::regprocedure);")).replaceAll('\r\n','\n');
 const attrs=()=>q("SELECT jsonb_build_object('owner',proowner,'acl',proacl,'securityDefiner',prosecdef,'configuration',proconfig)::text FROM pg_proc WHERE oid='biplan.seal_preparation_batch_v2(text,jsonb)'::regprocedure;");
 const beforeAttrs=await attrs();
 await q(beforeDefinition.replace('DECLARE b biplan.preparation_batches%ROWTYPE;', 'DECLARE b biplan.preparation_batches%ROWTYPE; /* unexpected stale edit */'));
 await assert.rejects(install,/complete seal function body/);
 await q(beforeDefinition.replaceAll('\n','\r\n'));
 await install();await install();assert.equal(await attrs(),beforeAttrs);
 const afterDefinition=(await q("SELECT pg_get_functiondef('biplan.seal_preparation_batch_v2(text,jsonb)'::regprocedure);")).replaceAll('\r\n','\n');
 const oldGuard=migration.split('$old_guard$')[1],newGuard='IF EXISTS(SELECT 1 FROM ('+proto+') bulk_global_projection_integrity_v1 WHERE NOT usable) THEN blocked:=blocked+1; END IF;';
 assert.equal(afterDefinition.replace(newGuard,()=>oldGuard),beforeDefinition);
 await q(afterDefinition.replace('DECLARE b biplan.preparation_batches%ROWTYPE;', 'DECLARE b biplan.preparation_batches%ROWTYPE; /* unexpected replay edit */'));
 await assert.rejects(install,/complete seal function body/);await q(afterDefinition);
 r.migrationReplay={nonSuperuser:true,crlfSourceAccepted:true,staleAndUpdatedFunctionRejected:true,exactSurroundingFunctionPreserved:true,ownerAclConfigurationPreserved:true};
 const fixture=`CREATE TEMP TABLE probe_offer AS SELECT i.id offer_id,i.session_id,r.id revision_id,i.provider,i.provider_record_id,r.source_url,r.observed_at,r.source_updated_at,r.source_session_ids,biplan.legacy_offer_occurrence(r.id) bound FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id WHERE i.session_id=(SELECT session_id FROM biplan.offer_identities GROUP BY session_id HAVING count(*)>1 ORDER BY session_id LIMIT 1) ORDER BY i.id LIMIT 1;`;
 const unknown=`DELETE FROM biplan.publication_offers WHERE offer_revision_id=(SELECT revision_id FROM probe_offer);DELETE FROM biplan.offer_occurrence_bindings WHERE offer_revision_id=(SELECT revision_id FROM probe_offer);UPDATE biplan.offer_revisions SET source_payload='{}' WHERE id=(SELECT revision_id FROM probe_offer);`;
 const soldout=`UPDATE biplan.offer_revisions SET availability='sold_out' WHERE id=(SELECT revision_id FROM probe_offer);`;
 const binding=(changed=false)=>`INSERT INTO biplan.offer_occurrence_bindings(offer_revision_id,session_id,facts,evidence_basis,evidence_observed_at,evidence_source_updated_at) SELECT revision_id,session_id,${changed?`jsonb_set(bound,'{title}','"INCOMPATIBLE UNSELECTED OFFER"')`:'bound'},'full_source_record',observed_at+interval '2 seconds',source_updated_at FROM probe_offer ON CONFLICT(offer_revision_id) DO UPDATE SET facts=EXCLUDED.facts,evidence_basis=EXCLUDED.evidence_basis,evidence_observed_at=EXCLUDED.evidence_observed_at;`;
 const dispute=(wide=false)=>`INSERT INTO biplan.canonical_occurrence_disputes(request_id,session_id,offer_id,source_name,source_record_id,observation_id,facts,observed_at,source_updated_at,reason) SELECT 'probe-dispute',session_id,${wide?'NULL':'offer_id'},provider,provider_record_id,(SELECT id FROM biplan.source_observations LIMIT 1),'{}',observed_at+interval '1 second',source_updated_at,'fixture_conflict' FROM probe_offer;`;
 const page=(status='verified',receipt='accepted',supported=false)=>`INSERT INTO biplan.canonical_requests(id,request_hash,payload,receipt) SELECT 'probe-request','probe',jsonb_build_object('record',jsonb_build_object('id',provider_record_id,'source',provider,'url',source_url,'checkedAt',observed_at)),jsonb_build_object('status','accepted','offerRevisionId',revision_id) FROM probe_offer;
 INSERT INTO biplan.source_page_observations(id,page_hash,payload,receipt,provider,source_url,observed_at,source_updated_at,status) SELECT 'probe-page','probe',jsonb_build_object('complete',true,'records',${supported?`jsonb_build_array(jsonb_build_object('requestId','probe-request','sourceRecordId',provider_record_id))`:`'[]'::jsonb`}),jsonb_build_object('status','${receipt}'),provider,source_url,observed_at,source_updated_at,'${status}' FROM probe_offer;
 INSERT INTO biplan.source_page_heads(provider,source_url,page_id) SELECT provider,source_url,'probe-page' FROM probe_offer ON CONFLICT(provider,source_url) DO UPDATE SET page_id=EXCLUDED.page_id;`;
 const cases=[['unknown-unsupported',unknown,true],['unknown-supported',unknown+page('verified','accepted',true),false],['known-supported',page('verified','accepted',true),true],['page-retired',page('retired'),true],['page-failed',page('failed'),true],['quarantined-family',page('quarantined'),false],['held-page-clock',page('verified','held'),false],['soldout-quarantine',soldout+page('quarantined'),false],['unselected-offer-drift',binding(true),false],['soldout-occurrence-drift',binding(true)+soldout,true],['offer-dispute',dispute(),false],['session-wide-dispute',dispute(true),false],['soldout-dispute',soldout+dispute(),false],['resolved-dispute',dispute()+binding(),true],['null-current-head',`UPDATE biplan.offer_identities SET current_revision_id=NULL WHERE id=(SELECT offer_id FROM probe_offer);`,true]];
 for(const [name,mutation,expected] of cases){
  const filter=`s.id=(SELECT session_id FROM probe_offer) AND s.status='scheduled'`;
  const a=old.replace("s.status='scheduled'",filter),b=proto.replace("s.status='scheduled'",filter);
  const output=await q(`BEGIN;SET LOCAL session_replication_role=replica;${fixture}${mutation}${results(a)}${results(b)}ROLLBACK;`);
  const [before,after]=output.split('\n').filter(x=>x.startsWith('{')).map(JSON.parse);assert.deepEqual(after,before,name);assert.equal(Object.values(before)[0],expected,name);r.cases.push({name,sessions:Object.keys(before).length,expected,exact:true});
 }
 const malformed=old.replace("s.status='scheduled'","s.id=(SELECT session_id FROM probe_offer) AND s.status='scheduled'").replaceAll('COALESCE(r.facts,ps.eligibility_snapshot)',`'{"startsAt":"invalid"}'::jsonb`);
 const malformedNew=proto.replace("s.status='scheduled'","s.id=(SELECT session_id FROM probe_offer) AND s.status='scheduled'").replaceAll('COALESCE(r.facts,snapshot_row.eligibility_snapshot)',`'{"startsAt":"invalid"}'::jsonb`);
 const out=await q(`BEGIN;SET LOCAL session_replication_role=replica;${fixture}UPDATE biplan.offer_revisions SET availability='sold_out' WHERE session_id=(SELECT session_id FROM probe_offer);${results(malformed)}${results(malformedNew)}ROLLBACK;`);
 const [a,b]=out.split('\n').filter(x=>x.startsWith('{')).map(JSON.parse);assert.deepEqual(b,a);assert.equal(Object.values(a)[0],true);r.cases.push({name:'malformed-facts-soldout-do-not-normalize',exact:true,expected:true});
 await q(`INSERT INTO biplan.preparation_storage_limits(singleton,max_database_bytes,min_headroom_bytes,max_batch_records,max_record_bytes) VALUES(true,4294967296,1073741824,20000,1048576) ON CONFLICT(singleton) DO NOTHING;`);
 const fixtureBytes=await readFile(resolve(dir,'logical-publisher-source-b6df4c871040.json'));r.sourceFixtureSha256=createHash('sha256').update(fixtureBytes).digest('hex');
 const envelope=JSON.parse(fixtureBytes);
 const started=performance.now();const source=await ingestPageBatchSource(envelope,{store:createPageBatchSourceStore(q),canonicalStore:createCanonicalStore(q),limit:100});assert.equal(source.seal.status,'sealed');
 r.fullSource={elapsedMs:performance.now()-started,seal:source.seal,records:source.decisions.filter(x=>x.kind==='record').length};
}catch(e){r.error=String(e.message);process.exitCode=1;}
finally{if(created){await control(`DROP DATABASE ${db} WITH (FORCE);`);r.databaseDropped=true;}if(roleCreated){await control(`DROP ROLE ${installer};`);r.roleDropped=true;}r.finishedAt=new Date().toISOString();await writeFile(resolve(dir,`bulk-seal-integrity-verification-${Date.now()}.json`),JSON.stringify(r,null,2));await writeFile(resolve(dir,'bulk-seal-integrity-verification-latest.json'),JSON.stringify(r,null,2));console.log(JSON.stringify({error:r.error,plans:Object.fromEntries(Object.entries(r.plans).map(([k,v])=>[k,v[0]['Execution Time']])),parity:r.baselineParity,cases:r.cases,migrationReplay:r.migrationReplay,fullSource:r.fullSource,databaseDropped:r.databaseDropped,roleDropped:r.roleDropped}));}
