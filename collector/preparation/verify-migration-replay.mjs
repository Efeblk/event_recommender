import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertOwned, container, docker, literal, work } from './db.mjs';
import { initializeCatalog, migrate, backfillFrozenImportOffers } from './migrate.mjs';

const suffix = randomBytes(6).toString('hex'), database = `biplan_installer_${suffix}`, admin = `${database}_admin`;
const roles = Object.fromEntries(['owner','reader','prepare','web','preparer'].map(name => [name, `${database}_${name}`]));
const paths = ['migrate.mjs','local.mjs','import.ts','roles.sql','verify-migration-replay.mjs','migrations/012-bulk-seal-integrity.sql','migrations/013-bulk-publication-projections.sql'];
const hashes = () => Promise.all(paths.map(async path => [path,createHash('sha256').update(await readFile(resolve(import.meta.dirname,path))).digest('hex')])).then(Object.fromEntries);
const sourceHashes = await hashes(), receipt = { startedAt: new Date().toISOString(), sourceHashes, checks: [], cloudCalls: 0, providerCalls: 0, aiCalls: 0 };
let created = false, adminCreated = false;
const psql = (db, user, statement) => docker(['exec','-i',container,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U',user,'-d',db],
  `\\set VERBOSITY terse\nSET statement_timeout='30s';\n${statement}`);
const control = statement => psql('postgres','postgres',statement);
const query = statement => psql(database,admin,statement);
const fingerprint = () => query(`SELECT md5(COALESCE(string_agg(pg_get_functiondef(p.oid)||COALESCE(p.proacl::text,'')||p.proowner::text,'' ORDER BY p.oid),'empty'))
  FROM pg_proc p WHERE p.pronamespace='biplan'::regnamespace;`);
const definition = () => query("SELECT pg_get_functiondef('biplan.seal_preparation_batch_v2(text,jsonb)'::regprocedure);");
const check = async (name, fn) => { await fn(); receipt.checks.push(name); console.log(`PASS ${name}`); };
try {
  await assertOwned(); assert.match(database,/^biplan_installer_[0-9a-f]{12}$/);
  await control(`CREATE ROLE ${admin} LOGIN NOSUPERUSER CREATEDB CREATEROLE;`); adminCreated = true;
  await control(`CREATE DATABASE ${database} OWNER ${admin};`); created = true;
  await psql(database,'postgres','CREATE EXTENSION postgis; CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;');
  await check('fresh initialization installs known versions without superuser and repeats without rewriting functions',async () => {
    const initial = await initializeCatalog(query); assert.equal(initial.initialized,true); assert.equal(initial.applied.length,12);
    const roleSql = (await readFile(resolve(import.meta.dirname,'roles.sql'),'utf8')).replace(/\bbiplan_(owner|reader|prepare|web|preparer)\b/g,(_,name)=>roles[name]);
    await query(roleSql);
    const before = await fingerprint(); assert.match(await definition(),/bulk_global_projection_integrity_v1/);
    assert.deepEqual(await initializeCatalog(query),{initialized:false,applied:[]});
    assert.deepEqual(await migrate(query),{initialized:false,applied:[]});
    assert.equal(await fingerprint(),before);
  });
  await check('pending 012 and 013 apply without replaying history; local/import calls preserve bodies and ACL',async () => {
    const migration = await readFile(resolve(import.meta.dirname,'migrations/012-bulk-seal-integrity.sql'),'utf8');
    const old = migration.split('$old_guard$')[1], bulk = migration.split('$bulk_query$')[1];
    const current = await definition(), replacement = `IF EXISTS(SELECT 1 FROM (${bulk}) bulk_global_projection_integrity_v1 WHERE NOT usable) THEN blocked:=blocked+1; END IF;`;
    const original = current.replace(replacement,()=>old); assert.notEqual(original,current);
    const thirteen=(await readFile(resolve(import.meta.dirname,'migrations/013-bulk-publication-projections.sql'),'utf8')).replaceAll('\r\n','\n');
    let publisher=await query("SELECT pg_get_functiondef('biplan.publish_preparation_batch(text,text,text,bigint,text)'::regprocedure);");
    let validator=await query("SELECT pg_get_functiondef('biplan.validate_publication_offers(text)'::regprocedure);");
    for(const name of ['integrity','snapshots'])publisher=publisher.replace(thirteen.split(`$new_${name}$`)[1],()=>thirteen.split(`$old_${name}$`)[1]);
    validator=validator.replace(thirteen.split('$new_terms$')[1],()=>thirteen.split('$old_terms$')[1]);
    await query(`BEGIN;${original};${publisher};${validator}; DELETE FROM biplan.schema_migrations WHERE version IN ('012-bulk-seal-integrity','013-bulk-publication-projections');COMMIT;`);
    const result = await migrate(query); assert.deepEqual(result.applied,['012-bulk-seal-integrity','013-bulk-publication-projections']);
    assert.equal(await definition(),current); const before = await fingerprint();
    await initializeCatalog(query); await migrate(query); assert.equal(await fingerprint(),before);
  });
  await check('unknown/incompatible markers and incompatible schema fail before any mutation',async () => {
    for (const [setup,restore] of [
      ["INSERT INTO biplan.schema_migrations VALUES('999-unknown','unknown');","DELETE FROM biplan.schema_migrations WHERE version='999-unknown';"],
      ["UPDATE biplan.schema_migrations SET migration_hash='invalid' WHERE version='008-offer-evidence-projections';","UPDATE biplan.schema_migrations SET migration_hash='008-offer-evidence-projections-v1' WHERE version='008-offer-evidence-projections';"],
      ["DELETE FROM biplan.schema_migrations WHERE version='007-page-receipts';","INSERT INTO biplan.schema_migrations(version,migration_hash) VALUES('007-page-receipts','007-page-receipts-v1');"],
      ["DELETE FROM biplan.schema_migrations WHERE version='008-offer-evidence-projections';","INSERT INTO biplan.schema_migrations(version,migration_hash) VALUES('008-offer-evidence-projections','008-offer-evidence-projections-v1');"],
      ["DELETE FROM biplan.schema_migrations WHERE version='012-bulk-seal-integrity';","INSERT INTO biplan.schema_migrations(version,migration_hash) VALUES('012-bulk-seal-integrity','012-bulk-seal-integrity-v1');"],
      ['UPDATE biplan.schema_metadata SET schema_version=2;','UPDATE biplan.schema_metadata SET schema_version=1;'],
    ]) {
      await query(setup); const before = await fingerprint(), calls = [];
      await assert.rejects(()=>initializeCatalog(async sql=>{calls.push(sql);return query(sql);}),/Unknown or incompatible|Incompatible catalog|Non-contiguous/);
      assert.ok(calls.every(sql=>sql.trimStart().startsWith('SELECT '))); assert.equal(await fingerprint(),before); await query(restore);
    }
  });
  await check('installed function drift fails closed before any historical migration can reset it',async () => {
    const current = await definition();
    await query(current.replace('DECLARE b biplan.preparation_batches%ROWTYPE;','DECLARE b biplan.preparation_batches%ROWTYPE; /* drift fixture */'));
    const before = await fingerprint(); await assert.rejects(()=>initializeCatalog(query),/complete seal function body/);
    assert.equal(await fingerprint(),before); await query(current);
    const publisher=await query("SELECT pg_get_functiondef('biplan.publish_preparation_batch(text,text,text,bigint,text)'::regprocedure);");
    await query(publisher.replace('DECLARE b biplan.preparation_batches%ROWTYPE;','DECLARE b biplan.preparation_batches%ROWTYPE; /* publisher drift fixture */'));
    const changed=await fingerprint();await assert.rejects(()=>migrate(query),/complete publisher function body/);
    assert.equal(await fingerprint(),changed);await query(publisher);
    for(const [signature,expectedError] of [['validate_publication_offers(text)',/complete validator function body/],['publication_offer_term(text,text)',/dependency implementation drifted/]]) {
      const original=await query(`SELECT pg_get_functiondef('biplan.${signature}'::regprocedure);`);
      const drifted=original.replace('AS $function$','AS $function$/* dependency drift fixture */');assert.notEqual(drifted,original);
      await query(drifted);const before=await fingerprint();await assert.rejects(()=>migrate(query),expectedError);
      assert.equal(await fingerprint(),before);await query(original);
    }
  });
  await check('frozen import creates initial revisions idempotently without migration replay or head resurrection',async () => {
    const now = new Date().toISOString();
    const payload = { productions:[{id:'installer-production',title:'Fixture'}],
      venues:[{id:'installer-venue',name:'Fixture Venue'}],
      sessions:[{id:'installer-session',productionId:'installer-production',venueId:'installer-venue',startsAt:'2030-01-01T12:00:00Z'}],
      providerOffers:[{id:'installer-offer',sessionId:'installer-session',provider:'bubilet',providerRecordId:'installer-record',
        providerSessionId:'installer-provider-session',sourceSessionIds:['installer-provider-session'],
        sourceUrl:'https://www.bubilet.com.tr/istanbul/etkinlik/installer',observedAt:now,price:100,priceMinor:10000,
        priceKind:'starting_at',availability:'available',currency:'TRY',contentHash:'fixture-hash',sourcePayload:{raw:'fixture'}}] };
    const before = await fingerprint();
    await initializeCatalog(query); await query(`SELECT biplan.ingest_prepared_payload(${literal(JSON.stringify(payload))}::jsonb);`);
    await backfillFrozenImportOffers(query);
    const identity = JSON.parse(await query("SELECT to_jsonb(i)::text FROM biplan.offer_identities i WHERE id='installer-offer';"));
    assert.equal(identity.current_revision_id,'installer-offer'); assert.equal(identity.provider_session_id,'installer-provider-session');
    const revision = await query("SELECT to_jsonb(r)::text FROM biplan.offer_revisions r WHERE id='installer-offer';");
    await initializeCatalog(query); await query(`SELECT biplan.ingest_prepared_payload(${literal(JSON.stringify(payload))}::jsonb);`);
    await backfillFrozenImportOffers(query); assert.equal(await query("SELECT to_jsonb(r)::text FROM biplan.offer_revisions r WHERE id='installer-offer';"),revision);
    await query("UPDATE biplan.offer_identities SET current_revision_id=NULL WHERE id='installer-offer';");
    await backfillFrozenImportOffers(query);
    assert.equal(await query("SELECT current_revision_id IS NULL FROM biplan.offer_identities WHERE id='installer-offer';"),'t');
    assert.equal(await fingerprint(),before);
  });
  assert.deepEqual(await hashes(),sourceHashes);
} catch(error) { receipt.error=String(error.message); process.exitCode=1; }
finally {
  if(created){await control(`DROP DATABASE ${database} WITH (FORCE);`);receipt.databaseDropped=true;}
  for(const role of [roles.web,roles.preparer,roles.reader,roles.prepare,roles.owner]) await control(`DROP ROLE IF EXISTS ${role};`);
  if(adminCreated)await control(`DROP ROLE ${admin};`);receipt.rolesDropped=true;receipt.finishedAt=new Date().toISOString();
  await writeFile(resolve(work,`migration-replay-verification-${Date.now()}.json`),JSON.stringify(receipt,null,2));
  await writeFile(resolve(work,'migration-replay-verification-latest.json'),JSON.stringify(receipt,null,2));
  console.log(JSON.stringify(receipt));
}
