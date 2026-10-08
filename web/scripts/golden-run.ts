/** Frozen quality replay. Default is offline; --prepare never calls a provider. */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  buildSearchCatalog,
  searchCatalogCandidates,
  type SearchCatalog,
} from '../lib/materialized-catalog.ts';
import { recommendRequest } from '../lib/recommend.ts';
import { interpretSpanInput } from '../lib/span-interpreter.ts';
import { rankWithJev, jevConfigFrom } from '../lib/jev.ts';
import {
  embedWithVoyage,
  voyageCacheKey,
  voyageDocumentText,
} from '../lib/voyage.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';
import { GoldenTransport, type GoldenBudget } from '../evals/golden-cache.ts';
import {
  auditGoldenResult,
  expectedMatches,
  qualitySummary,
  resultDigest,
  sha256,
  validateGoldenFixture,
  type GoldenFixture,
  type GoldenLabels,
  type GoldenRow,
} from '../evals/golden-v1.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = resolve(root, 'work/phase-one');
const voyage = {
  apiKey: 'offline-replay',
  model: 'voyage-4-large',
  dimensions: 1024 as const,
};

export async function beginGoldenRow(options: {
  live: boolean;
  lastStart: number;
  intervalMs: number;
  transportErrors: number;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<number | null> {
  if (options.live && options.transportErrors > 0) return null;
  const now = options.now ?? Date.now;
  if (options.live && options.lastStart) {
    const milliseconds = Math.max(
      0,
      options.lastStart + options.intervalMs - now(),
    );
    await (options.wait ??
      ((delay) => new Promise((resolve) => setTimeout(resolve, delay))))(
      milliseconds,
    );
  }
  return now();
}

function workPath(path: string): string {
  const full = resolve(root, path),
    child = relative(resolve(root, 'work'), full);
  if (!child || child.startsWith('..') || resolve(root, 'work', child) !== full)
    throw new Error(
      'Golden catalog, vectors, cache, budget and output must stay under web/work.',
    );
  return full;
}

async function preparationProfile(): Promise<string> {
  const parts: string[] = [];
  async function walk(directory: string) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const path = join(directory, item.name);
      if (item.isDirectory()) await walk(path);
      else if (/\.(ts|mjs)$/.test(item.name))
        parts.push(`${relative(root, path)}\n${sha256(await readFile(path))}`);
    }
  }
  for (const path of [
    'lib',
    '../contracts',
    '../collector/identity',
    '../collector/normalize',
  ])
    await walk(resolve(root, path));
  return sha256(parts.join('\n'));
}

export async function loadFrozenCatalog(
  fixture: GoldenFixture,
  path: string,
  cacheDirectory: string,
) {
  const raw = await readFile(path);
  if (
    raw.length !== fixture.catalog.bytes ||
    sha256(raw) !== fixture.catalog.sha256
  )
    throw new Error(
      'Frozen catalog bytes/hash differ from the reviewed fixture.',
    );
  const source = JSON.parse(raw.toString('utf8')) as EventRecord[];
  if (
    !Array.isArray(source) ||
    source.length !== fixture.catalog.sourceRecords ||
    new Set(source.map((e) => e.id)).size !== source.length
  )
    throw new Error('Invalid frozen source records.');
  const profile = await preparationProfile();
  const key = sha256(
    JSON.stringify({
      catalog: fixture.catalog.sha256,
      profile,
      now: fixture.referenceTime,
    }),
  );
  const cachePath = join(cacheDirectory, `prepared-${key}.json`);
  let catalog: SearchCatalog;
  let cached: string | undefined;
  try {
    cached = await readFile(cachePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (cached !== undefined) {
    const entry = JSON.parse(cached) as { raw: string; sha256: string };
    if (sha256(entry.raw) !== entry.sha256)
      throw new Error('Corrupt prepared catalog cache.');
    catalog = JSON.parse(entry.raw);
  } else {
    catalog = buildSearchCatalog(source, new Date(fixture.referenceTime));
    await mkdir(cacheDirectory, { recursive: true });
    const raw = JSON.stringify(catalog);
    await writeFile(cachePath, JSON.stringify({ raw, sha256: sha256(raw) }), {
      flag: 'wx',
    });
  }
  const at = Date.parse(fixture.referenceTime);
  // Match store.gcp.ts embeddingCandidates: current and all future versions.
  const embeddingEvents = catalog.groups.flatMap(({ versions }) =>
    versions.flatMap((version, index) =>
      (versions[index + 1]?.from ?? Infinity) <= at ? [] : version.events,
    ),
  );
  return {
    events: searchCatalogCandidates(
      catalog,
      emptyFilters,
      new Date(fixture.referenceTime),
    ),
    embeddingEvents,
    profile,
  };
}

export function documentEstimate(events: EventRecord[]) {
  const documents = new Map(
    events.map((event) => {
      const text = voyageDocumentText(event);
      return [sha256(text), text];
    }),
  );
  const texts = [...documents.values()];
  const characters = texts.reduce((sum, text) => sum + text.length, 0);
  const utf8Bytes = texts.reduce(
    (sum, text) => sum + Buffer.byteLength(text),
    0,
  );
  return {
    inputRecords: events.length,
    uniqueDocuments: documents.size,
    characters,
    utf8Bytes,
    estimatedTokens: Math.ceil(characters / 3),
    conservativeTokenEnvelope: utf8Bytes,
    estimateMethod:
      'UTF-16 code units/3 estimate; UTF-8 bytes as conservative planning envelope, not a tokenizer count or guaranteed invoice cap',
    voyageUsdPerMillionTokens: 0.12,
    estimatedUsd: (Math.ceil(characters / 3) * 0.12) / 1_000_000,
    conservativeUsdEnvelope: (utf8Bytes * 0.12) / 1_000_000,
    pricingSource: 'https://docs.voyageai.com/docs/pricing',
    pricingCheckedAt: '2026-10-04',
    freeTierAssumed: false,
    legacyIndexOversizedDocuments: texts.filter(
      (text) => Buffer.byteLength(text) > 8000,
    ).length,
  };
}

export async function loadVectors(
  path: string,
  events: EventRecord[],
  allowPartial = false,
) {
  const raw = await readFile(path);
  const value = JSON.parse(raw.toString('utf8')) as {
    schemaVersion: number;
    profile: string;
    dimensions: number;
    entries: { hash: string; vector: number[] }[];
  };
  if (
    raw.length > 128 * 1024 * 1024 ||
    value.schemaVersion !== 1 ||
    value.profile !== voyageCacheKey(voyage) ||
    value.dimensions !== 1024 ||
    !Array.isArray(value.entries) ||
    value.entries.length > 20_000
  )
    throw new Error('Invalid golden Voyage vector export.');
  const byHash = new Map<string, number[]>();
  for (const entry of value.entries) {
    if (
      !/^[a-f0-9]{64}$/.test(entry.hash) ||
      byHash.has(entry.hash) ||
      !Array.isArray(entry.vector) ||
      entry.vector.length !== 1024 ||
      !entry.vector.every(Number.isFinite) ||
      !entry.vector.some((v) => v !== 0)
    )
      throw new Error('Invalid golden vector entry.');
    byHash.set(entry.hash, entry.vector);
  }
  const byId = new Map<string, number[]>();
  for (const event of events) {
    const vector = byHash.get(sha256(voyageDocumentText(event)));
    if (vector) byId.set(event.id, vector);
  }
  if (byId.size !== events.length && !allowPartial)
    throw new Error(
      `Full frozen vector coverage required: ${byId.size}/${events.length}.`,
    );
  return { byId, sha256: sha256(raw), complete: byId.size === events.length };
}

function reviewHtml(fixture: GoldenFixture, fixtureSha256: string): string {
  const escape = (text: string) =>
    text.replace(
      /[&<>"']/g,
      (c) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[c]!,
    );
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Phase 1 request review</title>
<style>body{font:16px/1.5 system-ui;margin:32px auto;padding:0 20px;max-width:1000px;color:#172b3a}article{border-top:1px solid #c8d6df;padding:20px 0}h2{font-size:16px;color:#496477}p{margin:8px 0}code,pre{overflow-wrap:anywhere}pre{white-space:pre-wrap}blockquote{margin:12px 0;font-size:20px}small{color:#496477}</style>
<h1>Review the 40 golden requests</h1><p>25 Turkish + 15 English; each request is independent. Fixed time: 4 October 2026, 09:50 Istanbul. This preparation makes no paid calls.</p><p>Review each request and its constraints. Reply in T3 Code with approval or the IDs to change.</p><p><small>Fixture SHA-256: <code>${fixtureSha256}</code></small></p>
${fixture.cases.map((c) => `<article><h2>${escape(c.id)} · ${c.language}</h2><blockquote>${escape(c.message)}</blockquote><p>${escape(c.reviewSummary)}</p>${c.relevanceNotes ? `<p>${escape(c.relevanceNotes)}</p>` : ''}<details><summary>Exact expected plan</summary><pre>${escape(JSON.stringify(c.expected, null, 2))}</pre></details></article>`).join('\n')}</html>`;
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      prepare: { type: 'boolean', default: false },
      live: { type: 'boolean', default: false },
      fixture: { type: 'string', default: 'fixtures/golden-v1.json' },
      catalog: { type: 'string' },
      vectors: { type: 'string' },
      'allow-partial-vectors': { type: 'boolean', default: false },
      'interval-ms': { type: 'string', default: '13000' },
      cache: { type: 'string', default: 'work/phase-one/cache' },
      budget: { type: 'string' },
      'reviewed-retry': { type: 'string' },
      output: { type: 'string' },
      labels: { type: 'string', default: 'fixtures/golden-v1-labels.json' },
    },
  });
  if (values.prepare && values.live)
    throw new Error('--prepare cannot be live.');
  const rawFixture = await readFile(resolve(root, values.fixture!), 'utf8');
  const fixture = validateGoldenFixture(JSON.parse(rawFixture));
  const fixtureSha256 = sha256(rawFixture);
  if (!values.prepare && fixture.review.status !== 'approved')
    throw new Error(
      'The user must review all 40 requests before a scored run.',
    );
  if (!values.prepare && !values.vectors)
    throw new Error('--vectors with full frozen-catalog coverage is required.');
  await mkdir(work, { recursive: true });
  const { events, embeddingEvents, profile } = await loadFrozenCatalog(
    fixture,
    workPath(values.catalog ?? fixture.catalog.defaultPath),
    workPath(values.cache!),
  );
  const now = new Date(fixture.referenceTime);
  if (values.prepare) {
    const report = {
      schemaVersion: 1,
      mode: 'preparation-only',
      fixtureSha256,
      catalogSha256: fixture.catalog.sha256,
      referenceTime: fixture.referenceTime,
      preparationProfile: profile,
      networkCalls: 0,
      eligibleSessions: events.length,
      documentEstimate: documentEstimate(embeddingEvents),
      cases: fixture.cases.map((item) => ({
        caseId: item.id,
        expectedHardMatchCount: expectedMatches(events, item, now).length,
      })),
    };
    const out = workPath(values.output ?? 'work/phase-one/preparation.json');
    await writeFile(out, JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
    });
    await writeFile(
      join(work, 'request-review.html'),
      reviewHtml(fixture, fixtureSha256),
    );
    console.log(JSON.stringify(report));
    return;
  }
  const vectors = await loadVectors(
    workPath(values.vectors!),
    events,
    values['allow-partial-vectors'],
  );
  const intervalMs = Number(values['interval-ms']);
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 0 ||
    (values.live && intervalMs < 13000)
  )
    throw new Error(
      'Live golden requests must be paced at least 13 seconds apart.',
    );
  const config = values.live
    ? jevConfigFrom({
        TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
        TYPESAFE_MODEL: process.env.TYPESAFE_MODEL,
      })
    : {
        apiKey: 'offline-replay',
        model: process.env.TYPESAFE_MODEL ?? 'jev-1.13.0',
      };
  if (!config)
    throw new Error('TYPESAFE_API_KEY is required for live golden calls.');
  const embeddingConfig = {
    ...voyage,
    apiKey: values.live
      ? (process.env.VOYAGE_API_KEY?.trim() ?? '')
      : voyage.apiKey,
  };
  if (!embeddingConfig.apiKey)
    throw new Error('VOYAGE_API_KEY is required for live golden queries.');
  const budget = values.budget
    ? (JSON.parse(
        await readFile(workPath(values.budget), 'utf8'),
      ) as GoldenBudget)
    : undefined;
  if (values.live && !budget)
    throw new Error('--budget with a user-approved phase budget is required.');
  const transport = new GoldenTransport({
    directory: workPath(values.cache!),
    budgetDirectory: work,
    catalogSha256: fixture.catalog.sha256,
    referenceTime: fixture.referenceTime,
    live: values.live,
    budget,
    paceVoyage: values.live,
    reviewedRetry: values['reviewed-retry']
      ? JSON.parse(await readFile(workPath(values['reviewed-retry']), 'utf8'))
      : undefined,
  });
  const rows: GoldenRow[] = [];
  const out = workPath(
    values.output ??
      `work/phase-one/run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  const handle = await import('node:fs/promises').then((fs) =>
    fs.open(out, 'wx', 0o600),
  );
  const provenance = {
    fixtureSha256,
    catalogSha256: fixture.catalog.sha256,
    referenceTime: fixture.referenceTime,
    preparationProfile: profile,
    vectorsSha256: vectors.sha256,
    vectorCoverage: {
      available: vectors.byId.size,
      eligible: events.length,
      complete: vectors.complete,
    },
    jevModel: config.model,
    voyageProfile: voyageCacheKey(voyage),
  };
  let lastStart = 0;
  try {
    for (const item of fixture.cases) {
      const nextStart = await beginGoldenRow({
        live: Boolean(values.live),
        lastStart,
        intervalMs,
        transportErrors: transport.errors.length,
      });
      if (nextStart === null) break;
      lastStart = nextStart;
      const start = performance.now(),
        hits = transport.hits,
        paid = transport.paidCalls,
        errors = transport.errors.length;
      let result: GoldenRow['result'] = null;
      const rowErrors: string[] = [];
      {
        const context = JSON.stringify({ message: item.message });
        const fetcher = transport.fetcher(context);
        result = await recommendRequest(
          { message: item.message },
          {
            now,
            candidates: async () => events,
            config,
            embeddingConfig,
            inputInterpreter: 'span-v2',
            vectors: async (candidates) =>
              new Map(
                candidates
                  .filter((e) => vectors.byId.has(e.id))
                  .map((e) => [e.id, vectors.byId.get(e.id)!]),
              ),
            spanInterpret: (input, options) =>
              interpretSpanInput(input, { ...options, fetcher }),
            rank: (cfg, input, candidates) =>
              rankWithJev(cfg, input, candidates, fetcher),
            embed: (cfg, texts, type) =>
              // The evaluation transport can wait for the shared local pacer.
              // Production/staging keeps its normal provider timeout.
              embedWithVoyage(cfg, texts, type, fetcher, 120_000),
          },
        );
        rowErrors.push(...transport.errors.slice(errors));
        if (
          result.status === 'needs_input' ||
          result.status === 'unsupported_location'
        )
          rowErrors.push(
            `Request did not produce a searchable plan: ${result.status}.`,
          );
        if (result.recommendations.length && result.mode !== 'jev')
          rowErrors.push('Provider fallback is not a scored Jev result.');
      }
      const row: GoldenRow = {
        caseId: item.id,
        elapsedMs: performance.now() - start,
        cacheHits: transport.hits - hits,
        paidCalls: transport.paidCalls - paid,
        errors: rowErrors,
        result,
        top10: (result?.recommendations ?? [])
          .slice(0, 10)
          .map(({ event }, i) => ({
            rank: i + 1,
            recordId: event.id,
            sourceRecordIds: [
              ...new Set([
                ...(event.mergedIds ?? [event.id]),
                ...(event.offers ?? []).map((o) => o.id),
              ]),
            ],
            event,
          })),
        audit: result ? auditGoldenResult(item, result, events, now) : null,
      };
      rows.push(row);
      // Rewrite after each serial request, retaining completed rows on a crash.
      const snapshot =
        JSON.stringify(
          {
            schemaVersion: 1,
            mode: values.live ? 'live-frozen' : 'offline-replay',
            ...provenance,
            completed: false,
            requests: rows.length,
            paidCalls: transport.paidCalls,
            cacheHits: transport.hits,
            rows,
          },
          null,
          2,
        ) + '\n';
      await handle.truncate(0);
      await handle.write(snapshot, 0, 'utf8');
      await handle.sync();
      console.log(
        JSON.stringify({
          caseId: item.id,
          status: result?.status ?? 'blocked',
          cards: row.top10.length,
          errors: row.errors,
          paidCalls: row.paidCalls,
          cacheHits: row.cacheHits,
        }),
      );
    }
    const raw =
      JSON.stringify(
        {
          schemaVersion: 1,
          mode: values.live ? 'live-frozen' : 'offline-replay',
          ...provenance,
          completed: rows.every((r) => !r.errors.length),
          requests: rows.length,
          paidCalls: transport.paidCalls,
          cacheHits: transport.hits,
          rows,
        },
        null,
        2,
      ) + '\n';
    await handle.truncate(0);
    await handle.write(raw, 0, 'utf8');
    await handle.sync();
    const labels = JSON.parse(
      await readFile(resolve(root, values.labels!), 'utf8'),
    ) as GoldenLabels;
    const resultSha256 = resultDigest(rows);
    const summary = qualitySummary(rows, labels, {
      ...provenance,
      resultSha256,
    });
    if (!vectors.complete) summary.frozenQualityPassed = false;
    await writeFile(
      `${out}.summary.json`,
      JSON.stringify(summary, null, 2) + '\n',
      { flag: 'wx' },
    );
    console.log(
      JSON.stringify({
        output: relative(root, out),
        runSha256: sha256(raw),
        resultSha256,
        ...summary,
      }),
    );
    process.exitCode = rows.some((r) => r.errors.length)
      ? 1
      : summary.frozenQualityPassed
        ? 0
        : 2;
  } finally {
    await handle.close();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch(() => {
    console.error(
      'Golden run stopped. Check review, frozen inputs, cache and budget; no automatic retry.',
    );
    process.exitCode = 1;
  });
}
