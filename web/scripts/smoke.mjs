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
  config.r2_buckets = [
    { binding: 'COLLECTION_STATE', bucket_name: 'biplan-isolated-smoke-state' },
  ];
  config.vars = {
    // Old keys must not silently enable another model on the Jev-only path.
    AI_API_KEY: 'unused-legacy-smoke-key',
    OPENAI_API_KEY: 'unused-legacy-smoke-key',
    TYPESAFE_API_KEY: '',
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
  const publicSite = await server.fetch('/api/site');
  assert.equal(publicSite.status, 200);
  assert.deepEqual(await publicSite.json(), { donationUrl: null });
  // Dispatch directly to workerd. The dev HTTP proxy can lose its connection
  // after an early 401 leaves a request body unread (workerd issue #1730).
  let worker = server.getWorker();
  let env = await worker.getEnv();
  const absentCheckpoint = await worker.fetch('/api/admin/collection', {
    headers: { Authorization: 'Bearer local-smoke-only' },
  });
  assert.equal(absentCheckpoint.status, 404);
  await absentCheckpoint.arrayBuffer();
  const initialReadiness = await worker.fetch('/api/ready');
  assert.equal(initialReadiness.status, 503);
  assert.ok(
    (await initialReadiness.json()).reasons.includes('checkpoint_missing'),
  );
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
  const expiredCheckedAt = new Date(Date.now() - 73 * 3600000).toISOString();
  await env.DB.prepare(
    "UPDATE events SET checked_at=?, payload=json_set(payload,'$.checkedAt',?)",
  )
    .bind(expiredCheckedAt, expiredCheckedAt)
    .run();
  const staleHealthResponse = await worker.fetch('/api/health');
  assert.equal(staleHealthResponse.status, 200);
  const staleCatalog = (await staleHealthResponse.json()).catalog;
  assert.equal(staleCatalog.status, 'stale');
  assert.equal(staleCatalog.eligible, 0);
  assert.equal(staleCatalog.stored, snapshot.length);
  assert.equal(staleCatalog.lastCheckedAt, expiredCheckedAt);
  assert.equal(
    staleCatalog.expiresAt,
    new Date(Date.parse(expiredCheckedAt) + 72 * 3600000).toISOString(),
  );
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
  assert.ok(['empty', 'results'].includes(result.status));
  assert.equal('message' in result, false);
  assert.ok(result.recommendations.every((item) => !('reason' in item)));
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
  const unclear = await request('/api/recommend', {
    message: 'Toplam bütçem 800 TL',
  });
  assert.equal(unclear.status, 200);
  const unclearBody = await unclear.json();
  assert.equal(unclearBody.status, 'needs_input');
  assert.equal(unclearBody.filters.maxPrice, null);
  assert.deepEqual(unclearBody.recommendations, []);
  const excluded = await request('/api/recommend', {
    message: 'Konser istemiyorum',
  });
  assert.equal(excluded.status, 200);
  const excludedBody = await excluded.json();
  assert.deepEqual(excludedBody.filters.excludedCategories, ['Konser']);
  assert.ok(
    excludedBody.recommendations.every(
      ({ event }) => event.category !== 'Konser',
    ),
  );
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
  const expectedExpiry = new Date(
    Date.parse(checkedAt) + 72 * 3600000,
  ).toISOString();
  const readyHealth = await request('/api/health');
  assert.equal(readyHealth.status, 200);
  const readyCatalog = (await readyHealth.json()).catalog;
  assert.equal(readyCatalog.status, 'ready');
  assert.equal(readyCatalog.lastCheckedAt, checkedAt);
  assert.equal(readyCatalog.expiresAt, expectedExpiry);
  assert.ok(readyCatalog.stored >= snapshot.length + 1);
  assert.ok(readyCatalog.eligible >= 1);
  const readyEvents = await request('/api/events');
  assert.equal(readyEvents.status, 200);
  assert.deepEqual((await readyEvents.json()).catalog, readyCatalog);

  await env.DB.prepare(
    "INSERT INTO metadata(key,value) VALUES('sync_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  )
    .bind(`${Date.now() + 300000}:smoke-held-lease`)
    .run();
  const lockedImport = await request(
    '/api/admin/import',
    envelope({ ...importedEvent, id: 'smoke-locked-import' }),
    true,
  );
  assert.equal(lockedImport.status, 409);
  assert.deepEqual(await lockedImport.json(), {
    error: 'Sync already running',
  });
  await env.DB.prepare("DELETE FROM metadata WHERE key='sync_lock'").run();
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

  const seedSource = snapshot.find(
    (candidate, index) =>
      snapshot.findIndex((event) => event.url === candidate.url) === index &&
      snapshot.filter((event) => event.url === candidate.url).length > 1,
  )?.url;
  assert.ok(seedSource);
  const seedSourceEvent = snapshot.find((event) => event.url === seedSource);
  assert.ok(seedSourceEvent);
  const obsoleteSeedIds = snapshot
    .filter((event) => event.url === seedSource)
    .map((event) => event.id);
  assert.ok(obsoleteSeedIds.length > 1);
  const replacement = {
    ...seedSourceEvent,
    id: 'smoke-seed-source-replacement',
    title: 'Yeniden Başlatma Doğrulama Etkinliği',
    startsAt: new Date(Date.now() + 4 * 86400000).toISOString(),
    checkedAt: new Date(Date.now() + 1000).toISOString(),
  };
  const replacementImport = await request(
    '/api/admin/import',
    envelope(replacement),
    true,
  );
  assert.equal(replacementImport.status, 200);
  assert.deepEqual(await replacementImport.json(), { imported: 1, skipped: 0 });
  await env.DB.prepare("DELETE FROM metadata WHERE key='seed_version'").run();
  await server.update((options) => ({
    ...options,
    workers: options.workers?.map((configuredWorker) =>
      'configPath' in configuredWorker
        ? {
            ...configuredWorker,
            secrets: {
              ...configuredWorker.secrets,
              SMOKE_RELOAD_MARKER: crypto.randomUUID(),
              DONATION_URL: 'https://example.com/support',
            },
          }
        : configuredWorker,
    ),
  }));
  worker = server.getWorker();
  env = await worker.getEnv();
  const afterRestart = await request('/api/health');
  assert.equal(afterRestart.status, 200);
  await afterRestart.arrayBuffer();
  const configuredSite = await request('/api/site');
  assert.equal(configuredSite.status, 200);
  assert.deepEqual(await configuredSite.json(), {
    donationUrl: 'https://example.com/support',
  });
  const sourceAfterRestart = await env.DB.prepare(
    'SELECT id FROM events WHERE source_url=? ORDER BY id',
  )
    .bind(seedSource)
    .all();
  assert.deepEqual(
    sourceAfterRestart.results.map(({ id }) => id),
    [replacement.id],
  );
  assert.ok(
    obsoleteSeedIds.every(
      (id) => !sourceAfterRestart.results.some((row) => row.id === id),
    ),
  );
  assert.ok(
    await env.DB.prepare(
      "SELECT value FROM metadata WHERE key='seed_version'",
    ).first(),
  );
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
  // Durable checkpoints must contain the canonical published DB, never a
  // caller-provided snapshot. R2 and D1 here are both disposable local bindings.
  const checkpointRequest = (body, authenticated = true) =>
    request('/api/admin/collection', body, authenticated);
  const checkpointGet = () =>
    worker.fetch('/api/admin/collection', {
      headers: { Authorization: 'Bearer local-smoke-only' },
    });
  const checkpointUnauthorized = await checkpointRequest({}, false);
  assert.equal(checkpointUnauthorized.status, 401);
  await checkpointUnauthorized.arrayBuffer();
  const checkpointUnauthorizedGet = await worker.fetch('/api/admin/collection');
  assert.equal(checkpointUnauthorizedGet.status, 401);
  await checkpointUnauthorizedGet.arrayBuffer();
  const canonical = await env.DB.prepare(
    'SELECT payload FROM events ORDER BY id',
  ).all();
  const report = {
    finishedAt: new Date().toISOString(),
    summary: {
      blocked: null,
      events: canonical.results.length,
      available: 103,
      refreshedPages: 3,
      sources: { biletinial: 103, bubilet: 1, biletix: 1 },
    },
  };
  const reportEnvelope = {
    schemaVersion: 1,
    report,
    events: [{ id: 'caller-forged-event' }],
  };
  const blockedCheckpoint = await checkpointRequest({
    schemaVersion: 1,
    report: {
      ...report,
      summary: { ...report.summary, blocked: 'large_catalog_drop' },
    },
  });
  assert.equal(blockedCheckpoint.status, 400);
  await blockedCheckpoint.arrayBuffer();
  const oversizedCheckpoint = await checkpointRequest({
    ...reportEnvelope,
    oversized: 'x'.repeat(128 * 1024),
  });
  assert.equal(oversizedCheckpoint.status, 413);
  await oversizedCheckpoint.arrayBuffer();
  await env.DB.prepare(
    "INSERT INTO metadata(key,value) VALUES('sync_lock',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  )
    .bind(`${Date.now() + 300000}:checkpoint-held-lease`)
    .run();
  const lockedCheckpoint = await checkpointRequest(reportEnvelope);
  assert.equal(lockedCheckpoint.status, 409);
  await lockedCheckpoint.arrayBuffer();
  await env.DB.prepare("DELETE FROM metadata WHERE key='sync_lock'").run();
  const checkpointResponse = await checkpointRequest(reportEnvelope);
  assert.equal(
    checkpointResponse.status,
    200,
    await checkpointResponse.clone().text(),
  );
  const savedCheckpoint = await checkpointResponse.json();
  assert.equal(savedCheckpoint.events, canonical.results.length);
  const restoredResponse = await checkpointGet();
  assert.equal(restoredResponse.status, 200);
  const restoredCheckpoint = await restoredResponse.json();
  assert.equal(restoredCheckpoint.events.length, canonical.results.length);
  assert.deepEqual(
    restoredCheckpoint.events,
    canonical.results.map((row) => JSON.parse(row.payload)),
  );
  assert.ok(
    restoredCheckpoint.events.every(
      (event) => event && event.id !== 'caller-forged-event',
    ),
  );
  const checkpointReady = await worker.fetch('/api/ready');
  assert.equal(
    checkpointReady.status,
    200,
    await checkpointReady.clone().text(),
  );
  assert.equal((await checkpointReady.json()).ready, true);
  const duplicateCheckpoint = await checkpointRequest(reportEnvelope);
  assert.equal(duplicateCheckpoint.status, 200);
  assert.deepEqual(await duplicateCheckpoint.json(), savedCheckpoint);
  const olderCheckpoint = await checkpointRequest({
    schemaVersion: 1,
    report: {
      ...report,
      finishedAt: new Date(Date.parse(report.finishedAt) - 60000).toISOString(),
    },
  });
  assert.equal(olderCheckpoint.status, 200);
  assert.deepEqual(await olderCheckpoint.json(), savedCheckpoint);
  const pointerRow = await env.DB.prepare(
    "SELECT value FROM metadata WHERE key='collection_checkpoint'",
  ).first();
  const pointer = JSON.parse(pointerRow.value);
  await env.DB.prepare(
    "UPDATE metadata SET value=? WHERE key='collection_checkpoint'",
  )
    .bind(
      JSON.stringify({
        ...pointer,
        finishedAt: new Date(Date.now() - 25 * 3600000).toISOString(),
      }),
    )
    .run();
  const oldReportReady = await worker.fetch('/api/ready');
  assert.equal(oldReportReady.status, 503);
  assert.ok((await oldReportReady.json()).reasons.includes('checkpoint_stale'));
  await env.DB.prepare(
    "UPDATE metadata SET value=? WHERE key='collection_checkpoint'",
  )
    .bind(pointerRow.value)
    .run();
  await env.COLLECTION_STATE.delete(savedCheckpoint.key);
  const missingObjectReady = await worker.fetch('/api/ready');
  assert.equal(missingObjectReady.status, 503);
  assert.ok(
    (await missingObjectReady.json()).reasons.includes(
      'checkpoint_unavailable',
    ),
  );
  const missingObjectGet = await checkpointGet();
  assert.equal(missingObjectGet.status, 503);
  await missingObjectGet.arrayBuffer();
  await env.COLLECTION_STATE.put(
    savedCheckpoint.key,
    JSON.stringify(restoredCheckpoint),
  );
  const checkpointRecovered = await worker.fetch('/api/ready');
  assert.equal(checkpointRecovered.status, 200);
  await checkpointRecovered.arrayBuffer();
  // Regression through the actual HTTP route and D1, without a provider key.
  // A play request must not be padded with concerts or child performances.
  // The restart test reseeded other pages; expire those in this disposable DB
  // so the regression does not depend on today's scraped catalogue ordering.
  await env.DB.prepare(
    "UPDATE events SET checked_at=?, payload=json_set(payload,'$.checkedAt',?)",
  )
    .bind(expiredCheckedAt, expiredCheckedAt)
    .run();
  const plays = [
    {
      id: 'smoke-adult-play',
      title: 'Son Mektup',
      description: 'Yetişkinlere yönelik dramatik bir oyun. Komedi değildir.',
    },
    {
      id: 'smoke-child-play',
      title: 'Ormandaki Arkadaşlar',
      description: '4–8 yaş çocuklar ve aileleri için kukla tiyatrosu.',
    },
  ].map((play) => ({
    ...importedEvent,
    ...play,
    category: 'Tiyatro',
    url: `https://biletinial.com/tr-tr/tiyatro/${play.id}`,
  }));
  for (const play of plays) {
    const importedPlay = await request(
      '/api/admin/import',
      envelope(play),
      true,
    );
    assert.equal(importedPlay.status, 200, await importedPlay.clone().text());
    await importedPlay.arrayBuffer();
  }
  const playMessage =
    'Çocuk oyunu istemiyorum, yetişkinlere uygun ciddi bir oyun olsun.';
  const playResponse = await request('/api/recommend', {
    message: playMessage,
  });
  assert.equal(playResponse.status, 200);
  const playResult = await playResponse.json();
  assert.equal(playResult.filters.category, 'Tiyatro');
  assert.deepEqual(
    playResult.recommendations.map(({ event }) => event.id),
    ['smoke-adult-play'],
  );
  const noMorePlays = await request('/api/recommend', {
    message: 'Aynı koşullarda başka etkinlikler bul',
    filters: playResult.filters,
    history: [{ role: 'user', content: playMessage }],
    excludeIds: ['smoke-adult-play'],
  });
  assert.equal(noMorePlays.status, 200);
  const noMoreResult = await noMorePlays.json();
  assert.equal(noMoreResult.status, 'empty');
  assert.deepEqual(noMoreResult.recommendations, []);
  console.log(
    'Built Worker smoke check passed: page, D1, protected import, restart-safe source replacement, canonical R2 checkpoints, stale/missing-state readiness and play recommendation exclusions.',
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
