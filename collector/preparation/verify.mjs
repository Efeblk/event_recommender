import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { searchCatalogCandidates } from '../../web/lib/materialized-catalog.ts';
import { emptyFilters } from '../../web/lib/types.ts';
import { sql, literal, work } from './db.mjs';

const receipt = JSON.parse(await readFile(resolve(work, 'import-receipt.json'), 'utf8'));
const publication = receipt.publicationId, summary = receipt.manifest.summary;
const checks = [];
const verify = async (name, run) => { await run(); checks.push(name); console.log(`PASS ${name}`); };
const catalogPath = process.env.CATALOG_PREPARED_PATH ?? resolve(import.meta.dirname, '../../web/work/event-preparation-20260929/search-after.json');
const originalText = await readFile(catalogPath, 'utf8');
assert.equal(createHash('sha256').update(originalText).digest('hex'), receipt.manifest.catalogHash);
const originalEvents = searchCatalogCandidates(JSON.parse(originalText), emptyFilters, new Date(receipt.manifest.referenceAt));
const originals = new Map(originalEvents.map(event => [event.id, event]));
const rows = JSON.parse(await sql(`SELECT jsonb_agg(jsonb_build_object('id',session_id,'event',eligibility_snapshot))::text FROM biplan.published_sessions WHERE publication_id=${literal(publication)};`));
const offers = JSON.parse(await sql("SELECT jsonb_agg(jsonb_build_object('id',id,'sessionId',session_id,'raw',source_payload,'price',price))::text FROM biplan.provider_offers;"));
const expectedOffers = new Map();
for (const row of rows) for (const offer of row.event.offers?.length ? row.event.offers : [row.event]) expectedOffers.set(offer.id, { sessionId: row.id, offer });

await verify('all published sessions and provider offers retain exact source fields', async () => {
  assert.equal(rows.length, summary.sessions); assert.equal(offers.length, summary.offers);
  assert.equal(originalEvents.length, rows.length);
  for (const row of rows) assert.deepEqual(row.event, originals.get(row.id));
  assert.equal(expectedOffers.size, summary.offers);
  const observations = JSON.parse(await sql("SELECT jsonb_agg(jsonb_build_object('id',subject_id,'raw',raw_payload))::text FROM biplan.source_observations;"));
  assert.equal(observations.length, summary.observations);
  const observed = new Map(observations.map(row => [row.id, row.raw]));
  for (const row of rows) assert.deepEqual(row.event, observed.get(row.id));
  for (const stored of offers) {
    const expected = expectedOffers.get(stored.id); assert.ok(expected);
    assert.equal(stored.sessionId, expected.sessionId); assert.deepEqual(stored.raw, expected.offer);
    assert.equal(stored.price, expected.offer.price);
  }
});
await verify('expected Tuğkan and Halil Sezai session families retain all five offers', async () => {
  const expected = [
    { id: 'session-091d6eea5c442ab11dc9e6d5dc476f6b', label: 'Tuğkan', count: 2 },
    { id: 'session-c6a53fe8ff27d45f5ef2cdbdaf2ee787', label: 'Halil Sezai', count: 3 },
  ];
  for (const family of expected) {
    const row = rows.find(row => row.id === family.id); assert.ok(row, family.label);
    assert.match(row.event.title.toLocaleLowerCase('tr-TR'), new RegExp(family.label.toLocaleLowerCase('tr-TR')));
    assert.equal(offers.filter(offer => offer.sessionId === family.id).length, family.count);
  }
});
await verify('quality remains pending and unscored without acquired evidence', async () => {
  const status = JSON.parse(await sql(`SELECT jsonb_build_object('total',count(*),'invalid',count(*) FILTER(WHERE status<>'pending' OR components->'score'<>'null'::jsonb OR cardinality(evidence_claim_ids)<>0),'works',(SELECT count(*) FROM biplan.works),'people',(SELECT count(*) FROM biplan.people))::text FROM biplan.evaluations e JOIN biplan.publication_evaluations pe ON pe.evaluation_id=e.id WHERE pe.publication_id=${literal(publication)};`));
  assert.equal(status.total, summary.pendingEvaluations); assert.equal(status.invalid, 0);
  assert.equal(status.works, 0); assert.equal(status.people, 0);
});
await verify('cached vector coverage and native exact cosine remain valid', async () => {
  const result = JSON.parse(await sql(`SELECT jsonb_build_object('documents',count(*),'embedded',count(*) FILTER(WHERE embedding IS NOT NULL),'invalid',count(*) FILTER(WHERE embedding IS NOT NULL AND (embedding_profile<>${literal(receipt.manifest.embeddingProfile)} OR abs(embedding <=> embedding)>0.00001)))::text FROM biplan.search_documents;`));
  assert.equal(result.documents, summary.documents); assert.equal(result.embedded, summary.embeddedSessions); assert.equal(result.invalid, 0);
});
async function rejection(statement, expected) {
  await assert.rejects(() => sql(statement), error => expected.test(error.message));
}
await verify('published session and manifest content reject mutation', async () => {
  await rejection(`UPDATE biplan.published_sessions SET snapshot_hash='changed' WHERE publication_id=${literal(publication)};`, /immutable/i);
  await rejection(`UPDATE biplan.publications SET manifest='{}'::jsonb WHERE id=${literal(publication)};`, /immutable/i);
  await rejection("UPDATE biplan.search_documents SET document_text='changed' WHERE id=(SELECT id FROM biplan.search_documents LIMIT 1);", /immutable/i);
});
await verify('stale publication guard rejects replacement', async () => {
  await rejection(`SELECT biplan.activate_publication(${literal(publication)},'wrong-previous-version');`, /guard failed/i);
  assert.equal(await sql('SELECT publication_id FROM biplan.active_publication WHERE singleton;'), publication);
});
await verify('candidate with missing mandatory records cannot activate', async () => {
  await sql(`BEGIN;
    INSERT INTO biplan.publications(id,state,manifest,manifest_hash,required_session_count,required_document_count,validated_at,validation_hash)
      VALUES('fixture-missing','validated','{}','fixture-missing',1,0,clock_timestamp(),'fixture');
    DO $check$ BEGIN
      BEGIN PERFORM biplan.activate_publication('fixture-missing',${literal(publication)}); RAISE EXCEPTION 'test erroneously activated invalid publication';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%integrity failed%' THEN RAISE; END IF; END;
    END $check$;
    ROLLBACK;`);
});
await verify('publication switch retains pinned immutable generation and rolls back', async () => {
  await sql(`BEGIN;
    INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count,required_embedding_profile)
      SELECT 'fixture-next',manifest,'fixture-next',required_session_count,required_document_count,required_embedding_profile FROM biplan.publications WHERE id=${literal(publication)};
    INSERT INTO biplan.published_sessions SELECT 'fixture-next',session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot FROM biplan.published_sessions WHERE publication_id=${literal(publication)};
    INSERT INTO biplan.publication_evaluations SELECT 'fixture-next',evaluation_id FROM biplan.publication_evaluations WHERE publication_id=${literal(publication)};
    INSERT INTO biplan.publication_offers SELECT 'fixture-next',session_id,offer_revision_id FROM biplan.publication_offers WHERE publication_id=${literal(publication)};
    UPDATE biplan.publications SET state='validated',validated_at=clock_timestamp(),validation_hash='fixture' WHERE id='fixture-next';
    SELECT biplan.activate_publication('fixture-next',${literal(publication)});
    DO $check$ BEGIN
      IF (SELECT publication_id FROM biplan.active_publication WHERE singleton)<>'fixture-next' THEN RAISE EXCEPTION 'pointer did not switch'; END IF;
      IF (SELECT count(*) FROM biplan.published_sessions WHERE publication_id=${literal(publication)})<>${summary.sessions} THEN RAISE EXCEPTION 'pinned generation disappeared'; END IF;
    END $check$;
    ROLLBACK;`);
  assert.equal(await sql('SELECT publication_id FROM biplan.active_publication WHERE singleton;'), publication);
});
await verify('expired lease is reclaimed with a new fencing token; stale completion rejected', async () => {
  await sql(`BEGIN;
    INSERT INTO biplan.preparation_jobs(id,stage,stage_version,subject_type,subject_id,input_hash) VALUES('fixture-job','fixture','1','production','fixture','fixture');
    SELECT id FROM biplan.claim_preparation_jobs('fixture-old',1,interval '5 minutes');
    UPDATE biplan.preparation_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id='fixture-job';
    SELECT id FROM biplan.claim_preparation_jobs('fixture-new',1,interval '5 minutes');
    DO $check$ BEGIN
      BEGIN PERFORM biplan.complete_preparation_job('fixture-job','fixture-old',1,'{}'); RAISE EXCEPTION 'test erroneously completed stale job';
      EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT LIKE '%stale%' THEN RAISE; END IF; END;
      PERFORM biplan.complete_preparation_job('fixture-job','fixture-new',2,'{"checked":true}');
      IF (SELECT state FROM biplan.preparation_jobs WHERE id='fixture-job')<>'succeeded' THEN RAISE EXCEPTION 'job did not complete'; END IF;
    END $check$;
    ROLLBACK;`);
});
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', windowsHide: true }).trim();
const dirtyWorkingTree = execFileSync('git', ['status', '--porcelain'], { cwd: resolve(import.meta.dirname, '../..'), encoding: 'utf8', windowsHide: true }).trim().length > 0;
const sourceHashes = {};
for (const path of ['collector/preparation/schema.sql', 'collector/preparation/migrations/002-offer-revisions.sql', 'collector/preparation/import.ts', 'collector/preparation/verify.mjs', 'collector/preparation/db.mjs', 'web/lib/catalog-knowledge.ts'])
  sourceHashes[path] = createHash('sha256').update(await readFile(resolve(import.meta.dirname, '../..', path))).digest('hex');
const result = { at: new Date().toISOString(), runtime: process.version, baseRevision: revision, dirtyWorkingTree, sourceHashes,
  publicationId: publication, summary, checks, checkedCards: rows.length,
  checkedOffers: offers.length, limitations: ['frozen prepared inventory', 'no acquired enrichment or calibrated quality scores', 'not integrated into live application', 'no concurrency/capacity claim'], aiCalls: 0 };
await writeFile(resolve(work, 'verification.json'), JSON.stringify(result, null, 2));
await writeFile(resolve(work, `verification-${publication}-${Date.now()}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ passed: checks.length, summary, receipt: 'web/work/catalog-foundation/verification.json' }));
