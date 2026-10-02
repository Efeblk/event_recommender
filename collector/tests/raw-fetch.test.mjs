import test from 'node:test';
import assert from 'node:assert/strict';
import { retainProviderResponse } from '../raw/fetch.mjs';
const metadata = { url: 'https://www.bubilet.com.tr/test', fetchedAt: '2026-10-02T12:00:00Z' };
function capture() { const entries=[];return {entries,put:async(body,meta)=>{entries.push({body,meta});return {fetchId:'test',metadata:meta};}}; }
test('failed HTTP bodies are retained with their exact status before parsing',async()=>{
  const store=capture();
  const result=await retainProviderResponse(new Response('source failure',{status:503}),metadata,store,100);
  assert.equal(result.body,'source failure'); assert.equal(store.entries[0].meta.status,503);
  assert.equal(store.entries[0].meta.complete,true);
});
test('oversized and interrupted transfers retain bounded incomplete prefixes',async()=>{
  const store=capture();
  const oversized=await retainProviderResponse(new Response('123456'),metadata,store,3);
  assert.equal(oversized.bodyError.message,'response_too_large');
  assert.equal(store.entries[0].body.toString(),'123'); assert.equal(store.entries[0].meta.complete,false);
  let pulls=0;
  const stream=new ReadableStream({pull(controller){if(pulls++===0)controller.enqueue(Buffer.from('partial'));else controller.error(new Error('transfer interrupted'));}});
  const interrupted=await retainProviderResponse(new Response(stream),metadata,store,100);
  assert.equal(interrupted.bodyError.message,'transfer interrupted');
  assert.equal(store.entries[1].body.toString(),'partial'); assert.equal(store.entries[1].meta.complete,false);
});
test('storage admission failure prevents exposing a response to extraction',async()=>{
  await assert.rejects(retainProviderResponse(new Response('provider body'),metadata,{put:async()=>{throw new Error('admission');}},100),/admission/);
});
