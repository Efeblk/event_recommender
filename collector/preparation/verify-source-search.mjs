import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertOwned, docker, sql, literal, container, work } from './db.mjs';
import { createPublicationStore } from './publication-store.mjs';
import { createWorkerStore } from './worker-store.mjs';
import { createRefreshStore, runPublicationRefresh } from './refresh-consumer.mjs';
import { createSourceStore } from './source-store.mjs';
import { replaySourceRecords } from './run-source.mjs';
import { runPreparationWorker } from './worker.mjs';
import { searchPreparedPublication } from '../../web/lib/prepared-publication-search.ts';
import { emptyFilters } from '../../web/lib/types.ts';

// Fixtures never enter the
// real frozen database, and failed evidence is retained rather than overwritten.
export async function verifySourceSearch(exercise) {
  const database = `biplan_source_search_verify_${randomBytes(6).toString('hex')}`;
  assert.match(database, /^biplan_source_search_verify_[0-9a-f]{12}$/);
  const paths = [
    'collector/preparation/schema.sql', 'collector/preparation/migrations/002-offer-revisions.sql',
    'collector/preparation/migrations/003-workers.sql', 'collector/preparation/migrations/004-publication-refresh.sql',
    'collector/preparation/source-adapter.mjs', 'collector/preparation/source-store.mjs',
    'collector/preparation/publication-store.mjs', 'collector/preparation/verify-source-search.mjs',
    'collector/preparation/worker.mjs', 'collector/preparation/worker-store.mjs',
    'collector/preparation/refresh-consumer.mjs', 'web/lib/prepared-publication-search.ts',
  ];
  const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async path =>
    [path, createHash('sha256').update(await readFile(resolve(import.meta.dirname, '../..', path))).digest('hex')])));
  const sourceHashes = await hashes(), checks = [], timings = [];
  let created = false, problem;
  const query = async statement => {
    await assertOwned();
    return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database],
      `SET statement_timeout='30s';\n${statement}`);
  };
  const json = value => `${literal(JSON.stringify(value))}::jsonb`;
  const verify = async (name, fn) => {
    const start = performance.now(); await fn(); checks.push(name);
    timings.push({ name, ms: Math.round(performance.now() - start) }); console.log(`PASS ${name}`);
  };
  const now = new Date(), observedAt = new Date(now.getTime() - 3600000).toISOString();
  const startsAt = new Date(now.getTime() + 172800000).toISOString();
  const event = (id, title, price) => ({ id, title, description: `${title} birlikte etkinlik`, startsAt,
    venue: 'Fixture venue', city: 'İstanbul', district: 'Beyoğlu', address: 'Fixture address', price,
    currency: 'TRY', url: `https://www.bubilet.com.tr/istanbul/etkinlik/${id}`, imageUrl: '', category: 'Workshop',
    availability: 'available', source: 'bubilet', sourceSessionIds: [id], checkedAt: observedAt });
  const one = event('offer-one', 'Seramik Atölyesi', 200), two = event('offer-two', 'Resim Atölyesi', 300);
  one.attendanceTiming = null; // JSON null snapshot with SQL NULL canonical metadata.
  const events = [one, two];
  try {
    await assertOwned(); await sql(`CREATE DATABASE ${database};`); created = true;
    await query(await readFile(resolve(import.meta.dirname, 'schema.sql'), 'utf8'));
    for (const e of events) {
      await query(`INSERT INTO biplan.productions(id,title,content_hash) VALUES(${literal(`production-${e.id}`)},${literal(e.title)},${literal(e.id)});
        INSERT INTO biplan.venues(id,name,district,address_text,content_hash) VALUES(${literal(`venue-${e.id}`)},'Fixture venue','Beyoğlu','Fixture address',${literal(e.id)});
        INSERT INTO biplan.sessions(id,production_id,venue_id,starts_at,status,content_hash,attendance_timing)
          VALUES(${literal(e.id)},${literal(`production-${e.id}`)},${literal(`venue-${e.id}`)},${literal(startsAt)},'scheduled',${literal(e.id)},${e===one?'NULL':"'null'::jsonb"});
        INSERT INTO biplan.provider_offers(id,session_id,provider,provider_record_id,source_url,currency,price,price_minor,price_kind,availability,observed_at,content_hash,source_payload)
          VALUES(${literal(e.id)},${literal(e.id)},'bubilet',${literal(e.id)},${literal(e.url)},'TRY',${e.price},${e.price * 100},'starting_at','available',${literal(observedAt)},${literal(e.id)},${json(e)});
        INSERT INTO biplan.search_documents(id,subject_type,subject_id,document_profile,document_text,document_hash,dependency_hash)
          VALUES(${literal(`document-${e.id}`)},'session',${literal(e.id)},'event-title-category-venue-description-v1',${literal(e.title)},${literal(createHash('sha256').update(e.title).digest('hex'))},${literal(e.id)});`);
    }
    for (const p of paths.slice(1,4)) await query(await readFile(resolve(import.meta.dirname,'../..',p),'utf8'));
    await query(`BEGIN;
      INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count)
        VALUES('source-search-base','{"version":3,"requiredOfferCount":2,"requiredEvaluationCount":0}','source-search-base',2,2);` +
      events.map(e => `INSERT INTO biplan.published_sessions(publication_id,session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot)
        VALUES('source-search-base',${literal(e.id)},${literal(`production-${e.id}`)},${literal(`venue-${e.id}`)},${literal(`document-${e.id}`)},${literal(e.id)},${json({ ...e, offers:[e] })});
        INSERT INTO biplan.publication_offers VALUES('source-search-base',${literal(e.id)},${literal(e.id)});`).join('\n') +
      `UPDATE biplan.publications SET state='validated',validated_at=clock_timestamp(),validation_hash='fixture' WHERE id='source-search-base';
       SELECT biplan.activate_publication('source-search-base',NULL); COMMIT;`);
    await exercise({ query, json, verify, events, now,
      publications: createPublicationStore(query), workers: createWorkerStore(query),
      refreshStore: createRefreshStore(query), runPublicationRefresh });
    assert.deepEqual(await hashes(), sourceHashes, 'Sources changed during verification');
  } catch (error) { problem = error; }
  finally {
    if (created) { try { await assertOwned(); await sql(`DROP DATABASE ${database} WITH (FORCE);`); created=false; } catch(error) { problem ??= error; } }
    const receipt = { at:new Date().toISOString(), runtime:process.version,
      baseRevision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(), dirtyWorkingTree:true,
      sourceHashes, sourcesUnchanged:JSON.stringify(await hashes())===JSON.stringify(sourceHashes), passed:!problem,
      checks, timings, temporaryDatabaseRemoved:!created, aiCalls:0, cloudChanges:false,
      error:problem?.message };
    await writeFile(resolve(work,`source-search-verification-${Date.now()}.json`),JSON.stringify(receipt,null,2));
    await writeFile(resolve(work,'source-search-verification.json'),JSON.stringify(receipt,null,2));
  }
  if (problem) throw problem;
}

await verifySourceSearch(async ({ query,verify,events,now,publications,workers,refreshStore }) => {
  const source = createSourceStore(query);
  const search = (repository=publications, options={}) => searchPreparedPublication(repository,
    { query:'atölye',filters:emptyFilters,mode:'lexical',now,...options });
  const count = table => query(`SELECT count(*) FROM biplan.${table};`).then(Number);
  const observed = offset => new Date(now.getTime()+offset*60000).toISOString();
  let receipt, firstPublication;
  await verify('legacy publication uses exact pins, preserves lexical-only coverage and refuses unknown checkout budgets', async () => {
    const result=await search(); assert.equal(result.publicationId,'source-search-base'); assert.equal(result.considered,2);
    assert.equal(result.events.length,2); assert.ok(result.events.every(e=>e.price===null));
    const budget=await search(publications,{filters:{...emptyFilters,maxPrice:500,partySize:2,totalBudget:1000}});
    assert.equal(budget.events.length,0);
  });
  await verify('normalized source acceptance preserves clocks/raw evidence and replays without duplicate outbox work', async () => {
    const record={...events[0],price:600,checkedAt:observed(-30)};
    const result=await replaySourceRecords([record],{store:source});receipt=result.receipt;
    assert.equal(result.decisions[0].status,'accepted');assert.equal(await count('outbox'),1);
    const raw=JSON.parse(await query(`SELECT to_jsonb(r) FROM biplan.offer_revisions r JOIN biplan.offer_identities i ON i.current_revision_id=r.id WHERE i.id='offer-one';`));
    assert.deepEqual(raw.source_payload,record);assert.equal(raw.source_updated_at,null);assert.equal(raw.fee_minor,null);assert.equal(raw.price_kind,'starting_at');
    await replaySourceRecords([record],{store:source,receipt});assert.equal(await count('outbox'),1);
    // Lost local checkpoint simulates a crash after DB commit, not another observation.
    const lost=await replaySourceRecords([record],{store:source});assert.equal(lost.decisions[0].idempotent,true);assert.equal(await count('outbox'),1);
    const old=await search(publications,{publicationId:'source-search-base'});
    assert.deepEqual(old.events.map(e=>e.id),['offer-two']);assert.equal(old.revalidationWithheld,true);
  });
  await verify('real offer worker/outbox/refresh publishes one coherent generation and reuses immutable documents', async () => {
    const workResult=await runPreparationWorker({store:workers,workerId:'source-search-worker',maxJobs:8,maxEvents:8,timeBudgetMs:60000});
    assert.deepEqual(workResult.failures,[]);
    const refreshed=await runPublicationRefresh({store:refreshStore,workerId:'source-search-refresh',maxRequests:8,timeBudgetMs:60000});
    assert.deepEqual(refreshed.failures,[]);assert.equal(refreshed.published,1);
    const read=await publications.readPublication();firstPublication=read.publicationId;assert.notEqual(firstPublication,'source-search-base');
    const s=read.sessions.find(s=>s.sessionId==='offer-one');assert.equal(s.snapshot.offerTermsVersion,1);
    assert.equal(s.pinnedOfferTerms[0].priceMinor,'60000');assert.equal(s.document.id,'document-offer-one');
    const result=await search();assert.equal(result.events.length,2);assert.equal(result.publicationId,firstPublication);
    assert.equal(result.revalidationWithheld,false);assert.equal(await count('offer_derivations'),1);
  });
  await verify('canonical changes/new identities quarantine without silently changing prepared search facts', async () => {
    const records=[{...events[0],title:'Different production',checkedAt:observed(-20)},
      {...events[0],startsAt:observed(5000),checkedAt:observed(-20)},
      {...events[0],venue:'Different venue',checkedAt:observed(-20)},
      {...events[0],id:'new',sourceSessionIds:['new'],checkedAt:observed(-20)}];
    const before=await count('offer_revisions'),result=await replaySourceRecords(records,{store:source});
    assert.ok(result.decisions.every(d=>d.status==='quarantined'));assert.equal(await count('offer_revisions'),before);
    assert.deepEqual(result.decisions.map(d=>d.reason),['canonical_title_changed','canonical_session_time_changed','canonical_venue_changed','existing_offer_identity_not_found']);
  });
  await verify('typed exact zero-fee fixtures support group budgets; older source observations remain held', async () => {
    const previous=await query("SELECT current_revision_id FROM biplan.offer_identities WHERE id='offer-one';");
    const exact={revisionId:'exact-fixture',offerId:'offer-one',sessionId:'offer-one',provider:'bubilet',providerRecordId:'offer-one',sourceSessionIds:['offer-one'],
      sourceUrl:events[0].url,observedAt:observed(-10),price:400,priceMinor:'40000',feeMinor:'0',currency:'TRY',priceKind:'exact',availability:'available',
      contentHash:'synthetic-exact-checkout-evidence',sourcePayload:{...events[0],fixtureExactCheckout:400}};
    const accepted=await source.accept(exact,previous);assert.equal(accepted.status,'accepted');
    const older=await replaySourceRecords([{...events[0],price:500,checkedAt:observed(-20)}],{store:source});
    assert.equal(older.decisions[0].status,'held_stale');
    await runPreparationWorker({store:workers,workerId:'source-search-worker',maxJobs:8,maxEvents:8,timeBudgetMs:60000});
    await runPublicationRefresh({store:refreshStore,workerId:'source-search-refresh',maxRequests:8,timeBudgetMs:60000});
    const result=await search(publications,{filters:{...emptyFilters,maxPrice:500,partySize:2,totalBudget:1000}});
    assert.equal(result.events.length,1);assert.equal(result.events[0].price,400);
    const below=await search(publications,{filters:{...emptyFilters,maxPrice:350,partySize:2,totalBudget:700}});assert.equal(below.events.length,0);
  });
  await verify('final mandatory check rejects a changed exact offer rather than switching generations', async () => {
    const before=(await publications.readPublication()).publicationId;
    const concurrent={...publications,readPublication:async(...args)=>{
      const pinned=await publications.readPublication(...args);
      const previous=await query("SELECT current_revision_id FROM biplan.offer_identities WHERE id='offer-one';");
      await source.accept({revisionId:'concurrent-sold-out',offerId:'offer-one',sessionId:'offer-one',provider:'bubilet',providerRecordId:'offer-one',sourceSessionIds:['offer-one'],
        sourceUrl:events[0].url,observedAt:observed(-5),price:400,priceMinor:'40000',feeMinor:'0',currency:'TRY',priceKind:'exact',availability:'sold_out',
        contentHash:'synthetic-sold-out-evidence',sourcePayload:{fixture:'sold-out'}},previous);
      return pinned;
    }};
    const result=await search(concurrent,{filters:{...emptyFilters,maxPrice:500}});
    assert.equal(result.publicationId,before);assert.equal(result.events.length,0);assert.equal(result.revalidationWithheld,true);
    const frozen=await search(publications,{publicationId:firstPublication});assert.ok(frozen.events.every(e=>e.id!=='offer-one'));
  });
  await verify('canonical cancellation invalidates every returned card even without optional refresh', async () => {
    await query("UPDATE biplan.sessions SET status='canceled' WHERE id='offer-two';");
    const result=await search();assert.equal(result.events.length,0);assert.equal(result.revalidationWithheld,true);
  });
});
