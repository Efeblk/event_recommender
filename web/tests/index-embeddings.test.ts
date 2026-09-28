import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../scripts/index-embeddings.mjs', import.meta.url),
);
const work = fileURLToPath(new URL('../work/', import.meta.url));
const profile =
  'voyage-embedding-v1|endpoint=https://api.voyageai.com/v1/embeddings|model=voyage-4-large|dimensions=1024|input_type=document|text_profile=event-title-category-venue-description-v1';
const hash = 'a'.repeat(64);
let reportNumber = 0;

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
    assert.equal(
      request.headers['x-serverless-authorization'],
      'Bearer test-identity-token',
    );
    const { __status = 200, ...body } = replies.shift() ?? {};
    if (body.configured === true && body.profile === undefined)
      body.profile = profile;
    if (body.embedded !== undefined) {
      body.hashes ??= Array(body.embedded).fill(hash);
      body.usage ??= { totalTokens: body.embedded };
    }
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

async function invoke(
  origin: string,
  args: string[] = [],
  options: {
    script?: string;
    token?: string | null;
    serverlessToken?: string | null;
    autoLive?: boolean;
  } = {},
) {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    BIPLAN_URL: '',
  };
  if (options.serverlessToken === null) delete environment.SERVERLESS_ID_TOKEN;
  else
    environment.SERVERLESS_ID_TOKEN =
      options.serverlessToken ?? 'test-identity-token';
  if (options.token === null) delete environment.SYNC_TOKEN;
  else environment.SYNC_TOKEN = options.token ?? 'test-token';
  const actualArgs = [...args];
  let reportPath: string | undefined;
  if (actualArgs.includes('--live') && options.autoLive !== false) {
    await mkdir(work, { recursive: true });
    reportPath = join(
      work,
      `index-command-${process.pid}-${reportNumber++}.json`,
    );
    if (!actualArgs.some((value) => value.startsWith('--max-batches')))
      actualArgs.push('--max-batches', '100');
    if (!actualArgs.some((value) => value.startsWith('--max-total-tokens')))
      actualArgs.push('--max-total-tokens', '10000');
    if (!actualArgs.some((value) => value.startsWith('--expected-profile')))
      actualArgs.push('--expected-profile', profile);
    if (!actualArgs.some((value) => value.startsWith('--expected-pending')))
      actualArgs.push('--expected-pending', '1');
    if (!actualArgs.some((value) => value.startsWith('--report')))
      actualArgs.push('--report', reportPath);
  }
  const child = spawn(
    process.execPath,
    [
      options.script ?? script,
      '--origin',
      origin,
      '--allow-loopback-http',
      ...actualArgs,
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
  return new Promise<{
    code: number;
    stdout: string;
    stderr: string;
    report?: unknown;
    journal?: Array<{ event: string; state: unknown }>;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', async (code) => {
      let report;
      let journal;
      if (reportPath) {
        try {
          journal = (await readFile(reportPath, 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
          report = journal.at(-1)?.state;
        } finally {
          await rm(reportPath, { force: true });
        }
      }
      resolve({ code: code ?? 1, stdout, stderr, report, journal });
    });
  });
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
      const result = await invoke(origin, [
        '--live',
        '--max-batches',
        '1',
        '--expected-pending',
        '3',
      ]);
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

await test('live mode requires explicit cost, profile, pending, and report guards', async () => {
  const result = await invoke('https://service-example.run.app', ['--live'], {
    autoLive: false,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Live private Cloud Run indexing requires/);
});

await test('private Cloud Run requires a separate identity token', async () => {
  const result = await invoke('https://service-example.run.app', [], {
    serverlessToken: null,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /SERVERLESS_ID_TOKEN is required/);
});

await test('live indexing activates a fully cached pending publication', async () => {
  await withEndpoint(
    [
      { configured: true, eligible: 1, documents: 1, indexed: 1, pending: 0 },
      {
        configured: true,
        eligible: 1,
        documents: 1,
        indexed: 1,
        pending: 0,
        embedded: 0,
        usage: { totalTokens: 0 },
      },
    ],
    async (origin, methods) => {
      const result = await invoke(origin, ['--live'], { autoLive: false });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(methods, ['GET', 'POST']);
      assert.equal(result.report, undefined);
    },
  );
});

await test('private evidence report refuses to overwrite an existing file', async () => {
  await mkdir(work, { recursive: true });
  const reportPath = join(work, `existing-${process.pid}.json`);
  await writeFile(reportPath, 'preserve me', { flag: 'wx' });
  try {
    const result = await invoke(
      'https://service-example.run.app',
      [
        '--live',
        '--max-batches',
        '1',
        '--max-total-tokens',
        '100',
        '--expected-profile',
        profile,
        '--expected-pending',
        '1',
        '--report',
        reportPath,
      ],
      { autoLive: false },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /EEXIST/);
    assert.equal(await readFile(reportPath, 'utf8'), 'preserve me');
  } finally {
    await rm(reportPath, { force: true });
  }
});

await test('profile and pending drift stop before a paid POST', async () => {
  await withEndpoint(
    [{ configured: true, eligible: 2, documents: 2, indexed: 1, pending: 1 }],
    async (origin, methods) => {
      const result = await invoke(origin, [
        '--live',
        '--expected-profile',
        profile.replace('voyage-4-large', 'voyage-4'),
      ]);
      assert.notEqual(result.code, 0);
      assert.deepEqual(methods, ['GET']);
      assert.match(result.stderr, /profile does not match/);
      assert.equal((result.report as { outcome: string }).outcome, 'failed');
    },
  );
  await withEndpoint(
    [{ configured: true, eligible: 3, documents: 3, indexed: 1, pending: 2 }],
    async (origin, methods) => {
      const result = await invoke(origin, ['--live']);
      assert.notEqual(result.code, 0);
      assert.deepEqual(methods, ['GET']);
      assert.match(result.stderr, /Pending count/);
    },
  );
});

await test('observed token cap stops without retry and preserves partial report', async () => {
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
        usage: { totalTokens: 11 },
      },
    ],
    async (origin, methods) => {
      const result = await invoke(origin, [
        '--live',
        '--expected-pending',
        '2',
        '--max-total-tokens',
        '10',
      ]);
      assert.notEqual(result.code, 0);
      assert.deepEqual(methods, ['GET', 'POST']);
      const evidence = result.report as {
        outcome: string;
        totalTokens: number;
        postAttempts: number;
        batches: Array<{ usage: { totalTokens: number } }>;
      };
      assert.equal(evidence.outcome, 'failed');
      assert.equal(evidence.totalTokens, 11);
      assert.equal(evidence.postAttempts, 1);
      assert.equal(evidence.batches[0].usage.totalTokens, 11);
      assert.deepEqual(
        result.journal?.map((entry) => entry.event),
        [
          'created',
          'initial-status',
          'post-attempt',
          'batch-receipt',
          'finished',
        ],
      );
    },
  );
});

await test('an exact observed token cap stops before another paid POST', async () => {
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
        usage: { totalTokens: 10 },
      },
    ],
    async (origin, methods) => {
      const result = await invoke(origin, [
        '--live',
        '--expected-pending',
        '2',
        '--max-total-tokens',
        '10',
      ]);
      assert.notEqual(result.code, 0);
      assert.deepEqual(methods, ['GET', 'POST']);
      assert.match(result.stderr, /reached --max-total-tokens/);
      const evidence = result.report as {
        totalTokens: number;
        postAttempts: number;
        batches: unknown[];
      };
      assert.equal(evidence.totalTokens, 10);
      assert.equal(evidence.postAttempts, 1);
      assert.equal(evidence.batches.length, 1);
    },
  );
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
      const result = await invoke(origin, [
        '--live',
        '--interval-ms',
        '60',
        '--expected-pending',
        '2',
      ]);
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
