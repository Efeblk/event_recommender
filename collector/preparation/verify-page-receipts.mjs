import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertOwned, container, docker, literal, sql, work } from './db.mjs';
import { adaptCanonicalRecord, canonicalRequestId } from './canonical-adapter.mjs';
import { createCanonicalStore } from './canonical-store.mjs';
import { createBatchStore } from './batch-store.mjs';
import { runBatchPreparation, runBatchPublication } from './batch-worker.mjs';
import { runCanonicalWorker } from './canonical-worker.mjs';

const suffix = randomBytes(6).toString('hex'), database = `biplan_pages_verify_${suffix}`;
const roleNames = Object.fromEntries(['owner', 'reader', 'prepare', 'web', 'preparer'].map(k => [k, `biplan_pages_${suffix}_${k}`]));
const migrations = ['schema.sql', 'migrations/002-offer-revisions.sql', 'migrations/003-workers.sql', 'migrations/004-publication-refresh.sql',
  'migrations/005-canonical-preparation.sql', 'migrations/006-batched-publication.sql', 'migrations/007-page-receipts.sql'];
const paths = [...migrations, 'roles.sql', 'verify-page-receipts.mjs'];
const hashes = async () => Object.fromEntries(await Promise.all(paths.map(async p => [p, createHash('sha256').update(await readFile(resolve(import.meta.dirname, p))).digest('hex')])));
const sourceHashes = await hashes(), startedAt = new Date().toISOString(), checks = [], runs = [];
let created = false, databaseDropped = false, rolesDropped = false, problem = null;
const query = async statement => { await assertOwned(); return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database], `SET statement_timeout='30s';\n${statement}`); };
const prepQuery = s => query(`SET ROLE ${roleNames.preparer};\n${s}`);
const webQuery = s => query(`SET ROLE ${roleNames.web};\n${s}`);
const j = x => `${literal(JSON.stringify(x))}::jsonb`;
const invoke = (fn, ...args) => prepQuery(`SELECT biplan.${fn}(${args.join(',')})::text;`).then(JSON.parse);
const canonical = createCanonicalStore(prepQuery), batch = createBatchStore(prepQuery);
const sha = x => createHash('sha256').update(x).digest('hex');
const clock = Date.now(), stamp = new Date(clock - 20000).toISOString(), cycleStart = new Date(clock - 60000).toISOString();
const urls = { bubilet: 'https://www.bubilet.com.tr/istanbul/etkinlik/page-fixture', biletinial: 'https://biletinial.com/tr-tr/tiyatro/page-fixture' };
const providers = ['biletinial', 'bubilet'];
const event = (provider, index, observed = stamp) => ({ id: `${provider}-page-${index}`, source: provider, sourceSessionIds: [`${provider}-page-${index}`],
  title: `Page Play ${index}`, description: 'Source verified performance.', category: 'Tiyatro', venue: 'Page Venue', district: 'Kadikoy', address: 'Page Street', city: '\u0130stanbul',
  startsAt: new Date(clock + (index + 1) * 86400000).toISOString(), checkedAt: observed, attendanceTiming: null, price: 100, currency: 'TRY', availability: 'available', url: urls[provider], imageUrl: '' });
const header = (id, scope = 'full') => ({ schemaVersion: 2, batchId: id, collectionRunId: id, inputHash: sha(id), scope, providers,
  startedAt: cycleStart, horizonStart: scope === 'legacy_incremental' ? null : new Date(clock).toISOString(),
  horizonEnd: scope === 'legacy_incremental' ? null : new Date(clock + 30 * 86400000).toISOString(), scopeEvidence: { geography: 'Istanbul', listingConfigHash: sha('listings') } });
const page = (id, provider, records, status = 'verified', observedAt = records[0]?.checkedAt ?? stamp, extra = {}) => ({ pageId: id, provider, url: urls[provider],
  observedAt, sourceUpdatedAt: null, evidenceHash: sha(id), evidenceKind: 'normalized_page', parserVersion: 'fixture-v1', status, origin: 'current_run', originRunId: id,
  records: records.map(r => ({ requestId: canonicalRequestId(r), sourceRecordId: r.id })), complete: true, ...extra });
function coverage(pages, records, full = true, extra = {}) {
  const inventory = providers.map(provider => { const own = pages.filter(p => p.provider === provider && p.origin === 'current_run');
    return { provider, known: own.length, attemptedThisRun: own.length, verifiedThisRun: own.filter(p => p.status === 'verified').length,
      retiredThisRun: own.filter(p => p.status === 'retired').length, failedThisRun: own.filter(p => p.status === 'failed').length,
      quarantinedThisRun: own.filter(p => p.status === 'quarantined').length, unattemptedThisRun: 0, neverVisited: 0, stale: 0, outstandingFailures: 0 }; });
  const identities = pages.map(p => ({ provider: p.provider, url: p.url })).sort((a, b) => a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.url < b.url ? -1 : 1);
  const oldest = new Date(Math.min(...pages.map(p => Date.parse(p.observedAt)), ...records.map(r => Date.parse(r.checkedAt)))).toISOString();
  return { schemaVersion: 2, complete: full, finishedAt: new Date().toISOString(), discovery: { unit: 'detail_url', listingConfigHash: sha('listings'),
    inventoryHash: sha(identities.map(x => `${x.provider}\t${x.url}\n`).join('')), urls: identities, exhausted: true }, inventory,
    records: { unit: 'event_record', submitted: records.length, currentRun: records.length, recovered: 0, carried: 0, sourceQuarantined: 0 },
    freshness: { maxSourceAgeMs: 86400000, oldestResolvedAt: full ? oldest : null, validUntil: full ? new Date(Date.parse(oldest) + 86400000).toISOString() : null }, ...extra };
}
const check = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
const begin = h => invoke('begin_preparation_batch_v2', j(h));
const savePage = (id, p) => invoke('record_batch_page', literal(id), j({ ...p, originRunId: p.origin === 'current_run' ? id : null }));
const seal = (h, pages, records, c = coverage(pages, records)) => invoke('seal_preparation_batch_v2', literal(h.batchId), j({ inputHash: h.inputHash, recordCount: records.length, pageCount: pages.length, collectorCoverage: c }));
async function accept(id, records) { const results = []; for (const r of records) { const a = adaptCanonicalRecord(r, await canonical.findHeads(r)); assert.equal(a.status, 'ready'); results.push(await batch.accept(id, a.payload)); } return results; }
async function publish(id) {
  const prepared = await runBatchPreparation({ store: batch, batchId: id, workerId: 'page-worker', maxJobs: 10 }); runs.push(prepared); assert.deepEqual(prepared.failures, []);
  const published = await runBatchPublication({ store: batch, batchId: id, workerId: 'page-publisher' }); runs.push(published); assert.deepEqual(published.failures, []); assert.equal(published.published, 1); return published.receipt.resultPublicationId;
}
let initial, accepted, firstPages, firstRecords;
try {
  await assertOwned(); await sql(`CREATE DATABASE ${database};`); created = true;
  for (const path of migrations) await query(await readFile(resolve(import.meta.dirname, path), 'utf8'));
  await query('INSERT INTO biplan.preparation_storage_limits VALUES(true,1073741824,67108864,20000,1048576);');
  const roles = (await readFile(resolve(import.meta.dirname, 'roles.sql'), 'utf8')).replace(/\bbiplan_(owner|reader|prepare|web|preparer)\b/g, (_, k) => roleNames[k]);
  await query(roles);
  await check('one detail URL supports multiple records; full inventory and normalized counts remain independent', async () => {
    const h = header('full-pages'); firstRecords = [event('bubilet', 0), event('bubilet', 1), event('biletinial', 0)];
    firstPages = [page('a-page', 'bubilet', firstRecords.slice(0, 2)), page('b-page', 'biletinial', firstRecords.slice(2))];
    await begin(h);
    await assert.rejects(invoke('record_batch_page', literal(h.batchId), j({ ...firstPages[0], originRunId: 'wrong-cycle' })), /invalid v2 page/i);
    for (const p of firstPages) await savePage(h.batchId, p); accepted = await accept(h.batchId, firstRecords);
    assert.equal(accepted[0].sessionId, accepted[2].sessionId);
    assert.equal((await seal(h, firstPages, firstRecords)).status, 'sealed'); initial = await publish(h.batchId);
    const manifest = JSON.parse(await query(`SELECT manifest::text FROM biplan.publications WHERE id=${literal(initial)};`));
    assert.equal(manifest.collectorCoverage.records.submitted, 3); assert.equal(manifest.collectorCoverage.discovery.urls.length, 2);
    assert.equal(manifest.collectorCoverage.schemaVersion, 2); assert.equal(manifest.preparationReceipt.publicationId, initial);
    const replay = await savePage(h.batchId, firstPages[0]); assert.equal(replay.idempotent, true);
    await assert.rejects(savePage(h.batchId, { ...firstPages[0], evidenceHash: sha('tampered') }), /reused/i);
  });
  await check('empty retirement invalidates only linked provider offers immediately and blocks unsupported reconciliation', async () => {
    const h = header('negative-pages', 'incremental'), p = page('a-retired', 'bubilet', [], 'retired', new Date(clock - 10000).toISOString());
    await begin(h); await savePage(h.batchId, p);
    const status = JSON.parse(await webQuery(`SELECT biplan.current_publication_offer_status(${literal(initial)},${literal(accepted[0].sessionId)})::text;`));
    assert.equal(status.canonicalSessionUsable, false);
    const supports = status.canonicalOfferSupport.pageSupport;
    assert.equal(supports.find(x => x.offerId === accepted[0].offerId)?.usable, false);
    assert.equal(supports.find(x => x.offerId === accepted[2].offerId)?.usable, true);
    assert.equal(await query(`SELECT status FROM biplan.sessions WHERE id=${literal(accepted[0].sessionId)};`), 'scheduled');
    assert.equal((await seal(h, [p], [], coverage([p], [], false))).status, 'blocked');
    assert.equal(await batch.activePublication(), initial); await batch.cancel(h.batchId, 'fixture negative hold');
  });
  await check('older source pages do not clear negative evidence and newer complete pages must reconcile all sessions', async () => {
    const h = header('older-page', 'incremental'); await begin(h);
    const old = page('older-page-observation', 'bubilet', firstRecords.slice(0, 2), 'verified', stamp);
    assert.equal((await savePage(h.batchId, old)).status, 'stale'); await batch.cancel(h.batchId, 'fixture stale');
    const h2 = header('missing-session', 'incremental'), only = event('bubilet', 0, new Date(clock - 5000).toISOString()), p = page('missing-session-page', 'bubilet', [only]);
    await begin(h2); await savePage(h2.batchId, p); await accept(h2.batchId, [only]);
    assert.equal((await seal(h2, [p], [only], coverage([p], [only], false))).status, 'blocked'); await batch.cancel(h2.batchId, 'fixture missing session');
  });
  await check('full coverage cannot omit URL identities or misstate source expiry', async () => {
    const h = header('coverage-denials'); const records = [event('bubilet', 4), event('bubilet', 5)].map(r => ({ ...r, url: `${urls.bubilet}-coverage` }));
    const p = page('coverage-denials-page', 'bubilet', records, 'verified', stamp, { url: records[0].url });
    await begin(h); await savePage(h.batchId, p); await accept(h.batchId, records);
    const c = coverage([p], records); delete c.discovery.urls; c.discovery.inventoryHash = null;
    await assert.rejects(seal(h, [p], records, c), /coverage|inventory|record/i);
    const expired = coverage([p], records); expired.freshness.maxSourceAgeMs = 1; expired.freshness.validUntil = new Date(Date.parse(stamp) + 1).toISOString();
    await assert.rejects(seal(h, [p], records, expired), /freshness expired/i);
    const omitted = coverage([p], records); omitted.discovery.urls.push({ provider: 'bubilet', url: `${urls.bubilet}-omitted` });
    omitted.discovery.inventoryHash = sha(omitted.discovery.urls.map(x => `${x.provider}\t${x.url}\n`).join(''));
    omitted.inventory.find(x => x.provider === 'bubilet').known++; omitted.inventory.find(x => x.provider === 'bubilet').unattemptedThisRun++;
    await assert.rejects(seal(h, [p], records, omitted), /coverage|inventory/i); await batch.cancel(h.batchId, 'fixture invalid full');
  });
  await check('a newer complete page reconciles the entire provider family before publication resumes', async () => {
    const h = header('reconciled-pages', 'incremental'), records = [event('bubilet', 0, new Date(clock - 1000).toISOString()), event('bubilet', 1, new Date(clock - 1000).toISOString())];
    const p = page('reconciled-page', 'bubilet', records); await begin(h); await savePage(h.batchId, p); await accept(h.batchId, records);
    assert.equal((await seal(h, [p], records, coverage([p], records, false))).status, 'sealed'); await publish(h.batchId);
  });
  await check('recovered records retain their original clocks and cannot establish a current full refresh', async () => {
    const h = header('recovered-records'), records = [event('bubilet', 6)].map(r => ({ ...r, url: `${urls.bubilet}-recovered` }));
    const p = page('recovered-record-page', 'bubilet', records, 'verified', stamp, { origin: 'recovered', url: records[0].url });
    await begin(h); await savePage(h.batchId, p); await accept(h.batchId, records);
    const c = coverage([p], records); const item = c.inventory.find(x => x.provider === 'bubilet'); item.known = 1; item.unattemptedThisRun = 1;
    c.records.currentRun = 0; c.records.recovered = 1;
    await assert.rejects(seal(h, [p], records, c), /coverage|inventory/i);
    c.complete = false; c.freshness.oldestResolvedAt = null; c.freshness.validUntil = null;
    assert.equal((await seal(h, [p], records, c)).status, 'sealed'); await publish(h.batchId);
    assert.equal(await query(`SELECT to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM biplan.source_page_observations WHERE id='recovered-record-page';`), stamp);
  });
  await check('provider update clocks defeat later fetches and missing clocks remain held', async () => {
    const h = header('clock-evidence', 'incremental'), url = `${urls.bubilet}-clock`; await begin(h);
    const p = page('clock-first', 'bubilet', [], 'verified', stamp, { url, sourceUpdatedAt: new Date(clock - 30000).toISOString() });
    assert.equal((await savePage(h.batchId, p)).status, 'accepted');
    assert.equal((await savePage(h.batchId, { ...p, pageId: 'clock-regression', observedAt: new Date(clock - 15000).toISOString(), sourceUpdatedAt: new Date(clock - 40000).toISOString() })).status, 'stale');
    assert.equal((await savePage(h.batchId, { ...p, pageId: 'clock-missing', observedAt: new Date(clock - 10000).toISOString(), sourceUpdatedAt: null })).status, 'held');
    await batch.cancel(h.batchId, 'fixture source clock');
  });
  await check('legacy unknown horizon and carried state remain explicit incremental provenance', async () => {
    const h = header('legacy-empty', 'legacy_incremental'); await begin(h);
    const c = { schemaVersion: 2, complete: false, finishedAt: new Date().toISOString(), discovery: { unit: 'detail_url', listingConfigHash: sha('listings'), inventoryHash: null, exhausted: true },
      inventory: providers.map(provider => ({ provider, known: 5, attemptedThisRun: 1, verifiedThisRun: 0, retiredThisRun: 0, failedThisRun: 1, quarantinedThisRun: 0, unattemptedThisRun: 4, neverVisited: 0, stale: 2, outstandingFailures: 3 })),
      records: { unit: 'event_record', submitted: 0, currentRun: 0, recovered: 0, carried: 6189, sourceQuarantined: 0 },
      freshness: { maxSourceAgeMs: 86400000, oldestResolvedAt: null, validUntil: null } };
    assert.equal((await seal(h, [], [], c)).status, 'sealed'); const id = await publish(h.batchId);
    const m = JSON.parse(await query(`SELECT manifest::text FROM biplan.publications WHERE id=${literal(id)};`));
    assert.equal(m.collectorCoverage.complete, false); assert.equal(m.collectorCoverage.horizonStart, null);
    assert.equal(m.previousFullCoverage.finishedAt, JSON.parse(await query(`SELECT manifest::text FROM biplan.publications WHERE id=${literal(initial)};`)).collectorCoverage.finishedAt);
    await query(`UPDATE biplan.publications SET state='validated' WHERE id=${literal(initial)}; SELECT biplan.activate_publication(${literal(initial)},${literal(id)});`);
    const status = JSON.parse(await webQuery(`SELECT biplan.current_publication_offer_status(${literal(initial)},${literal(accepted[1].sessionId)})::text;`));
    assert.equal(status.canonicalSessionUsable, false);
  });
  await check('restricted clients cannot edit page evidence or bypass guarded internal publishers', async () => {
    for (const statement of ['DELETE FROM biplan.source_page_heads;', 'DELETE FROM biplan.source_page_observations;', "SELECT biplan.publish_preparation_batch_v6('x','x','x',1,NULL);"])
      await assert.rejects(prepQuery(statement), /permission denied/i);
    await assert.rejects(webQuery("SELECT biplan.begin_preparation_batch_v2('{}');"), /permission denied/i);
  });
  await check('preserved real artifact demonstrates URL versus record units without inventing a horizon', async () => {
    const audit = JSON.parse(await readFile(resolve(work, 'collector-artifact-audit-36638393923.json'), 'utf8'));
    const report = JSON.parse(await readFile(resolve(work, 'latest-collector-36638393923/collector/output/report.json'), 'utf8'));
    assert.equal(audit.collection.scope.declaredHorizon, null); assert.equal(audit.inventory.knownDetailUrls, 4516);
    assert.ok(report.pages.some(p => p.events.length > 1)); assert.equal(audit.preservation.reconciledReportPageRecords, 8004);
    assert.equal(audit.preservation.currentRunRefreshedRecords + audit.preservation.recoveredUnpublishedRecords, 8004);
  });
  await check('full coverage cannot copy an omitted eligible legacy offer; incomplete scope remains explicit', async () => {
    const legacy = { ...event('bubilet', 20), url: `${urls.bubilet}-legacy` };
    const adapted = adaptCanonicalRecord(legacy, await canonical.findHeads(legacy)); assert.equal(adapted.status, 'ready');
    const acceptedLegacy = await canonical.accept(adapted.payload);
    const oldPrepared = await runCanonicalWorker({ store: canonical, workerId: 'legacy-fixture', maxJobs: 10, timeBudgetMs: 30000 });
    assert.deepEqual(oldPrepared.failures, []); const before = await batch.activePublication();
    assert.equal(await query(`SELECT count(*) FROM biplan.published_sessions WHERE publication_id=${literal(before)} AND session_id=${literal(acceptedLegacy.sessionId)};`), '1');
    assert.equal(JSON.parse(await webQuery(`SELECT biplan.offer_page_support(${literal(acceptedLegacy.offerId)})::text;`)).status, 'legacy_no_page');
    const h = { ...header('full-omitted-legacy'), horizonStart: new Date(clock + 20 * 86400000).toISOString(), horizonEnd: new Date(clock + 23 * 86400000).toISOString() };
    const record = { ...event('bubilet', 21), url: `${urls.bubilet}-new-scope` }, p = page('new-scope-page', 'bubilet', [record], 'verified', stamp, { url: record.url });
    await begin(h); await savePage(h.batchId, p); await accept(h.batchId, [record]);
    await assert.rejects(seal(h, [p], [record]), /full coverage omits an eligible provider offer/i);
    assert.equal(await batch.activePublication(), before);
    assert.equal((await seal(h, [p], [record], coverage([p], [record], false))).status, 'sealed');
    const result = await publish(h.batchId), manifest = JSON.parse(await query(`SELECT manifest::text FROM biplan.publications WHERE id=${literal(result)};`));
    assert.equal(manifest.collectorCoverage.complete, false);
  });
  await check('a new unobserved eligible offer after full sealing also prevents activation', async () => {
    const h = { ...header('full-late-legacy'), horizonStart: new Date(clock + 25 * 86400000).toISOString(), horizonEnd: new Date(clock + 29 * 86400000).toISOString() };
    const record = { ...event('bubilet', 25), url: `${urls.bubilet}-late-scope` }, p = page('late-scope-page', 'bubilet', [record], 'verified', stamp, { url: record.url });
    await begin(h); await savePage(h.batchId, p); await accept(h.batchId, [record]); assert.equal((await seal(h, [p], [record])).status, 'sealed');
    const late = { ...event('bubilet', 26), url: `${urls.bubilet}-late-legacy` };
    const adapted = adaptCanonicalRecord(late, await canonical.findHeads(late)); assert.equal(adapted.status, 'ready'); await canonical.accept(adapted.payload);
    const before = await batch.activePublication();
    const prepared = await runBatchPreparation({ store: batch, batchId: h.batchId, workerId: 'late-prepare', maxJobs: 10 }); assert.deepEqual(prepared.failures, []);
    const result = await runBatchPublication({ store: batch, batchId: h.batchId, workerId: 'late-publish' });
    assert.equal(result.published, 0); assert.match(result.failures[0].message, /full coverage omits an eligible provider offer/i);
    assert.equal(await batch.activePublication(), before); await batch.cancel(h.batchId, 'fixture late eligible offer');
  });
  assert.deepEqual(await hashes(), sourceHashes);
} catch (error) { problem = { message: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 4000) }; }
finally {
  if (created) { await sql(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=${literal(database)} AND pid<>pg_backend_pid(); DROP DATABASE ${database};`); databaseDropped = true; }
  for (const name of [roleNames.web, roleNames.preparer, roleNames.reader, roleNames.prepare, roleNames.owner]) await sql(`DROP ROLE IF EXISTS ${name};`);
  rolesDropped = true; await mkdir(work, { recursive: true });
  await writeFile(resolve(work, `page-receipts-verification-${Date.now()}.json`), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), runtime: process.version,
    baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), sourceHashes, checks, runs, problem,
    database, databaseDropped, rolesDropped, aiCalls: 0, externalCalls: 0, syntheticCoverage: true }, null, 2));
}
if (problem) throw new Error(problem.message);
console.log(JSON.stringify({ passed: checks.length, databaseDropped, rolesDropped, aiCalls: 0, externalCalls: 0 }));
