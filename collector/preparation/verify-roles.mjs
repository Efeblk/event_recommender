import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertOwned, container, docker, literal, sql, work } from './db.mjs';
import { adaptCanonicalRecord } from './canonical-adapter.mjs';
import { createCanonicalStore } from './canonical-store.mjs';
import { runCanonicalWorker } from './canonical-worker.mjs';
import { createWorkerStore } from './worker-store.mjs';
import { runPreparationWorker } from './worker.mjs';
import { createRefreshStore, runPublicationRefresh } from './refresh-consumer.mjs';
import { createPublicationStore } from './publication-store.mjs';
import { createBatchStore } from './batch-store.mjs';
import { runBatchPreparation, runBatchPublication } from './batch-worker.mjs';

const suffix = randomBytes(6).toString('hex');
const database = `biplan_roles_verify_${suffix}`;
const roleNames = Object.fromEntries(['owner', 'reader', 'prepare', 'web', 'preparer'].map(name => [name, `biplan_verify_${suffix}_${name}`]));
assert.match(database, /^biplan_roles_verify_[0-9a-f]{12}$/);
const migrations = ['schema.sql', 'migrations/002-offer-revisions.sql', 'migrations/003-workers.sql', 'migrations/004-publication-refresh.sql', 'migrations/005-canonical-preparation.sql', 'migrations/006-batched-publication.sql'];
const paths = [...migrations, 'roles.sql', 'verify-roles.mjs', 'canonical-adapter.mjs', 'canonical-store.mjs', 'canonical-worker.mjs',
  'worker-store.mjs', 'worker.mjs', 'refresh-consumer.mjs', 'publication-store.mjs', 'db.mjs', 'batch-store.mjs', 'batch-worker.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async path => [path, createHash('sha256').update(await readFile(resolve(import.meta.dirname, path))).digest('hex')])));
const sourceHashes = await hashes();
const startedAt = new Date().toISOString(), checks = [], runs = [];
let created = false, databaseDropped = false, rolesDropped = false, problem = null;
const query = async statement => {
  await assertOwned();
  return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], `SET statement_timeout='30s';\n${statement}`);
};
const asRole = name => statement => query(`SET ROLE ${roleNames[name]};\n${statement}`);
const preparerQuery = asRole('preparer'), webQuery = asRole('web');
const canonical = createCanonicalStore(preparerQuery);
const publication = createPublicationStore(webQuery, { includeVectors: true });
const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const check = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
const denied = async (name, statement) => assert.rejects(asRole(name)(statement), /permission denied|must be owner|must be superuser|not permitted/i);
const record = { id: 'role-fixture', sourceSessionIds: ['role-fixture'], source: 'bubilet', title: 'Yetki Denemesi',
  category: 'Tiyatro', description: 'Source verified performance.', venue: 'Deneme Sahnesi', district: 'Kadikoy', address: 'Moda Caddesi', city: '\u0130stanbul',
  startsAt: new Date(Date.now() + 86400000).toISOString(), checkedAt: new Date(Date.now() - 60000).toISOString(),
  attendanceTiming: null, price: 19.99, currency: 'TRY', availability: 'available', imageUrl: '',
  url: 'https://www.bubilet.com.tr/istanbul/etkinlik/role-fixture' };
let accepted;

try {
  await assertOwned(); await sql(`CREATE DATABASE ${database};`); created = true;
  for (const path of migrations) await query(await readFile(resolve(import.meta.dirname, path), 'utf8'));
  const roleScript = (await readFile(resolve(import.meta.dirname, 'roles.sql'), 'utf8'))
    .replace(/\bbiplan_(owner|reader|prepare|web|preparer)\b/g, (_, name) => roleNames[name]);
  await check('explicit role installation and replay preserve a closed allowlist', async () => {
    await query(roleScript); await query(roleScript);
    const attributes = JSON.parse(await query(`SELECT jsonb_agg(jsonb_build_object('name',rolname,'login',rolcanlogin,
      'elevated',rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))::text
      FROM pg_roles WHERE rolname IN (${Object.values(roleNames).map(literal).join(',')});`));
    assert.equal(attributes.length, 5); assert.ok(attributes.every(row => !row.elevated));
    for (const row of attributes) assert.equal(row.login, [roleNames.web, roleNames.preparer].includes(row.name));
    assert.equal(await query(`SELECT pg_has_role(${literal(roleNames.web)},${literal(roleNames.owner)},'MEMBER')
      OR pg_has_role(${literal(roleNames.preparer)},${literal(roleNames.owner)},'MEMBER');`), 'f');
  });

  await check('application roles cannot mutate canonical heads, job state, outbox, or publications directly', async () => {
    for (const role of ['web', 'preparer']) {
      for (const table of ['canonical_heads', 'sessions', 'offer_identities', 'preparation_jobs', 'outbox', 'active_publication', 'preparation_batches', 'preparation_batch_items', 'preparation_storage_limits']) {
        await denied(role, `DELETE FROM biplan.${table};`);
        await denied(role, `TRUNCATE biplan.${table};`);
      }
      await denied(role, "UPDATE biplan.publications SET state='validated';");
      await denied(role, "INSERT INTO biplan.outbox(id,topic,aggregate_type,aggregate_id,payload,idempotency_key) VALUES('bad','bad','bad','bad','{}','bad');");
    }
  });

  await check('application roles cannot create roles, schemas, temporary objects, functions, operators, or disable triggers', async () => {
    for (const role of ['web', 'preparer']) {
      await denied(role, `CREATE ROLE biplan_verify_${suffix}_forbidden;`);
      await denied(role, 'CREATE SCHEMA forbidden;');
      await denied(role, 'CREATE TEMP TABLE publications(id text);');
      await denied(role, 'CREATE TABLE public.forbidden(id integer);');
      await denied(role, "CREATE OR REPLACE FUNCTION biplan.canonical_text(text) RETURNS text LANGUAGE sql AS 'SELECT $1';");
      await denied(role, 'CREATE OPERATOR biplan.=== (LEFTARG=integer,RIGHTARG=integer,FUNCTION=pg_catalog.int4eq);');
      await denied(role, 'ALTER TABLE biplan.sessions DISABLE TRIGGER ALL;');
      await denied(role, 'GRANT biplan_owner TO CURRENT_USER;'.replace(/biplan_owner/g, roleNames.owner));
    }
  });

  await check('reader has no preparation or raw-evidence access and preparer cannot bypass guarded entrypoints', async () => {
    await denied('web', 'SELECT * FROM biplan.source_observations;');
    await denied('web', 'SELECT * FROM biplan.preparation_jobs;');
    await denied('web', "SELECT biplan.accept_canonical_observation('{}'::jsonb);");
    for (const role of ['web', 'preparer']) {
      await denied(role, "SELECT biplan.ingest_prepared_payload('{}'::jsonb);");
      await denied(role, 'SELECT biplan.activate_publication(NULL,NULL);');
      await denied(role, "SELECT * FROM biplan.claim_preparation_jobs('bypass',1,interval '1 minute');");
      await denied(role, "SELECT biplan.complete_preparation_job('bypass','bypass',1,NULL);");
      await denied(role, "SELECT biplan.refresh_publication_request_v4('bypass','bypass',1,NULL);");
    }
  });

  await check('restricted preparer executes canonical CAS, fenced preparation, and atomic publication', async () => {
    const adapted = adaptCanonicalRecord(record, await canonical.findHeads(record)); assert.equal(adapted.status, 'ready');
    accepted = await canonical.accept(adapted.payload); assert.equal(accepted.status, 'accepted');
    const result = await runCanonicalWorker({ store: canonical, workerId: 'roles-canonical', maxJobs: 2, timeBudgetMs: 30000 });
    runs.push(result); assert.equal(result.completed, 1); assert.deepEqual(result.failures, []);
    await assert.rejects(canonical.accept({ ...adapted.payload, requestId: `${adapted.requestId}-bad`,
      record: { ...record, description: 'Changed', checkedAt: new Date(Date.parse(record.checkedAt) + 1000).toISOString() },
      expectedCanonicalRevisionId: 'wrong-head', expectedOfferRevisionId: accepted.offerRevisionId }), /guard/i);
    assert.equal(await query(`SELECT count(*) FROM biplan.canonical_revisions WHERE session_id=${literal(accepted.sessionId)};`), '1');
    await assert.rejects(preparerQuery("SELECT biplan.accept_offer_revision('{\"revisionId\":\"invalid\"}'::jsonb,NULL);"), /required typed field/i);
    await assert.rejects(preparerQuery("SELECT biplan.complete_canonical_preparation_job('missing','impostor',1,'{}',NULL);"), /unsupported canonical completion stage/i);
  });

  await check('restricted worker executes derivation, durable outbox, and guarded refresh APIs', async () => {
    const result = await runPreparationWorker({ store: createWorkerStore(preparerQuery), workerId: 'roles-offer', maxJobs: 4, maxEvents: 4, timeBudgetMs: 30000 });
    runs.push(result); assert.equal(result.completedJobs, 1); assert.equal(result.deliveredEvents, 1); assert.deepEqual(result.failures, []);
    const refreshed = await runPublicationRefresh({ store: createRefreshStore(preparerQuery), workerId: 'roles-refresh', maxRequests: 2, timeBudgetMs: 30000 });
    runs.push(refreshed); assert.equal(refreshed.completed, 1); assert.deepEqual(refreshed.failures, []);
  });

  await check('reader pins immutable snapshots, reads compatible vectors, and revalidates via a narrow definer', async () => {
    const read = await publication.readPublication(); assert.equal(read.sessions.length, 1);
    assert.equal(read.sessions[0].sessionId, accepted.sessionId); assert.equal(read.sessions[0].document.vector, null);
    const status = await publication.revalidatePublication(read.publicationId, [accepted.sessionId], new Date().toISOString(), 72 * 3600000);
    assert.equal(status[0].canonicalSessionUsable, true); assert.equal(status[0].availabilityUsable, true);
    const vector = `[${Array.from({ length: 1024 }, (_, i) => i ? 0 : 1).join(',')}]`;
    // Administrator fixture only: a real vector row, read through the production
    // reader's table privileges. The application cannot insert or alter it.
    await query(`INSERT INTO biplan.search_documents(id,subject_type,subject_id,document_profile,embedding_profile,document_text,document_hash,dependency_hash,embedding)
      VALUES('roles-vector','session',${literal(accepted.sessionId)},'fixture','fixture-vector','fixture','fixture','fixture',${literal(vector)}::vector(1024));`);
    assert.equal(await webQuery("SELECT vector_dims(embedding) FROM biplan.search_documents WHERE id='roles-vector';"), '1024');
    await denied('web', "UPDATE biplan.search_documents SET document_text='tampered';");
  });

  await check('restricted batch APIs prepare without publishing and switch one sealed cohort', async () => {
    await query('INSERT INTO biplan.preparation_storage_limits VALUES(true,1073741824,67108864,20000,1048576);');
    const store = createBatchStore(preparerQuery), batchId = 'role-batch', inputHash = 'a'.repeat(64);
    await denied('web', `SELECT biplan.begin_preparation_batch('{}');`);
    await denied('preparer', 'SELECT biplan.check_preparation_storage();');
    await store.begin({ batchId, collectionRunId: batchId, inputHash, scope: 'full', providers: ['bubilet'],
      horizonStart: new Date().toISOString(), horizonEnd: new Date(Date.now() + 2 * 86400000).toISOString() });
    const updated = { ...record, checkedAt: new Date().toISOString() };
    const adapted = adaptCanonicalRecord(updated, await canonical.findHeads(updated));
    assert.equal(adapted.status, 'ready');
    await store.accept(batchId, adapted.payload);
    await store.seal(batchId, { recordCount: 1, inputHash, collectorCoverage: { complete: true, failedPages: 0, unvisited: 0,
      finishedAt: new Date().toISOString(), inventory: [{ provider: 'bubilet', discovered: 1, verified: 1, retired: 0, quarantined: 0, unvisited: 0, failedPages: 0 }] } });
    const before = await store.activePublication();
    const prepared = await runBatchPreparation({ store, batchId, workerId: 'roles-batch', maxJobs: 2 });
    assert.equal(prepared.completed, 1); assert.deepEqual(prepared.failures, []);
    assert.equal(await store.activePublication(), before);
    const published = await runBatchPublication({ store, batchId, workerId: 'roles-publisher' });
    assert.equal(published.published, 1); assert.deepEqual(published.failures, []);
    assert.notEqual(await store.activePublication(), before); runs.push(prepared, published);
  });

  await check('definers use a fixed trusted search path and new owner/admin functions remain closed', async () => {
    const unsafe = await query(`SELECT count(*) FROM pg_proc p WHERE p.pronamespace='biplan'::regnamespace AND p.prosecdef
      AND (p.proowner<>${literal(roleNames.owner)}::regrole OR NOT(COALESCE(p.proconfig,'{}') @> ARRAY['search_path=pg_catalog, biplan, public, pg_temp']));`);
    assert.equal(unsafe, '0');
    await query("CREATE FUNCTION biplan.roles_future_admin() RETURNS integer LANGUAGE sql AS 'SELECT 1';");
    await query(`SET ROLE ${roleNames.owner}; CREATE FUNCTION biplan.roles_future_owner() RETURNS integer LANGUAGE sql AS 'SELECT 1';`);
    for (const role of ['web', 'preparer']) {
      await denied(role, 'SELECT biplan.roles_future_admin();');
      await denied(role, 'SELECT biplan.roles_future_owner();');
      assert.equal(await asRole(role)("SET search_path=public,pg_catalog; SELECT biplan.offer_revision_term('missing') IS NULL;"), 't');
    }
    await query('DROP FUNCTION biplan.roles_future_admin(); DROP FUNCTION biplan.roles_future_owner();');
    await query(roleScript);
    const unrelated = `biplan_verify_${suffix}_forbidden`;
    await query(`CREATE ROLE ${unrelated} NOLOGIN; GRANT CREATE ON SCHEMA public TO ${unrelated};`);
    await assert.rejects(query(roleScript), /schema writable by an unrelated role/);
    await query(`REVOKE CREATE ON SCHEMA public FROM ${unrelated}; DROP ROLE ${unrelated};`);
  });
  assert.deepEqual(await hashes(), sourceHashes, 'Source changed during role verification');
} catch (error) {
  problem = { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 5000) };
} finally {
  if (created) {
    try {
      await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${literal(database)} AND pid<>pg_backend_pid(); DROP DATABASE ${database};`);
      databaseDropped = true;
    } catch (error) { problem ??= { message: `Disposable database cleanup failed: ${error.message}` }; }
  }
  try {
    // Names are random, task-created, and checked; never drop shared deployment roles.
    await sql(`DROP ROLE IF EXISTS ${Object.values(roleNames).reverse().join(',')},biplan_verify_${suffix}_forbidden;`);
    rolesDropped = true;
  } catch (error) { problem ??= { message: `Disposable role cleanup failed: ${error.message}` }; }
  const receipt = { startedAt, finishedAt: new Date().toISOString(), runtime: process.version,
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    dirtyWorkingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim().length > 0,
    database, roleNames, databaseDropped, rolesDropped, sourceHashes, checks, runs, problem, aiCalls: 0, externalCalls: 0,
    limitations: ['Disposable PostgreSQL effective-role tests; no password, Cloud SQL IAM, network authentication, or deployed readiness proof.'] };
  await mkdir(work, { recursive: true });
  await writeFile(resolve(work, `roles-verification-${Date.now()}.json`), JSON.stringify(receipt, null, 2));
}
if (problem) throw new Error(problem.message);
console.log(JSON.stringify({ passed: checks.length, databaseDropped, rolesDropped, aiCalls: 0, externalCalls: 0 }));
