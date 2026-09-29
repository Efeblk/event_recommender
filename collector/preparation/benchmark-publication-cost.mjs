import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertOwned, container, docker, literal, sql, work } from './db.mjs';

// READ ONLY against the main catalog. Only three representative copy generations
// are inserted, in a disposable database. This isolates row/TOAST/index/WAL costs;
// it deliberately does not claim full publication, Cloud SQL, or capacity timing.
const database = `biplan_copy_cost_${randomBytes(6).toString('hex')}`;
assert.match(database, /^biplan_copy_cost_[0-9a-f]{12}$/);
const tables = ['published_sessions', 'publication_offers', 'publication_evaluations'];
const sourcePaths = ['benchmark-publication-cost.mjs', 'db.mjs', 'migrations/004-publication-refresh.sql', 'migrations/005-canonical-preparation.sql'];
const hashSources = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file,
  createHash('sha256').update(await readFile(resolve(import.meta.dirname, file))).digest('hex')])));
const sourceHashes = await hashSources(), startedAt = new Date().toISOString();
let created = false, databaseDropped = false, problem = null, source;
const samples = [];
const quoteShell = text => `'${text.replace(/'/g, `'"'"'`)}'`;
const query = async statement => {
  await assertOwned();
  return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], `SET statement_timeout='60s';\n${statement}`);
};
const sizes = async () => JSON.parse(await query(`SELECT jsonb_object_agg(c.relname,jsonb_build_object(
  'tableBytes',pg_table_size(c.oid),'indexBytes',pg_indexes_size(c.oid),'totalBytes',pg_total_relation_size(c.oid)))::text
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='biplan' AND c.relkind='r';`));
try {
  await assertOwned();
  source = JSON.parse(await sql(`WITH pin AS MATERIALIZED(SELECT publication_id FROM biplan.active_publication WHERE singleton)
    SELECT jsonb_build_object('publicationId',pin.publication_id,'databaseBytes',pg_database_size(current_database()),
      'sessions',(SELECT count(*) FROM biplan.published_sessions WHERE publication_id=pin.publication_id),
      'offers',(SELECT count(*) FROM biplan.publication_offers WHERE publication_id=pin.publication_id),
      'evaluations',(SELECT count(*) FROM biplan.publication_evaluations WHERE publication_id=pin.publication_id),
      'pendingEvaluations',(SELECT count(*) FROM biplan.publication_evaluations pe JOIN biplan.evaluations e ON e.id=pe.evaluation_id
        WHERE pe.publication_id=pin.publication_id AND e.status='pending'),
      'manifest',(SELECT manifest FROM biplan.publications WHERE id=pin.publication_id))::text FROM pin;`));
  assert.ok(source.publicationId && source.sessions > 0);
  await sql(`CREATE DATABASE ${database};`); created = true;
  await query('CREATE SCHEMA biplan;');
  source.tables = {};
  for (const table of tables) {
    const shape = JSON.parse(await sql(`SELECT jsonb_build_object('columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,
      'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull) ORDER BY a.attnum) FROM pg_attribute a
      WHERE a.attrelid=${literal(`biplan.${table}`)}::regclass AND a.attnum>0 AND NOT a.attisdropped),
      'indexes',(SELECT jsonb_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname='biplan' AND tablename=${literal(table)}),
      'logicalRowBytes',(SELECT sum(pg_column_size(t)) FROM biplan.${table} t WHERE publication_id=${literal(source.publicationId)}))::text;`));
    for (const column of shape.columns) assert.match(column.name, /^[a-z_]+$/);
    await query(`CREATE TABLE biplan.${table} (${shape.columns.map(c => `${c.name} ${c.type}${c.notNull ? ' NOT NULL' : ''}`).join(',')});`);
    for (const index of shape.indexes) await query(`${index};`);
    const sourceCopy = `COPY (SELECT * FROM biplan.${table} WHERE publication_id=${literal(source.publicationId)}) TO STDOUT`;
    const targetCopy = `COPY biplan.${table} FROM STDIN`;
    // Data travels directly between local PostgreSQL clients inside the owned
    // container. It is never printed, written into chat, or sent outside the host.
    await assertOwned();
    await docker(['exec', container, 'bash', '-o', 'pipefail', '-c',
      `psql -X -q -v ON_ERROR_STOP=1 -U postgres -d biplan_catalog -c ${quoteShell(sourceCopy)} | psql -X -q -v ON_ERROR_STOP=1 -U postgres -d ${database} -c ${quoteShell(targetCopy)}`]);
    source.tables[table] = { logicalRowBytes: shape.logicalRowBytes, indexes: shape.indexes, columns: shape.columns.length };
  }
  await query('ANALYZE;');
  let previous = await sizes();
  source.isolatedBaselineSizes = previous;
  for (let iteration = 1; iteration <= 3; iteration++) {
    const publicationId = `copy-cost-publication-${iteration}`;
    const sample = { iteration, plans: {}, insertedRows: 0, executionMs: 0, walBytes: 0 };
    for (const table of tables) {
      const cols = JSON.parse(await query(`SELECT jsonb_agg(attname ORDER BY attnum)::text FROM pg_attribute
        WHERE attrelid=${literal(`biplan.${table}`)}::regclass AND attnum>0 AND NOT attisdropped;`));
      const projection = cols.map(name => name === 'publication_id' ? literal(publicationId) : name).join(',');
      const plan = JSON.parse(await query(`EXPLAIN(ANALYZE,BUFFERS,WAL,FORMAT JSON) INSERT INTO biplan.${table}
        SELECT ${projection} FROM biplan.${table} WHERE publication_id=${literal(source.publicationId)};`))[0];
      sample.plans[table] = plan;
      sample.executionMs += plan['Execution Time'];
      sample.walBytes += plan.Plan['WAL Bytes'] ?? 0;
      sample.insertedRows += Number(await query(`SELECT count(*) FROM biplan.${table} WHERE publication_id=${literal(publicationId)};`));
    }
    sample.sizesAfter = await sizes();
    sample.growthBytes = tables.reduce((sum, table) => sum + sample.sizesAfter[table].totalBytes - previous[table].totalBytes, 0);
    previous = sample.sizesAfter;
    samples.push(sample);
    console.log(JSON.stringify({ iteration, insertedRows: sample.insertedRows, growthBytes: sample.growthBytes,
      executionMs: Math.round(sample.executionMs), walBytes: sample.walBytes }));
  }
  assert.deepEqual(await hashSources(), sourceHashes, 'Benchmark source changed during measurement');
  source.activePublicationAfter = await sql('SELECT publication_id FROM biplan.active_publication WHERE singleton;');
  source.activePointerUnchanged = source.activePublicationAfter === source.publicationId;
} catch (error) {
  problem = { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 5000) };
} finally {
  if (created) {
    try {
      await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${literal(database)} AND pid<>pg_backend_pid(); DROP DATABASE ${database};`);
      databaseDropped = true;
    } catch (error) { problem ??= { message: `Disposable database cleanup failed: ${error.message}` }; }
  }
  const average = key => samples.length ? samples.reduce((sum, row) => sum + row[key], 0) / samples.length : null;
  const rowCopies = source ? source.sessions + source.offers + source.pendingEvaluations : null;
  const projection = samples.length ? { observations: 10000, publicationRowsPerSwitch: rowCopies,
    rowInsertsFor10000Switches: rowCopies * 10000, averageCopyGrowthBytes: average('growthBytes'),
    extrapolatedCopyGrowthBytesFor10000Switches: average('growthBytes') * 10000,
    averageCopyWalBytes: average('walBytes'), extrapolatedCopyWalBytesFor10000Switches: average('walBytes') * 10000,
    copyGenerationsFitting10GiBAtMeasuredAverage: Math.floor(10 * 1024 ** 3 / average('growthBytes')) } : null;
  const receipt = { startedAt, finishedAt: new Date().toISOString(), runtime: process.version,
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    dirtyWorkingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim().length > 0,
    sourceHashes, source, samples, projection, database, databaseDropped, problem, aiCalls: 0, externalCalls: 0,
    limitations: ['Three local warm copy-only samples; no latency percentile or Cloud SQL/production throughput claim.',
      'Copies match current table columns/indexes and exact pinned data; foreign keys, triggers, manifest validation, other preparation work and concurrent contention are omitted.',
      '10,000-switch storage/WAL figures are linear extrapolations, not an executed workload; 10 GiB also needs base data, raw evidence, indexes, temporary space and retention headroom.',
      'No main database writes, no provider requests, and no paid inference.'] };
  await mkdir(work, { recursive: true });
  const path = resolve(work, `publication-copy-cost-${Date.now()}.json`);
  await writeFile(path, JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ receipt: path, projection, databaseDropped, problem }));
}
if (problem) throw new Error(problem.message);
