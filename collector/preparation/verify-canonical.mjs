import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { adaptCanonicalRecord } from './canonical-adapter.mjs';
import { createCanonicalStore } from './canonical-store.mjs';
import { prepareCanonicalSearch, runCanonicalWorker } from './canonical-worker.mjs';
import { assertOwned, container, docker, literal, sql, work } from './db.mjs';

const database = `biplan_canonical_verify_${randomBytes(6).toString('hex')}`;
assert.match(database, /^biplan_canonical_verify_[0-9a-f]{12}$/);
const paths = ['schema.sql', 'migrations/002-offer-revisions.sql', 'migrations/003-workers.sql', 'migrations/004-publication-refresh.sql',
  'migrations/005-canonical-preparation.sql', 'canonical-adapter.mjs', 'canonical-store.mjs', 'canonical-worker.mjs', 'verify-canonical.mjs'];
const sourceHashes = {};
for (const path of paths) sourceHashes[`collector/preparation/${path}`] = createHash('sha256').update(await readFile(resolve(import.meta.dirname, path))).digest('hex');
const query = async statement => { await assertOwned(); return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], `SET statement_timeout='20s';\n${statement}`); };
const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const store = createCanonicalStore(query), checks = [], runs = [], startedAt = new Date().toISOString();
let created = false, problem = null;
const checkedAt = new Date(Date.now() - 60000).toISOString(), startsAt = new Date(Date.now() + 172800000).toISOString();
const event = (id, changed = {}) => ({ id, source: 'bubilet', sourceSessionIds: [id], title: 'Bir Oyun', description: 'Dostluk üzerine bir oyun.',
  venue: 'Sahne', district: 'Kadıköy', address: 'Moda Caddesi', city: 'İstanbul', category: 'Tiyatro', startsAt, checkedAt,
  attendanceTiming: null, price: 19.99, currency: 'TRY', availability: 'available',
  url: `https://www.bubilet.com.tr/istanbul/etkinlik/${id}`, imageUrl: '', ...changed });
const primary = changed => event('new-record', { canonicalProductionKey: 'supported:bir-oyun', ...changed });
const verify = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
const accept = async record => { const adapted = adaptCanonicalRecord(record, await store.findHeads(record)); assert.equal(adapted.status, 'ready'); return store.accept(adapted.payload); };
const active = () => store.activePublication();
const run = async (worker = 'canonical-verifier') => { const result = await runCanonicalWorker({ store, workerId: worker, maxJobs: 8, timeBudgetMs: 30000 }); runs.push(result); return result; };

try {
  await assertOwned(); await sql(`CREATE DATABASE ${database};`); created = true;
  await query(await readFile(resolve(import.meta.dirname, 'schema.sql'), 'utf8'));
  const base = event('base-record');
  const baseSnapshot = { ...base, offers: [base] };
  await query(`INSERT INTO biplan.productions(id,title,content_hash) VALUES('production-base','Base','base');
    INSERT INTO biplan.venues(id,name,address_text,district,content_hash) VALUES('venue-base','Sahne','Moda Caddesi','Kadıköy','venue');
    INSERT INTO biplan.sessions(id,production_id,venue_id,starts_at,status,source_session_ids,availability,content_hash)
      VALUES('session-base','production-base','venue-base',${literal(startsAt)},'scheduled',ARRAY['base-record'],'available','base');
    INSERT INTO biplan.provider_offers(id,session_id,provider,provider_record_id,source_url,currency,price,price_minor,price_kind,availability,observed_at,content_hash,source_payload)
      VALUES('offer-base','session-base','bubilet','base-record',${literal(base.url)},'TRY',19.99,1999,'starting_at','available',${literal(checkedAt)},'base',${json(base)});
    INSERT INTO biplan.search_documents(id,subject_type,subject_id,document_profile,document_text,document_hash,dependency_hash)
      VALUES('document-base','session','session-base','event-title-category-venue-description-v1','base','base','base');`);
  for (const migration of paths.slice(1, 5)) await query(await readFile(resolve(import.meta.dirname, migration), 'utf8'));
  await query(`INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count)
      VALUES('publication-base','{"requiredOfferCount":1,"requiredEvaluationCount":0}','base',1,1);
    INSERT INTO biplan.published_sessions VALUES('publication-base','session-base','production-base','venue-base','document-base','base',${json(baseSnapshot)});
    INSERT INTO biplan.publication_offers VALUES('publication-base','session-base','offer-base');
    UPDATE biplan.publications SET state='validated',validated_at=clock_timestamp(),validation_hash='base' WHERE id='publication-base';
    SELECT biplan.activate_publication('publication-base',NULL);`);

  await verify('new source identity is isolated, prepared lexical-first, and atomically published', async () => {
    const receipt = await accept(primary({})); assert.equal(receipt.status, 'accepted');
    const result = await run(); assert.equal(result.completed, 1); assert.equal(result.failures.length, 0);
    const row = JSON.parse(await query(`SELECT jsonb_build_object('sessionId',session_id,'snapshot',eligibility_snapshot,
      'embedding',(SELECT embedding FROM biplan.search_documents WHERE id=search_document_id))::text FROM biplan.published_sessions
      WHERE publication_id=(SELECT publication_id FROM biplan.active_publication WHERE singleton) AND session_id=${literal(receipt.sessionId)};`));
    assert.equal(row.sessionId, receipt.sessionId); assert.equal(row.embedding, null); assert.equal(row.snapshot.indexingStatus, 'lexical_only');
  });

  await verify('lost-response replay is immutable and cannot rewind a newer head', async () => {
    const a = primary({}), first = await accept(a), second = await accept({ ...a, checkedAt: new Date(Date.parse(checkedAt) + 1000).toISOString(), title: 'Bir Oyun Yeni' });
    const replay = await accept(a); assert.equal(replay.idempotent, true); assert.equal(replay.revisionId, first.revisionId);
    assert.equal(await query(`SELECT revision_id FROM biplan.canonical_heads WHERE session_id=${literal(second.sessionId)};`), second.revisionId);
    const prepared = await run('canonical-replay-head'); assert.equal(prepared.failures.length, 0);
  });

  await verify('explicit supported cross-provider identity merges only exact time and resolved venue', async () => {
    const original = await query("SELECT session_id FROM biplan.canonical_source_mappings WHERE source_record_id='new-record';");
    const cross = event('cross-record', { source: 'biletinial', canonicalProductionKey: 'supported:bir-oyun', title: 'Bir Oyun Yeni',
      checkedAt: new Date(Date.parse(checkedAt) + 2000).toISOString(), url: 'https://biletinial.com/tr-tr/tiyatro/bir-oyun' });
    const receipt = await accept(cross); assert.equal(receipt.status, 'accepted'); assert.equal(receipt.sessionId, original);
    assert.notEqual(receipt.offerId, await query("SELECT offer_id FROM biplan.canonical_source_mappings WHERE source_record_id='new-record';"));
  });

  await verify('same title at different time and venue remains a separate session', async () => {
    const other = await accept(event('other-record', { startsAt: new Date(Date.parse(startsAt) + 3600000).toISOString(), venue: 'Başka Sahne' }));
    const original = await query("SELECT session_id FROM biplan.canonical_source_mappings WHERE source_record_id='new-record';");
    assert.notEqual(other.sessionId, original);
    const drained = await run('canonical-drain'); assert.equal(drained.failures.length, 0);
  });

  await verify('old publication becomes unusable immediately after canonical change and stale fences cannot complete', async () => {
    const before = await active(), changed = await accept(event('base-record', { title: 'Düzeltilmiş Oyun', checkedAt: new Date(Date.parse(checkedAt) + 2000).toISOString() }));
    const status = JSON.parse(await query(`SELECT biplan.current_publication_offer_status(${literal(before)},'session-base',clock_timestamp(),interval '3 days')::text;`));
    assert.equal(status.canonicalSessionUsable, false);
    const [old] = await store.claim('old-worker', 1, 1); assert.ok(old); await query(`UPDATE biplan.preparation_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${literal(old.id)};`);
    const [fresh] = await store.claim('fresh-worker', 1, 60); assert.equal(fresh.fencing_token, '2');
    const input = await store.input(fresh, 'fresh-worker');
    await assert.rejects(() => store.complete(old, 'old-worker', { documentProfile: 'event-title-category-venue-description-v1', documentText: 'x', documentHash: 'x', dependencyHash: input.dependencyHash, lexicalTokens: [], embeddingProfile: null, embedding: null }, before), /stale/i);
    assert.equal(changed.jobId, fresh.id);
    const prepared = prepareCanonicalSearch(input), completed = await store.complete(fresh, 'fresh-worker', prepared, before);
    const replay = await store.complete(fresh, 'fresh-worker', prepared, before);
    assert.equal(completed.status, 'completed'); assert.equal(replay.idempotent, true); assert.equal(replay.resultPublicationId, completed.resultPublicationId);
  });

  await verify('CAS mismatch preserves raw failure atomically and does not move heads', async () => {
    const record = event('base-record', { checkedAt: new Date(Date.parse(checkedAt) + 3000).toISOString(), category: 'Konser' });
    const adapted = adaptCanonicalRecord(record, await store.findHeads(record)); adapted.payload.expectedCanonicalRevisionId = 'wrong-head';
    const head = await query("SELECT revision_id FROM biplan.canonical_heads WHERE session_id='session-base';");
    await assert.rejects(() => store.accept(adapted.payload), /guard/i);
    assert.equal(await query("SELECT revision_id FROM biplan.canonical_heads WHERE session_id='session-base';"), head);
    assert.equal(await query(`SELECT count(*) FROM biplan.canonical_requests WHERE id=${literal(adapted.requestId)};`), '0');
  });

  await verify('canonical cancellation removes the row from the next coherent publication', async () => {
    const canceled = await accept(event('base-record', { title: 'Düzeltilmiş Oyun', availability: 'cancelled',
      checkedAt: new Date(Date.parse(checkedAt) + 4000).toISOString() }));
    assert.equal(canceled.status, 'accepted'); const result = await run('canonical-cancel'); assert.equal(result.failures.length, 0);
    assert.equal(await query(`SELECT count(*) FROM biplan.published_sessions WHERE publication_id=(SELECT publication_id FROM biplan.active_publication WHERE singleton) AND session_id='session-base';`), '0');
  });

  await verify('multi-provider occurrence correction is withheld until every offer has matching complete evidence', async () => {
    const a = event('family-a', { title: 'Aile Oyunu', checkedAt: new Date(Date.parse(checkedAt) + 10000).toISOString(), price: 20 });
    const acceptedA = await accept(a); assert.equal(acceptedA.status, 'accepted'); assert.equal((await run('family-a-create')).failures.length, 0);
    const b = { ...a, id: 'family-b', sourceSessionIds: ['family-b'], source: 'biletinial', price: 5,
      checkedAt: new Date(Date.parse(checkedAt) + 11000).toISOString(), url: 'https://biletinial.com/tr-tr/tiyatro/aile-oyunu' };
    const acceptedB = await accept(b); assert.equal(acceptedB.sessionId, acceptedA.sessionId); assert.equal((await run('family-b-create')).failures.length, 0);
    assert.equal((await accept({ ...a, checkedAt: new Date(Date.parse(checkedAt) + 11500).toISOString() })).status, 'accepted');
    assert.equal((await run('family-a-authority')).failures.length, 0);
    const pinned = await active(), correction = { startsAt: new Date(Date.parse(startsAt) + 3600000).toISOString(), venue: 'Yeni Sahne',
      district: 'Beşiktaş', address: 'Yeni Cadde', attendanceTiming: { doorsOpenMinutesBefore: 45 } };
    const correctedA = await accept({ ...a, ...correction, checkedAt: new Date(Date.parse(checkedAt) + 12000).toISOString() });
    assert.equal(correctedA.status, 'accepted');
    const withheld = JSON.parse(await query(`SELECT biplan.current_publication_offer_status(${literal(pinned)},${literal(acceptedA.sessionId)},clock_timestamp(),interval '3 days')::text;`));
    assert.equal(withheld.canonicalSessionUsable, false); assert.ok(withheld.reasons.includes('canonical_offer_occurrence_unproven'));
    const blocked = await run('family-correction-blocked'); assert.equal(blocked.completed, 0); assert.match(blocked.failures[0].message, /canonical offer occurrence evidence/i);
    const partial = { revisionId: 'family-b-price-only', offerId: acceptedB.offerId, sessionId: acceptedA.sessionId, provider: 'biletinial',
      providerRecordId: 'family-b', providerSessionId: null, sourceSessionIds: ['family-b'], sourceUrl: b.url,
      ticketTierId: null, ticketTierName: null, currency: 'TRY', price: '4', priceMinor: '400', feeMinor: null,
      priceKind: 'starting_at', availability: 'available', observedAt: new Date(Date.parse(checkedAt) + 12500).toISOString(),
      sourceUpdatedAt: null, validFrom: null, validUntil: null, contentHash: 'family-b-price-only', sourcePayload: { venue: b.venue } };
    const partialReceipt = JSON.parse(await query(`SELECT biplan.accept_offer_revision(${json(partial)},${literal(acceptedB.offerRevisionId)})::text;`));
    assert.equal(partialReceipt.status, 'accepted');
    const stillWithheld = JSON.parse(await query(`SELECT biplan.current_publication_offer_status(${literal(pinned)},${literal(acceptedA.sessionId)},clock_timestamp(),interval '3 days')::text;`));
    assert.equal(stillWithheld.canonicalSessionUsable, false); assert.ok(stillWithheld.reasons.includes('canonical_offer_occurrence_unproven'));
    const correctedB = await accept({ ...b, ...correction, checkedAt: new Date(Date.parse(checkedAt) + 13000).toISOString() });
    assert.equal(correctedB.status, 'accepted'); const reconciled = await run('family-correction-reconciled');
    assert.equal(reconciled.failures.length, 0); assert.equal(reconciled.completed, 1);
  });

  await verify('held cross-source cancellation withholds immediately; same-provider full observation reconciles', async () => {
    const a = event('cancel-a', { title: 'İptal Ailesi', checkedAt: new Date(Date.parse(checkedAt) + 20000).toISOString() });
    const accepted = await accept(a); assert.equal((await run('cancel-family-create')).failures.length, 0); const pinned = await active();
    const held = await accept({ ...a, id: 'cancel-b', sourceSessionIds: ['cancel-b'], source: 'biletinial', availability: 'cancelled',
      checkedAt: new Date(Date.parse(checkedAt) + 21000).toISOString(), url: 'https://biletinial.com/tr-tr/tiyatro/iptal-ailesi' });
    assert.equal(held.status, 'held');
    const status = JSON.parse(await query(`SELECT biplan.current_publication_offer_status(${literal(pinned)},${literal(accepted.sessionId)},clock_timestamp(),interval '3 days')::text;`));
    assert.equal(status.canonicalSessionUsable, false); assert.ok(status.reasons.includes('canonical_offer_occurrence_unproven'));
    const resolved = await accept({ ...a, availability: 'cancelled', checkedAt: new Date(Date.parse(checkedAt) + 22000).toISOString() });
    assert.equal(resolved.status, 'accepted'); assert.equal((await run('cancel-family-resolve')).failures.length, 0);
    assert.equal(await query(`SELECT count(*) FROM biplan.published_sessions WHERE publication_id=(SELECT publication_id FROM biplan.active_publication WHERE singleton) AND session_id=${literal(accepted.sessionId)};`), '0');
  });

  await verify('explicit incompatible adaptation keys stay separate and a no-key exact collision is ambiguous', async () => {
    const firstRecord = event('adaptation-a', { title: 'İki Yorum', canonicalProductionKey: 'adaptation:a',
      checkedAt: new Date(Date.parse(checkedAt) + 30000).toISOString() });
    const first = await accept(firstRecord); assert.equal(first.status, 'accepted');
    const secondRecord = { ...firstRecord, id: 'adaptation-b', sourceSessionIds: ['adaptation-b'], source: 'biletinial',
      canonicalProductionKey: 'adaptation:b', checkedAt: new Date(Date.parse(checkedAt) + 31000).toISOString(),
      url: 'https://biletinial.com/tr-tr/tiyatro/iki-yorum' };
    const second = await accept(secondRecord); assert.equal(second.status, 'accepted'); assert.notEqual(second.sessionId, first.sessionId);
    const noKey = { ...firstRecord, id: 'adaptation-unknown', sourceSessionIds: ['adaptation-unknown'], source: 'biletix',
      checkedAt: new Date(Date.parse(checkedAt) + 32000).toISOString(), url: 'https://www.biletix.com/etkinlik/ABC123/ISTANBUL/tr' };
    delete noKey.canonicalProductionKey;
    const heads = await store.findHeads(noKey); assert.equal(heads.length, 2);
    assert.equal(adaptCanonicalRecord(noKey, heads).reason, 'ambiguous_provider_identity');
  });
} catch (error) {
  problem = { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 4000) };
  throw error;
} finally {
  const receipt = { startedAt, finishedAt: new Date().toISOString(), runtime: process.version,
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    dirtyWorkingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim().length > 0,
    database, databaseOwned: created, sourceHashes, checks, runs, problem, aiCalls: 0, externalCalls: 0,
    limitations: ['local disposable PostgreSQL fixtures; no live providers, paid inference, capacity, or cloud changes'] };
  await mkdir(work, { recursive: true }); await writeFile(resolve(work, `canonical-verification-${Date.now()}.json`), JSON.stringify(receipt, null, 2));
  if (created) await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${literal(database)} AND pid<>pg_backend_pid(); DROP DATABASE ${database};`);
}
console.log(JSON.stringify({ passed: checks.length, databaseDropped: created, aiCalls: 0, externalCalls: 0 }));
