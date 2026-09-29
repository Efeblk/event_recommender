import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRefreshStore,runPublicationRefresh } from '../preparation/refresh-consumer.mjs';

function memoryStore(count=2) {
  const requests=Array.from({length:count},(_,i)=>({id:`request-${i}`,fencing_token:'1'})),calls=[];
  return {calls,claim:async()=>{calls.push('claim');return requests.length?[requests.shift()]:[];},active:async()=>{calls.push('base');return 'publication-base';},
    checkpoint:async()=>calls.push('checkpoint'),refresh:async()=>{calls.push('refresh');return {status:'completed',basePublicationId:'publication-base',resultPublicationId:'publication-next'};},
    fail:async()=>{calls.push('fail');return {status:'failed'};}};
}
test('refresh consumer completes exactly the bounded work and reports publication switches separately',async()=>{
  const store=memoryStore(),summary=await runPublicationRefresh({store,workerId:'fixture',maxRequests:1});
  assert.equal(summary.claimed,1);assert.equal(summary.completed,1);assert.equal(summary.published,1);assert.equal(summary.stopped,'item_limit');
  assert.deepEqual(store.calls,['claim','base','checkpoint','refresh']);
});
test('blocked mandatory integrity does not count as successful publication',async()=>{
  const store=memoryStore(1);store.refresh=async()=>({status:'blocked',reason:'unknown_session'});
  const result=await runPublicationRefresh({store,workerId:'fixture'});assert.equal(result.blocked,1);assert.equal(result.completed,0);assert.equal(result.published,0);
});
test('a changed base records an explicit retry for a later invocation without immediate retry',async()=>{
  const store=memoryStore(1);store.claim=async()=>{store.calls.push('claim');return [{id:'same-request',fencing_token:'1'}];};store.refresh=async()=>{throw new Error('active publication guard failed');};
  store.fail=async(_r,_w,error)=>{assert.equal(error.retryable,true);return {status:'pending'};};
  const result=await runPublicationRefresh({store,workerId:'fixture',maxRequests:8});assert.equal(result.failures[0].persistence,'retry_scheduled');assert.equal(result.published,0);
  assert.equal(store.calls.filter(value=>value==='claim').length,1);
});
test('interruption before commit remains retryable and never attempts activation',async()=>{
  const store=memoryStore(),controller=new AbortController();store.checkpoint=async()=>controller.abort();
  store.fail=async(_r,_w,error)=>{assert.equal(error.code,'worker_interrupted');assert.equal(error.retryable,true);return {status:'pending'};};
  const result=await runPublicationRefresh({store,workerId:'fixture',signal:controller.signal});
  assert.equal(result.published,0);assert.equal(result.stopped,'interrupted');assert.equal(store.calls.includes('refresh'),false);
});
test('preexisting interruption and expired claim deadlines take no work',async()=>{
  const store=memoryStore(),controller=new AbortController();controller.abort();
  await runPublicationRefresh({store,workerId:'fixture',signal:controller.signal});assert.deepEqual(store.calls,[]);
  let tick=0;const result=await runPublicationRefresh({store,workerId:'fixture',timeBudgetMs:1,now:()=>tick++});
  assert.equal(result.stopped,'time_budget');assert.deepEqual(store.calls,[]);
});
test('lost ownership during failure reporting is uncertain rather than a successful refresh',async()=>{
  const store=memoryStore(1);store.refresh=async()=>{throw new Error('stale fence');};store.fail=async()=>{throw new Error('stale failure');};
  const result=await runPublicationRefresh({store,workerId:'fixture',maxRequests:1});assert.equal(result.failures[0].persistence,'uncertain');assert.equal(result.completed,0);
});
test('refresh SQL adapter rejects precision loss in fencing before executing a query',()=>{
  const store=createRefreshStore(()=>{throw new Error('unexpected query');});
  assert.throws(()=>store.refresh({id:'request',fencing_token:Number('9007199254740993')},'worker','base'),/Unsafe/);
});
