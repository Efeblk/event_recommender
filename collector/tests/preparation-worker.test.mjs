import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveOfferFacts,runPreparationWorker } from '../preparation/worker.mjs';
import { createWorkerStore } from '../preparation/worker-store.mjs';

const job={id:'job',stage:'offer_revision_accepted',stage_version:'1',subject_id:'offer',input_hash:'hash',fencing_token:'1'};
const revision={id:'revision',offer_id:'offer',semantic_content_hash:'hash',acceptance_status:'accepted',currency:'TRY',price_minor:'70000',fee_minor:null,price_kind:'exact',availability:'available'};
test('quoted zero price and zero fee remain exact; missing fees and lower bounds never become exact checkout totals',()=>{
  assert.equal(deriveOfferFacts({...revision,price_minor:'0',fee_minor:'0'},job).facts.exactCheckoutPriceMinor,'0');
  assert.equal(deriveOfferFacts(revision,job).facts.exactCheckoutPriceMinor,null);
  assert.equal(deriveOfferFacts({...revision,fee_minor:'0',price_kind:'starting_at'},job).facts.exactCheckoutPriceMinor,null);
  assert.equal(deriveOfferFacts({...revision,fee_minor:'0',price_kind:'range'},job).facts.exactCheckoutPriceMinor,null);
  assert.equal(deriveOfferFacts({...revision,currency:null,fee_minor:'0'},job).facts.priceStatus,'unknown');
  assert.equal(deriveOfferFacts({...revision,price_minor:null,fee_minor:'0'},job).facts.exactCheckoutPriceMinor,null);
});
test('minor-unit arithmetic preserves bigint precision and rejects unsafe JSON numbers',()=>{
  const facts=deriveOfferFacts({...revision,price_minor:'9007199254740993',fee_minor:'17'},job).facts;
  assert.equal(facts.exactCheckoutPriceMinor,'9007199254741010');
  assert.throws(()=>deriveOfferFacts({...revision,price_minor:Number('9007199254740993')},job),/Unsafe/);
  assert.throws(()=>deriveOfferFacts({...revision,fee_minor:'-1'},job),/Invalid/);
});
test('derivation stays tied to accepted content and contains no inferred stock, promotion or clock eligibility',()=>{
  assert.throws(()=>deriveOfferFacts({...revision,semantic_content_hash:'other'},job),/dependency/);
  assert.throws(()=>deriveOfferFacts({...revision,acceptance_status:'held_stale'},job),/dependency/);
  const value=deriveOfferFacts({...revision,observed_at:'2000-01-01',valid_until:'2000-01-02'},job);
  assert.equal(value.facts.groupStock,'unknown'); assert.equal(value.facts.promotionStatus,'unknown');
  assert.equal('currentlyEligible' in value.facts,false); assert.equal('observedAt' in value.facts,false);
});

function memoryStore(count=2) {
  const jobs=Array.from({length:count},(_,i)=>({...job,id:`job-${i}`})),events=Array.from({length:count},(_,i)=>({id:`event-${i}`,fencing_token:'1'}));
  const calls=[];
  return {calls,claimJobs:async()=>{calls.push('claim-job');return jobs.length?[jobs.shift()]:[];},
    claimEvents:async()=>{calls.push('claim-event');return events.length?[events.shift()]:[];},
    revisionForJob:async()=>revision,checkpointJob:async()=>calls.push('checkpoint'),finishJob:async()=>calls.push('finish'),
    failJob:async()=>calls.push('fail-job'),deliverEvent:async()=>calls.push('deliver'),failEvent:async()=>calls.push('fail-event')};
}
test('one bounded invocation alternates queues, completes only claimed work, and never exceeds either item cap',async()=>{
  const store=memoryStore();
  const result=await runPreparationWorker({store,workerId:'test',maxJobs:1,maxEvents:1});
  assert.equal(result.completedJobs,1); assert.equal(result.deliveredEvents,1); assert.equal(result.stopped,'item_limit');
  assert.deepEqual(store.calls,['claim-job','checkpoint','finish','claim-event','deliver']);
});
test('an expired invocation budget and preexisting interruption make no new claims',async()=>{
  const store=memoryStore(),signal=new AbortController(); signal.abort();
  const result=await runPreparationWorker({store,workerId:'test',signal:signal.signal});
  assert.equal(result.stopped,'interrupted'); assert.equal(store.calls.length,0);
  let tick=0;
  const timeout=await runPreparationWorker({store,workerId:'test',timeBudgetMs:1,now:()=>tick++});
  assert.equal(timeout.stopped,'time_budget'); assert.equal(store.calls.length,0);
});
test('interruption after compute records failure and never writes a derived result',async()=>{
  const store=memoryStore(),signal=new AbortController();
  const result=await runPreparationWorker({store,workerId:'test',maxJobs:1,maxEvents:1,signal:signal.signal,
    derive:async(r,j)=>{signal.abort();return deriveOfferFacts(r,j);}});
  assert.equal(result.completedJobs,0); assert.equal(result.deliveredEvents,0); assert.equal(result.failures.length,1);
  assert.equal(result.failures[0].retryable,true);
  assert.deepEqual(store.calls,['claim-job','fail-job']);
});
test('failure persistence rejected by a stale lease is reported as uncertain without automatic retry',async()=>{
  const store=memoryStore(); store.finishJob=async()=>{throw new Error('stale completion');};
  store.failJob=async()=>{throw new Error('stale failure');};
  const result=await runPreparationWorker({store,workerId:'test',maxJobs:1,maxEvents:0});
  assert.equal(result.failures[0].persistence,'uncertain'); assert.equal(result.completedJobs,0);
  assert.equal(store.calls.filter(value=>value==='claim-job').length,1);
});
test('SQL adapter never silently rounds large fencing tokens',async()=>{
  const store=createWorkerStore(async()=>{throw new Error('query should not execute');});
  assert.throws(()=>store.finishJob({...job,fencing_token:Number('9007199254740993')},'test',{}),/Unsafe/);
});
