// Exercise the built Worker against a disposable local D1 database, without secrets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'dist/server');
const config = JSON.parse(await readFile(join(build, 'wrangler.json'), 'utf8'));
const temp = await mkdtemp(join(tmpdir(), 'biplan-smoke-'));
let worker;
let stopped;
let logs = '';
try {
  // A config outside the checkout prevents loading .dev.vars or local D1 state.
  config.main = resolve(build, config.main);
  config.assets.directory = resolve(build, config.assets.directory);
  config.vars = {
    AI_API_KEY: '',
    OPENAI_API_KEY: '',
    EMBEDDING_API_KEY: '',
    EMBEDDING_ENABLED: 'false',
    SYNC_TOKEN: 'local-smoke-only',
  };
  await writeFile(join(temp, 'wrangler.json'), JSON.stringify(config));
  await writeFile(join(temp, '.env'), '');
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise((resolveClose, reject) =>
    socket.close((err) => (err ? reject(err) : resolveClose())),
  );
  const origin = `http://127.0.0.1:${port}`;
  worker = spawn(
    process.execPath,
    [
      join(root, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--config',
      join(temp, 'wrangler.json'),
      '--env-file',
      join(temp, '.env'),
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--inspector-port',
      '0',
      '--persist-to',
      join(temp, 'state'),
      '--show-interactive-dev-session=false',
    ],
    {
      cwd: temp,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        XDG_CONFIG_HOME: join(temp, 'config'),
        CI: 'true',
        WRANGLER_SEND_METRICS: 'false',
        WRANGLER_LOG_PATH: join(temp, 'logs'),
        CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  stopped = once(worker, 'close');
  worker.stdout.on('data', (chunk) => {
    logs = (logs + chunk.toString()).slice(-12000);
  });
  worker.stderr.on('data', (chunk) => {
    logs = (logs + chunk.toString()).slice(-12000);
  });
  await once(worker, 'spawn');
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (worker.exitCode !== null)
      throw new Error('Worker exited before becoming ready');
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const health = await response.json();
        assert.equal(health.status, 'ok');
        assert.equal(health.aiEnabled, false);
        ready = true;
        break;
      }
      await response.body?.cancel();
    } catch {
      /* The local Worker can take a few seconds to initialize. */
    }
    await delay(500);
  }
  assert.ok(ready, 'Worker must start with a healthy local database');
  async function request(path, body, authenticated = false) {
    return fetch(`${origin}${path}`, {
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
  await page.body?.cancel();
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
  await invalid.body?.cancel();
  const sync = await request('/api/admin/sync', {});
  assert.equal(sync.status, 401);
  await sync.body?.cancel();
  const unauthorizedImport = await request('/api/admin/import', {});
  assert.equal(unauthorizedImport.status, 401);
  await unauthorizedImport.body?.cancel();
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
    await delay(250); // Allow the worker process to flush its diagnostic output.
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
  const badImport = await request(
    '/api/admin/import',
    envelope({ ...importedEvent, url: 'https://evil.example/event' }),
    true,
  );
  assert.equal(badImport.status, 400);
  await badImport.body?.cancel();
  console.log(
    'Built Worker smoke check passed: page, D1, keyless search, validation, protected sync, import and stale-update protection.',
  );
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (worker && stopped) {
    worker.kill('SIGTERM');
    const force = setTimeout(() => worker.kill('SIGKILL'), 5000);
    await stopped;
    clearTimeout(force);
  }
  await rm(temp, { recursive: true, force: true });
}
