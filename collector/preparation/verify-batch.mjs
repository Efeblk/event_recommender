import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { adaptCanonicalRecord } from './canonical-adapter.mjs';
import { createCanonicalStore } from './canonical-store.mjs';
import { createBatchStore } from './batch-store.mjs';
import { runBatchPreparation, runBatchPublication } from './batch-worker.mjs';
import { assertOwned, container, docker, literal, sql, work } from './db.mjs';

const database = `biplan_batch_verify_${randomBytes(6).toString('hex')}`; assert.match(database, /^biplan_batch_verify_[0-9a-f]{12}$/);
const paths = ['schema.sql', 'migrations/002-offer-revisions.sql', 'migrations/003-workers.sql', 'migrations/004-publication-refresh.sql',
  'migrations/005-canonical-preparation.sql', 'migrations/006-batched-publication.sql', 'batch-store.mjs', 'batch-worker.mjs', 'verify-batch.mjs'];
const sourceHashes = {}; for (const path of paths) sourceHashes[`collector/preparation/${path}`] = createHash('sha256').update(await readFile(resolve(import.meta.dirname, path))).digest('hex');
const query = async statement => { await assertOwned(); return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], `SET statement_timeout='30s';\n${statement}`); };
const json = value => `${literal(JSON.stringify(value))}::jsonb`, batchStore = createBatchStore(query), canonicalStore = createCanonicalStore(query);
const checks = [], runs = [], startedAt = new Date().toISOString(); let created = false, problem = null;
const now = Date.now(), checkedAt = new Date(now - 60000).toISOString(), horizonStart = new Date(now).toISOString(), horizonEnd = new Date(now + 30 * 86400000).toISOString();
const event = index => ({ id: `batch-record-${index}`, source: 'bubilet', sourceSessionIds: [`batch-record-${index}`], title: `Batch Oyun ${index}`,
  description: 'Sentetik toplu hazırlık doğrulaması.', venue: `Sahne ${index}`, district: 'Kadıköy', address: `Adres ${index}`,
  city: 'İstanbul', category: 'Tiyatro', startsAt: new Date(now + (index + 2) * 3600000).toISOString(), checkedAt,
  attendanceTiming: null, price: 100 + index, currency: 'TRY', availability: 'available',
  url: `https://www.bubilet.com.tr/istanbul/etkinlik/batch-oyun-${index}`, imageUrl: '' });
const verify = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
const active = () => batchStore.activePublication();
const batchPayload = (id, count, scope = 'full') => ({ batchId: id, collectionRunId: `collection-${id}`, inputHash: createHash('sha256').update(`${id}:${count}`).digest('hex'), scope,
  providers: ['bubilet'], horizonStart, horizonEnd });
const coverage = (count, complete = true) => ({ complete, failedPages: 0, unvisited: 0, finishedAt: new Date().toISOString(),
  inventory: [{ provider: 'bubilet', discovered: count, verified: count, retired: 0, quarantined: 0, unvisited: 0, failedPages: 0 }] });
async function acceptRange(batchId, offset, count) { for (let index = offset; index < offset + count; index++) {
  const record = event(index), adapted = adaptCanonicalRecord(record, await canonicalStore.findHeads(record)); assert.equal(adapted.status, 'ready');
  const receipt = await batchStore.accept(batchId, adapted.payload); assert.equal(receipt.status, 'accepted');
} }
async function prepareAll(batchId) { for (let pass = 0; pass < 20; pass++) { const result = await runBatchPreparation({ store: batchStore, batchId,
  workerId: `batch-worker-${pass}`, maxJobs: 100, timeBudgetMs: 60000 }); runs.push(result); assert.equal(result.failures.length, 0); if (result.stopped === 'drained') return; }
  throw new Error('batch preparation did not drain within bounded passes'); }

try {
  await assertOwned(); await sql(`CREATE DATABASE ${database};`); created = true; await query(await readFile(resolve(import.meta.dirname, 'schema.sql'), 'utf8'));
  const base = event(1000), baseSnapshot = { ...base, offers: [base] };
  await query(`INSERT INTO biplan.productions(id,title,content_hash) VALUES('production-base','Base','base');
    INSERT INTO biplan.venues(id,name,address_text,district,content_hash) VALUES('venue-base','Base Sahne','Base Adres','Kadıköy','venue');
    INSERT INTO biplan.sessions(id,production_id,venue_id,starts_at,status,source_session_ids,availability,content_hash)
      VALUES('session-base','production-base','venue-base',${literal(base.startsAt)},'scheduled',ARRAY['base'],'available','base');
    INSERT INTO biplan.provider_offers(id,session_id,provider,provider_record_id,source_url,currency,price,price_minor,price_kind,availability,observed_at,content_hash,source_payload)
      VALUES('offer-base','session-base','bubilet','base',${literal(base.url)},'TRY',100,10000,'starting_at','available',${literal(checkedAt)},'base',${json(base)});
    INSERT INTO biplan.search_documents(id,subject_type,subject_id,document_profile,document_text,document_hash,dependency_hash)
      VALUES('document-base','session','session-base','event-title-category-venue-description-v1','base','base','base');`);
  for (const migration of paths.slice(1, 6)) await query(await readFile(resolve(import.meta.dirname, migration), 'utf8'));
  await query(`INSERT INTO biplan.preparation_storage_limits(singleton,max_database_bytes,min_headroom_bytes,max_batch_records,max_record_bytes)
      VALUES(true,10737418240,2147483648,20000,1048576);
    INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count)
      VALUES('publication-base','{"requiredOfferCount":1,"requiredEvaluationCount":0}','base',1,1);
    INSERT INTO biplan.published_sessions VALUES('publication-base','session-base','production-base','venue-base','document-base','base',${json(baseSnapshot)});
    INSERT INTO biplan.publication_offers VALUES('publication-base','session-base','offer-base');
    UPDATE biplan.publications SET state='validated',validated_at=clock_timestamp(),validation_hash='base' WHERE id='publication-base';
    SELECT biplan.activate_publication('publication-base',NULL);`);

  await verify('twenty observations prepare without pointer churn and publish one coherent generation', async () => {
    const payload = batchPayload('batch-20', 20), before = await active(), publications = Number(await query('SELECT count(*) FROM biplan.publications;'));
    await batchStore.begin(payload); await acceptRange(payload.batchId, 0, 20);
    await batchStore.seal(payload.batchId, { recordCount: 20, inputHash: payload.inputHash, collectorCoverage: coverage(20) });
    assert.equal(await active(), before); await prepareAll(payload.batchId); assert.equal(await active(), before);
    const published = await runBatchPublication({ store: batchStore, batchId: payload.batchId, workerId: 'publisher-20' });
    assert.equal(published.published, 1); assert.notEqual(await active(), before);
    assert.equal(Number(await query('SELECT count(*) FROM biplan.publications;')), publications + 1);
    assert.equal(await query(`SELECT count(*) FROM biplan.published_sessions WHERE publication_id=${literal(await active())};`), '21');
  });

  await verify('incremental incomplete coverage remains truthful in its published manifest', async () => {
    const payload = batchPayload('batch-incomplete', 1, 'incremental'); await batchStore.begin(payload); await acceptRange(payload.batchId, 500, 1);
    const sealed = await batchStore.seal(payload.batchId, { recordCount: 1, inputHash: payload.inputHash,
      collectorCoverage: { ...coverage(1, false), failedPages: 1, inventory: [{ provider: 'bubilet', discovered: 1, verified: 1, retired: 0, quarantined: 0, unvisited: 0, failedPages: 1 }] } });
    assert.equal(sealed.status, 'sealed'); assert.equal(await batchStore.claimPublication(payload.batchId, 'unprepared-publisher', 60), null);
    await prepareAll(payload.batchId); const publication = await runBatchPublication({ store: batchStore, batchId: payload.batchId, workerId: 'incremental-publisher' });
    assert.equal(publication.published, 1);
    const manifest = JSON.parse(await query(`SELECT manifest::text FROM biplan.publications WHERE id=${literal(publication.receipt.resultPublicationId)};`));
    assert.equal(manifest.collectorCoverage.complete, false); assert.equal(manifest.collectorCoverage.scope, 'incremental');
  });

  await verify('one hundred observations remain linear and activate exactly once after all preparation', async () => {
    const payload = batchPayload('batch-100', 100), before = await active(), publications = Number(await query('SELECT count(*) FROM biplan.publications;'));
    await batchStore.begin(payload); await acceptRange(payload.batchId, 100, 100); assert.equal(await active(), before);
    await batchStore.seal(payload.batchId, { recordCount: 100, inputHash: payload.inputHash, collectorCoverage: coverage(100) });
    await prepareAll(payload.batchId); assert.equal(await active(), before);
    const published = await runBatchPublication({ store: batchStore, batchId: payload.batchId, workerId: 'publisher-100' }); assert.equal(published.published, 1);
    assert.equal(Number(await query('SELECT count(*) FROM biplan.publications;')), publications + 1);
    const receipt = published.receipt; assert.equal(receipt.basePublicationId, before); assert.equal(receipt.resultPublicationId, await active());
  });
} catch (error) { problem = { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 4000) }; throw error; }
finally {
  const receipt = { startedAt, finishedAt: new Date().toISOString(), runtime: process.version,
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    dirtyWorkingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim().length > 0,
    database, databaseOwned: created, sourceHashes, checks, runs, problem, syntheticCoverage: true, aiCalls: 0, externalCalls: 0,
    limitations: ['local synthetic provider inventory; no live coverage, paid inference, capacity, or cloud claim'] };
  await mkdir(work, { recursive: true }); await writeFile(resolve(work, `batch-verification-${Date.now()}.json`), JSON.stringify(receipt, null, 2));
  if (created) await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${literal(database)} AND pid<>pg_backend_pid(); DROP DATABASE ${database};`);
}
console.log(JSON.stringify({ passed: checks.length, databaseDropped: created, syntheticCoverage: true, aiCalls: 0, externalCalls: 0 }));
