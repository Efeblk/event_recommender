import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const image = process.argv[2];
if (!image || image.startsWith('-')) {
  throw new Error('Usage: node scripts/smoke-container.mjs <local-image-tag>');
}

const token = 'isolated-container-smoke-token';
const probe = String.raw`
  import assert from 'node:assert/strict';
  import { setTimeout as delay } from 'node:timers/promises';
  const origin = 'http://127.0.0.1:8080';
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(origin + '/api/site');
      if (response.status === 200) { started = true; break; }
    } catch {}
    await delay(100);
  }
  assert.ok(started, 'Container server did not start');
  const home = await fetch(origin);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Bi.{0,10}Plan/);
  assert.deepEqual(await (await fetch(origin + '/api/site')).json(), { donationUrl: null });
  assert.equal((await fetch(origin + '/api/health')).status, 503);
  const ready = await fetch(origin + '/api/ready');
  assert.equal(ready.status, 503);
  assert.ok((await ready.json()).reasons.includes('collection_state_unavailable'));
  for (const route of ['import', 'collection', 'embeddings', 'sync']) {
    const denied = await fetch(origin + '/api/admin/' + route, { method: 'POST', body: '{}' });
    assert.equal(denied.status, 401, route + ' must authorize before storage access');
  }
  const legacy = await fetch(origin + '/api/admin/sync', {
    method: 'POST',
    headers: { authorization: 'Bearer ${token}' },
  });
  assert.equal(legacy.status, 410, 'The container must use the Node storage adapter');
`;

let containerId;
try {
  const started = await run(
    'docker',
    [
      'run',
      '--detach',
      '--rm',
      '--network',
      'none',
      '--env',
      `SYNC_TOKEN=${token}`,
      image,
    ],
    { encoding: 'utf8', timeout: 30_000 },
  );
  containerId = started.stdout.trim();
  if (!/^[0-9a-f]{64}$/.test(containerId)) {
    throw new Error('Docker did not return a full container ID.');
  }
  await run(
    'docker',
    ['exec', containerId, 'node', '--input-type=module', '-e', probe],
    { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000 },
  );
  console.log(
    'Container smoke passed: UI, private admin authorization, fail-closed storage, and Node adapter. Cloud/AI calls: 0.',
  );
} finally {
  if (containerId) {
    await run('docker', ['stop', '--time', '1', containerId], {
      encoding: 'utf8',
      timeout: 10_000,
    }).catch(() => {});
  }
}
