import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { recommend, validateInput } from '../lib/recommend.ts';
import { emptyFilters } from '../lib/types.ts';
import { voyageDocumentText } from '../lib/voyage.ts';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dimensions = 1024;
const repeats = 3;
const concurrencies = [1, 4, 8];

async function findDatabases(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await findDatabases(path)));
    else if (entry.isFile() && entry.name.endsWith('.sqlite')) found.push(path);
  }
  return found;
}

async function sqlite(database, sql) {
  const { stdout } = await exec(
    'sqlite3',
    ['-readonly', '-json', database, sql],
    { maxBuffer: 128 * 1024 * 1024 },
  );
  return stdout.trim() ? JSON.parse(stdout) : [];
}

async function cachedVectors() {
  const databases = await findDatabases(
    join(root, '.wrangler', 'state', 'v3', 'd1'),
  );
  for (const database of databases) {
    const tables = await sqlite(
      database,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='voyage_embeddings'",
    );
    if (!tables.length) continue;
    const profiles = await sqlite(
      database,
      'SELECT profile,COUNT(*) AS rows FROM voyage_embeddings GROUP BY profile ORDER BY rows DESC LIMIT 1',
    );
    if (!profiles.length) continue;
    const escaped = String(profiles[0].profile).replaceAll("'", "''");
    const rows = await sqlite(
      database,
      `SELECT hash,vector FROM voyage_embeddings WHERE profile='${escaped}'`,
    );
    if (rows.length) return { database, profile: profiles[0].profile, rows };
  }
  throw new Error(
    'No local cached Voyage vectors found under web/.wrangler; run the local index separately before benchmarking.',
  );
}

async function sha256(value) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function deltaCpu(start) {
  const cpu = process.cpuUsage(start);
  return (cpu.user + cpu.system) / 1000;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

const catalog = JSON.parse(
  await readFile(join(root, 'data', 'events.json'), 'utf8'),
);
const cache = await cachedVectors();
const vectorJsonByHash = new Map(
  cache.rows.map((row) => [row.hash, row.vector]),
);
const documentHashes = new Map(
  await Promise.all(
    catalog.map(async (event) => [
      event.id,
      await sha256(voyageDocumentText(event)),
    ]),
  ),
);
const firstVector = JSON.parse(cache.rows[0].vector);
if (
  firstVector.length !== dimensions ||
  !firstVector.every((value) => Number.isFinite(value))
)
  throw new Error(`Cached vectors are not ${dimensions}-dimensional.`);

const now = new Date(
  catalog.reduce(
    (latest, event) => (event.checkedAt > latest ? event.checkedAt : latest),
    '',
  ),
);
const input = validateInput({
  message: 'İstanbul için bir etkinlik öner',
  filters: emptyFilters,
});
const embeddingConfig = {
  apiKey: 'local-benchmark-never-sent',
  model: 'voyage-4-large',
  dimensions,
};
let lastCoverage = 0;
const dependencies = {
  now,
  candidates: async () => catalog,
  config: { apiKey: 'local-benchmark-never-sent', model: 'jev-1.13.0' },
  embeddingConfig,
  vectors: async (events) => {
    const vectors = new Map();
    for (const event of events) {
      const json = vectorJsonByHash.get(documentHashes.get(event.id));
      if (json) vectors.set(event.id, JSON.parse(json));
    }
    lastCoverage = vectors.size;
    return vectors;
  },
  embed: async () => [firstVector],
  rank: async (config, request, events) => ({
    ranked: events.map((event) => ({
      event,
      score: 2.1,
      confidence: 0.9,
      probabilities: [0.02, 0.08, 0.7, 0.2],
      supportProbability: 0.9,
    })),
    model: config.model,
    usage: { inputTokens: 0, outputTokens: 0 },
  }),
};

async function one() {
  const result = await recommend(input, dependencies);
  if (result.status !== 'results' || result.mode !== 'jev')
    throw new Error(
      `Unexpected benchmark result: ${result.status}/${result.mode}`,
    );
  return result;
}

await one();
const results = [];
for (const concurrency of concurrencies) {
  for (let run = 1; run <= repeats; run++) {
    const beforeMemory = process.memoryUsage();
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    await Promise.all(Array.from({ length: concurrency }, () => one()));
    const wallMs = performance.now() - wallStart;
    const cpuMs = deltaCpu(cpuStart);
    const afterMemory = process.memoryUsage();
    results.push({
      concurrency,
      run,
      requests: concurrency,
      wallMs,
      cpuMs,
      cpuMsPerRequest: cpuMs / concurrency,
      wallMsPerRequest: wallMs / concurrency,
      rssBeforeBytes: beforeMemory.rss,
      rssAfterBytes: afterMemory.rss,
      rssDeltaBytes: afterMemory.rss - beforeMemory.rss,
      heapUsedBeforeBytes: beforeMemory.heapUsed,
      heapUsedAfterBytes: afterMemory.heapUsed,
    });
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  diagnosticOnly: true,
  warning:
    'Local Node CPU, wall-time, and process-memory measurements are directional only; they do not prove Cloudflare Worker CPU, D1 latency, subrequest use, or production capacity.',
  networkCalls: 0,
  cacheWrites: 0,
  fixture: {
    events: catalog.length,
    eligibleVectorCoverage: lastCoverage,
    cachedRows: cache.rows.length,
    dimensions,
    lookupPageSize: 200,
    estimatedD1VectorLookupQueries: Math.ceil(lastCoverage / 200),
    queryVector: 'first valid cached document vector (synthetic query)',
    database: cache.database.replace(root, 'web'),
    profile: cache.profile,
    now: now.toISOString(),
  },
  runs: results,
  summary: Object.fromEntries(
    concurrencies.map((concurrency) => {
      const runs = results.filter(
        (result) => result.concurrency === concurrency,
      );
      return [
        String(concurrency),
        {
          requestsPerRun: concurrency,
          runs: runs.length,
          medianCpuMsPerRequest: percentile(
            runs.map((result) => result.cpuMsPerRequest),
            0.5,
          ),
          p95CpuMsPerRequest: percentile(
            runs.map((result) => result.cpuMsPerRequest),
            0.95,
          ),
          medianBatchWallMs: percentile(
            runs.map((result) => result.wallMs),
            0.5,
          ),
          maxObservedRssBytes: Math.max(
            ...runs.flatMap((result) => [
              result.rssBeforeBytes,
              result.rssAfterBytes,
            ]),
          ),
          maxObservedHeapUsedBytes: Math.max(
            ...runs.flatMap((result) => [
              result.heapUsedBeforeBytes,
              result.heapUsedAfterBytes,
            ]),
          ),
        },
      ];
    }),
  ),
};

console.log(JSON.stringify(report, null, 2));
