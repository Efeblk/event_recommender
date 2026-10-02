import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertOwned, container, docker, sql, work } from './db.mjs';

const suffix = randomBytes(6).toString('hex'), database = `biplan_offer_index_${suffix}`;
assert.match(database, /^biplan_offer_index_[0-9a-f]{12}$/);
const baseMigrations = ['schema.sql', 'migrations/002-offer-revisions.sql', 'migrations/003-workers.sql',
  'migrations/004-publication-refresh.sql', 'migrations/005-canonical-preparation.sql',
  'migrations/006-batched-publication.sql', 'migrations/007-page-receipts.sql',
  'migrations/008-offer-evidence-projections.sql'];
const migrations = [...baseMigrations, 'migrations/009-offer-identity-provider-session.sql',
  'migrations/010-offer-identity-session-index.sql'];
const paths = [...migrations, 'verify-offer-identity-session-index.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(paths.map(async path =>
  [path, createHash('sha256').update(await readFile(resolve(import.meta.dirname, path))).digest('hex')])));
const startedAt = new Date().toISOString(), checks = [];
let created = false, databaseDropped = false, problem = null, beforePlan, afterPlan;
const query = async statement => {
  await assertOwned();
  return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database],
    `SET statement_timeout='30s';\n${statement}`);
};
const check = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
const nodes = plan => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

try {
  await assertOwned(); await sql(`CREATE DATABASE ${database};`); created = true;
  await query('CREATE EXTENSION postgis; CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;');
  for (const path of baseMigrations) await query(await readFile(resolve(import.meta.dirname, path), 'utf8'));
  await query(`INSERT INTO biplan.works(id,title,content_hash) VALUES('work','Work','work');
    INSERT INTO biplan.productions(id,work_id,title,content_hash) VALUES('production','work','Production','production');
    INSERT INTO biplan.venues(id,name,content_hash) VALUES('venue','Venue','venue');
    INSERT INTO biplan.sessions(id,production_id,venue_id,content_hash)
      SELECT 'session-'||g,'production','venue','session-'||g FROM generate_series(1,7719) g;
    INSERT INTO biplan.offer_identities(id,session_id,provider,provider_record_id)
      SELECT 'offer-'||g,'session-'||(((g-1)%7719)+1),'bubilet','record-'||g FROM generate_series(1,10024) g;
    ANALYZE biplan.offer_identities;`);
  await check('frozen-scale baseline has no session access path and preserves the predicate result', async () => {
    assert.equal(await query(`SELECT count(*) FROM pg_indexes WHERE schemaname='biplan' AND tablename='offer_identities'
      AND indexname='offer_identities_session_idx';`), '0');
    assert.equal(await query(`SELECT count(*) FROM biplan.offer_identities WHERE session_id='session-5000';`), '1');
    beforePlan = JSON.parse(await query(`EXPLAIN (FORMAT JSON) SELECT id FROM biplan.offer_identities WHERE session_id='session-5000';`))[0].Plan;
    assert.ok(nodes(beforePlan).some(node => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'offer_identities'));
  });
  await query(await readFile(resolve(import.meta.dirname, 'migrations/009-offer-identity-provider-session.sql'), 'utf8'));
  const migrationSql = await readFile(resolve(import.meta.dirname, 'migrations/010-offer-identity-session-index.sql'), 'utf8');
  await query(migrationSql);
  await check('migration keeps results identical and selects the indexed session lookup', async () => {
    assert.equal(await query(`SELECT count(*) FROM biplan.offer_identities WHERE session_id='session-5000';`), '1');
    afterPlan = JSON.parse(await query(`EXPLAIN (FORMAT JSON) SELECT id FROM biplan.offer_identities WHERE session_id='session-5000';`))[0].Plan;
    assert.ok(nodes(afterPlan).some(node => ['Index Scan', 'Index Only Scan', 'Bitmap Index Scan'].includes(node['Node Type'])
      && node['Index Name'] === 'offer_identities_session_idx'));
  });
  await check('index definition, migration hash, and replay stay exact', async () => {
    assert.equal(await query(`SELECT pg_get_indexdef('biplan.offer_identities_session_idx'::regclass);`),
      'CREATE INDEX offer_identities_session_idx ON biplan.offer_identities USING btree (session_id)');
    assert.equal(await query(`SELECT migration_hash FROM biplan.schema_migrations
      WHERE version='010-offer-identity-session-index';`), '010-offer-identity-session-index-v1');
    await query(migrationSql);
    assert.equal(await query(`SELECT count(*) FROM pg_indexes WHERE schemaname='biplan' AND tablename='offer_identities'
      AND indexname='offer_identities_session_idx';`), '1');
  });
} catch (error) {
  problem = { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 4000) };
} finally {
  try { if (created) { await sql(`DROP DATABASE ${database} WITH (FORCE);`); databaseDropped = true; } }
  catch (error) { problem ??= { message: `Cleanup failed: ${error.message}` }; }
  await mkdir(work, { recursive: true });
  await writeFile(resolve(work, `offer-identity-session-index-${Date.now()}.json`), JSON.stringify({
    startedAt, finishedAt: new Date().toISOString(), database, databaseDropped, sourceHashes, checks,
    scale: { sessions: 7719, offerIdentities: 10024 },
    plans: { before: beforePlan?.['Node Type'] ?? null, after: afterPlan?.['Node Type'] ?? null },
    aiCalls: 0, externalCalls: 0, problem }, null, 2));
}
if (problem) throw new Error(problem.message);
console.log(JSON.stringify({ passed: checks.length, databaseDropped, before: beforePlan['Node Type'],
  after: afterPlan['Node Type'], aiCalls: 0, externalCalls: 0 }));
