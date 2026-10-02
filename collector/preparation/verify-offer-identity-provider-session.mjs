import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertOwned, container, docker, literal, sql, work } from './db.mjs';

const suffix = randomBytes(6).toString('hex');
const database = `biplan_offer_alias_${suffix}`;
assert.match(database, /^biplan_offer_alias_[0-9a-f]{12}$/);
const baseMigrations = ['schema.sql', 'migrations/002-offer-revisions.sql', 'migrations/003-workers.sql',
  'migrations/004-publication-refresh.sql', 'migrations/005-canonical-preparation.sql',
  'migrations/006-batched-publication.sql', 'migrations/007-page-receipts.sql',
  'migrations/008-offer-evidence-projections.sql'];
const migration = 'migrations/009-offer-identity-provider-session.sql';
const paths = [...baseMigrations, migration, 'verify-offer-identity-provider-session.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
  [path, createHash('sha256').update(await readFile(resolve(import.meta.dirname, path))).digest('hex')])));
const startedAt = new Date().toISOString(), checks = [];
let created = false, databaseDropped = false, problem = null;
const query = async statement => {
  await assertOwned();
  return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database],
    `SET statement_timeout='30s';\n${statement}`);
};
const check = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
const revision = (identity, id, alias, status = 'accepted') => `INSERT INTO biplan.offer_revisions(
  id,offer_id,session_id,provider,provider_record_id,source_session_ids,provider_session_id,price_kind,availability,
  observed_at,supplied_content_hash,server_content_hash,semantic_content_hash,immutable_record_hash,source_payload,acceptance_status,held_reason)
  VALUES(${literal(id)},${literal(identity)},'session','bubilet',${literal(identity)},'{}',${alias === null ? 'NULL' : literal(alias)},
    'unknown','unknown',clock_timestamp(),'supplied','server','semantic','immutable','{}',${literal(status)},
    ${status === 'accepted' ? 'NULL' : literal('fixture_hold')});`;

try {
  await assertOwned();
  await sql(`CREATE DATABASE ${database};`); created = true;
  await query('CREATE EXTENSION postgis; CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;');
  for (const path of baseMigrations) await query(await readFile(resolve(import.meta.dirname, path), 'utf8'));
  // Reproduce databases that recorded migration 002 before this column appeared
  // in its CREATE TABLE definition; migration hashes alone cannot repair them.
  await query('ALTER TABLE biplan.offer_identities DROP COLUMN provider_session_id;');
  await check('historical schema reproduces the missing compatibility column', async () => {
    assert.equal(await query(`SELECT count(*) FROM information_schema.columns WHERE table_schema='biplan'
      AND table_name='offer_identities' AND column_name='provider_session_id';`), '0');
  });
  await query(`INSERT INTO biplan.works(id,title,content_hash) VALUES('work','Work','work');
    INSERT INTO biplan.productions(id,work_id,title,content_hash) VALUES('production','work','Production','production');
    INSERT INTO biplan.venues(id,name,content_hash) VALUES('venue','Venue','venue');
    INSERT INTO biplan.sessions(id,production_id,venue_id,content_hash) VALUES('session','production','venue','session');
    INSERT INTO biplan.offer_identities(id,session_id,provider,provider_record_id)
      SELECT id,'session','bubilet',id FROM unnest(ARRAY['same','conflict','held','empty','future','new','space']) id;
    ${revision('same','same-1','alias-a')}${revision('same','same-2','alias-a')}
    ${revision('conflict','conflict-1','alias-b')}${revision('conflict','conflict-2','alias-c')}
    ${revision('held','held-1','alias-d')}${revision('held','held-2','alias-bad','held_conflict')}
    ${revision('empty','empty-1',null)}${revision('future','future-1','alias-e')}
    ${revision('space','space-1','alias-h')}${revision('space','space-2',' alias-h ')}
    UPDATE biplan.offer_identities SET current_revision_id=CASE id
      WHEN 'same' THEN 'same-2' WHEN 'conflict' THEN 'conflict-2' WHEN 'held' THEN 'held-1'
      WHEN 'empty' THEN 'empty-1' WHEN 'future' THEN 'future-1' WHEN 'space' THEN 'space-2' ELSE NULL END WHERE id<>'new';`);
  const migrationSql = await readFile(resolve(import.meta.dirname, migration), 'utf8');
  await query(migrationSql);
  await check('backfill keeps one accepted alias and refuses ambiguous or held evidence', async () => {
    const rows = JSON.parse(await query(`SELECT jsonb_object_agg(id,provider_session_id ORDER BY id)::text
      FROM biplan.offer_identities;`));
    assert.deepEqual(rows, { conflict: null, empty: null, future: 'alias-e', held: 'alias-d', new: null, same: 'alias-a', space: null });
  });
  await check('accepted alias correction is allowed and clears the ambiguous projection', async () => {
    await query(`${revision('future','future-2','alias-f')}
      UPDATE biplan.offer_identities SET current_revision_id='future-2' WHERE id='future';`);
    assert.equal(await query(`SELECT provider_session_id IS NULL FROM biplan.offer_identities WHERE id='future';`), 't');
  });
  await check('new identities derive a single accepted alias when their head advances', async () => {
    await query(`${revision('new','new-1','alias-g')}
      UPDATE biplan.offer_identities SET current_revision_id='new-1' WHERE id='new';`);
    assert.equal(await query(`SELECT provider_session_id FROM biplan.offer_identities WHERE id='new';`), 'alias-g');
  });
  await check('migration replay is stable and records its exact hash', async () => {
    const before = await query(`SELECT jsonb_object_agg(id,provider_session_id ORDER BY id)::text FROM biplan.offer_identities;`);
    await query(migrationSql);
    assert.equal(await query(`SELECT jsonb_object_agg(id,provider_session_id ORDER BY id)::text FROM biplan.offer_identities;`), before);
    assert.equal(await query(`SELECT migration_hash FROM biplan.schema_migrations
      WHERE version='009-offer-identity-provider-session';`), '009-offer-identity-provider-session-v1');
    assert.equal(await query(`SELECT has_function_privilege('public','biplan.sync_offer_identity_provider_session()','EXECUTE');`), 'f');
  });
} catch (error) {
  problem = { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 4000) };
} finally {
  try { if (created) { await sql(`DROP DATABASE ${database} WITH (FORCE);`); databaseDropped = true; } }
  catch (error) { problem ??= { message: `Cleanup failed: ${error.message}` }; }
  await mkdir(work, { recursive: true });
  await writeFile(resolve(work, `offer-identity-provider-session-${Date.now()}.json`), JSON.stringify({
    startedAt, finishedAt: new Date().toISOString(), database, databaseDropped, sourceHashes, checks,
    aiCalls: 0, externalCalls: 0, problem }, null, 2));
}
if (problem) throw new Error(problem.message);
console.log(JSON.stringify({ passed: checks.length, databaseDropped, aiCalls: 0, externalCalls: 0 }));
