import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { GraphClient } from './client.ts';
import { loadSnapshot } from './snapshot.ts';
import { graphSearch, type GraphSearchInput } from './search.ts';
import { emptyFilters, type EventRecord } from '../../lib/types.ts';
import { isEligible, cosine } from '../../lib/search.ts';
import { meetsRequirements } from '../../lib/requirements.ts';
import { hybridRank } from '../../lib/hybrid.ts';
import { shortlistEvents } from '../../lib/retrieval.ts';

const snapshot = await loadSnapshot(), graph = new GraphClient();
const vectorByHash = new Map(snapshot.vectors.entries.map(row => [row.hash, row.vector]));
const vectors = new Map(snapshot.events.flatMap(event => {
  const vector = vectorByHash.get(event.preparedSearch!.documentHash);
  return vector ? [[event.id, vector] as const] : [];
}));
const probe = snapshot.events.find(event => event.category === 'Workshop' && vectors.has(event.id)) ?? snapshot.events.find(event => vectors.has(event.id))!;
const queryVector = vectors.get(probe.id)!;
const cases: {id:string;input:GraphSearchInput}[] = [
  {id:'all-eligible',input:{filters:emptyFilters,query:'bir etkinlik',queryVector}},
  {id:'saturday-nonconcert-partner-budget',input:{filters:{...emptyFilters,dateFrom:'2026-10-03',dateTo:'2026-10-03',district:'Kadıköy',maxPrice:1000,maxPriceExclusive:true,partySize:2,excludedCategories:['Konser']},query:'sevgilimle workshop',queryVector,preferences:{mood:null,companion:'partner',interests:['workshop']}}},
  {id:'workshop-not-theatre-concert',input:{filters:{...emptyFilters,maxPrice:2000,excludedCategories:['Konser','Tiyatro']},query:'workshop',queryVector,preferences:{mood:null,companion:'partner',interests:['workshop'],order:'soonest'}}},
  {id:'total-budget-four-people',input:{filters:{...emptyFilters,maxPrice:800,totalBudget:3200,partySize:4},query:'gülelim',queryVector}},
  {id:'strict-evening-boundaries',input:{filters:{...emptyFilters,startTimeFrom:'20:00',startTimeFromExclusive:true,startTimeTo:'22:00',startTimeToExclusive:true,maxPrice:1000},query:'tiyatro',queryVector}},
  {id:'mandatory-accessibility',input:{filters:emptyFilters,query:'basamaksız',queryVector,requirements:[{kind:'accessibility',value:'step_free',policy:'require_support'}]}},
  {id:'lexical-without-query-vector',input:{filters:{...emptyFilters,category:'Workshop'},query:'seramik'}},
  {id:'empty-does-not-fill',input:{filters:{...emptyFilters,maxPrice:0,district:'Adalar',dateFrom:'2026-10-03',dateTo:'2026-10-03'},query:'etkinlik',queryVector}},
];
const ids = (events:EventRecord[]) => events.map(event=>event.id);
const reports=[];
for (const test of cases) {
  const baseline = () => {
    const start=performance.now();
    const eligible=snapshot.events.filter(event=>isEligible(event,test.input.filters,snapshot.at) && meetsRequirements(event,test.input.requirements??[]));
    const semantic=test.input.queryVector?{queryVector:test.input.queryVector,vectors}:undefined;
    const ranked=semantic?hybridRank(eligible,test.input.query,semantic):eligible;
    const shortlist=shortlistEvents(eligible,test.input.query,[],16,semantic,{version:1,filters:test.input.filters,requirements:test.input.requirements??[],preferences:test.input.preferences??{mood:null,companion:null,interests:[]}});
    return {eligible,ranked,shortlist,totalMs:performance.now()-start};
  };
  const base=baseline(), result=await graphSearch(graph,snapshot.eventMap,test.input);
  const baselineIds=new Set(ids(base.eligible)),graphIds=new Set(ids(result.eligible));
  const missing=ids(base.eligible).filter(id=>!graphIds.has(id)), extra=ids(result.eligible).filter(id=>!baselineIds.has(id));
  assert.deepEqual(missing,[],`${test.id}: graph missed eligible sessions`); assert.deepEqual(extra,[],`${test.id}: graph admitted extra sessions`);
  let maxCosineError=0;
  if(result.denseScores) for(const [id,score] of result.denseScores) maxCosineError=Math.max(maxCosineError,Math.abs(score-cosine(queryVector,vectors.get(id)!)));
  assert.ok(maxCosineError<0.00001,`${test.id}: vector function mismatch`);
  const graphSamples=[], baselineSamples=[];
  for(let repeat=0;repeat<3;repeat++){baselineSamples.push(baseline().totalMs);graphSamples.push((await graphSearch(graph,snapshot.eventMap,test.input)).timings.totalMs);}
  const overlap=ids(result.shortlist).filter(id=>ids(base.shortlist).includes(id)).length;
  reports.push({id:test.id,eligible:base.eligible.length,missing,extra,shortlistOverlap:overlap,baselineShortlist:ids(base.shortlist),graphShortlist:ids(result.shortlist),orderedShortlistEqual:JSON.stringify(ids(base.shortlist))===JSON.stringify(ids(result.shortlist)),maxCosineError,firstGraphTimings:result.timings,warmGraphMs:graphSamples,warmBaselineMs:baselineSamples});
}
const areaReports=[];
for(const neighborhood of ['Taksim','Moda','Karakoy','Balat']) {
  const result=await graphSearch(graph,snapshot.eventMap,{filters:emptyFilters,query:'etkinlik',neighborhood});
  const venueIds=new Set(snapshot.projection.venues.filter(row=>snapshot.projection.neighborhoods.some(n=>n.id===row.neighborhoodId&&n.name.toLowerCase()===neighborhood.toLowerCase())).map(row=>row.id));
  const expected=snapshot.projection.sessions.filter(row=>venueIds.has(row.venueId)).map(row=>row.id).sort();
  assert.deepEqual(ids(result.eligible).sort(),expected,`${neighborhood}: explicit graph path mismatch`);
  assert.ok(result.eligible.every(event=>new RegExp(neighborhood==='Karakoy'?'karak[oö]y':neighborhood,'iu').test(event.address+' '+event.venue)),`${neighborhood}: missing original source mention`);
  areaReports.push({neighborhood,eligible:result.eligible.length,sourceMentionVerified:true,examples:result.shortlist.slice(0,4).map(({id,title,venue,address,district})=>({id,title,venue,address,district}))});
}
// Global ANN is diagnostic only: show how a top-16 vector pool loses filtered sessions.
const ann=await graph.query("CALL db.index.vector.queryNodes('search_document_vector',16,$vector) YIELD node,score MATCH (s:Session)-[:HAS_SEARCH_DOCUMENT]->(node) RETURN s.id AS id,score",{vector:queryVector});
const restrictive=reports.find(row=>row.id==='saturday-nonconcert-partner-budget')!;
const globalAnnSurvivors=ann.filter(row=>restrictive.graphShortlist.includes(String(row.id))).length;
const familyIds=['10df015cc1c09e06897b1d3f','f3f9c063d615e0710f34e443','d8dc8c0c075cac62eac3187c','f8bd3e78fb53409451bdfa1e','ff8fd2456f8ca4a67fa5e036'];
const familyMatches=snapshot.events.filter(event=>event.offers?.some(offer=>familyIds.includes(offer.id)));
assert.equal(familyMatches.length,2,'Expected Tuğkan and Halil families remain exactly two prepared sessions');
assert.deepEqual(familyMatches.flatMap(event=>event.offers!.map(offer=>offer.id)).sort(),[...familyIds].sort());
const offerCount=(await graph.query('MATCH (:Session)-[:HAS_OFFER]->(o:Offer) RETURN count(*) AS count'))[0].count;
assert.equal(offerCount,snapshot.projection.summary.offers,'Provider offers must be preserved');
const report={at:new Date().toISOString(),...snapshot.provenance,summary:snapshot.projection.summary,probe:{id:probe.id,title:probe.title,documentHash:probe.preparedSearch!.documentHash,type:'cached-document-as-query; mechanics only, not human semantic relevance'},reports,areaReports,globalAnnDiagnostic:{topDocuments:16,survivorsInRestrictiveShortlist:globalAnnSurvivors,notUsedForSearch:true},familyMatches:familyMatches.map(event=>({id:event.id,title:event.title,startsAt:event.startsAt,venue:event.venue,offerIds:event.offers!.map(offer=>offer.id)})),providerCalls:0};
await writeFile(resolve(import.meta.dirname,'../../work/graph-20260929/benchmark.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
