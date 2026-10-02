import { randomUUID } from 'node:crypto';
import { hash, transaction } from '../db/index.mjs';
import { createJobStore, enqueue } from './store.mjs';
import { validateRawRef } from '../raw/store.mjs';
import { extractProviderListings, EXTRACTOR_VERSION } from '../extract/index.mjs';
import { ingestCollection } from './ingest.mjs';
import { persistFetchLedger, requireUsableFetch, validateFetchLedger } from './fetch-receipts.mjs';

/** Replays retained responses only. The injected extractor is pure and has no fetch capability. */
export async function extractCollection(pool,input,{readRaw,extract=extractProviderListings,extractorVersions=EXTRACTOR_VERSION,maxJobs=2000,timeBudgetMs=60000,leaseMs=30000,signal,owner=`extract-${randomUUID()}`}={}) {
  if(!input?.id||!['complete','partial','unknown'].includes(input.scope)||!Array.isArray(input.inventory)||!Array.isArray(input.pages)||input.pages.length>6000||new Set(input.inventory).size!==input.inventory.length||input.inventory.length!==input.pages.length||new Set(input.pages.map(p=>p.url)).size!==input.pages.length||input.pages.some(p=>!input.inventory.includes(p.url))) throw new Error('Invalid raw collection inventory');
  if(typeof readRaw!=='function'||!Number.isSafeInteger(maxJobs)||maxJobs<1||maxJobs>6000||!Number.isFinite(timeBudgetMs)||timeBudgetMs<1||timeBudgetMs>300000) throw new Error('Invalid bounded extraction configuration');
  const fetches=validateFetchLedger(input.fetches);
  const pages=[...input.pages].sort((a,b)=>a.url.localeCompare(b.url)),refs=new Map();
  for(const fetch of fetches??[]) refs.set(fetch.rawObjectRef.sha256,fetch.rawObjectRef);
  for(const page of pages) {
    if(!extractorVersions[page.provider]||!Number.isFinite(Date.parse(page.observedAt))||!['verified','retired','failed','quarantined','unvisited'].includes(page.status??'verified')) throw new Error('Invalid raw page receipt');
    if(['verified','retired'].includes(page.status??'verified')&&!page.rawObjectRef) throw new Error('Successful raw page requires a response');
    for(const ref of [page.rawObjectRef,...(page.supplementaryRawObservations??[]).map(o=>o.rawObjectRef)].filter(Boolean)) {validateRawRef(ref);refs.set(ref.sha256,ref);}
    if(['verified','retired'].includes(page.status??'verified')) {
      requireUsableFetch(fetches,{url:page.responseUrl??page.url,observedAt:page.observedAt,sha256:page.rawObjectRef.sha256});
      for(const observation of page.supplementaryRawObservations??[]) requireUsableFetch(fetches,{url:observation.url,observedAt:observation.fetchedAt,sha256:observation.rawObjectRef.sha256});
    }
  }
  const verifiedRead=async ref=>{
    const body=await readRaw(ref);
    if(!(body instanceof Uint8Array)||body.byteLength!==ref.bytes||hash(body)!==ref.sha256) throw new Error('Raw extraction integrity failure');
    return Buffer.from(body);
  };
  // Read/hash before durable references are accepted. Extraction reads are also
  // verified, so changed local bytes cannot race this preliminary admission.
  for(const ref of refs.values()) await verifiedRead(ref);
  const body={...input,inventory:[...input.inventory].sort(),pages,extractorVersions:Object.fromEntries([...new Set(pages.map(page=>page.provider))].sort().map(provider=>[provider,extractorVersions[provider]]))},inputHash=hash(body);
  await transaction(pool,async client=>{
    const existing=(await client.query('SELECT input_hash FROM biplan_pipeline.raw_collections WHERE id=$1',[input.id])).rows[0];
    if(existing&&existing.input_hash!==inputHash) throw new Error('Raw collection ID is immutable');
    await client.query('INSERT INTO biplan_pipeline.raw_collections(id,input_hash,body) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[input.id,inputHash,body]);
    for(const ref of refs.values()) {
      await client.query('INSERT INTO biplan_pipeline.raw_objects VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT DO NOTHING',[ref.sha256,ref.key,ref.bytes]);
      const stored=(await client.query('SELECT object_key,bytes FROM biplan_pipeline.raw_objects WHERE sha256=$1',[ref.sha256])).rows[0];
      if(stored.object_key!==ref.key||Number(stored.bytes)!==ref.bytes) throw new Error('Conflicting durable raw reference');
    }
    await persistFetchLedger(client,fetches);
    for(const page of pages) if((page.status??'verified')==='verified') await enqueue(client,{rawCollectionId:input.id},
      {stage:'extract',subject:`${page.provider}:${page.url}`,inputHash:hash(page),version:extractorVersions[page.provider],input:{page}});
  });
  const jobs=createJobStore(pool),started=Date.now();let processed=0;
  while(processed<maxJobs&&Date.now()-started<timeBudgetMs&&!signal?.aborted) {
    const job=await jobs.claim({rawCollectionId:input.id,stage:'extract',owner,leaseMs});
    if(!job) break;
    try {
      const page=job.input.page;
      const supplementaryResponses=new Map();
      for(const observation of page.supplementaryRawObservations??[]) {
        if(!observation.url||!Number.isFinite(Date.parse(observation.fetchedAt))) throw new Error('Invalid supplementary observation');
        supplementaryResponses.set(observation.url,{...observation,body:(await verifiedRead(observation.rawObjectRef)).toString('utf8')});
      }
      const listings=await extract({provider:page.provider,url:page.url,body:(await verifiedRead(page.rawObjectRef)).toString('utf8'),fetchedAt:page.observedAt,rawObjectRef:page.rawObjectRef},
        {fallbackCategory:page.fallbackCategory,supplementaryResponses});
      if(!Array.isArray(listings)) throw new Error('Extractor returned no listing array');
      await jobs.complete(job,{listings},{signal});processed++;
    } catch(error) {await jobs.fail(job,error,{retry:signal?.aborted===true}).catch(()=>{});throw error;}
  }
  const pending=await jobs.pending({rawCollectionId:input.id},'extract');
  if(pending||signal?.aborted) return {collectionId:input.id,complete:false,processed,pending,stopped:signal?.aborted?'interrupted':'bounded_or_failed'};
  const outputs=(await pool.query(`SELECT j.input,j.output FROM biplan_pipeline.jobs j JOIN biplan_pipeline.raw_collection_jobs c ON c.job_id=j.id WHERE c.raw_collection_id=$1 AND j.stage='extract' AND j.state='completed'`,[input.id])).rows;
  const byUrl=new Map(outputs.map(row=>[row.input.page.url,row.output.listings]));
  const listingEnvelope={id:input.id,scope:input.scope,horizon:input.horizon??null,inventory:input.inventory,collectorRevision:input.collectorRevision??'unknown',rawObjects:[...refs.values()],...(input.fetches===undefined?{}:{fetches:input.fetches}),
    listings:pages.flatMap(page=>byUrl.get(page.url)??[]),pages:pages.map(page=>({url:page.url,provider:page.provider,status:page.status??'verified',observedAt:page.observedAt,rawObjectSha256:page.rawObjectRef?.sha256??null,
      listingIds:(byUrl.get(page.url)??[]).map(listing=>listing.listingId),...(page.responseUrl?{responseUrl:page.responseUrl}:{}),...(page.httpStatus===undefined?{}:{httpStatus:page.httpStatus}),...(page.headers?{headers:page.headers}:{}),...(page.method?{method:page.method}:{})}))};
  const ingestion=await ingestCollection(pool,listingEnvelope,{readRaw:verifiedRead});
  return {collectionId:input.id,complete:true,processed,pending:0,stopped:'drained',ingestion};
}
