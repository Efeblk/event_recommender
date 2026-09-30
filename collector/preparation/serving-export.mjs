import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const MAX_ROWS=20000, MAX_LINE=1024*1024, MAX_RAW=128*1024*1024;
const OBJECT_FIELDS=['bucket','objectName','generation','encoding','compressedSha256','uncompressedSha256','compressedBytes','uncompressedBytes'];
const interrupted=signal=>{ if(signal?.aborted) throw new Error('Serving export interrupted'); };

/** One durable export job. Every storage call occurs outside SQL transactions. */
export async function exportPublicationServingArtifact({publicationId,bucket,workerId,leaseSeconds=180,pageSize=1000,store,storage,encode,decode,signal}) {
  assert(Number.isInteger(pageSize) && pageSize>0 && pageSize<=1000,'Invalid serving export page size');
  interrupted(signal);
  const binding=await store.begin(publicationId,bucket);
  assert(binding?.header?.publicationId===publicationId && binding.bucket===bucket,'Serving export binding mismatch');
  if(binding.state==='ready') return {status:'already_completed',publicationId,idempotent:true,aiCalls:0,providerCalls:0};
  const job=await store.claim(publicationId,workerId,leaseSeconds);
  if(!job) return {status:'not_claimed',publicationId,aiCalls:0,providerCalls:0};
  assert(job.id===binding.jobId,'Serving export job mismatch');
  const counters={pages:0,rows:0,storageWrites:0,storageReads:0};
  try {
    interrupted(signal);
    let object=job.checkpoint?.uploadedObject;
    if(object) {
      assert(typeof object==='object' && Object.keys(object).length===OBJECT_FIELDS.length && OBJECT_FIELDS.every(key=>Object.hasOwn(object,key)),'Checkpoint receipt fields differ');
      assert(object.bucket===bucket,'Checkpoint storage bucket mismatch');
      counters.storageReads++;
      const bytes=await storage.readPinned({...binding,...object},signal);
      await decode({...binding,...object},bytes);
    } else {
      const lines=[];
      let after='',rawBytes=Buffer.byteLength(binding.headerText)+1;
      assert(rawBytes<=MAX_LINE && binding.header.sessionCount<=MAX_ROWS,'Serving export metadata exceeds bounds');
      for(let pageNumber=0;;pageNumber++) {
        assert(pageNumber<=MAX_ROWS/pageSize,'Serving export page bound exceeded');
        interrupted(signal);
        const page=await store.page(job,workerId,after,pageSize);
        counters.pages++;
        assert(Array.isArray(page.rows) && page.rows.length<=pageSize && typeof page.done==='boolean','Invalid serving export page');
        for(const row of page.rows) {
          assert(typeof row.sessionId==='string' && row.sessionId>after && typeof row.rawRowText==='string','Serving export ordering mismatch');
          const rowBytes=Buffer.byteLength(row.rawRowText)+1;
          assert(rowBytes<=MAX_LINE && !row.rawRowText.includes('\n') && !row.rawRowText.includes('\r'),'Serving export row exceeds bound');
          after=row.sessionId; rawBytes+=rowBytes; lines.push(row.rawRowText); counters.rows++;
          assert(lines.length<=MAX_ROWS && rawBytes<=MAX_RAW,'Serving export size exceeds bounds');
        }
        assert(page.nextAfter===after,'Serving export cursor mismatch');
        if(page.done) break;
        assert(page.rows.length>0,'Serving export page cannot advance');
        await store.checkpoint(job,workerId,{stage:'collecting',afterSessionId:after,rowsRead:lines.length,rawBytes});
      }
      assert(lines.length===binding.header.sessionCount && rawBytes===binding.uncompressedBytes,'Serving export completeness mismatch');
      // SQL produces the exact bytes and root; the shared codec verifies both.
      const encoded=await encode(binding.headerText,lines);
      const objectName=`staging/preparation/serving/v1/${createHash('sha256').update(publicationId).digest('hex')}/${encoded.compressedSha256}.ndjson.gz`;
      interrupted(signal);
      counters.storageWrites++;
      const uploaded=await storage.putCreateOnly({bucket,objectName,body:encoded.compressed,sha256:encoded.compressedSha256,signal});
      object={bucket,objectName,generation:uploaded.generation,encoding:'gzip',compressedSha256:encoded.compressedSha256,
        uncompressedSha256:encoded.uncompressedSha256,compressedBytes:encoded.compressedBytes,uncompressedBytes:encoded.uncompressedBytes};
      interrupted(signal);
      counters.storageReads++;
      const bytes=await storage.readPinned({...binding,...object},signal);
      await decode({...binding,...object},bytes);
      interrupted(signal);
      await store.checkpoint(job,workerId,{stage:'uploaded_verified',uploadedObject:object});
    }
    interrupted(signal);
    const ready=await store.complete(job,workerId,object);
    assert(ready.state==='ready' && ready.header?.publicationId===publicationId,'Serving export completion mismatch');
    return {status:'completed',publicationId,...counters,compressedBytes:object.compressedBytes,uncompressedBytes:object.uncompressedBytes,aiCalls:0,providerCalls:0};
  } catch(error) {
    // Persist only controlled codes; external exception text may contain secrets.
    let persistence='recorded';
    try {await store.fail(job,workerId,{code:signal?.aborted?'interrupted':'export_failed',retryable:true});}
    catch {persistence='fence_or_completion_changed';}
    const failure=new Error(signal?.aborted?'Serving export interrupted':'Serving export failed');
    failure.code=signal?.aborted?'interrupted':'export_failed'; failure.persistence=persistence; failure.counters=counters;
    throw failure;
  }
}
