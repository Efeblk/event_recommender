import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertOwned, container, docker, literal, work } from './db.mjs';

const suffix = randomBytes(6).toString('hex');
const database = `biplan_managed_admin_${suffix}`;
const admin = `biplan_managed_admin_${suffix}`;
const roleNames = Object.fromEntries(['owner', 'reader', 'prepare', 'web', 'preparer']
  .map(name => [name, `biplan_managed_${suffix}_${name}`]));
const forbiddenDatabase = `biplan_managed_forbidden_${suffix}`;
const forbiddenRole = `biplan_managed_forbidden_${suffix}`;

assert.match(database, /^biplan_managed_admin_[0-9a-f]{12}$/);
assert.match(admin, /^biplan_managed_admin_[0-9a-f]{12}$/);
assert.match(forbiddenDatabase, /^biplan_managed_forbidden_[0-9a-f]{12}$/);
assert.match(forbiddenRole, /^biplan_managed_forbidden_[0-9a-f]{12}$/);
for (const [kind, name] of Object.entries(roleNames)) {
  assert.match(name, new RegExp(`^biplan_managed_[0-9a-f]{12}_${kind}$`));
}

const migrations = ['schema.sql', 'migrations/002-offer-revisions.sql', 'migrations/003-workers.sql',
  'migrations/004-publication-refresh.sql', 'migrations/005-canonical-preparation.sql',
  'migrations/006-batched-publication.sql', 'migrations/007-page-receipts.sql',
  'migrations/008-offer-evidence-projections.sql'];
const sourcePaths = [...migrations, 'roles.sql', 'verify-managed-admin.mjs'];
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path =>
  [path, createHash('sha256').update(await readFile(resolve(import.meta.dirname, path))).digest('hex')])));
const initialHashes = await sourceHashes();
const roleScript = (await readFile(resolve(import.meta.dirname, 'roles.sql'), 'utf8'))
  .replace(/\bbiplan_(owner|reader|prepare|web|preparer)\b/g, (_, name) => roleNames[name]);
const startedAt = new Date().toISOString();
const checks = [];
let stage = 'snapshot-main-before';
let databaseCreated = false;
let databaseDropped = false;
let rolesDropped = false;
let problem = null;
let mainActivePublicationBefore;
let mainActivePublicationAfter;

const psql = async (user, targetDatabase, statement) => {
  await assertOwned();
  return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
    '-U', user, '-d', targetDatabase], `SET statement_timeout='30s';\n${statement}`);
};
const control = statement => psql('postgres', 'postgres', statement);
const query = (user, statement) => psql(user, database, statement);
const mainActivePublication = () => psql('postgres', 'biplan_catalog', `SELECT COALESCE(
  jsonb_agg(to_jsonb(active) ORDER BY active.singleton),'[]'::jsonb)::text FROM biplan.active_publication active;`);
const check = async (name, fn) => {
  stage = name;
  await fn();
  checks.push(name);
  console.log(`PASS ${name}`);
};
const denied = async (user, statement) => assert.rejects(query(user, statement),
  /permission denied|must be owner|must be superuser|not permitted|must have.*privilege|cannot set role|read-only transaction/i);
const asOwnerDenied = statement => denied(admin, `SET ROLE ${roleNames.owner};\n${statement}`);

try {
  await assertOwned();
  mainActivePublicationBefore = await mainActivePublication();
  stage = 'create-disposable-administrator';
  await control(`CREATE ROLE ${admin} LOGIN NOSUPERUSER CREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS;`);
  stage = 'create-disposable-database';
  await control(`CREATE DATABASE ${database} OWNER ${admin};`);
  databaseCreated = true;

  // The local container needs its superuser for extension installation. This does
  // not simulate or prove Cloud SQL's managed extension permissions.
  stage = 'preinstall-local-extensions';
  await query('postgres', 'CREATE EXTENSION postgis; CREATE EXTENSION vector; CREATE EXTENSION pg_trgm;');
  for (const path of migrations) {
    stage = `initial-migration:${path}`;
    await query(admin, await readFile(resolve(import.meta.dirname, path), 'utf8'));
  }

  await check('non-superuser managed administrator installs and replays the role policy', async () => {
    await query(admin, roleScript);
    await query(admin, roleScript);
    const attributes = JSON.parse(await query(admin, `SELECT jsonb_agg(jsonb_build_object(
      'name',rolname,'login',rolcanlogin,'elevated',rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
      ORDER BY rolname)::text FROM pg_roles WHERE rolname IN (${Object.values(roleNames).map(literal).join(',')});`));
    assert.equal(attributes.length, 5);
    assert.ok(attributes.every(row => !row.elevated));
    for (const row of attributes) assert.equal(row.login, [roleNames.web, roleNames.preparer].includes(row.name));
    assert.equal(await query(admin, `SELECT count(*) FROM pg_auth_members m
      WHERE m.roleid=${literal(roleNames.owner)}::regrole AND m.member<>${literal(admin)}::regrole;`), '0');
    assert.equal(await query(admin, `SELECT bool_or(inherit_option) AND bool_or(set_option) FROM pg_auth_members
      WHERE roleid=${literal(roleNames.owner)}::regrole AND member=${literal(admin)}::regrole;`), 't');
    assert.equal(await query(admin, `SELECT count(*) FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
      WHERE m.roleid=${literal(roleNames.owner)}::regrole AND member.rolname IN
      (${Object.values(roleNames).map(literal).join(',')});`), '0');
  });

  await check('owner and application logins retain closed database and schema privileges', async () => {
    assert.equal(await query(admin, `SELECT has_database_privilege(${literal(roleNames.owner)},current_database(),'CONNECT')
      AND NOT has_database_privilege(${literal(roleNames.owner)},current_database(),'CREATE')
      AND NOT has_database_privilege(${literal(roleNames.owner)},current_database(),'TEMP');`), 't');
    await asOwnerDenied('CREATE SCHEMA managed_owner_forbidden;');
    await asOwnerDenied('CREATE TEMP TABLE managed_owner_forbidden(id integer);');
    await asOwnerDenied(`CREATE ROLE ${forbiddenRole} NOLOGIN;`);
    await asOwnerDenied(`ALTER ROLE ${roleNames.owner} CREATEDB;`);
    for (const name of ['web', 'preparer']) {
      const user = roleNames[name];
      await denied(user, `CREATE DATABASE ${forbiddenDatabase};`);
      await denied(user, `CREATE SCHEMA managed_${name}_forbidden;`);
      await denied(user, `CREATE TEMP TABLE managed_${name}_forbidden(id integer);`);
      await denied(user, `CREATE ROLE ${forbiddenRole} NOLOGIN;`);
      await denied(user, `ALTER ROLE ${user} CREATEDB;`);
      await denied(user, `SET ROLE ${roleNames.owner};`);
      await denied(user, `SET ROLE ${admin};`);
    }
    assert.equal(await query(admin, `SELECT NOT rolcanlogin AND NOT rolcreatedb AND NOT rolcreaterole
      FROM pg_roles WHERE rolname=${literal(roleNames.owner)};`), 't');
  });

  await check('administrator can replay reviewed migrations and update owner objects', async () => {
    await query(admin, 'ALTER TABLE biplan.schema_metadata ADD COLUMN managed_admin_probe boolean;');
    for (const path of migrations) await query(admin, await readFile(resolve(import.meta.dirname, path), 'utf8'));
    await query(admin, roleScript);
    assert.equal(await query(admin, `SELECT tableowner=${literal(roleNames.owner)} FROM pg_tables
      WHERE schemaname='biplan' AND tablename='schema_metadata';`), 't');
    assert.equal(await query(admin, `SELECT pg_get_userbyid(proowner)=${literal(roleNames.owner)}
      FROM pg_proc WHERE oid='biplan.canonical_text(text)'::regprocedure;`), 't');
    await query(admin, 'ALTER TABLE biplan.schema_metadata DROP COLUMN managed_admin_probe;');
    await query(admin, roleScript);
  });

  await check('future administrator and owner functions stay closed by default', async () => {
    await query(admin, "CREATE FUNCTION biplan.managed_admin_future_admin() RETURNS integer LANGUAGE sql AS 'SELECT 1';");
    await query(admin, `SET ROLE ${roleNames.owner};
      CREATE FUNCTION biplan.managed_admin_future_owner() RETURNS integer LANGUAGE sql AS 'SELECT 1';`);
    for (const name of ['web', 'preparer']) {
      await denied(roleNames[name], 'SELECT biplan.managed_admin_future_admin();');
      await denied(roleNames[name], 'SELECT biplan.managed_admin_future_owner();');
    }
    await query(admin, 'DROP FUNCTION biplan.managed_admin_future_admin(); DROP FUNCTION biplan.managed_admin_future_owner();');
    await query(admin, roleScript);
  });

  stage = 'verify-source-and-main-database-unchanged';
  assert.deepEqual(await sourceHashes(), initialHashes, 'Source changed during managed-admin verification');
  mainActivePublicationAfter = await mainActivePublication();
  assert.equal(mainActivePublicationAfter, mainActivePublicationBefore, 'Main database active publication changed');
  stage = 'complete';
} catch (error) {
  problem = { stage, message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 5000) };
} finally {
  if (mainActivePublicationAfter === undefined) {
    try {
      mainActivePublicationAfter = await mainActivePublication();
      if (mainActivePublicationBefore !== undefined && mainActivePublicationAfter !== mainActivePublicationBefore) {
        problem ??= { stage: 'verify-main-database-unchanged', message: 'Main database active publication changed' };
      }
    } catch (error) {
      problem ??= { stage: 'snapshot-main-after', message: `Main database verification failed: ${error.message}` };
    }
  }
  try {
    await control(`DROP DATABASE IF EXISTS ${forbiddenDatabase} WITH (FORCE);`);
    if (databaseCreated) {
      await control(`DROP DATABASE IF EXISTS ${database} WITH (FORCE);`);
      databaseDropped = true;
    }
  } catch (error) {
    problem ??= { message: `Disposable database cleanup failed: ${error.message}` };
  }
  try {
    await control(`DROP ROLE IF EXISTS ${forbiddenRole},${Object.values(roleNames).reverse().join(',')},${admin};`);
    rolesDropped = true;
  } catch (error) {
    problem ??= { message: `Disposable role cleanup failed: ${error.message}` };
  }
  const receipt = {
    startedAt, finishedAt: new Date().toISOString(), runtime: process.version,
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    dirtyWorkingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim().length > 0,
    database, admin, roleNames, databaseDropped, rolesDropped, sourceHashes: initialHashes,
    mainActivePublicationHashBefore: mainActivePublicationBefore === undefined ? null
      : createHash('sha256').update(mainActivePublicationBefore).digest('hex'),
    mainActivePublicationHashAfter: mainActivePublicationAfter === undefined ? null
      : createHash('sha256').update(mainActivePublicationAfter).digest('hex'),
    stage, checks, problem,
    aiCalls: 0, externalCalls: 0,
    limitations: ['Local disposable PostgreSQL simulation; extensions were installed by the local superuser. No Cloud SQL, IAM, network, or managed-extension behavior was exercised.']
  };
  await mkdir(work, { recursive: true });
  await writeFile(resolve(work, `managed-admin-verification-${Date.now()}.json`), JSON.stringify(receipt, null, 2));
}

if (problem) throw new Error(problem.message);
console.log(JSON.stringify({ passed: checks.length, databaseDropped, rolesDropped, aiCalls: 0, externalCalls: 0 }));
