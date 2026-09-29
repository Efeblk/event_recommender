// Read-only compiled Node HTTP smoke against the task-owned loopback PostgreSQL.
// This script never inherits ADC/provider credentials and never prints DB secrets.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.match(process.version, /^v22\./, 'Use the Node version pinned by web/.nvmrc');
const root = resolve(import.meta.dirname, '..');
const dist = resolve(root, 'dist-node');
const work = resolve(root, 'work', 'catalog-foundation');
const envFile = resolve(work, 'postgres.env');
const settings = Object.fromEntries(
  (await readFile(envFile, 'utf8')).trim().split(/\r?\n/).map((line) => {
    const separator = line.indexOf('=');
    assert.ok(separator > 0, 'Malformed local PostgreSQL settings');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }),
);
assert.equal(settings.POSTGRES_DB, 'biplan_catalog');
assert.ok(settings.POSTGRES_PASSWORD, 'Local PostgreSQL password is missing');

const packagedRequire = createRequire(resolve(dist, 'package.json'));
const pgEntry = packagedRequire.resolve('pg');
assert.ok(pgEntry.startsWith(dist), 'pg must be present in the traced Node artifact');
const { Pool } = packagedRequire('pg');
const pool = new Pool({
  host: '127.0.0.1', port: 15432, database: settings.POSTGRES_DB,
  user: 'postgres', password: settings.POSTGRES_PASSWORD, max: 1,
  connectionTimeoutMillis: 5000, statement_timeout: 5000,
  options: '-c default_transaction_read_only=on', application_name: 'biplan-http-smoke-readonly',
});

const sourcePaths = [
  'lib/postgres-client.node.ts', 'lib/postgres-catalog.node.ts',
  'lib/publication-repository.ts', 'lib/prepared-publication-search.ts',
  'lib/postgres-readiness.node.ts', 'lib/sql-literal.ts', 'lib/recommend.ts',
  'lib/store.node.ts', 'app/api/events/route.ts',
  'app/api/health/route.ts', 'app/api/ready/route.ts', 'app/api/recommend/route.ts',
];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const hashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (path) =>
  [path, sha256(await readFile(resolve(root, path)))],
)));
const compiledHashes = {
  'dist-node/server.js': sha256(await readFile(resolve(dist, 'server.js'))),
  'dist-node/package.json': sha256(await readFile(resolve(dist, 'package.json'))),
};

const active = await pool.query(`SELECT p.id,
  (SELECT count(*)::int FROM biplan.published_sessions ps WHERE ps.publication_id=p.id) AS sessions
  FROM biplan.active_publication a JOIN biplan.publications p ON p.id=a.publication_id
  WHERE a.singleton`);
assert.equal(active.rowCount, 1, 'Expected one active local publication');
const publicationId = active.rows[0].id;
const publishedSessions = active.rows[0].sessions;

const portFinder = createServer();
await new Promise((done) => portFinder.listen(0, '127.0.0.1', done));
const port = portFinder.address().port;
await new Promise((done, reject) => portFinder.close((error) => error ? reject(error) : done()));
const child = spawn(process.execPath, ['server.js'], {
  cwd: dist,
  windowsHide: true,
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: 'production', HOST: '127.0.0.1', HOSTNAME: '127.0.0.1', PORT: String(port),
    DEPLOYMENT_ENV: 'staging', DEPLOYMENT_SHA: 'local-postgres-compiled-smoke',
    BIPLAN_PREVIEW_TESTING: 'true', BIPLAN_CLIENT_IP_MODE: 'shared', INPUT_INTERPRETER: 'rules',
    CATALOG_BACKEND: 'postgres', BIPLAN_PG_HOST: '127.0.0.1', BIPLAN_PG_PORT: '15432',
    BIPLAN_PG_DATABASE: settings.POSTGRES_DB, BIPLAN_PG_USER: 'postgres',
    BIPLAN_PG_PASSWORD: settings.POSTGRES_PASSWORD, BIPLAN_PG_POOL_MAX: '2',
    BIPLAN_PG_STATEMENT_TIMEOUT_MS: '5000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOutput = '', spawnFailure;
const capture = (chunk) => { serverOutput = (serverOutput + chunk).slice(-12000); };
child.stdout.on('data', capture); child.stderr.on('data', capture);
child.on('error', (error) => { spawnFailure = error; });
const redact = (value) => String(value)
  .replaceAll(settings.POSTGRES_PASSWORD, '[redacted]')
  .replace(/(password|secret|token|key)=[^\s&]+/gi, '$1=[redacted]');
const origin = `http://127.0.0.1:${port}`;
const requests = [];
const observations = {};
async function request(path, init) {
  assert.ok(requests.length < 10, 'Functional HTTP request budget exceeded');
  const response = await fetch(origin + path, init);
  requests.push({ method: init?.method ?? 'GET', path, status: response.status });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { response, body };
}
const recommend = (message, extra = {}) => request('/api/recommend', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message, ...extra }),
});

function usable(term, now = Date.now()) {
  const observed = Date.parse(term.observed_at), from = term.valid_from && Date.parse(term.valid_from);
  const until = term.valid_until && Date.parse(term.valid_until);
  return ['available', 'limited'].includes(term.availability) && Number.isFinite(observed) &&
    observed <= now && observed >= now - 72 * 3600000 && (!from || from <= now) && (!until || until >= now);
}
function expectedCard(row) {
  const terms = row.terms.filter((term) => usable(term));
  const exact = terms.flatMap((term) => term.currency === 'TRY' && term.price_kind === 'exact' &&
    term.price_minor !== null && term.fee_minor !== null
    ? [{ term, total: Number(term.price_minor) + Number(term.fee_minor) }] : []).sort((a, b) => a.total - b.total);
  const advertised = terms.flatMap((term) => term.currency === 'TRY' && ['exact', 'starting_at'].includes(term.price_kind) && term.price_minor !== null
    ? [{ term, amount: Number(term.price_minor) }] : []).sort((a, b) => a.amount - b.amount);
  const chosen = exact[0]?.term ?? advertised[0]?.term ?? terms[0];
  assert.ok(chosen, `No usable pinned offer for ${row.session_id}`);
  const advertisedAmount = advertised.find(({ term }) => term.id === chosen.id)?.amount;
  return {
    id: row.session_id, title: row.snapshot.title, startsAt: row.snapshot.startsAt,
    url: new URL(chosen.source_url).href, price: exact[0]?.total === undefined ? null : exact[0].total / 100,
    advertisedPrice: advertisedAmount === undefined ? undefined : {
      amount: advertisedAmount / 100, currency: 'TRY', kind: chosen.price_kind,
      feesKnown: chosen.fee_minor !== null,
    },
  };
}
async function verifyCards(events) {
  assert.ok(events.length > 0 && events.length <= 16);
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  assert.equal(new Set(events.map((event) => event.canonicalProductionKey ?? event.productionKey ?? event.id)).size, events.length);
  for (const event of events) assert.ok(!('preparedSearch' in event), 'Prepared search internals must not be serialized');
  const ids = events.map((event) => event.id);
  const result = await pool.query(`SELECT ps.session_id, ps.eligibility_snapshot AS snapshot,
    COALESCE(jsonb_agg(jsonb_build_object('id',r.id,'offer_id',r.offer_id,'source_url',r.source_url,
      'currency',r.currency,'price_minor',r.price_minor,'fee_minor',r.fee_minor,'price_kind',r.price_kind,
      'availability',r.availability,'observed_at',r.observed_at,'valid_from',r.valid_from,'valid_until',r.valid_until)
      ORDER BY r.offer_id) FILTER (WHERE r.id IS NOT NULL),'[]'::jsonb) AS terms
    FROM biplan.published_sessions ps
    LEFT JOIN biplan.publication_offers po ON po.publication_id=ps.publication_id AND po.session_id=ps.session_id
    LEFT JOIN biplan.offer_revisions r ON r.id=po.offer_revision_id
    WHERE ps.publication_id=$1 AND ps.session_id=ANY($2::text[])
    GROUP BY ps.session_id,ps.eligibility_snapshot`, [publicationId, ids]);
  assert.equal(result.rows.length, events.length);
  const byId = new Map(result.rows.map((row) => [row.session_id, expectedCard(row)]));
  for (const event of events) {
    const expected = byId.get(event.id);
    assert.ok(expected); assert.equal(event.title, expected.title); assert.equal(event.startsAt, expected.startsAt);
    assert.equal(new URL(event.url).href, expected.url); assert.equal(event.price, expected.price);
    assert.deepEqual(event.advertisedPrice, expected.advertisedPrice);
  }
}

let problem;
try {
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnFailure || child.exitCode !== null) throw spawnFailure ?? new Error(`Node exited: ${child.exitCode}`);
    try { if ((await fetch(`${origin}/api/site`)).status === 200) { started = true; break; } } catch { /* startup poll */ }
    await delay(100);
  }
  assert.ok(started, 'Compiled Node server did not start');

  const home = await request('/'); assert.equal(home.response.status, 200); assert.match(home.body, /Bi.{0,10}Plan/);
  const site = await request('/api/site'); assert.equal(site.response.status, 200); assert.deepEqual(site.body, { donationUrl: null });
  const health = await request('/api/health'); assert.equal(health.response.status, 200);
  assert.equal(health.body.status, 'ok'); assert.equal(health.body.aiEnabled, false);
  assert.equal(health.body.catalog.stored, publishedSessions); assert.ok(health.body.catalog.eligible > 0);
  observations.health = { stored: health.body.catalog.stored, eligible: health.body.catalog.eligible, aiEnabled: health.body.aiEnabled };

  const ready = await request('/api/ready'); assert.equal(ready.response.status, 503);
  assert.equal(ready.body.backend, 'postgres'); assert.equal(ready.body.publicationId, publicationId);
  assert.ok(ready.body.reasons.includes('collector_coverage_missing'));
  assert.ok(ready.body.reasons.includes('preparation_receipt_missing'));
  observations.readiness = { status: ready.response.status, backend: ready.body.backend, publicationId: ready.body.publicationId, reasons: ready.body.reasons };

  const listing = await request('/api/events'); assert.equal(listing.response.status, 200);
  assert.equal(listing.body.catalog.stored, publishedSessions); assert.equal(listing.body.aiEnabled, false);
  await verifyCards(listing.body.events);
  observations.events = { cards: listing.body.events.length, sourceVerified: listing.body.events.length };

  const workshop = await recommend('seramik atölyesi'); assert.equal(workshop.response.status, 200);
  assert.equal(workshop.body.publicationId, publicationId); await verifyCards(workshop.body.recommendations.map((item) => item.event));
  observations.workshop = { cards: workshop.body.recommendations.length, sourceVerified: workshop.body.recommendations.length };
  const standup = await recommend('konser dışı stand up'); assert.equal(standup.response.status, 200);
  assert.equal(standup.body.publicationId, publicationId); await verifyCards(standup.body.recommendations.map((item) => item.event));
  observations.standup = { cards: standup.body.recommendations.length, sourceVerified: standup.body.recommendations.length };

  const budget = await recommend('100000 TL altında seramik atölyesi'); assert.equal(budget.response.status, 200);
  assert.equal(budget.body.publicationId, publicationId); assert.equal(budget.body.recommendations.length, 0);
  assert.equal(budget.body.filters.maxPrice, 100000);
  assert.ok(typeof budget.body.notice === 'string' && budget.body.notice.length > 20, 'Unknown-fee budget exclusion needs a truthful notice');
  observations.budget = { cards: 0, maxPrice: budget.body.filters.maxPrice, truthfulPriceNotice: true };

  const reset = await recommend('yeni arama, stand up'); assert.equal(reset.response.status, 200);
  assert.equal(reset.body.publicationId, publicationId); assert.equal(reset.body.filters.category, 'Stand-up');
  await verifyCards(reset.body.recommendations.map((item) => item.event));
  observations.reset = { cards: reset.body.recommendations.length, sourceVerified: reset.body.recommendations.length, category: reset.body.filters.category };
} catch (error) { problem = error; }
finally {
  if (child.exitCode === null) {
    const exited = new Promise((done) => child.once('exit', done)); child.kill(); await exited;
  }
  await pool.end();
}

await mkdir(work, { recursive: true });
const receiptPath = resolve(work, `postgres-node-http-smoke-${Date.now()}.json`);
const receipt = {
  checkedAt: new Date().toISOString(), passed: !problem, runtime: process.version,
  baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolve(root, '..'), encoding: 'utf8', windowsHide: true }).trim(),
  sourceHashes: hashes, compiledHashes, publicationId, publishedSessions,
  observations,
  functionalRequests: requests, functionalRequestCount: requests.length,
  limits: { functionalHttpRequests: 10, postgresPool: 2, aiCalls: 0 },
  isolation: { loopbackOnly: true, databaseReadOnly: true, inheritedCloudCredentials: false, providerCalls: 0, databaseWrites: 0 },
  error: problem ? redact(problem.message) : null,
};
await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
if (problem) {
  console.error(redact(serverOutput));
  console.error(JSON.stringify({ passed: false, receipt: receiptPath, error: receipt.error }));
  throw problem;
}
console.log(JSON.stringify({ passed: true, publicationId, requests: requests.length, receipt: receiptPath, aiCalls: 0, providerCalls: 0 }));
