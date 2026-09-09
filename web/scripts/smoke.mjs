// Exercise the production Worker and disposable D1 through Cloudflare's test harness.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'dist/server');
const config = JSON.parse(await readFile(join(build, 'wrangler.json'), 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'biplan-smoke-'));
// No developer secrets or platform credentials are used by this local harness.
process.env.WRANGLER_SEND_METRICS = 'false';
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
process.env.WRANGLER_LOG_PATH = join(temp, 'logs');
const { createTestHarness } = await import('wrangler');
let server;
try {
  config.main = resolve(build, config.main);
  config.assets.directory = resolve(build, config.assets.directory);
  config.vars = {
    AI_API_KEY: '',
    OPENAI_API_KEY: '',
    EMBEDDING_API_KEY: '',
    EMBEDDING_ENABLED: 'false',
    SYNC_TOKEN: 'local-smoke-only',
  };
  // Load the built config outside the checkout to avoid .dev.vars and local D1.
  await writeFile(join(temp, 'wrangler.json'), JSON.stringify(config));
  await writeFile(join(temp, '.env'), '');
  server = createTestHarness({
    root: temp,
    workers: [
      { configPath: join(temp, 'wrangler.json'), secrets: config.vars },
    ],
  });
  await server.listen();
  const healthResponse = await server.fetch('/api/health');
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, 'ok');
  assert.equal(health.aiEnabled, false);
  // Dispatch directly to workerd. The dev HTTP proxy can lose its connection
  // after an early 401 leaves a request body unread (workerd issue #1730).
  const worker = server.getWorker();
  const env = await worker.getEnv();
  const snapshot = JSON.parse(
    await readFile(join(root, 'data/events.json'), 'utf8'),
  );
  const stored = await env.DB.prepare('SELECT payload FROM events').all();
  assert.equal(stored.results.length, snapshot.length);
  const indexed = new Map(
    stored.results.map((row) => {
      const e = JSON.parse(row.payload);
      return [e.id, e];
    }),
  );
  for (const event of snapshot) assert.deepEqual(indexed.get(event.id), event);
  function request(path, body, authenticated = false) {
    return worker.fetch(path, {
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(authenticated
                ? { Authorization: 'Bearer local-smoke-only' }
                : {}),
            },
            body: JSON.stringify(body),
          }),
      signal: AbortSignal.timeout(10000),
    });
  }
  const page = await request('/');
  assert.equal(page.status, 200);
  await page.arrayBuffer();
  const events = await request('/api/events');
  assert.equal(events.status, 200);
  const listing = await events.json();
  assert.equal(listing.aiEnabled, false);
  assert.ok(Array.isArray(listing.events));
  const search = await request('/api/recommend', {
    message: '1000 TL altında konser',
  });
  assert.equal(search.status, 200);
  const result = await search.json();
  assert.equal(result.mode, 'filters');
  assert.equal(result.filters.maxPrice, 1000);
  assert.match(result.notice, /Anahtarsız/);
  // A source snapshot can expire: an empty result is valid, fabricated events aren't.
  assert.ok(
    result.recommendations.every(
      ({ event }) =>
        event.price !== null &&
        event.price <= 1000 &&
        event.category === 'Konser',
    ),
  );
  const invalid = await request('/api/recommend', { message: '' });
  assert.equal(invalid.status, 400);
  await invalid.arrayBuffer();
  const sync = await request('/api/admin/sync', {});
  assert.equal(sync.status, 401);
  await sync.arrayBuffer();
  const unauthorizedImport = await request('/api/admin/import', {});
  const unauthorizedDetail = await unauthorizedImport.text();
  assert.equal(unauthorizedImport.status, 401, unauthorizedDetail);
  const checkedAt = new Date().toISOString();
  const importedEvent = {
    id: 'smoke-import',
    title: 'Zümrütkristal Doğrulama Konseri',
    description: 'Yalnızca izole test veritabanında kullanılan kayıt.',
    startsAt: new Date(Date.now() + 2 * 86400000).toISOString(),
    checkedAt,
    venue: 'Zümrütkristal test sahnesi',
    district: '',
    address: '',
    city: 'İstanbul',
    price: 500,
    currency: 'TRY',
    category: 'Konser',
    availability: 'available',
    imageUrl: '',
    url: 'https://biletinial.com/tr-tr/muzik/smoke-import',
    source: 'biletinial',
  };
  const envelope = (event) => ({
    schemaVersion: 1,
    pages: [{ url: event.url, events: [event] }],
  });
  const imported = await request(
    '/api/admin/import',
    envelope(importedEvent),
    true,
  );
  if (imported.status !== 200) {
    const detail = await imported.text();
    assert.fail(`Import returned ${imported.status}: ${detail.slice(0, 2000)}`);
  }
  assert.equal((await imported.json()).imported, 1);
  const staleImport = await request(
    '/api/admin/import',
    envelope({
      ...importedEvent,
      price: 800,
      checkedAt: new Date(Date.now() - 60000).toISOString(),
    }),
    true,
  );
  assert.equal(staleImport.status, 200);
  assert.equal((await staleImport.json()).skipped, 1);
  const readBack = await request('/api/recommend', {
    message: 'Zümrütkristal konser',
  });
  const importedRecommendation = (await readBack.json()).recommendations.find(
    ({ event }) => event.id === 'smoke-import',
  );
  assert.equal(importedRecommendation.event.price, 500);
  assert.ok(importedRecommendation.event.productionKey);
  const bulk = Array.from({ length: 101 }, (_, i) => ({
    ...importedEvent,
    id: `smoke-bulk-${i}`,
    title: `Türkçe ŞĞİÜÖÇ ${i}`,
    description: 'ŞĞ'.repeat(2000),
    startsAt: new Date(Date.now() + (i + 3) * 86400000).toISOString(),
    price: i % 2 ? null : 500,
    url: 'https://biletinial.com/tr-tr/muzik/smoke-bulk',
  }));
  const bulkResponse = await request(
    '/api/admin/import',
    {
      schemaVersion: 1,
      pages: [{ url: bulk[0].url, events: bulk }],
    },
    true,
  );
  assert.equal(bulkResponse.status, 200);
  assert.equal((await bulkResponse.json()).imported, 101);
  const bulkRows = await env.DB.prepare(
    'SELECT payload FROM events WHERE source_url=?',
  )
    .bind(bulk[0].url)
    .all();
  assert.equal(bulkRows.results.length, 101);
  assert.equal(
    JSON.parse(
      bulkRows.results.find((r) => JSON.parse(r.payload).id === 'smoke-bulk-1')
        .payload,
    ).price,
    null,
  );
  const badImport = await request(
    '/api/admin/import',
    envelope({ ...importedEvent, url: 'https://evil.example/event' }),
    true,
  );
  assert.equal(badImport.status, 400);
  await badImport.arrayBuffer();
  console.log(
    'Built Worker smoke check passed: page, D1, keyless search, validation, protected sync, import and stale-update protection.',
  );
} catch (error) {
  server?.debug();
  throw error;
} finally {
  try {
    await server?.close();
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}
