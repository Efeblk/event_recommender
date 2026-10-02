import { canonical, hash, transaction } from '../db/index.mjs';
import { enqueue } from './store.mjs';
import { validateProviderListing } from '../../contracts/listing.ts';
import { IDENTITY_NORMALIZATION_VERSION } from '../normalize/identity.ts';
import { persistFetchLedger, requireUsableFetch, validateFetchLedger } from './fetch-receipts.mjs';

const instant = value => typeof value==='string' && Number.isFinite(Date.parse(value));
function validateCollection(input) {
  if(!input.id || !['complete','partial','unknown'].includes(input.scope) || !Array.isArray(input.inventory) || !Array.isArray(input.pages) || !Array.isArray(input.listings)) throw new Error('Invalid collection contract');
  if(input.pages.length>6000||input.listings.length>20000) throw new Error('Collection exceeds the bounded ingestion limit');
  if(input.scope==='complete' && (!instant(input.horizon?.start) || !instant(input.horizon?.end) || Date.parse(input.horizon.end)<=Date.parse(input.horizon.start))) throw new Error('Complete coverage requires a declared horizon');
  if(new Set(input.inventory).size!==input.inventory.length || new Set(input.pages.map(p=>p.url)).size!==input.pages.length) throw new Error('Duplicate inventory/page URL');
  const inventory=new Set(input.inventory);
  if(input.pages.some(p=>!inventory.has(p.url)) || input.pages.length!==inventory.size) throw new Error('Every declared inventory URL requires one page receipt');
  const byListing=new Map(input.listings.map(l=>[l.listingId,l]));
  if(byListing.size!==input.listings.length) throw new Error('Duplicate listing identity in collection');
  const referenced=new Set();
  for(const page of input.pages) {
    if(!['verified','retired','failed','quarantined','unvisited'].includes(page.status) || !instant(page.observedAt) || !Array.isArray(page.listingIds)) throw new Error('Invalid page receipt');
    if(page.status!=='verified' && page.listingIds.length) throw new Error('Only verified pages can supply listings');
    if(['verified','retired'].includes(page.status) && !page.rawObjectSha256) throw new Error('Successful page requires raw provenance');
    for(const id of page.listingIds) {
      const listing=byListing.get(id);
      if(!listing || listing.provider!==page.provider || listing.url!==page.url || listing.observedAt!==page.observedAt) throw new Error('Page and listing provenance disagree');
      if(listing.rawObjectRef.sha256!==page.rawObjectSha256 && !listing.supplementaryRawObjectRefs?.some(ref=>ref.sha256===page.rawObjectSha256)) throw new Error('Page raw response is absent from listing provenance');
      if(referenced.has(id)) throw new Error('Listing appears on multiple page receipts');
      referenced.add(id);
    }
  }
  if(referenced.size!==byListing.size) throw new Error('Listing has no successful page receipt');
  for(const listing of input.listings) {
    validateProviderListing(listing);
    if(listing.contractVersion!=='provider-listing.v1' || !listing.listingId || !instant(listing.observedAt) || !instant(listing.startsAt) || !listing.rawObjectRef || !Array.isArray(listing.tiers)) throw new Error('Invalid provider listing');
    if(listing.tiers.some(t=>t.price!==null && (!Number.isFinite(t.price)||t.price<0))) throw new Error('Invalid ticket tier');
  }
}

/** verifyRaw(ref) must read the exact stored object and return its bytes; hashes are checked here. */
export async function ingestCollection(pool,input,{readRaw}={}) {
  validateCollection(input);
  const fetches=validateFetchLedger(input.fetches);
  if(typeof readRaw!=='function') throw new Error('Raw object verification is required before ingestion');
  const refs=new Map();
  for(const ref of input.rawObjects??[]) refs.set(ref.sha256,ref);
  for(const fetch of fetches??[]) refs.set(fetch.rawObjectRef.sha256,fetch.rawObjectRef);
  for(const listing of input.listings) for(const ref of [listing.rawObjectRef,...listing.supplementaryRawObjectRefs??[]]) {
    const previous=refs.get(ref.sha256);
    if(previous && (previous.key!==ref.key || previous.bytes!==ref.bytes)) throw new Error('Conflicting raw object references');
    refs.set(ref.sha256,ref);
  }
  for(const page of input.pages) if(page.rawObjectSha256 && !refs.has(page.rawObjectSha256)) throw new Error('Page raw object reference is missing');
  for(const page of input.pages) if(['verified','retired'].includes(page.status)) requireUsableFetch(fetches,{url:page.responseUrl??page.url,observedAt:page.observedAt,sha256:page.rawObjectSha256});
  for(const listing of input.listings) for(const observation of listing.supplementaryRawObservations??[])
    requireUsableFetch(fetches,{url:observation.url,observedAt:observation.fetchedAt,sha256:observation.rawObjectRef.sha256});
  for(const ref of refs.values()) {
    const bytes=await readRaw(ref);
    if(!(bytes instanceof Uint8Array) || bytes.byteLength!==ref.bytes || hash(Buffer.from(bytes))!==ref.sha256) throw new Error('Raw object verification failed');
  }
  const stable={...input,rawObjects:[...refs.values()].sort((a,b)=>a.sha256.localeCompare(b.sha256)),listings:[...input.listings].sort((a,b)=>a.listingId.localeCompare(b.listingId)),pages:[...input.pages].sort((a,b)=>a.url.localeCompare(b.url)),inventory:[...input.inventory].sort()};
  const inputHash=hash(stable);
  return transaction(pool,async client=>{
    const existing=await client.query('SELECT input_hash FROM biplan_pipeline.collections WHERE id=$1',[input.id]);
    if(existing.rows.length) {
      if(existing.rows[0].input_hash!==inputHash) throw new Error('Collection ID is immutable');
      return {collectionId:input.id,replayed:true,listings:input.listings.length};
    }
    for(const ref of refs.values()) {
      await client.query(`INSERT INTO biplan_pipeline.raw_objects VALUES($1,$2,$3,clock_timestamp()) ON CONFLICT DO NOTHING`,[ref.sha256,ref.key,ref.bytes]);
      const row=(await client.query('SELECT object_key,bytes FROM biplan_pipeline.raw_objects WHERE sha256=$1',[ref.sha256])).rows[0];
      if(row.object_key!==ref.key || Number(row.bytes)!==ref.bytes) throw new Error('Stored raw reference conflicts');
    }
    await persistFetchLedger(client,fetches);
    await client.query(`INSERT INTO biplan_pipeline.collections(id,input_hash,scope,horizon_start,horizon_end,inventory)
      VALUES($1,$2,$3,$4,$5,$6)`,[input.id,inputHash,input.scope,input.horizon?.start??null,input.horizon?.end??null,JSON.stringify(stable.inventory)]);
    for(const page of input.pages) {
      const negativeZero=page.status==='verified'&&page.listingIds.length===0;
      const linked=negativeZero||page.status!=='verified'?(await client.query(`SELECT h.listing_id FROM biplan_pipeline.listing_heads h JOIN biplan_pipeline.listings l ON l.revision_id=h.revision_id
        WHERE l.url=$1 AND l.observed_at<=$2::timestamptz FOR UPDATE OF h`,[page.url,page.observedAt])).rows:[];
      await client.query('INSERT INTO biplan_pipeline.page_receipts(collection_id,url,provider,status,observed_at,raw_sha256,listing_ids,reconciliation_required) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[input.id,page.url,page.provider,page.status,page.observedAt,page.rawObjectSha256??null,JSON.stringify(page.listingIds),linked.length>0]);
      if(page.rawObjectSha256) await client.query(`INSERT INTO biplan_pipeline.fetches(id,provider,url,status,fetched_at,collector_revision,raw_sha256,headers,method,complete)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,NULL WHERE NOT EXISTS(SELECT 1 FROM biplan_pipeline.fetches WHERE url=$3 AND fetched_at=$5::timestamptz AND raw_sha256=$7)
        ON CONFLICT DO NOTHING`,[hash({url:page.responseUrl??page.url,at:page.observedAt,raw:page.rawObjectSha256}),page.provider,page.responseUrl??page.url,page.httpStatus??null,page.observedAt,input.collectorRevision??'unknown',page.rawObjectSha256,page.headers??{},page.method??'GET']);
      if(page.status!=='verified'||negativeZero) await client.query(`UPDATE biplan_pipeline.listing_heads h SET withheld=true,reason=$2 FROM biplan_pipeline.listings l
        WHERE l.revision_id=h.revision_id AND l.url=$1 AND l.observed_at<=$3::timestamptz`,[page.url,negativeZero?'negative_zero_page':page.status,page.observedAt]);
    }
    for(const listing of input.listings) {
      const dependencyHash=hash(listing),revisionId=`listing-${dependencyHash}`;
      await client.query(`INSERT INTO biplan_pipeline.listings(revision_id,listing_id,input_hash,provider,provider_event_id,provider_session_ids,url,title,description,category,starts_at,observed_at,availability,raw_sha256,extractor_version,body)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT DO NOTHING`,[revisionId,listing.listingId,dependencyHash,listing.provider,listing.providerEventId??null,listing.providerSessionIds,listing.url,listing.title,listing.description,listing.category,listing.startsAt,listing.observedAt,listing.availability,listing.rawObjectRef.sha256,listing.extractorVersion,listing]);
      const head=await client.query(`SELECT l.observed_at,h.revision_id FROM biplan_pipeline.listing_heads h JOIN biplan_pipeline.listings l ON l.revision_id=h.revision_id WHERE h.listing_id=$1 FOR UPDATE OF h`,[listing.listingId]);
      if(head.rows.length && new Date(head.rows[0].observed_at).getTime()>Date.parse(listing.observedAt)) throw new Error('Collection attempts to replace a newer listing observation');
      if(head.rows.length && new Date(head.rows[0].observed_at).getTime()===Date.parse(listing.observedAt) && head.rows[0].revision_id!==revisionId) throw new Error('Conflicting same-clock listing observations require reconciliation');
      await client.query(`INSERT INTO biplan_pipeline.listing_heads(listing_id,revision_id) VALUES($1,$2)
        ON CONFLICT(listing_id) DO UPDATE SET revision_id=excluded.revision_id,withheld=false,reason=NULL`,[listing.listingId,revisionId]);
      await client.query('INSERT INTO biplan_pipeline.collection_listings VALUES($1,$2,$3)',[input.id,listing.listingId,revisionId]);
      await enqueue(client,input.id,{stage:'normalize',subject:listing.listingId,inputHash:dependencyHash,input:{revisionId},version:IDENTITY_NORMALIZATION_VERSION});
    }
    return {collectionId:input.id,replayed:false,listings:input.listings.length};
  });
}
