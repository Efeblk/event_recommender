import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exportPublicationServingArtifact } from '../preparation/serving-export.mjs';
import { encodePublicationServingArtifact, decodePublicationServingArtifact, servingRowsContentRoot } from '../../web/lib/publication-serving-artifact.node.ts';

function fixture() {
  const row=JSON.stringify({sessionId:'session-1',productionId:'production-1',venueId:null,snapshot:{title:'Test'},document:null,pinnedOfferTerms:[{offerId:'offer-1',revisionId:'revision-1'}]});
  const header={schemaVersion:1,kind:'biplan-publication-serving',publicationId:'publication-1',manifestHash:'a'.repeat(64),validationHash:'b'.repeat(64),offerProjectionVersion:null,embeddingProfile:null,sessionCount:1,offerCount:1,contentRoot:servingRowsContentRoot([row])};
  const headerText=JSON.stringify(header), encoded=encodePublicationServingArtifact(headerText,[row]);
  const binding={jobId:'job-1',state:'pending',bucket:'test-bucket',header,headerText,contentRoot:header.contentRoot,uncompressedBytes:encoded.uncompressedBytes};
  const object={bucket:binding.bucket,objectName:`staging/preparation/serving/v1/${createHash('sha256').update(header.publicationId).digest('hex')}/${encoded.compressedSha256}.ndjson.gz`,generation:'123',encoding:'gzip',...encoded};
  delete object.compressed;
  const calls=[];let ready=false;
  const store={
    begin:async()=>ready?{...binding,...object,state:'ready'}:binding,
    claim:async()=>({id:'job-1',fencing_token:'1',checkpoint:{}}),
    page:async()=>{calls.push('page');return {rows:[{sessionId:'session-1',rawRowText:row}],nextAfter:'session-1',done:true};},
    checkpoint:async()=>{calls.push('checkpoint');},
    complete:async()=>{calls.push('complete');ready=true;return {...binding,...object,state:'ready'};},
    fail:async()=>{calls.push('fail');},
  };
  const storage={putCreateOnly:async()=>{calls.push('put');return {generation:'123'};},readPinned:async()=>{calls.push('read');return encoded.compressed;}};
  const args={publicationId:header.publicationId,bucket:binding.bucket,workerId:'worker-1',store,storage,encode:encodePublicationServingArtifact,decode:decodePublicationServingArtifact};
  return {args,calls,object,encoded,binding};
}

test('export commits only after exact uploaded bytes have been read back and verified',async()=>{
  const {args,calls}=fixture();
  const result=await exportPublicationServingArtifact(args);
  assert.equal(result.status,'completed');assert.equal(result.rows,1);
  assert.deepEqual(calls,['page','put','read','checkpoint','complete']);
  calls.length=0;
  const replay=await exportPublicationServingArtifact(args);
  assert.equal(replay.status,'already_completed');assert.deepEqual(calls,[]);
});
test('corrupt upload cannot commit a serving reference',async()=>{
  const {args,calls}=fixture();args.storage.readPinned=async()=>Buffer.from('corrupt');
  await assert.rejects(exportPublicationServingArtifact(args),/Serving export failed/);
  assert(!calls.includes('complete'));assert.equal(calls.at(-1),'fail');
});
test('reclaimed uploaded checkpoint verifies its exact generation without another upload or page read',async()=>{
  const {args,calls,object}=fixture();
  args.store.claim=async()=>({id:'job-1',fencing_token:'2',checkpoint:{uploadedObject:object}});
  args.storage.readPinned=async binding=>{assert.equal(binding.generation,'123');calls.push('read');return fixture().encoded.compressed;};
  assert.equal((await exportPublicationServingArtifact(args)).status,'completed');
  assert.deepEqual(calls,['read','complete']);
});
test('interruption after upload retains no database reference and can resume explicitly',async()=>{
  const {args,calls}=fixture();const controller=new AbortController();args.signal=controller.signal;
  args.storage.putCreateOnly=async()=>{calls.push('put');controller.abort();return {generation:'123'};};
  await assert.rejects(exportPublicationServingArtifact(args),/interrupted/);
  assert.deepEqual(calls,['page','put','fail']);
});
test('lost completion response is recovered by durable ready replay with no additional storage calls',async()=>{
  const {args,calls}=fixture();const complete=args.store.complete;
  args.store.complete=async(...values)=>{await complete(...values);throw new Error('connection lost');};
  args.store.fail=async()=>{calls.push('fail-stale');throw new Error('fence changed');};
  await assert.rejects(exportPublicationServingArtifact(args),error=>error.persistence==='fence_or_completion_changed');
  calls.length=0;
  assert.equal((await exportPublicationServingArtifact(args)).status,'already_completed');assert.deepEqual(calls,[]);
});
test('stale completion never retries upload or masks the failure',async()=>{
  const {args,calls}=fixture();
  args.store.complete=async()=>{calls.push('complete-stale');throw new Error('stale fence');};
  await assert.rejects(exportPublicationServingArtifact(args),/Serving export failed/);
  assert.equal(calls.filter(x=>x==='put').length,1);assert.equal(calls.filter(x=>x==='complete-stale').length,1);
});
test('incomplete or nonadvancing pages cannot upload any object',async()=>{
  const {args,calls}=fixture();args.store.page=async()=>({rows:[],nextAfter:'',done:false});
  await assert.rejects(exportPublicationServingArtifact(args),/Serving export failed/);
  assert(!calls.includes('put'));assert(!calls.includes('complete'));
});
