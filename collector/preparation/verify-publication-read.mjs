import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPublicationStore } from './publication-store.mjs';
import { stableJson } from './source-adapter.mjs';
import { work } from './db.mjs';
import { emptyFilters } from '../../web/lib/types.ts';
import { searchCatalogCandidates } from '../../web/lib/materialized-catalog.ts';
import { searchPreparedPublication } from '../../web/lib/prepared-publication-search.ts';

const started=performance.now(), store=createPublicationStore(), publication=await store.readPublication();
const path=resolve(work,'../event-preparation-20260929/search-after.json');
const raw=await readFile(path), frozen=JSON.parse(raw), reference=new Date('2026-09-29T11:47:23.732Z');
const expected=searchCatalogCandidates(frozen,emptyFilters,reference);
const sessions=new Map(publication.sessions.map(s=>[s.sessionId,s]));
assert.equal(sessions.size,expected.length);
for(const event of expected) {
  const session=sessions.get(event.id);assert.ok(session,`Missing ${event.id}`);
  assert.equal(stableJson(session.snapshot),stableJson(event),`Snapshot changed ${event.id}`);
  assert.equal(session.document.text,event.preparedSearch.documentText);
  assert.equal(session.document.hash,createHash('sha256').update(session.document.text).digest('hex'));
  assert.deepEqual(session.pinnedOfferTerms.map(t=>t.offerId).sort(),event.offers.map(o=>o.id).sort());
}
assert.equal(sessions.get('session-091d6eea5c442ab11dc9e6d5dc476f6b').pinnedOfferTerms.length,2);
assert.equal(sessions.get('session-c6a53fe8ff27d45f5ef2cdbdaf2ee787').pinnedOfferTerms.length,3);
const readMs=performance.now()-started, runs=[],at=new Date();
const pinned={...store,readPublication:async(id)=>{assert.ok(id===undefined||id===publication.publicationId);return publication;}};
for(const [query,filters] of [['seramik atölyesi',{...emptyFilters,category:'Workshop'}],
  ['konser dışı stand up',{...emptyFilters,excludedCategories:['Konser']}],
  ['iki kişi 1000 TL',{...emptyFilters,maxPrice:500,totalBudget:1000,partySize:2}]]) {
  const result=await searchPreparedPublication(pinned,{query,filters,mode:'lexical',now:at});
  assert.equal(result.considered,expected.length);assert.ok(result.events.length<=16);
  if(!filters.totalBudget) { assert.ok(result.events.length>0,'Expected source-backed cards from the actual eligible frozen catalog'); assert.equal(result.revalidationWithheld,false); }
  for(const event of result.events) {
    const session=sessions.get(event.id);assert.ok(session);
    assert.equal(event.title,session.snapshot.title);assert.equal(event.startsAt,session.snapshot.startsAt);
    assert.ok(!filters.excludedCategories?.includes(event.category));
    assert.ok(session.pinnedOfferTerms.some(t=>t.sourceUrl===event.url));
  }
  if(filters.totalBudget) assert.equal(result.events.length,0,'Frozen aggregate minima/unknown fees cannot prove checkout budget');
  runs.push({query,filters,...result});
}
const receipt={at:at.toISOString(),runtime:process.version,
  baseRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),dirtyWorkingTree:true,
  passed:true,publicationId:publication.publicationId,
  frozenSource:{path,sha256:createHash('sha256').update(raw).digest('hex'),referenceTime:reference.toISOString()},
  auditedSessions:expected.length,auditedOffers:publication.sessions.reduce((n,s)=>n+s.pinnedOfferTerms.length,0),
  everySnapshotDocumentAndOfferPinChecked:true,expectedMergedFamiliesChecked:true,readMs,runs,aiCalls:0,cloudChanges:false,
  limitation:'Frozen September 29 inventory, current-time lexical shortlists only. No Jev judgment; timings include local Docker/psql and are not production measurements.'};
for(const f of ['collector/preparation/publication-store.mjs','collector/preparation/verify-publication-read.mjs','web/lib/prepared-publication-search.ts'])
  (receipt.sourceHashes??={})[f]=createHash('sha256').update(await readFile(resolve(import.meta.dirname,'../..',f))).digest('hex');
const output=resolve(work,`publication-read-verification-${Date.now()}.json`);
await writeFile(output,JSON.stringify(receipt,null,2));
console.log(JSON.stringify({passed:true,sessions:receipt.auditedSessions,offers:receipt.auditedOffers,readMs:Math.round(readMs),
  runs:runs.map(r=>({query:r.query,eligible:r.eligible,returned:r.events.length,withheld:r.excludedAtRevalidation.length,ms:Math.round(r.elapsedMs)})),receipt:output}));
