import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { servingExportJobConfig,createServingExportStorage,runServingExportJob } from '../scripts/run-postgres-serving-export.mjs';

const env={DEPLOYMENT_ENV:'staging',BIPLAN_GCP_PROJECT:'biplan-staging-efeblk',GCP_STORAGE_BUCKET:'biplan-staging-efeblk-biplan-staging-data'};
const sha='a'.repeat(64),objectName=`staging/preparation/serving/v1/${'b'.repeat(64)}/${sha}.ndjson.gz`;
const upload={bucket:env.GCP_STORAGE_BUCKET,objectName,body:Buffer.from('gzip-bytes'),sha256:sha};
void test('serving export configuration rejects foreign targets, oversized bounds and a deadline beyond its lease',()=>{
  const config=servingExportJobConfig(['publication-1'],env);
  assert.equal(config.pageSize,1000);assert.equal(config.leaseSeconds,180);
  assert.throws(()=>servingExportJobConfig([],env));
  assert.throws(()=>servingExportJobConfig(['p'],{...env,GCP_STORAGE_BUCKET:'another-bucket'}));
  assert.throws(()=>servingExportJobConfig(['p'],{...env,CATALOG_EXPORT_PAGE_SIZE:'1001'}));
  assert.throws(()=>servingExportJobConfig(['p'],{...env,CATALOG_EXPORT_LEASE_SECONDS:'30'}));
});
void test('serving upload is create-only with CRC and binary gzip content without transparent encoding',async()=>{
  let options;
  const storage={bucket:name=>{assert.equal(name,upload.bucket);return {file:key=>{assert.equal(key,objectName);return {
    createWriteStream:value=>{options=value;return new Writable({write(chunk,encoding,done){done();}});},
    getMetadata:async()=>[{generation:'123456789012345678',size:upload.body.length}],
  };}};}};
  const adapter=createServingExportStorage(storage,async()=>Buffer.alloc(0),upload.bucket);
  assert.equal((await adapter.putCreateOnly(upload)).generation,'123456789012345678');
  assert.equal(options.preconditionOpts.ifGenerationMatch,0);assert.equal(options.validation,'crc32c');
  assert.equal(options.resumable,false);assert.equal(options.metadata.contentType,'application/gzip');assert.equal(options.metadata.contentEncoding,undefined);
});
void test('explicit upload replay accepts 412 only for subsequent pinned verification, without another write',async()=>{
  let writes=0,reads=0;
  const storage={bucket:()=>({file:()=>({
    createWriteStream:()=>{writes++;return new Writable({write(chunk,encoding,done){done(Object.assign(new Error('exists'),{code:412}));}});},
    getMetadata:async()=>[{generation:'77',size:upload.body.length}],
  })})};
  const adapter=createServingExportStorage(storage,async value=>{reads++;assert.equal(value.binding.generation,'77');return upload.body;},upload.bucket);
  const result=await adapter.putCreateOnly(upload);await adapter.readPinned({...upload,generation:result.generation});
  assert.equal(writes,1);assert.equal(reads,1);
});
void test('interruption cancels hung upload metadata and never returns a locator',async()=>{
  const controller=new AbortController();
  const storage={bucket:()=>({file:()=>({
    createWriteStream:()=>new Writable({write(chunk,encoding,done){done();}}),
    getMetadata:()=>new Promise(()=>{}),
  })})};
  const adapter=createServingExportStorage(storage,async()=>Buffer.alloc(0),upload.bucket);
  const pending=adapter.putCreateOnly({...upload,signal:controller.signal});
  setTimeout(()=>controller.abort(),10);
  await assert.rejects(pending,/interrupted/);
});
void test('export job closes the database even when verification or completion fails',async()=>{
  let closed=0;
  await assert.rejects(runServingExportJob({config:{publicationId:'p'},dependencies:{
    createClient:()=>({queryText:()=>{},close:async()=>{closed++;}}),createStore:()=>({}),
    runExport:async()=>{throw new Error('verification failed');},storage:{},encode:()=>{},decode:()=>{},
  }}),/verification failed/);
  assert.equal(closed,1);
});
