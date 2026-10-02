import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { sql, literal, work } from './db.mjs';

const checks = [];
async function verify(name, run) { await run(); checks.push(name); console.log(`PASS ${name}`); }
const active = await sql('SELECT publication_id FROM biplan.active_publication WHERE singleton;');
const setup = `BEGIN;
  CREATE FUNCTION pg_temp.check(ok boolean, message text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'acceptance: %',message; END IF; END $$;
  CREATE FUNCTION pg_temp.reject(statement text, pattern text) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      BEGIN EXECUTE statement; EXCEPTION WHEN OTHERS THEN
        IF SQLERRM !~* pattern THEN RAISE; END IF; RETURN;
      END;
      RAISE EXCEPTION 'acceptance: expected rejection for %',statement;
    END $$;`;
async function transaction(statement) { await sql(`${setup}\n${statement}\nROLLBACK;`); }

await verify('all frozen revisions and every historical publication preserve exact offer evidence', async () => {
  const counts = JSON.parse(await sql(`SELECT jsonb_build_object('legacy',count(*),'invalid',count(*) FILTER (WHERE
    r.id IS NULL OR r.offer_id IS DISTINCT FROM l.id OR r.source_payload IS DISTINCT FROM l.source_payload
    OR r.session_id IS DISTINCT FROM l.session_id OR r.provider IS DISTINCT FROM l.provider
    OR r.provider_record_id IS DISTINCT FROM l.provider_record_id OR r.provider_session_id IS DISTINCT FROM l.provider_session_id
    OR r.price IS DISTINCT FROM l.price OR r.price_minor IS DISTINCT FROM l.price_minor
    OR r.fee_minor IS DISTINCT FROM l.fee_minor OR r.availability IS DISTINCT FROM l.availability
    OR r.source_session_ids IS DISTINCT FROM l.source_session_ids OR r.source_url IS DISTINCT FROM l.source_url
    OR r.currency IS DISTINCT FROM l.currency OR r.price_kind IS DISTINCT FROM l.price_kind
    OR r.ticket_tier_id IS DISTINCT FROM l.ticket_tier_id OR r.ticket_tier_name IS DISTINCT FROM l.ticket_tier_name
    OR r.observed_at IS DISTINCT FROM l.observed_at OR r.source_updated_at IS DISTINCT FROM l.source_updated_at
    OR r.valid_from IS DISTINCT FROM l.valid_from OR r.valid_until IS DISTINCT FROM l.valid_until))::text
    FROM biplan.provider_offers l LEFT JOIN biplan.offer_revisions r ON r.id=l.id;`));
  assert.equal(counts.legacy, 10024); assert.equal(counts.invalid, 0);
  await sql("SELECT biplan.validate_publication_offers(id) FROM biplan.publications WHERE state IN ('active','superseded');");
});

const original = JSON.parse(await sql(`SELECT jsonb_build_object(
  'offerId',i.id,'revisionId',r.id,'sessionId',r.session_id,'provider',r.provider,
  'providerRecordId',r.provider_record_id,'providerSessionId',r.provider_session_id,
  'sourceSessionIds',r.source_session_ids,'sourceUrl',r.source_url,'ticketTierId',r.ticket_tier_id,
  'ticketTierName',r.ticket_tier_name,'currency',r.currency,'price',r.price,'priceMinor',r.price_minor,
  'feeMinor',r.fee_minor,'priceKind',r.price_kind,'availability',r.availability,
  'observedAt',r.observed_at,'sourceUpdatedAt',r.source_updated_at,'validFrom',r.valid_from,
  'validUntil',r.valid_until,'contentHash',r.supplied_content_hash,'sourcePayload',r.source_payload)::text
  FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id LIMIT 1;`));
const time = Math.max(Date.parse(original.observedAt), Date.parse(original.sourceUpdatedAt ?? original.observedAt));
const date = offset => new Date(time + offset * 60000).toISOString();
const changed = { ...original, revisionId: 'fixture-offer-B', observedAt: date(10), sourceUpdatedAt: date(10),
  price: 123, priceMinor: 12300, availability: 'sold_out', sourcePayload: { ...original.sourcePayload, price: 123, availability: 'sold_out' }, contentHash: 'fixture-content-B' };
const call = (payload, expected) => `SELECT biplan.accept_offer_revision(${literal(JSON.stringify(payload))}::jsonb,${expected === null ? 'NULL' : literal(expected)});`;
const head = `(SELECT current_revision_id FROM biplan.offer_identities WHERE id=${literal(original.offerId)})`;
const count = table => `(SELECT count(*) FROM biplan.${table} WHERE id LIKE 'offer-revision:fixture-%')`;

await verify('price/availability acceptance commits pointer, one job and one outbox together; rollback restores all', async () => {
  await transaction(`${call(changed, original.revisionId)}
    SELECT pg_temp.check(${head}='fixture-offer-B','pointer');
    SELECT pg_temp.check(${count('preparation_jobs')}=1 AND ${count('outbox')}=1,'atomic work');
    SELECT pg_temp.check((SELECT source_payload FROM biplan.offer_revisions WHERE id=${literal(original.revisionId)})=${literal(JSON.stringify(original.sourcePayload))}::jsonb,'old evidence');
    SELECT biplan.validate_publication_offers(${literal(active)});`);
  assert.equal(await sql(`SELECT ${head};`), original.revisionId);
  assert.equal(await sql(`SELECT ${count('preparation_jobs')}+${count('outbox')};`), '0');
});

await verify('lost-response replay after another accepted revision never rewinds current head', async () => {
  const next = { ...changed, revisionId: 'fixture-offer-C', observedAt: date(20), sourceUpdatedAt: date(20), price: 234, priceMinor: 23400, sourcePayload: { ...changed.sourcePayload, price: 234 }, contentHash: 'fixture-content-C' };
  await transaction(`${call(changed, original.revisionId)} ${call(next, changed.revisionId)} ${call(changed, original.revisionId)}
    SELECT pg_temp.check(${head}='fixture-offer-C','replay rewound head');
    SELECT pg_temp.check(${count('preparation_jobs')}=2 AND ${count('outbox')}=2,'replay duplicated work');
    SELECT pg_temp.reject(${literal(call({ ...changed, priceMinor: 1 }, original.revisionId))},'reused|different|immutable');`);
});

await verify('stale and conflicting source clocks preserve head; CAS and stable identity guards reject writes', async () => {
  const stale = { ...changed, revisionId: 'fixture-offer-stale', sourceUpdatedAt: date(5), observedAt: date(30) };
  const conflict = { ...changed, revisionId: 'fixture-offer-conflict', priceMinor: 12301 };
  const olderSameVersion = { ...changed,revisionId:'fixture-offer-older-same-version',observedAt:date(5) };
  const missingVersion = { ...changed,revisionId:'fixture-offer-missing-version',sourceUpdatedAt:null,observedAt:date(40) };
  await transaction(`${call(changed, original.revisionId)} ${call(stale, changed.revisionId)} ${call(conflict, changed.revisionId)}
    ${call(olderSameVersion,changed.revisionId)} ${call(missingVersion,changed.revisionId)}
    SELECT pg_temp.check(${head}='fixture-offer-B','held revision replaced head');
    SELECT pg_temp.check((SELECT acceptance_status FROM biplan.offer_revisions WHERE id='fixture-offer-stale')='held_stale','stale status');
    SELECT pg_temp.check((SELECT acceptance_status FROM biplan.offer_revisions WHERE id='fixture-offer-conflict')='held_conflict','normalized conflict status');
    SELECT pg_temp.check((SELECT acceptance_status FROM biplan.offer_revisions WHERE id='fixture-offer-older-same-version')='held_stale','equal version freshness regression');
    SELECT pg_temp.check((SELECT acceptance_status FROM biplan.offer_revisions WHERE id='fixture-offer-missing-version')='held_conflict','missing clock authority');
    SELECT pg_temp.reject(${literal(call({ ...changed, revisionId: 'fixture-offer-wrong-cas' }, original.revisionId))},'guard failed');
    SELECT pg_temp.reject(${literal(call({ ...changed, revisionId: 'fixture-offer-wrong-identity', providerRecordId: 'different' }, changed.revisionId))},'identity.*cannot change');`);
});

await verify('fresh identical check advances watermark without duplicate work; older check cannot replace it', async () => {
  const unversioned = { ...changed, offerId: 'fixture-unversioned', providerRecordId: 'fixture-unversioned', revisionId: 'fixture-offer-first', sourceUpdatedAt: null };
  const fresh = { ...unversioned, revisionId: 'fixture-offer-fresh', observedAt: date(30) };
  const older = { ...unversioned, revisionId: 'fixture-offer-older', observedAt: date(20), priceMinor: 1 };
  await transaction(`${call(unversioned, null)} ${call(fresh, unversioned.revisionId)} ${call(older, fresh.revisionId)}
    SELECT pg_temp.check((SELECT acceptance_status FROM biplan.offer_revisions WHERE id='fixture-offer-older')='held_stale','freshness watermark lost');
    SELECT pg_temp.check(${count('preparation_jobs')}=1 AND ${count('outbox')}=2,'fresh check must reuse derivation and notify publication');`);
});

await verify('A to B to A reuses content derivation and emits every revision for publication', async () => {
  const first = { ...original, offerId:'fixture-reversion', providerRecordId:'fixture-reversion', revisionId:'fixture-offer-A', observedAt:date(1),sourceUpdatedAt:date(1) };
  const second = { ...changed, offerId:first.offerId,providerRecordId:first.providerRecordId };
  const revert = { ...first, revisionId:'fixture-offer-revert', observedAt:date(30),sourceUpdatedAt:date(30) };
  await transaction(`${call(first,null)} ${call(second,first.revisionId)} ${call(revert,second.revisionId)}
    SELECT pg_temp.check((SELECT current_revision_id FROM biplan.offer_identities WHERE id='fixture-reversion')='fixture-offer-revert','reversion rejected');
    SELECT pg_temp.check(${count('preparation_jobs')}=2 AND ${count('outbox')}=3,'reversion omitted publication event');`);
});

await verify('outbox failure rolls back revision, canonical pointer and derivation job', async () => {
  await transaction(`CREATE FUNCTION pg_temp.fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture outbox failure'; END $$;
    CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON biplan.outbox FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_outbox();
    SELECT pg_temp.reject(${literal(call(changed,original.revisionId))},'fixture outbox failure');
    SELECT pg_temp.check(${head}=${literal(original.revisionId)},'pointer survived failed transaction');
    SELECT pg_temp.check(NOT EXISTS(SELECT 1 FROM biplan.offer_revisions WHERE id='fixture-offer-B'),'revision survived failed transaction');
    SELECT pg_temp.check(${count('preparation_jobs')}=0 AND ${count('outbox')}=0,'work survived failed transaction');`);
});

await verify('concurrent first insertion is serialized before an identity row exists', async () => {
  const first = { ...changed,offerId:'fixture-first-race',providerRecordId:'fixture-first-race',revisionId:'fixture-offer-race' };
  const holder = sql(`SET application_name='biplan-offer-verification-holder'; BEGIN;
    ${call(first,null)} SELECT pg_sleep(3); ROLLBACK;`);
  // Observe the actual lock rather than assuming the first client has reached it.
  try {
    let locked = false;
    for (let attempt=0;attempt<25;attempt++) {
      locked = await sql("SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='biplan-offer-verification-holder' AND l.locktype='advisory' AND l.granted);") === 't';
      if (locked) break;
      await new Promise(done=>setTimeout(done,50));
    }
    assert.ok(locked,'first writer did not acquire its advisory lock');
    await assert.rejects(()=>sql(`BEGIN; SET LOCAL lock_timeout='300ms'; ${call({...first,revisionId:'fixture-offer-race-second'},null)} ROLLBACK;`), /lock timeout/i);
  } finally { await holder; }
  assert.equal(await sql("SELECT count(*) FROM biplan.offer_identities WHERE id='fixture-first-race';"),'0');
});

await verify('publication offer pins are immutable and missing pins block validation', async () => {
  await assert.rejects(() => sql(`UPDATE biplan.publication_offers SET session_id='changed' WHERE publication_id=${literal(active)};`), /immutable/i);
  await transaction(`INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count,required_embedding_profile)
      SELECT 'fixture-offer-publication',manifest,'fixture',required_session_count,required_document_count,required_embedding_profile FROM biplan.publications WHERE id=${literal(active)};
    INSERT INTO biplan.published_sessions SELECT 'fixture-offer-publication',session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot FROM biplan.published_sessions WHERE publication_id=${literal(active)};
    INSERT INTO biplan.publication_evaluations SELECT 'fixture-offer-publication',evaluation_id FROM biplan.publication_evaluations WHERE publication_id=${literal(active)};
    SELECT pg_temp.reject(${literal("UPDATE biplan.publications SET state='validated',validated_at=clock_timestamp(),validation_hash='fixture' WHERE id='fixture-offer-publication';")},'offer.*(pins|integrity|cover)');`);
});

const sourceHashes = {};
for (const path of ['schema.sql','migrations/002-offer-revisions.sql','migrations/003-workers.sql','migrations/004-publication-refresh.sql','verify-offers.mjs','import.ts','migrate.mjs'])
  sourceHashes[`collector/preparation/${path}`] = createHash('sha256').update(await readFile(resolve(import.meta.dirname, path))).digest('hex');
const result = { at: new Date().toISOString(), runtime: process.version,
  baseRevision: execFileSync('git',['rev-parse','HEAD'],{ encoding:'utf8',windowsHide:true }).trim(),
  dirtyWorkingTree: execFileSync('git',['status','--porcelain'],{ encoding:'utf8',windowsHide:true }).trim().length>0,
  publicationId: active, sourceHashes, checks, checkedFrozenOffers:10024, aiCalls:0, cloudChanges:false,
  limitations:['local transactional fixtures; no live source integration or capacity claim'] };
await writeFile(resolve(work,`offer-verification-${Date.now()}.json`),JSON.stringify(result,null,2));
await writeFile(resolve(work,'offer-verification.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({ passed:checks.length,receipt:'web/work/catalog-foundation/offer-verification.json' }));
