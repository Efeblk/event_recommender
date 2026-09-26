// Run the real Voyage adapter inside workerd against an offline loopback provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(join(tmpdir(), 'biplan-voyage-workerd-'));
const vector = Array.from({ length: 1024 }, (_, index) => (index + 1) / 1024);
let providerRequest;
const provider = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    providerRequest = {
      method: request.method,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    response.setHeader('content-type', 'application/json');
    if (request.url?.endsWith('/slow-body')) {
      response.write('{"data":');
      return;
    }
    response.end(JSON.stringify({ data: [{ index: 0, embedding: vector }] }));
  } catch {
    response.statusCode = 400;
    response.end('{}');
  }
});

process.env.WRANGLER_SEND_METRICS = 'false';
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
process.env.WRANGLER_LOG_PATH = join(temp, 'logs');
let harness;
try {
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const address = provider.address();
  assert(address && typeof address === 'object');
  const mockUrl = `http://127.0.0.1:${address.port}/embeddings`;

  const source = (await readFile(join(root, 'lib/voyage.ts'), 'utf8')).replace(
    "import { withDeadline } from './deadline.ts';",
    '',
  );
  const deadline = ts.transpileModule(
    await readFile(join(root, 'lib/deadline.ts'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      fileName: 'deadline.ts',
      reportDiagnostics: true,
    },
  );
  const adapter = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: 'voyage.ts',
    reportDiagnostics: true,
  });
  assert.deepEqual(
    [...(deadline.diagnostics ?? []), ...(adapter.diagnostics ?? [])].filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
  );
  const worker = `${deadline.outputText}
${adapter.outputText}
export default {
  async fetch(request) {
    const slow = request.headers.get('x-test-slow-body') === 'yes';
    try {
      const vectors = await embedWithVoyage(
        { apiKey: 'offline-test-key', model: 'voyage-4-large', dimensions: 1024 },
        ['hello'],
        'query',
        (_url, init) => fetch(${JSON.stringify(mockUrl)} + (slow ? '/slow-body' : '/'), init),
        slow ? 50 : 15000,
      );
      return Response.json({ rows: vectors.length, dimensions: vectors[0]?.length });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'unknown' }, { status: 504 });
    }
  },
};
`;
  await writeFile(join(temp, 'worker.mjs'), worker);
  await writeFile(join(temp, '.env'), '');
  await writeFile(
    join(temp, 'wrangler.json'),
    JSON.stringify({
      name: 'voyage-workerd-smoke',
      main: 'worker.mjs',
      compatibility_date: '2025-09-01',
    }),
  );
  const { createTestHarness } = await import('wrangler');
  harness = createTestHarness({
    root: temp,
    workers: [{ configPath: join(temp, 'wrangler.json') }],
  });
  await harness.listen();
  const response = await harness.getWorker().fetch('http://worker.test/');
  const detail = await response.text();
  assert.equal(response.status, 200, detail);
  assert.deepEqual(JSON.parse(detail), { rows: 1, dimensions: 1024 });
  assert.deepEqual(providerRequest, {
    method: 'POST',
    authorization: 'Bearer offline-test-key',
    body: {
      input: ['hello'],
      model: 'voyage-4-large',
      input_type: 'query',
      truncation: false,
      output_dimension: 1024,
      output_dtype: 'float',
    },
  });
  const slowStarted = Date.now();
  const slowResponse = await harness
    .getWorker()
    .fetch('http://worker.test/slow-body', {
      headers: { 'x-test-slow-body': 'yes' },
    });
  assert.equal(slowResponse.status, 504);
  assert.deepEqual(await slowResponse.json(), {
    error: 'Voyage request timed out.',
  });
  assert.ok(Date.now() - slowStarted < 2000);
  console.log('Voyage adapter workerd smoke test passed.');
} finally {
  await harness?.close();
  provider.closeAllConnections();
  provider.close();
  if (provider.listening) await once(provider, 'close');
  await rm(temp, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
