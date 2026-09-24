import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = join(root, 'dist/server');
const temp = await mkdtemp(join(tmpdir(), 'biplan-worker-benchmark-'));
const concurrencies = [1, 4, 8];
const repeats = 3;
let harness;

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

try {
  const config = JSON.parse(
    await readFile(join(build, 'wrangler.json'), 'utf8'),
  );
  config.main = resolve(build, config.main);
  config.assets.directory = resolve(build, config.assets.directory);
  config.r2_buckets = [
    {
      binding: 'COLLECTION_STATE',
      bucket_name: 'biplan-isolated-benchmark-state',
    },
  ];
  config.vars = {
    TYPESAFE_API_KEY: '',
    VOYAGE_API_KEY: '',
    AI_API_KEY: '',
    OPENAI_API_KEY: '',
    EMBEDDING_API_KEY: '',
    EMBEDDING_ENABLED: 'false',
    AI_DAILY_LIMIT: '100',
    SYNC_TOKEN: 'isolated-benchmark-only',
  };
  delete config.limits;
  await writeFile(join(temp, 'wrangler.json'), JSON.stringify(config));
  await writeFile(join(temp, '.env'), '');
  process.env.WRANGLER_SEND_METRICS = 'false';
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  process.env.WRANGLER_LOG_PATH = join(temp, 'logs');
  // Keep stdout machine-readable when Wrangler emits harness lifecycle logs.
  console.log = (...values) => console.error(...values);
  const { createTestHarness } = await import('wrangler');
  harness = createTestHarness({
    root: temp,
    workers: [
      { configPath: join(temp, 'wrangler.json'), secrets: config.vars },
    ],
  });
  await harness.listen();
  const worker = harness.getWorker();
  const healthResponse = await worker.fetch('/api/health');
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json();
  assert.equal(health.status, 'ok');
  assert.equal(health.aiEnabled, false);
  assert.ok(health.catalog.eligible > 0);

  async function request() {
    const started = performance.now();
    const response = await worker.fetch('/api/recommend', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '127.0.0.1',
      },
      body: JSON.stringify({ message: 'İstanbul için bir etkinlik öner' }),
      signal: AbortSignal.timeout(60_000),
    });
    const body = await response.json();
    return {
      status: response.status,
      mode: body.mode ?? null,
      resultStatus: body.status ?? null,
      recommendations: body.recommendations?.length ?? 0,
      wallMs: performance.now() - started,
    };
  }

  const warmup = await request();
  assert.equal(warmup.status, 200);
  assert.equal(warmup.mode, 'filters');
  const runs = [];
  for (const concurrency of concurrencies) {
    for (let run = 1; run <= repeats; run++) {
      const memoryBefore = process.memoryUsage();
      const started = performance.now();
      const responses = await Promise.all(
        Array.from({ length: concurrency }, () => request()),
      );
      const wallMs = performance.now() - started;
      const memoryAfter = process.memoryUsage();
      assert.ok(responses.every((response) => response.status === 200));
      assert.ok(responses.every((response) => response.mode === 'filters'));
      runs.push({
        concurrency,
        run,
        wallMs,
        requestWallMs: responses.map((response) => response.wallMs),
        statuses: responses.map((response) => response.status),
        modes: responses.map((response) => response.mode),
        resultStatuses: responses.map((response) => response.resultStatus),
        recommendations: responses.map((response) => response.recommendations),
        rssBeforeBytes: memoryBefore.rss,
        rssAfterBytes: memoryAfter.rss,
        heapUsedBeforeBytes: memoryBefore.heapUsed,
        heapUsedAfterBytes: memoryAfter.heapUsed,
      });
    }
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        diagnosticOnly: true,
        warning:
          'Local workerd harness timings and host-process memory are directional only; they do not report Cloudflare CPU time, isolate memory, D1 network latency, or production capacity.',
        compiledWorker: true,
        isolatedState: true,
        providerCalls: 0,
        semanticPath: false,
        catalog: health.catalog,
        warmup,
        runs,
        summary: Object.fromEntries(
          concurrencies.map((concurrency) => {
            const selected = runs.filter(
              (run) => run.concurrency === concurrency,
            );
            const requestTimes = selected.flatMap((run) => run.requestWallMs);
            return [
              String(concurrency),
              {
                requestsPerRun: concurrency,
                runs: selected.length,
                medianBatchWallMs: percentile(
                  selected.map((run) => run.wallMs),
                  0.5,
                ),
                medianRequestWallMs: percentile(requestTimes, 0.5),
                p95RequestWallMs: percentile(requestTimes, 0.95),
                maxObservedHostRssBytes: Math.max(
                  ...selected.flatMap((run) => [
                    run.rssBeforeBytes,
                    run.rssAfterBytes,
                  ]),
                ),
                maxObservedHostHeapUsedBytes: Math.max(
                  ...selected.flatMap((run) => [
                    run.heapUsedBeforeBytes,
                    run.heapUsedAfterBytes,
                  ]),
                ),
              },
            ];
          }),
        ),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await harness?.close();
  await rm(temp, { recursive: true, force: true, maxRetries: 3 });
}
