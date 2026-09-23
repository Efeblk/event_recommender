import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../scripts/index-embeddings.mjs', import.meta.url),
);

async function withEndpoint(
  replies: Array<Record<string, unknown> & { __status?: number }>,
  run: (
    origin: string,
    methods: string[],
    requestedAt: number[],
  ) => Promise<void>,
  expectedToken = 'test-token',
) {
  const methods: string[] = [];
  const requestedAt: number[] = [];
  const server = createServer((request, response) => {
    methods.push(request.method ?? '');
    requestedAt.push(Date.now());
    assert.equal(request.headers.authorization, `Bearer ${expectedToken}`);
    const { __status = 200, ...body } = replies.shift() ?? {};
    response.statusCode = __status;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address === 'object');
  try {
    await run(`http://127.0.0.1:${address.port}`, methods, requestedAt);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function invoke(
  origin: string,
  args: string[] = [],
  options: { script?: string; token?: string | null } = {},
) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    BIPLAN_URL: '',
  };
  if (options.token === null) delete environment.SYNC_TOKEN;
  else environment.SYNC_TOKEN = options.token ?? 'test-token';
  const child = spawn(
    process.execPath,
    [
      options.script ?? script,
      '--origin',
      origin,
      '--allow-loopback-http',
      ...args,
    ],
    {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return new Promise<{ code: number; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) =>
        resolve({ code: code ?? 1, stdout, stderr }),
      );
    },
  );
}

await test('embedding index command is a read-only status check by default', async () => {
  await withEndpoint(
    [{ configured: true, eligible: 2, documents: 2, indexed: 0, pending: 2 }],
    async (origin, methods) => {
      const result = await invoke(origin);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(methods, ['GET']);
      assert.match(result.stdout, /Dry run only/);
    },
  );
});

await test('loopback command loads a quoted token from an isolated .dev.vars', async () => {
  const root = await mkdtemp(join(tmpdir(), 'biplan-index-test-'));
  try {
    const scripts = join(root, 'scripts');
    await mkdir(scripts);
    const isolatedScript = join(scripts, 'index-embeddings.mjs');
    await copyFile(script, isolatedScript);
    await writeFile(
      join(root, '.dev.vars'),
      'IGNORED=value\nSYNC_TOKEN = "local-test-token" # quoted local token\n',
      { mode: 0o600 },
    );
    await withEndpoint(
      [{ configured: true, eligible: 1, documents: 1, indexed: 1, pending: 0 }],
      async (origin, methods) => {
        const result = await invoke(origin, [], {
          script: isolatedScript,
          token: null,
        });
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(methods, ['GET']);
      },
      'local-test-token',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await test('live indexing makes no paid request when the server has no key', async () => {
  await withEndpoint(
    [{ configured: false, eligible: 2, documents: 2, indexed: 0, pending: 2 }],
    async (origin, methods) => {
      const result = await invoke(origin, ['--live']);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(methods, ['GET']);
      assert.match(result.stdout, /no provider request was made/);
    },
  );
});

await test('live indexing stops at the requested batch bound', async () => {
  await withEndpoint(
    [
      { configured: true, eligible: 3, documents: 3, indexed: 0, pending: 3 },
      {
        configured: true,
        eligible: 3,
        documents: 3,
        indexed: 1,
        pending: 2,
        embedded: 1,
      },
    ],
    async (origin, methods) => {
      const result = await invoke(origin, ['--live', '--max-batches', '1']);
      assert.equal(result.code, 2, result.stderr);
      assert.deepEqual(methods, ['GET', 'POST']);
      assert.match(result.stdout, /still pending/);
    },
  );
});

await test('interval option is bounded to safe integer milliseconds', async () => {
  for (const value of ['-1', '60001', '1.5', 'NaN']) {
    const result = await invoke('http://127.0.0.1:1', [
      `--interval-ms=${value}`,
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /--interval-ms must be an integer/);
  }
});

await test('live indexing waits only between successful pending batches', async () => {
  await withEndpoint(
    [
      { configured: true, eligible: 2, documents: 2, indexed: 0, pending: 2 },
      {
        configured: true,
        eligible: 2,
        documents: 2,
        indexed: 1,
        pending: 1,
        embedded: 1,
      },
      {
        configured: true,
        eligible: 2,
        documents: 2,
        indexed: 2,
        pending: 0,
        embedded: 1,
      },
    ],
    async (origin, methods, requestedAt) => {
      const result = await invoke(origin, ['--live', '--interval-ms', '60']);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(methods, ['GET', 'POST', 'POST']);
      assert.ok(requestedAt[2] - requestedAt[1] >= 45);
    },
  );
});

await test('provider HTTP status is exposed only from the strict safe error', async () => {
  await withEndpoint(
    [
      { configured: true, eligible: 1, documents: 1, indexed: 0, pending: 1 },
      {
        __status: 503,
        error: 'Voyage request failed (HTTP 429).; no retry was attempted',
      },
    ],
    async (origin) => {
      const result = await invoke(origin, ['--live']);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Voyage request failed \(HTTP 429\)/);
    },
  );
  await withEndpoint(
    [
      { configured: true, eligible: 1, documents: 1, indexed: 0, pending: 1 },
      { __status: 503, error: 'secret upstream detail' },
    ],
    async (origin) => {
      const result = await invoke(origin, ['--live']);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /Embedding endpoint failed \(503\)/);
      assert.doesNotMatch(result.stderr, /secret upstream detail/);
    },
  );
});
