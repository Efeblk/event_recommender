import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertOwned, container, docker, literal, sql, work } from './db.mjs';
import { adaptCanonicalRecord, canonicalRequestId } from './canonical-adapter.mjs';
import { createCanonicalStore } from './canonical-store.mjs';
import { createBatchStore } from './batch-store.mjs';
import { runBatchPreparation, runBatchPublication } from './batch-worker.mjs';
import { runCanonicalWorker } from './canonical-worker.mjs';
import { createSqlPublicationRepository } from '../../web/lib/publication-repository.ts';
import { preparePublicationCandidates, searchPreparedPublication } from '../../web/lib/prepared-publication-search.ts';
import { emptyFilters } from '../../web/lib/types.ts';

const suffix = randomBytes(6).toString('hex'), database = `biplan_pages_verify_${suffix}`;
const roleNames = Object.fromEntries(['owner', 'reader', 'prepare', 'web', 'preparer'].map(k => [k, `biplan_pages_${suffix}_${k}`]));
const migrations = ['schema.sql', 'migrations/002-offer-revisions.sql', 'migrations/003-workers.sql', 'migrations/004-publication-refresh.sql',
  'migrations/005-canonical-preparation.sql', 'migrations/006-batched-publication.sql', 'migrations/007-page-receipts.sql', 'migrations/008-offer-evidence-projections.sql', 'migrations/009-offer-identity-provider-session.sql',
  'migrations/010-offer-identity-session-index.sql', 'migrations/012-bulk-seal-integrity.sql', 'migrations/013-bulk-publication-projections.sql'];
const paths = [...migrations, 'roles.sql', 'verify-offer-projections.mjs', '../../web/lib/publication-repository.ts', '../../web/lib/prepared-publication-search.ts'];
const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async p => [p, createHash('sha256').update(await readFile(resolve(import.meta.dirname, p))).digest('hex')])));
const sourceHashes = await hashes(), startedAt = new Date().toISOString(), checks = [], runs = [];
let created = false, databaseDropped = false, rolesDropped = false, problem = null;
let optionalArtifactAudit = { present: false, validated: false, reason: 'optional_local_artifact_absent' };
const query = async statement => { await assertOwned(); return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], `SET statement_timeout='30s';\n${statement}`); };
const prepQuery = s => query(`SET ROLE ${roleNames.preparer};\n${s}`);
const webQuery = s => query(`SET ROLE ${roleNames.web};\n${s}`);
const j = x => `${literal(JSON.stringify(x))}::jsonb`;
const invoke = (fn, ...args) => prepQuery(`SELECT biplan.${fn}(${args.join(',')})::text;`).then(JSON.parse);
const canonical = createCanonicalStore(prepQuery), batch = createBatchStore(prepQuery);
const sha = x => createHash('sha256').update(x).digest('hex');
const clock = Date.now(), stamp = new Date(clock - 20000).toISOString(), cycleStart = new Date(clock - 60000).toISOString();
const urls = { bubilet: 'https://www.bubilet.com.tr/istanbul/etkinlik/page-fixture', biletinial: 'https://biletinial.com/tr-tr/tiyatro/page-fixture' };
const providers = ['biletinial', 'bubilet'];
const event = (provider, index, observed = stamp) => ({ id: `${provider}-page-${index}`, source: provider, sourceSessionIds: [`${provider}-page-${index}`],
  title: `Page Play ${index}`, description: 'Source verified performance.', category: 'Tiyatro', venue: 'Page Venue', district: 'Kadikoy', address: 'Page Street', city: '\u0130stanbul',
  startsAt: new Date(clock + (index + 1) * 86400000).toISOString(), checkedAt: observed, attendanceTiming: null, price: 100, currency: 'TRY', availability: 'available', url: urls[provider], imageUrl: '' });
const header = (id, scope = 'full') => ({ schemaVersion: 2, batchId: id, collectionRunId: id, inputHash: sha(id), scope, providers,
  startedAt: cycleStart, horizonStart: scope === 'legacy_incremental' ? null : new Date(clock).toISOString(),
  horizonEnd: scope === 'legacy_incremental' ? null : new Date(clock + 30 * 86400000).toISOString(), scopeEvidence: { geography: 'Istanbul', listingConfigHash: sha('listings') } });
const page = (id, provider, records, status = 'verified', observedAt = records[0]?.checkedAt ?? stamp, extra = {}) => ({ pageId: id, provider, url: urls[provider],
  observedAt, sourceUpdatedAt: null, evidenceHash: sha(id), evidenceKind: 'normalized_page', parserVersion: 'fixture-v1', status, origin: 'current_run', originRunId: id,
  records: records.map(r => ({ requestId: canonicalRequestId(r), sourceRecordId: r.id })), complete: true, ...extra });
function coverage(pages, records, full = true, extra = {}) {
  const inventory = providers.map(provider => { const own = pages.filter(p => p.provider === provider && p.origin === 'current_run');
    return { provider, known: own.length, attemptedThisRun: own.length, verifiedThisRun: own.filter(p => p.status === 'verified').length,
      retiredThisRun: own.filter(p => p.status === 'retired').length, failedThisRun: own.filter(p => p.status === 'failed').length,
      quarantinedThisRun: own.filter(p => p.status === 'quarantined').length, unattemptedThisRun: 0, neverVisited: 0, stale: 0, outstandingFailures: 0 }; });
  const identities = pages.map(p => ({ provider: p.provider, url: p.url })).sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.url < b.url ? -1 : 1);
  const oldest = new Date(Math.min(...pages.map(p => Date.parse(p.observedAt)), ...records.map(r => Date.parse(r.checkedAt)))).toISOString();
  return { schemaVersion: 2, complete: full, finishedAt: new Date().toISOString(), discovery: { unit: 'detail_url', listingConfigHash: sha('listings'),
    inventoryHash: sha(identities.map(x => `${x.provider}\t${x.url}\n`).join('')), urls: identities, exhausted: true }, inventory,
    records: { unit: 'event_record', submitted: records.length, currentRun: records.length, recovered: 0, carried: 0, sourceQuarantined: 0 },
    freshness: { maxSourceAgeMs: 86400000, oldestResolvedAt: full ? oldest : null, validUntil: full ? new Date(Date.parse(oldest) + 86400000).toISOString() : null }, ...extra };
}
const check = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
const begin = h => invoke('begin_preparation_batch_v2', j(h));
const savePage = (id, p) => invoke('record_batch_page', literal(id), j({ ...p, originRunId: p.origin === 'current_run' ? id : null }));
const seal = (h, pages, records, c = coverage(pages, records)) => invoke('seal_preparation_batch_v2', literal(h.batchId), j({ inputHash: h.inputHash, recordCount: records.length, pageCount: pages.length, collectorCoverage: c }));
async function accept(id, records) { const results = []; for (const r of records) { const a = adaptCanonicalRecord(r, await canonical.findHeads(r)); assert.equal(a.status, 'ready'); results.push(await batch.accept(id, a.payload)); } return results; }
async function publish(id) {
  const prepared = await runBatchPreparation({ store: batch, batchId: id, workerId: 'page-worker', maxJobs: 10 }); runs.push(prepared); assert.deepEqual(prepared.failures, []);
  const published = await runBatchPublication({ store: batch, batchId: id, workerId: 'page-publisher' }); runs.push(published); assert.deepEqual(published.failures, []); assert.equal(published.published, 1); return published.receipt.resultPublicationId;
}
let initial, accepted, firstPages, firstRecords;
try {
  await assertOwned(); await sql(`CREATE DATABASE ${database};`); created = true;
  for (const path of migrations) await query(await readFile(resolve(import.meta.dirname, path), 'utf8'));
  await query('INSERT INTO biplan.preparation_storage_limits VALUES(true,1073741824,67108864,20000,1048576);');
  const roles = (await readFile(resolve(import.meta.dirname, 'roles.sql'), 'utf8')).replace(/\bbiplan_(owner|reader|prepare|web|preparer)\b/g, (_, k) => roleNames[k]);
  await query(roles);

  let legacy;
  await check('untouched legacy offers are preserved as evidence but never invented as page-supported',async()=>{
    const r={...event('bubilet',40),url:`${urls.bubilet}-legacy`}; const adapted=adaptCanonicalRecord(r,await canonical.findHeads(r));legacy=await canonical.accept(adapted.payload);
    const prepared=await runCanonicalWorker({store:canonical,workerId:'legacy-fixture',maxJobs:5});assert.deepEqual(prepared.failures,[]);
  });
  await check('supported A100 and B200 pin coherent version2 terms with one URL supporting multiple sessions', async () => {
    const h = header('projection-initial'); firstRecords = [event('bubilet', 0), event('bubilet', 1), {...event('biletinial', 0),price:200}];
    firstPages = [page('projection-a','bubilet',firstRecords.slice(0,2)),page('projection-b','biletinial',firstRecords.slice(2))];
    await begin(h); for(const p of firstPages) await savePage(h.batchId,p); accepted=await accept(h.batchId,firstRecords);
    assert.equal(accepted[0].sessionId,accepted[2].sessionId); assert.equal((await seal(h,firstPages,firstRecords)).status,'sealed'); initial=await publish(h.batchId);
    const snapshot=JSON.parse(await query(`SELECT eligibility_snapshot::text FROM biplan.published_sessions WHERE publication_id=${literal(initial)} AND session_id=${literal(accepted[0].sessionId)};`));
    assert.equal(snapshot.offerTermsVersion,2); assert.equal(snapshot.price,100); assert.equal(snapshot.offerTerms.length,2);
    assert.ok(snapshot.offerTerms.every(t=>t.evidenceStatus==='supported'));
    const legacyTerm=JSON.parse(await webQuery(`SELECT biplan.publication_offer_term(${literal(initial)},${literal(legacy.offerId)})::text;`));assert.equal(legacyTerm.evidenceReason,'legacy_unobserved');assert.equal(legacyTerm.price,null);
  });
  let negativePublication;
  await check('zero-record retirement projects A unknown and retains independently verified B200 without changing raw facts',async()=>{
    const h=header('projection-negative','incremental'),p=page('projection-retired','bubilet',[],'retired',new Date(clock-10000).toISOString());
    await begin(h);await savePage(h.batchId,p);
    const old=JSON.parse(await webQuery(`SELECT biplan.current_publication_offer_status(${literal(initial)},${literal(accepted[0].sessionId)})::text;`));assert.equal(old.canonicalSessionUsable,true);assert.equal(old.offers.find(o=>o.offerId===accepted[0].offerId).status,'unusable');
    assert.equal((await seal(h,[p],[],coverage([p],[],false))).status,'sealed');negativePublication=await publish(h.batchId);
    const terms=JSON.parse(await query(`SELECT jsonb_agg(biplan.publication_offer_term(${literal(negativePublication)},o.id) ORDER BY o.provider)::text FROM biplan.offer_identities o WHERE o.session_id=${literal(accepted[0].sessionId)};`));
    const a=terms.find(t=>t.provider==='bubilet'),b=terms.find(t=>t.provider==='biletinial');
    assert.equal(a.evidenceStatus,'unsupported');assert.equal(a.availability,'unknown');assert.equal(a.price,null);assert.equal(a.sourceUrl,null);assert.equal(Number(b.price),200);assert.equal(b.evidenceStatus,'supported');
    assert.equal(await query(`SELECT price_minor::text FROM biplan.offer_revisions WHERE id=${literal(accepted[0].offerRevisionId)};`),'10000');
    const snapshot=JSON.parse(await query(`SELECT eligibility_snapshot::text FROM biplan.published_sessions WHERE publication_id=${literal(negativePublication)} AND session_id=${literal(accepted[0].sessionId)};`));assert.equal(snapshot.price,200);
    const current=JSON.parse(await webQuery(`SELECT biplan.current_publication_offer_status(${literal(negativePublication)},${literal(accepted[0].sessionId)})::text;`));assert.equal(current.canonicalSessionUsable,true);assert.equal(current.availabilityUsable,true);
    assert.equal(current.offers.find(o=>o.offerId===accepted[0].offerId).status,'unsupported');assert.equal(current.offers.find(o=>o.offerId===accepted[2].offerId).status,'usable');
    assert.equal(await query(`SELECT status FROM biplan.sessions WHERE id=${literal(accepted[0].sessionId)};`),'scheduled');
  });
  await check('actual SQL reader and prepared search choose supported B200 with exact page evidence and no raw fallback',async()=>{
    const repository=createSqlPublicationRepository(webQuery),read=await repository.readPublication(negativePublication);assert.equal(read.offerProjectionVersion,1);
    const rows=preparePublicationCandidates(read,emptyFilters,new Date(clock));assert.equal(rows.events.length,1);assert.equal(rows.events[0].price,null);assert.equal(rows.events[0].advertisedPrice.amount,200);assert.equal(rows.events[0].advertisedPrice.feesKnown,false);assert.equal(rows.events[0].url,urls.biletinial);assert.equal(rows.selectedOffers.get(rows.events[0].id),accepted[2].offerId);
    const result=await searchPreparedPublication(repository,{publicationId:negativePublication,query:'Page Play',filters:emptyFilters,mode:'lexical',now:new Date(clock)});assert.equal(result.events.length,1);assert.equal(result.events[0].price,null);assert.equal(result.events[0].advertisedPrice.amount,200);assert.equal(result.events[0].url,urls.biletinial);
    const initialResult=await searchPreparedPublication(repository,{publicationId:initial,query:'Page Play',filters:emptyFilters,mode:'lexical',now:new Date(clock)});assert.equal(initialResult.events.length,0);
  });
  await check('all-unknown family has no positive price while masked pins still pass coherence readiness',async()=>{
    const snapshot=JSON.parse(await query(`SELECT eligibility_snapshot::text FROM biplan.published_sessions WHERE publication_id=${literal(negativePublication)} AND session_id=${literal(accepted[1].sessionId)};`));assert.equal(snapshot.price,null);assert.equal(snapshot.availability,'unknown');
    const current=JSON.parse(await webQuery(`SELECT biplan.current_publication_offer_status(${literal(negativePublication)},${literal(accepted[1].sessionId)})::text;`));assert.equal(current.availabilityUsable,false);
    assert.equal(await webQuery(`SELECT biplan.publication_offer_evidence_current(${literal(negativePublication)},${literal(accepted[1].offerId)});`),'t');
  });
  await check('rollback cannot revive the retired cheaper offer',async()=>{
    await query(`UPDATE biplan.publications SET state='validated' WHERE id=${literal(initial)};SELECT biplan.activate_publication(${literal(initial)},${literal(negativePublication)});`);
    const old=JSON.parse(await webQuery(`SELECT biplan.current_publication_offer_status(${literal(initial)},${literal(accepted[0].sessionId)})::text;`));assert.equal(old.offers.find(o=>o.offerId===accepted[0].offerId).status,'unusable');
    await query(`UPDATE biplan.publications SET state='validated' WHERE id=${literal(negativePublication)};SELECT biplan.activate_publication(${literal(negativePublication)},${literal(initial)});`);
  });
  await check('compatible unselected A page change leaves pinned B usable without silently selecting A',async()=>{
    const h=header('projection-compatible-page','incremental'),p=page('projection-compatible-page-row','bubilet',firstRecords.slice(0,2),'verified',new Date(clock-8000).toISOString());await begin(h);await savePage(h.batchId,p);
    const state=JSON.parse(await webQuery(`SELECT biplan.current_publication_offer_status(${literal(negativePublication)},${literal(accepted[0].sessionId)})::text;`));assert.equal(state.canonicalSessionUsable,true);assert.equal(state.offers.find(o=>o.offerId===accepted[2].offerId).status,'usable');assert.equal(state.offers.find(o=>o.offerId===accepted[0].offerId).status,'unusable');await batch.cancel(h.batchId,'fixture page drift');
  });
  await check('complete page missing one session restores only its supported session and masks disappeared session',async()=>{
    const h=header('projection-partial','incremental'),r=event('bubilet',0,new Date(clock-7000).toISOString()),p=page('projection-partial-page','bubilet',[r]);
    await begin(h);await savePage(h.batchId,p);await accept(h.batchId,[r]);assert.equal((await seal(h,[p],[r],coverage([p],[r],false))).status,'sealed');negativePublication=await publish(h.batchId);
    const a=JSON.parse(await webQuery(`SELECT biplan.publication_offer_term(${literal(negativePublication)},${literal(accepted[0].offerId)})::text;`));assert.equal(a.evidenceStatus,'supported');assert.equal(Number(a.price),100);
    const missing=JSON.parse(await webQuery(`SELECT biplan.publication_offer_term(${literal(negativePublication)},${literal(accepted[1].offerId)})::text;`));assert.equal(missing.evidenceReason,'session_absent');assert.equal(missing.price,null);
  });
  await check('same-batch canonical correction replaces the earlier page baseline with its completed canonical dependency',async()=>{
    const h=header('projection-own-correction','incremental'),r={...event('bubilet',1,new Date(clock-6500).toISOString()),venue:'Corrected Page Venue'},p=page('projection-own-correction-page','bubilet',[r]);
    await begin(h);await savePage(h.batchId,p);const result=await accept(h.batchId,[r]);assert.equal(result[0].status,'accepted');assert.equal(result[0].sessionId,accepted[1].sessionId);
    assert.equal((await seal(h,[p],[r],coverage([p],[r],false))).status,'sealed');negativePublication=await publish(h.batchId);
    const snapshot=JSON.parse(await query(`SELECT eligibility_snapshot::text FROM biplan.published_sessions WHERE publication_id=${literal(negativePublication)} AND session_id=${literal(accepted[1].sessionId)};`));assert.equal(snapshot.venue,'Corrected Page Venue');
  });
  await check('full coverage cannot omit an eligible legacy URL under projection policy',async()=>{
    const h={...header('projection-full-omitted'),horizonStart:new Date(clock+40*86400000).toISOString(),horizonEnd:new Date(clock+43*86400000).toISOString()};
    const r={...event('bubilet',41),url:`${urls.bubilet}-full-new`},p=page('projection-full-new','bubilet',[r],'verified',stamp,{url:r.url});await begin(h);await savePage(h.batchId,p);await accept(h.batchId,[r]);
    await assert.rejects(seal(h,[p],[r]),/full coverage omits an eligible provider offer/i);await batch.cancel(h.batchId,'fixture omitted');
  });
  await check('publisher rejects stale fencing and page-head change after sealing without switching pointer',async()=>{
    const h=header('projection-race','incremental'),r={...event('bubilet',10),url:urls.bubilet+'-race'};const p=page('projection-race-page','bubilet',[r],'verified',stamp,{url:r.url});
    await begin(h);await savePage(h.batchId,p);await accept(h.batchId,[r]);assert.equal((await seal(h,[p],[r],coverage([p],[r],false))).status,'sealed');
    const prep=await runBatchPreparation({store:batch,batchId:h.batchId,workerId:'race-prepare',maxJobs:10});assert.deepEqual(prep.failures,[]);
    const job=await batch.claimPublication(h.batchId,'race-publisher',60),before=await batch.activePublication();assert.ok(job);
    await assert.rejects(batch.publish(h.batchId,{...job,fencing_token:String(Number(job.fencing_token)+1)},'race-publisher',before),/fence|lease|worker|stale/i);
    // Single collecting-batch admission prevents a second page writer; inject a committed head drift as an adversarial administrator fixture.
    await query(`INSERT INTO biplan.source_page_observations(id,page_hash,payload,receipt,provider,source_url,observed_at,source_updated_at,status) SELECT 'projection-race-newer',md5(page_hash),payload||'{"pageId":"projection-race-newer"}'::jsonb,receipt||'{"pageId":"projection-race-newer"}'::jsonb,provider,source_url,observed_at+interval '1 second',source_updated_at,status FROM biplan.source_page_observations WHERE id='projection-race-page';UPDATE biplan.source_page_heads SET page_id='projection-race-newer' WHERE source_url=${literal(r.url)};`);
    await assert.rejects(batch.publish(h.batchId,job,'race-publisher',before),/page|guard|dependency/i);assert.equal(await batch.activePublication(),before);await batch.fail(job,'race-publisher',{retryable:false,reason:'fixture page dependency drift'});await batch.cancel(h.batchId,'fixture race');
  });
  await check('older page cannot rewind a newer page and source clock conflict remains held',async()=>{
    const h=header('projection-clock','incremental');await begin(h);
    const stale=page('projection-stale-page','bubilet',firstRecords.slice(0,2),'verified',stamp);assert.equal((await savePage(h.batchId,stale)).status,'stale');await batch.cancel(h.batchId,'fixture stale');
    const h2=header('projection-clock-new','incremental');await begin(h2);
    const fresh=page('projection-clock-fresh','bubilet',[],'retired',new Date(clock-6000).toISOString(),{sourceUpdatedAt:new Date(clock-15000).toISOString()});assert.equal((await savePage(h2.batchId,fresh)).status,'accepted');await batch.cancel(h2.batchId,'fixture clock');
    const h3=header('projection-clock-held','incremental');await begin(h3);
    const held=page('projection-clock-missing','bubilet',[],'retired',new Date(clock-4000).toISOString());assert.equal((await savePage(h3.batchId,held)).status,'held');assert.equal((await seal(h3,[held],[],coverage([held],[],false))).status,'blocked');await batch.cancel(h3.batchId,'fixture held');
  });
  await check('incomplete page cannot mask a held venue contradiction in its record',async()=>{
    const h=header('projection-incomplete-conflict','incremental'),r={...event('biletinial',0,new Date(clock-3000).toISOString()),venue:'Contradictory Venue',price:200},p=page('projection-incomplete-conflict-page','biletinial',[r],'verified',r.checkedAt,{complete:false});
    await begin(h);await savePage(h.batchId,p);const decisions=await accept(h.batchId,[r]);assert.equal(decisions[0].status,'held');
    const evidence=JSON.parse(await query(`SELECT biplan.current_offer_page_evidence(${literal(accepted[2].offerId)})::text;`));assert.equal(evidence.disposition,'family_hold');assert.equal(evidence.reasonCode,'record_integrity_conflict');await batch.cancel(h.batchId,'fixture conflict');
  });
  await check('quarantine remains a mandatory family hold instead of provider masking',async()=>{
    const h=header('projection-held','incremental'),p=page('projection-held-page','biletinial',[],'quarantined',new Date(clock-1000).toISOString(),{reasonCode:'venue_conflict'});
    await begin(h);await savePage(h.batchId,p);assert.equal((await seal(h,[p],[],coverage([p],[],false))).status,'blocked');
    const current=JSON.parse(await webQuery(`SELECT biplan.current_publication_offer_status(${literal(negativePublication)},${literal(accepted[0].sessionId)})::text;`));assert.equal(current.canonicalSessionUsable,false);assert.equal(await batch.activePublication(),negativePublication);await batch.cancel(h.batchId,'fixture');
  });
  await check('missing projection exposes no raw fallback and reviewed helper remains permission limited',async()=>{
    assert.equal(await webQuery(`SELECT biplan.publication_offer_term('missing',${literal(accepted[0].offerId)}) IS NULL;`),'t');
    assert.equal(await webQuery(`SELECT biplan.publication_offer_evidence_current('missing',${literal(accepted[0].offerId)});`),'f');
    await assert.rejects(webQuery('SELECT * FROM biplan.publication_offer_evidence;'),/permission denied/i);
  });
  assert.deepEqual(await hashes(), sourceHashes);
} catch (error) { problem = { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 4000) }; }
finally {
  if (created) { await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${literal(database)} AND pid<>pg_backend_pid(); DROP DATABASE ${database};`); databaseDropped = true; }
  for (const name of [roleNames.web, roleNames.preparer, roleNames.reader, roleNames.prepare, roleNames.owner]) await sql(`DROP ROLE IF EXISTS ${name};`);
  rolesDropped = true; await mkdir(work, { recursive: true });
  await writeFile(resolve(work, `offer-projections-verification-${Date.now()}.json`), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), runtime: process.version,
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), sourceHashes, checks, runs, problem,
    database, databaseDropped, rolesDropped, optionalArtifactAudit, aiCalls: 0, externalCalls: 0, syntheticCoverage: true }, null, 2));
}
if (problem) throw new Error(problem.message);
console.log(JSON.stringify({ passed: checks.length, databaseDropped, rolesDropped, aiCalls: 0, externalCalls: 0 }));
