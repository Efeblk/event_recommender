import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectorPageReceiptFromReport, pageBatchInputHash } from './collector-page-receipt.mjs';
import { createCanonicalStore } from './canonical-store.mjs';
import { assertOwned, container, docker, sql, work } from './db.mjs';
import { ingestPageBatchSource, validatePageBatchEnvelope } from './page-batch-source.mjs';
import { createPageBatchSourceStore } from './page-batch-source-store.mjs';

const suffix = randomBytes(6).toString('hex'), database = `biplan_page_source_verify_${suffix}`;
const migrations = ['schema.sql', 'migrations/002-offer-revisions.sql', 'migrations/003-workers.sql', 'migrations/004-publication-refresh.sql',
  'migrations/005-canonical-preparation.sql', 'migrations/006-batched-publication.sql', 'migrations/007-page-receipts.sql'];
const paths = [...migrations, 'canonical-adapter.mjs', 'canonical-store.mjs', 'batch-store.mjs', 'collector-page-receipt.mjs',
  'page-batch-source-store.mjs', 'page-batch-source.mjs', 'verify-page-source.mjs', '../../web/lib/sql-literal.ts'];
async function hashes() { return Object.fromEntries(await Promise.all(paths.map(async path => [path,
  createHash('sha256').update(await readFile(resolve(import.meta.dirname, path))).digest('hex')]))); }
const sourceHashes = await hashes(), artifact = process.env.BIPLAN_PAGE_SOURCE_ARTIFACT
  ? resolve(process.env.BIPLAN_PAGE_SOURCE_ARTIFACT)
  : resolve(work, 'latest-collector-36638393923/collector/output/report.json');
let artifactBody = null;
try { artifactBody = await readFile(artifact); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const artifactHash = artifactBody ? createHash('sha256').update(artifactBody).digest('hex') : null;
const startedAt = new Date().toISOString(), checks = []; let created = false, dropped = false, problem = null;
let actualArtifactAudit = artifactBody ? { present: true, validated: false } : { present: false, validated: false, reason: 'optional_local_artifact_absent' };
const query = async statement => { await assertOwned(); return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '-U', 'postgres', '-d', database], `SET statement_timeout='30s';\n${statement}`); };
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };

try {
  await assertOwned(); await sql(`CREATE DATABASE ${database};`); created = true;
  for (const migration of migrations) await query(await readFile(resolve(import.meta.dirname, migration), 'utf8'));
  await query('INSERT INTO biplan.preparation_storage_limits VALUES(true,1073741824,67108864,20000,1048576);');
  const databaseNow = Date.parse(await query("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"');"));
  const iso = offset => new Date(databaseNow + offset).toISOString(), checkedAt = iso(-30000), pageAt = iso(-12900);
  const activeUrl = 'https://www.bubilet.com.tr/istanbul/etkinlik/page-source-integration';
  const retiredUrl = 'https://www.bubilet.com.tr/istanbul/etkinlik/page-source-retired';
  const event = (id, offset) => ({ id, source: 'bubilet', sourceSessionIds: [id], canonicalProductionKey: `integration:${id}`,
    title: `Page Source ${id}`, description: 'Preserved source evidence.', venue: 'Page Source Venue', district: 'Kadıköy', address: 'Page Source Street',
    city: 'İstanbul', category: 'Tiyatro', startsAt: iso(offset), checkedAt, price: 100, currency: 'TRY', availability: 'available', url: activeUrl, imageUrl: '' });
  const records = [event('session-a', 86400000), event('session-b', 2 * 86400000)];
  const report = { schemaVersion: 1, startedAt: iso(-60000), finishedAt: iso(-5000), pages: [
    { source: 'bubilet', url: activeUrl, checkedAt: pageAt, contentHash: 'a'.repeat(64), parserVersion: 'fixture-v1', events: records },
    { source: 'bubilet', url: retiredUrl, checkedAt: iso(-86400000), retiredAt: iso(-86400000), contentHash: 'b'.repeat(64),
      parserVersion: 'fixture-v1', events: [], recoveredFromCoverage: true }],
    listings: [{ source: 'bubilet', url: 'https://www.bubilet.com.tr/istanbul/etkinlikler', completion: 'exhausted' }], failures: [], quarantined: [],
    summary: { blocked: null, carried: 5, quarantined: 0, complete: false, sourceCoverage: { bubilet: { discovered: 2, attempted: 1,
      verified: 1, retired: 1, quarantined: 0, unattemptedThisRun: 1, unvisited: 0, stale: 1, failure: 0, complete: false } } } };
  const envelope = collectorPageReceiptFromReport(report, { batchId: 'page-source-integration', collectionRunId: 'legacy-page-source-integration' });
  const store = createPageBatchSourceStore(query), canonicalStore = createCanonicalStore(query);
  let runs = 0, result;
  await check('bounded resume checkpoints a multi-session page, empty retirement and both records', async () => {
    do { result = await ingestPageBatchSource(envelope, { store, canonicalStore, limit: 1, now: () => new Date(databaseNow) }); runs++; assert.ok(runs < 10); }
    while (!result.sealed);
    assert.equal(runs, 4); assert.equal(result.replayed, 3); assert.equal(result.seal.status, 'sealed');
    assert.equal(await query('SELECT count(*) FROM biplan.source_page_observations;'), '2');
    assert.equal(await query('SELECT count(*) FROM biplan.preparation_batch_items;'), '2');
    assert.equal(await query("SELECT string_agg(status,',' ORDER BY request_id) FROM biplan.preparation_batch_items;"), 'accepted,accepted');
  });
  await check('original page clocks and normalized/raw hashes remain distinct', async () => {
    assert.equal(await query(`SELECT count(*) FROM biplan.source_page_observations WHERE observed_at IN ('${pageAt}'::timestamptz,'${iso(-86400000)}'::timestamptz);`), '2');
    const stored = JSON.parse(await query("SELECT payload::text FROM biplan.source_page_observations WHERE source_url LIKE '%page-source-integration';"));
    assert.equal(stored.observedAt, pageAt); assert.equal(stored.rawResponseHash, 'a'.repeat(64)); assert.notEqual(stored.evidenceHash, stored.rawResponseHash);
  });
  await check('changed hash-bound input fails closed and no publication pointer is created', async () => {
    const changed = structuredClone(envelope); changed.pages[0].evidenceHash = 'c'.repeat(64); changed.header.inputHash = pageBatchInputHash(changed);
    await assert.rejects(ingestPageBatchSource(changed, { store, canonicalStore, limit: 1, now: () => new Date(databaseNow) }), /different header|changed|reused/i);
    assert.equal(await query('SELECT count(*) FROM biplan.publications;'), '0'); assert.equal(await query('SELECT count(*) FROM biplan.active_publication;'), '0');
  });
  if (artifactBody) await check('optional preserved artifact adapts read-only without claiming its records were ingested', async () => {
    const preserved = JSON.parse(artifactBody.toString('utf8'));
    const adapted = collectorPageReceiptFromReport(preserved, { batchId: 'legacy-36638393923', collectionRunId: 'legacy-cycle-36638393923' });
    validatePageBatchEnvelope(adapted, { now: () => new Date(Date.parse(preserved.finishedAt) + 86400000) });
    actualArtifactAudit = { present: true, validated: true, pages: adapted.pages.length, records: adapted.records.length,
      currentRunPages: adapted.pages.filter(page => page.origin === 'current_run').length,
      recoveredPages: adapted.pages.filter(page => page.origin === 'recovered').length,
      carriedNotSubmitted: adapted.collectorCoverage.records.carried, scope: adapted.header.scope, complete: adapted.collectorCoverage.complete,
      databaseWritesForArtifact: 0 };
  });
  assert.deepEqual(await hashes(), sourceHashes);
} catch (error) { problem = { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 4000) }; }
finally {
  if (created) { await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${database}' AND pid<>pg_backend_pid(); DROP DATABASE ${database};`); dropped = true; }
  await mkdir(work, { recursive: true }); await writeFile(resolve(work, `page-source-verification-${Date.now()}.json`), JSON.stringify({ startedAt,
    finishedAt: new Date().toISOString(), runtime: process.version, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim().length > 0, database, databaseDropped: dropped,
    artifact, artifactHash, actualArtifactAudit, sourceHashes, checks, problem, databaseWrites: created, publicationCalls: 0, providerCalls: 0, apiCalls: 0, aiCalls: 0,
    limitations: ['representative preserved page families; no full artifact import, publication, provider request, cloud call or capacity claim'] }, null, 2));
}
if (problem) throw new Error(problem.message);
console.log(JSON.stringify({ passed: checks.length, databaseDropped: dropped, publicationCalls: 0, providerCalls: 0, apiCalls: 0, aiCalls: 0 }));
