import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createCatalogReader, type CatalogQuery } from '../lib/catalog-reader.ts';

await test('catalog reader rejects absent/unsupported publication and bounds final validation',async()=>{
  const empty=createCatalogReader(async()=>({rows:[]}));
  await assert.rejects(empty.pin(),/No active/);
  await assert.rejects(empty.read('missing'),/Unknown/);
  await assert.rejects(empty.revalidate('pub',Array.from({length:17},(_,i)=>({sessionId:String(i),offerId:'o',offerRevisionId:'r'})),new Date().toISOString()),/Invalid/);
});

await test('final source check rejects changed heads, unknown availability and an unpinned selected offer',async()=>{
  const query:CatalogQuery=async()=>({rows:[{sessionId:'s',offerId:'o',offerRevisionId:'r',pinned_revision:'r',listing_revision:'l1',current_revision:'l2',withheld:false,canonical_current:true,availability:'unknown',tier_available:false,observed_at:'2026-10-02T10:00:00Z',starts_at:'2027-01-01T00:00:00Z'}]});
  const reader=createCatalogReader(query);
  const [result]=await reader.revalidate('pub',[{sessionId:'s',offerId:'o',offerRevisionId:'wrong'}],'2026-10-02T11:00:00Z');
  assert.equal(result.usable,false);
  assert.deepEqual(result.reasons,['offer_not_pinned','source_revision_changed','unavailable']);
});

await test('reader pins once and rejects manifest/content tampering',async()=>{
  const manifest={contractVersion:'published-catalog.v1',scope:'unknown',horizon:null,inventoryHash:'x',pageCount:0,sessionCount:0,offerCount:0,lexicalOnlyCount:0,pages:[],sessionPins:[]};
  const sort=(value:unknown):unknown=>Array.isArray(value)?value.map(sort):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,sort((value as Record<string,unknown>)[k])])):value;
  const contentHash=createHash('sha256').update(JSON.stringify(sort({manifest,sessions:[]}))).digest('hex');
  const id=`publication-${contentHash}`,calls:Array<{sql:string;values?:unknown[]}>=[];
  const query:CatalogQuery=async(sql,values)=>{
    calls.push({sql,values});
    if(sql.includes('active_publication')) return {rows:[{publication_id:id}]};
    if(sql.includes('publication_sessions')) return {rows:[]};
    return {rows:[{id,manifest,content_hash:contentHash,session_count:0,offer_count:0}]};
  };
  const reader=createCatalogReader(query),pin=await reader.pin();
  assert.equal((await reader.read(pin)).publicationId,id);
  assert.equal(calls.filter(c=>c.sql.includes('active_publication')).length,1);
  assert.ok(calls.slice(1).every(c=>c.values?.[0]===id));
  manifest.scope='complete';
  await assert.rejects(reader.read(pin),/content verification/);
});
