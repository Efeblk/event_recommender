// Compiled Node routing/startup check. Deliberately no ADC, cloud or AI calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const portFinder = createServer();
await new Promise((resolve) => portFinder.listen(0, '127.0.0.1', resolve));
const port = portFinder.address().port;
await new Promise((resolve, reject) =>
  portFinder.close((error) => (error ? reject(error) : resolve())),
);
const cwd = resolve('dist-node');
// Check traced production dependencies without credentials or RPCs. The missing
// config HTTP cases alone would return before importing these SDKs.
const packagedRequire = createRequire(resolve(cwd, 'package.json'));
const { Firestore } = packagedRequire('@google-cloud/firestore');
const { Storage } = packagedRequire('@google-cloud/storage');
const firestore = new Firestore({ projectId: 'biplan-offline-smoke' });
assert.equal(firestore.doc('biplan/staging').path, 'biplan/staging');
assert.equal(new Storage({ projectId: 'biplan-offline-smoke' }).bucket('biplan-offline-staging').file('fixture.json').name, 'fixture.json');
await firestore.terminate();
const child = spawn(process.execPath, ['server.js'], {
  cwd,
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    NODE_ENV: 'production',
    HOSTNAME: '127.0.0.1',
    PORT: String(port),
    DEPLOYMENT_ENV: 'staging',
    DEPLOYMENT_SHA: 'node-smoke',
    SYNC_TOKEN: 'isolated-node-smoke-token',
    BIPLAN_CLIENT_IP_MODE: 'shared',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', (data) => {
  output = (output + data).slice(-8000);
});
child.stderr.on('data', (data) => {
  output = (output + data).slice(-8000);
});
let failure;
child.on('error', (error) => {
  failure = error;
});
const origin = `http://127.0.0.1:${port}`;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure || child.exitCode !== null)
      throw failure ?? new Error(`Node exited: ${child.exitCode}`);
    try {
      if ((await fetch(`${origin}/api/site`)).status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* Startup only. No provider retries. */
    }
    await delay(100);
  }
  assert.ok(ready, 'Node server did not start');
  const home = await fetch(origin);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Bi.{0,10}Plan/);
  assert.deepEqual(await (await fetch(`${origin}/api/site`)).json(), {
    donationUrl: null,
  });
  assert.equal(
    (await fetch(`${origin}/api/health`)).status,
    503,
    'Missing GCP config must fail closed',
  );
  const readiness = await fetch(`${origin}/api/ready`);
  assert.equal(readiness.status, 503);
  assert.ok(
    (await readiness.json()).reasons.includes('collection_state_unavailable'),
  );
  for (const route of ['import', 'collection', 'embeddings', 'sync']) {
    const denied = await fetch(`${origin}/api/admin/${route}`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(
      denied.status,
      401,
      `${route} must authorize before cloud access`,
    );
  }
  const legacy = await fetch(`${origin}/api/admin/sync`, {
    method: 'POST',
    headers: { authorization: 'Bearer isolated-node-smoke-token' },
  });
  assert.equal(
    legacy.status,
    410,
    'GCP must select the Node store, not D1 or a fake binding',
  );
  console.log(
    'Compiled Node smoke passed: UI, public configuration, auth and missing-storage handling. Cloud/AI calls: 0.',
  );
} catch (error) {
  console.error(output.replaceAll('isolated-node-smoke-token', '[redacted]'));
  throw error;
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    await exited;
  }
}
