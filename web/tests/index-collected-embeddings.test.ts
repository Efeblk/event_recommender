import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';

const script = fileURLToPath(
  new URL('../scripts/index-collected-embeddings.mjs', import.meta.url),
);
const work = fileURLToPath(
  new URL('../work/collected-index-tests/', import.meta.url),
);
const profile =
  'voyage-embedding-v1|endpoint=https://api.voyageai.com/v1/embeddings|model=voyage-4-large|dimensions=1024|input_type=document|text_profile=event-title-category-venue-description-v1';
const status = (pending = 0) => ({
  configured: true,
  profile,
  deploymentRevision: 'c'.repeat(40),
  checkpointSha256: 'a'.repeat(64),
  eligible: 1,
  documents: 1,
  indexed: 1 - pending,
  pending,
});
async function cli(args: string[], changes: Record<string, string>) {
  const now = Date.now(),
    env = {
      ...process.env,
      GCP_STAGING_INDEXING_ENABLED: 'true',
      GCP_STAGING_INDEXING_FROM: new Date(now - 1000).toISOString(),
      GCP_STAGING_INDEXING_UNTIL: new Date(now + 3600000).toISOString(),
      GCP_STAGING_INDEXING_MAX_CALLS: '4',
      GITHUB_RUN_ID: '123',
      SYNC_TOKEN: 'offline-sync',
      SERVERLESS_ID_TOKEN: 'offline-identity',
      ...changes,
    };
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', script, ...args],
    { env, windowsHide: true },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}
async function endpoint(
  responses: { status?: number; body?: unknown; raw?: string }[],
  run: (
    origin: string,
    requests: { method: string; body: string }[],
  ) => Promise<void>,
) {
  const requests: { method: string; body: string }[] = [],
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      requests.push({ method: req.method!, body });
      assert.equal(req.headers.authorization, 'Bearer offline-sync');
      assert.equal(
        req.headers['x-serverless-authorization'],
        'Bearer offline-identity',
      );
      const response = responses.shift();
      assert.ok(response);
      res.writeHead(response.status ?? 200, {
        'content-type': 'application/json',
      });
      res.end(response.raw ?? JSON.stringify(response.body));
    });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`, requests);
  } finally {
    server.close();
    await once(server, 'close');
  }
}
let number = 0;
async function reportPath() {
  await mkdir(work, { recursive: true });
  return join(work, `run-${process.pid}-${++number}.jsonl`);
}
await test('unattended indexing defaults off and validates enabled windows before network work', async () => {
  const report = await reportPath();
  const off = await cli(['--live'], {
    GCP_STAGING_INDEXING_ENABLED: '',
    BIPLAN_URL: 'invalid',
  });
  assert.equal(off.code, 0);
  assert.match(off.stdout, /disabled; no requests/);
  const recorded = await cli(['--live', '--report', report], {
    GCP_STAGING_INDEXING_ENABLED: '',
    BIPLAN_URL: 'invalid',
    SYNC_TOKEN: '',
    SERVERLESS_ID_TOKEN: '',
  });
  assert.equal(recorded.code, 0);
  assert.equal(JSON.parse(await readFile(report, 'utf8')).outcome, 'disabled');
  const bad = await cli(['--live'], {
    BIPLAN_URL: 'https://fixture.run.app',
    GCP_STAGING_INDEXING_MAX_CALLS: '97',
  });
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /Invalid or expired indexing window/);
  const plan = await cli([], {
    BIPLAN_URL: 'https://fixture.run.app',
    SYNC_TOKEN: '',
    SERVERLESS_ID_TOKEN: '',
  });
  assert.equal(plan.code, 0);
  assert.equal(JSON.parse(plan.stdout).requests, 0);
  const daily = await cli([], {
    BIPLAN_URL: 'https://fixture.run.app',
    GCP_STAGING_INDEXING_FROM: '',
    GCP_STAGING_INDEXING_UNTIL: 'open',
    GCP_STAGING_INDEXING_MAX_CALLS: '96',
    SYNC_TOKEN: '',
    SERVERLESS_ID_TOKEN: '',
  });
  assert.equal(daily.code, 0, daily.stderr);
  const window = JSON.parse(daily.stdout).input.window;
  assert.equal(window.maxCalls, 96);
  assert.match(window.startedAt, /T00:00:00\.000Z$/);
  assert.equal(Date.parse(window.until) - Date.parse(window.startedAt), 24 * 3600000);
});
await test('fully cached catalog makes one activation POST without provider usage', async () => {
  const report = await reportPath();
  await endpoint(
    [
      { body: status() },
      {
        body: {
          ...status(),
          outcome: 'complete',
          embedded: 0,
          hashes: [],
          usage: { totalTokens: 0 },
          publication: { activated: true, pending: 0 },
          audit: null,
        },
      },
    ],
    async (origin, requests) => {
      const result = await cli(
        ['--live', '--allow-loopback-http', '--report', report],
        { BIPLAN_URL: origin },
      );
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(
        requests.map((r) => r.method),
        ['GET', 'POST'],
      );
    },
  );
  const rows = (await readFile(report, 'utf8'))
    .trim()
    .split('\n')
    .map((x) => JSON.parse(x));
  assert.equal(rows.at(-1).attempts, 1);
  assert.equal(rows.at(-1).totalTokens, 0);
  assert.equal(rows.at(-1).pending, 0);
});
await test('an older deployed endpoint without audited pin metadata never receives a POST', async () => {
  const report = await reportPath();
  const older = {
    configured: true,
    profile,
    eligible: 1,
    documents: 1,
    indexed: 0,
    pending: 1,
  };
  await endpoint([{ body: older }], async (origin, requests) => {
    const result = await cli(
      ['--live', '--allow-loopback-http', '--report', report],
      { BIPLAN_URL: origin },
    );
    assert.equal(result.code, 1);
    assert.deepEqual(
      requests.map((r) => r.method),
      ['GET'],
    );
  });
});
await test('failed POST original HTTP evidence is retained and never retried', async () => {
  const report = await reportPath(),
    failure = { error: 'Audited indexing stopped; no retry was attempted' };
  await endpoint(
    [{ body: status(1) }, { status: 503, body: failure }],
    async (origin, requests) => {
      const result = await cli(
        ['--live', '--allow-loopback-http', '--report', report],
        { BIPLAN_URL: origin },
      );
      assert.equal(result.code, 1);
      assert.deepEqual(
        requests.map((r) => r.method),
        ['GET', 'POST'],
      );
      const input = JSON.parse(requests[1].body);
      assert.equal(input.checkpointSha256, 'a'.repeat(64));
      assert.equal(input.expectedProfile, profile);
      assert.equal(input.runId, '123');
    },
  );
  assert.deepEqual(
    JSON.parse(await readFile(report + '-http-2.json', 'utf8')),
    failure,
  );
  assert.equal(
    JSON.parse((await readFile(report, 'utf8')).trim().split('\n').at(-1)!)
      .outcome,
    'failed',
  );
});
await test('bounded-stop remains visible rather than treating collection as fully indexed', async () => {
  const report = await reportPath();
  await endpoint(
    [
      { body: status(1) },
      {
        body: {
          ...status(1),
          outcome: 'bounded-stop',
          embedded: 0,
          hashes: [],
          usage: { totalTokens: 0 },
          audit: null,
        },
      },
    ],
    async (origin, requests) => {
      const result = await cli(
        ['--live', '--allow-loopback-http', '--report', report],
        { BIPLAN_URL: origin },
      );
      assert.equal(result.code, 2);
      assert.equal(requests.length, 2);
      assert.equal(JSON.parse(result.stdout).pending, 1);
    },
  );
});
await test('escaped reflected credentials are suppressed even when configured tokens have whitespace', async () => {
  const report = await reportPath();
  const raw = JSON.stringify({ error: { nested: 'offline-sync' } }).replace(
    'offline',
    '\\u006fffline',
  );
  await endpoint([{ status: 503, raw }], async (origin, requests) => {
    const result = await cli(
      ['--live', '--allow-loopback-http', '--report', report],
      { BIPLAN_URL: origin, SYNC_TOKEN: '  offline-sync  ' },
    );
    assert.equal(result.code, 1);
    assert.equal(requests.length, 1);
    assert.ok(!result.stdout.includes('offline-sync'));
    assert.ok(!result.stderr.includes('offline-sync'));
  });
  await assert.rejects(readFile(report + '-http-1.json'), { code: 'ENOENT' });
  const rows = (await readFile(report, 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s));
  assert.ok(
    rows.some(
      (r) =>
        r.type === 'http-response-suppressed' &&
        r.credentialSuppressed &&
        !r.complete,
    ),
  );
});
test.after(async () => {
  for (const name of await readdir(work).catch(() => []))
    if (name.startsWith(`run-${process.pid}-`)) await rm(join(work, name));
});
