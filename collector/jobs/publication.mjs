import { hash, transaction } from '../db/index.mjs';
import { createJobStore } from './store.mjs';
import { randomUUID } from 'node:crypto';
import { categoryForEvent } from '../../contracts/category.ts';
import { canonical } from '../db/index.mjs';

function validateCatalog(catalog) {
  if(catalog.sessions.length!==catalog.manifest.sessionCount || catalog.sessions.reduce((n,s)=>n+s.offers.length,0)!==catalog.manifest.offerCount) throw new Error('Publication manifest counts disagree');
  if(hash({manifest:catalog.manifest,sessions:catalog.sessions})!==catalog.contentHash) throw new Error('Publication content hash failed');
  if(catalog.publicationId!==`publication-${catalog.contentHash}`) throw new Error('Publication identity failed');
}
export async function readPublication(client,id) {
  const rows=await client.query('SELECT * FROM biplan_pipeline.publications WHERE id=$1',[id]);
  if(!rows.rows.length) throw new Error('Unknown publication');
  const publication=rows.rows[0];
  const sessions=await client.query('SELECT body FROM biplan_pipeline.publication_sessions WHERE publication_id=$1 ORDER BY session_id COLLATE "C"',[id]);
  const catalog={publicationId:id,contentHash:publication.content_hash,manifest:publication.manifest,sessions:sessions.rows.map(row=>row.body)};
  validateCatalog(catalog);
  return catalog;
}
export async function publishCollection(pool,collectionId,{expectedPreviousId,processDeadlineAt=Date.now()+120000,leaseMs=120000,statementTimeoutMs=60000,signal}={}) {
  if(expectedPreviousId===undefined) throw new Error('Publication requires an explicit previous pointer (null for first publication)');
  if(!Number.isSafeInteger(statementTimeoutMs)||statementTimeoutMs<1000||statementTimeoutMs>60000||!Number.isSafeInteger(leaseMs)||leaseMs>300000||!Number.isFinite(processDeadlineAt)) throw new Error('Invalid publication budget');
  const requiredMs=statementTimeoutMs+35000;
  const admit=()=>{if(signal?.aborted) throw Object.assign(new Error('Publication interrupted'),{code:'job_interrupted'});if(leaseMs<requiredMs||processDeadlineAt-Date.now()<requiredMs) throw Object.assign(new Error('Insufficient publication process or lease budget'),{code:'publication_budget'});};
  admit();
  const existing=(await pool.query('SELECT state,publication_id,input_hash FROM biplan_pipeline.collections WHERE id=$1',[collectionId])).rows[0];
  if(!existing) throw new Error('Unknown collection');
  if(existing.state==='published') return {publicationId:existing.publication_id,replayed:true};
  const jobs=createJobStore(pool);
  await jobs.enqueue(collectionId,{stage:'publish',subject:collectionId,inputHash:existing.input_hash,version:'1',input:{collectionId}});
  admit();
  const job=await jobs.claim({collectionId,stage:'publish',owner:`publisher-${randomUUID()}`,leaseMs});
  if(!job) throw new Error('Publication is already leased or failed');
  let result;
  try { await jobs.complete(job,{collectionId},{signal,write:async client=>{
    // SET LOCAL resets at commit/rollback, including failure paths. Driver timeout
    // must exceed this server timeout; abort signals alone do not cancel SQL.
    admit();
    await client.query("SELECT set_config('statement_timeout',$1,true)",[String(statementTimeoutMs)]);
    const collection=(await client.query('SELECT * FROM biplan_pipeline.collections WHERE id=$1 FOR UPDATE',[collectionId])).rows[0];
    if(!collection) throw new Error('Unknown collection');
    // An idempotent replay must not undo a later administrative rollback.
    if(collection.state==='published') { result={publicationId:collection.publication_id,replayed:true};return; }
    if(collection.state!=='prepared') throw new Error('Collection is not prepared');
    const pages=(await client.query('SELECT * FROM biplan_pipeline.page_receipts WHERE collection_id=$1 ORDER BY url COLLATE "C"',[collectionId])).rows;
    if(pages.length!==collection.inventory.length || pages.some(page=>!['verified','retired'].includes(page.status)||!page.raw_sha256||page.reconciliation_required)) throw new Error('Unresolved page integrity failure or reconciliation requirement blocks publication');
    const pending=await client.query(`SELECT 1 FROM biplan_pipeline.jobs j JOIN biplan_pipeline.collection_jobs c ON c.job_id=j.id WHERE c.collection_id=$1 AND j.stage<>'publish' AND j.state<>'completed' LIMIT 1`,[collectionId]);
    if(pending.rows.length) throw new Error('Incomplete mandatory jobs block publication');
    const current=await client.query(`SELECT h.listing_id,h.revision_id,h.withheld,c.revision_id expected FROM biplan_pipeline.collection_listings c
      JOIN biplan_pipeline.listing_heads h ON h.listing_id=c.listing_id WHERE c.collection_id=$1 FOR SHARE OF h`,[collectionId]);
    if(current.rows.some(r=>r.withheld||r.revision_id!==r.expected)) throw new Error('Publication input is stale or withheld');
    const rows=(await client.query(`SELECT s.*,d.id document_id,d.document_hash,d.document_text,d.lexical_tokens,d.prepared_location,d.embedding_profile,d.embedding::text vector
      FROM biplan_pipeline.collection_sessions c JOIN biplan_pipeline.sessions s ON s.revision_id=c.revision_id
      JOIN biplan_pipeline.search_documents d ON d.id=c.search_document_id AND d.session_revision_id=s.revision_id WHERE c.collection_id=$1 ORDER BY s.id COLLATE "C"`,[collectionId])).rows;
    const expectedSessions=await client.query('SELECT count(*)::int count FROM biplan_pipeline.collection_sessions WHERE collection_id=$1',[collectionId]);
    if(rows.length!==expectedSessions.rows[0].count) throw new Error('Session search document coverage is incomplete');
    const sessions=[];
    const includedListings=new Set();
    for(const row of rows) {
      const listings=(await client.query(`SELECT l.body,l.revision_id,o.id offer_id,o.revision_id offer_revision FROM biplan_pipeline.session_listings sl
        JOIN biplan_pipeline.listings l ON l.revision_id=sl.listing_revision_id JOIN biplan_pipeline.offers o ON o.listing_revision_id=l.revision_id
        WHERE sl.session_revision_id=$1 ORDER BY l.listing_id COLLATE "C"`,[row.revision_id])).rows;
      if(!listings.length || new Set(listings.map(l=>l.body.provider)).size!==listings.length) throw new Error('Invalid publication provider membership');
      for(const listing of listings) {
        if(includedListings.has(listing.body.listingId)) throw new Error('Listing occurs in multiple published sessions');
        includedListings.add(listing.body.listingId);
        if(!current.rows.some(r=>r.listing_id===listing.body.listingId&&r.expected===listing.revision_id)) throw new Error('Session references a listing outside this collection');
      }
      const first=listings[0].body;
      const explicitAttendance=listings.map(l=>l.body.attendanceTiming).filter(value=>value!==undefined&&value!==null);
      const attendanceTiming=explicitAttendance.length?(explicitAttendance.every(value=>canonical(value)===canonical(explicitAttendance[0]))?explicitAttendance[0]:{kind:'unknown',evidence:'insufficient_source_evidence'}):undefined;
      sessions.push({id:row.id,revisionId:row.revision_id,productionId:row.production_id,venueId:row.venue_id,
        title:first.title,description:first.description,category:categoryForEvent(first.category,first.title,first.description),startsAt:new Date(row.starts_at).toISOString(),city:row.city==='istanbul'?'İstanbul':first.city??row.city,
        venue:first.venue,...(attendanceTiming===undefined?{}:{attendanceTiming}),...(first.imageUrl?{imageUrl:first.imageUrl}:{}),
        offers:listings.map(l=>({id:l.offer_id,revisionId:l.offer_revision,listingId:l.body.listingId,listingRevisionId:l.revision_id,provider:l.body.provider,url:l.body.url,observedAt:l.body.observedAt,availability:l.body.availability,
          tiers:l.body.tiers.map(t=>({...t,feeMinor:null,priceKind:'starting'}))})),
        document:{id:row.document_id,hash:row.document_hash,text:row.document_text,lexicalTokens:row.lexical_tokens,location:row.prepared_location,embeddingProfile:row.embedding_profile,vector:row.vector?JSON.parse(row.vector):null}});
    }
    if(includedListings.size!==current.rows.length) throw new Error('Publication omitted a collected listing');
    const manifest={contractVersion:'published-catalog.v1',scope:collection.scope,
      horizon:collection.horizon_start?{start:new Date(collection.horizon_start).toISOString(),end:new Date(collection.horizon_end).toISOString()}:null,
      inventoryHash:hash([...collection.inventory].sort()),pageCount:pages.length,sessionCount:sessions.length,offerCount:sessions.reduce((n,s)=>n+s.offers.length,0),lexicalOnlyCount:sessions.filter(s=>!s.document.vector).length,
      pages:pages.map(p=>({url:p.url,provider:p.provider,status:p.status,observedAt:new Date(p.observed_at).toISOString(),rawObjectSha256:p.raw_sha256})),
      sessionPins:sessions.map(s=>({id:s.id,revisionId:s.revisionId,documentId:s.document.id,offerRevisionIds:s.offers.map(o=>o.revisionId)}))};
    const contentHash=hash({manifest,sessions}),publicationId=`publication-${contentHash}`;
    await client.query('INSERT INTO biplan_pipeline.publications(id,manifest,content_hash,session_count,offer_count) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[publicationId,manifest,contentHash,sessions.length,manifest.offerCount]);
    for(const session of sessions) {
      await client.query('INSERT INTO biplan_pipeline.publication_sessions VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[publicationId,session.id,session.revisionId,session.document.id,session]);
      for(const offer of session.offers) await client.query('INSERT INTO biplan_pipeline.publication_offers VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[publicationId,session.id,offer.id,offer.revisionId]);
    }
    if(processDeadlineAt-Date.now()<35000) throw Object.assign(new Error('Publication exhausted its reserved close/failure time'),{code:'publication_budget'});
    await client.query("SELECT set_config('statement_timeout','5000',true)");
    const pointer=await client.query(`UPDATE biplan_pipeline.active_publication SET publication_id=$1 WHERE singleton AND publication_id IS NOT DISTINCT FROM $2::text RETURNING publication_id`,[publicationId,expectedPreviousId]);
    if(!pointer.rows.length) throw Object.assign(new Error('Active publication changed'),{code:'pointer_conflict'});
    await client.query("UPDATE biplan_pipeline.collections SET state='published',publication_id=$2 WHERE id=$1",[collectionId,publicationId]);
    result={publicationId,replayed:false,manifest};
  }});return result; }
  catch(error) { await jobs.fail(job,error,{retry:true}).catch(()=>{});throw error; }
}
export async function rollbackPublication(pool,{publicationId,expectedPreviousId}) {
  if(!publicationId || expectedPreviousId===undefined) throw new Error('Rollback requires explicit target and previous pointer');
  return transaction(pool,async client=>{
    await readPublication(client,publicationId);
    const result=await client.query(`UPDATE biplan_pipeline.active_publication SET publication_id=$1 WHERE singleton AND publication_id IS NOT DISTINCT FROM $2::text RETURNING publication_id`,[publicationId,expectedPreviousId]);
    if(!result.rows.length) throw Object.assign(new Error('Active publication changed'),{code:'pointer_conflict'});
    return {publicationId};
  });
}
