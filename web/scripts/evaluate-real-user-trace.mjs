import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import eventsJson from '../data/events.json' with { type: 'json' };
import { rankWithJev, jevConfigFrom } from '../lib/jev.ts';
import { mergeEventSessions } from '../lib/event-merge.ts';
import { recommend } from '../lib/recommend.ts';
import { deriveRequirements, meetsRequirements } from '../lib/requirements.ts';
import { interpretConstraints, isEligible } from '../lib/search.ts';
import { voyageConfigFrom, voyageCacheKey, voyageDocumentText } from '../lib/voyage.ts';
import { emptyFilters } from '../lib/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const evaluationTime = new Date('2026-09-24T07:30:29.223Z');
const frozenCasesUrl = new URL(
  '../evals/cases/2026-09-24-real-user-journeys.json',
  import.meta.url,
);
const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const timestamp = new Date().toISOString().replaceAll(':', '-');
const outputPath = resolve(
  process.cwd(),
  values.out ?? `evals/reports/${timestamp}-real-user-trace.json`,
);

async function localEnv() {
  try {
    return parseEnv(await readFile(resolve(webRoot, '.dev.vars'), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

async function findVoyageDatabase() {
  const directory = resolve(
    webRoot,
    '.wrangler/state/v3/d1/miniflare-D1DatabaseObject',
  );
  const names = (await readdir(directory)).filter(
    (name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite',
  );
  for (const name of names) {
    const path = resolve(directory, name);
    const db = new DatabaseSync(path, { readOnly: true });
    const found = db
      .prepare(
        "SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name='voyage_embeddings'",
      )
      .get();
    if (found) return { db, path };
    db.close();
  }
  throw new Error('No local read-only D1 database with voyage_embeddings found.');
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function cachedVectorReader(db, config, evidence) {
  const profile = voyageCacheKey(config);
  return async (events) => {
    const documents = events.map((event) => ({
      id: event.id,
      hash: hash(voyageDocumentText(event)),
    }));
    const rows = new Map();
    const hashes = [...new Set(documents.map((item) => item.hash))];
    for (let offset = 0; offset < hashes.length; offset += 200) {
      const page = hashes.slice(offset, offset + 200);
      const placeholders = page.map(() => '?').join(',');
      for (const row of db
        .prepare(
          `SELECT hash,vector FROM voyage_embeddings WHERE profile=? AND hash IN (${placeholders})`,
        )
        .all(profile, ...page))
        rows.set(row.hash, JSON.parse(row.vector));
    }
    const missing = documents.filter((item) => !rows.has(item.hash));
    evidence.vectorCoverage = {
      requestedEvents: events.length,
      uniqueDocuments: hashes.length,
      cachedDocuments: rows.size,
      missingIds: missing.map(({ id }) => id),
      profile,
    };
    if (missing.length)
      throw new Error(
        `Cached Voyage coverage incomplete for ${missing.length} filtered events; no paid request was made.`,
      );
    return new Map(documents.map((item) => [item.id, rows.get(item.hash)]));
  };
}

const frozen = JSON.parse(await readFile(frozenCasesUrl, 'utf8'));
const nominated = frozen.cases.find((item) => item.id === 'soft_mood');
if (!nominated) throw new Error('Frozen soft_mood case is missing.');
const env = await localEnv();
const voyageConfig = voyageConfigFrom(env);
if (!voyageConfig)
  throw new Error('VOYAGE_API_KEY/config is required to validate the cache profile.');
const { db, path: databasePath } = await findVoyageDatabase();
const evidence = {
  phases: [
    {
      phase: 'input',
      status: 'validated',
      detail: 'Frozen soft_mood case and fixed evaluation time loaded.',
    },
    {
      phase: 'retrieval',
      status: values.live ? 'pending' : 'readiness-only',
      detail: values.live
        ? 'Production recommend path will use cached document vectors and one query embedding.'
        : 'Dry run makes no query embedding call; local cache access is validated.',
    },
    {
      phase: 'jev',
      status: values.live ? 'pending' : 'not-called',
      detail: values.live
        ? 'Production recommend path may make one Jev ranking call for at most 16 candidates.'
        : 'Dry run validates deterministic recommendation flow only.',
    },
  ],
  vectorCoverage: null,
  jevCandidates: [],
  jevRanking: [],
};
const vectors = cachedVectorReader(db, voyageConfig, evidence);
let queryEmbeddingCalls = 0;
let jevCalls = 0;

const deps = {
  now: evaluationTime,
  candidates: async () => eventsJson,
  config: null,
  embeddingConfig: null,
};

// Fail closed before either provider can be called. recommend intentionally
// falls back when semantic retrieval is unavailable, so this explicit preflight
// is what makes complete cached-document coverage a live-run prerequisite.
const interpreted = interpretConstraints(
  nominated.message,
  emptyFilters,
  evaluationTime,
);
if (interpreted.issue)
  throw new Error(`Frozen case has a constraint issue: ${interpreted.issue}.`);
const requirements = deriveRequirements(nominated.message, []);
const filtered = mergeEventSessions(
  eventsJson.filter((event) => isEligible(event, emptyFilters, evaluationTime)),
).filter(
  (event) =>
    isEligible(event, interpreted.filters, evaluationTime) &&
    meetsRequirements(event, requirements),
);
await vectors(filtered);

if (values.live) {
  const jevConfig = jevConfigFrom(env);
  if (!jevConfig)
    throw new Error('TYPESAFE_API_KEY/config is required for --live. No request was made.');
  deps.config = jevConfig;
  deps.embeddingConfig = voyageConfig;
  deps.vectors = vectors;
  deps.embed = async (...args) => {
    queryEmbeddingCalls += 1;
    if (queryEmbeddingCalls > 1)
      throw new Error('Query embedding call ceiling exceeded.');
    const { embedWithVoyage } = await import('../lib/voyage.ts');
    return embedWithVoyage(...args);
  };
  deps.rank = async (config, input, candidates) => {
    jevCalls += 1;
    if (jevCalls > 1) throw new Error('Jev call ceiling exceeded.');
    evidence.jevCandidates = candidates.map((event) => ({
      id: event.id,
      title: event.title,
      description: event.description,
      category: event.category,
      venue: event.venue,
      district: event.district,
      startsAt: event.startsAt,
      price: event.price,
      currency: event.currency,
    }));
    const ranking = await rankWithJev(config, input, candidates);
    evidence.jevRanking = ranking.ranked.map(({ event, score, confidence }) => ({
      id: event.id,
      score,
      confidence,
    }));
    evidence.jevModel = ranking.model;
    evidence.jevUsage = ranking.usage;
    return ranking;
  };
}

let result;
try {
  result = await recommend(
    {
      message: nominated.message,
      history: [],
      filters: emptyFilters,
      excludeIds: [],
    },
    deps,
  );
} finally {
  db.close();
}

if (values.live) {
  evidence.phases[1].status = 'completed';
  evidence.phases[2].status = jevCalls === 1 ? 'completed' : 'not-needed';
}
const report = {
  schemaVersion: 1,
  kind: 'real-user-recommend-trace',
  mode: values.live ? 'live-single-case' : 'dry-run',
  generatedAt: new Date().toISOString(),
  evaluationTime: evaluationTime.toISOString(),
  case: nominated,
  source: {
    events: 'data/events.json',
    frozenCases: 'evals/cases/2026-09-24-real-user-journeys.json',
    localD1: databasePath.slice(webRoot.length + 1),
  },
  calls: { queryEmbedding: queryEmbeddingCalls, jev: jevCalls },
  evidence,
  result: {
    mode: result.mode,
    status: result.status,
    notice: result.notice,
    filters: result.filters,
    totalCandidates: result.totalCandidates,
    recommendationIds: result.recommendations.map(({ event }) => event.id),
  },
};
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n', {
  flag: 'wx',
  mode: 0o600,
});
console.log(`Wrote ${outputPath}`);
console.log(
  values.live
    ? `Paid calls: ${queryEmbeddingCalls} query embedding, ${jevCalls} Jev.`
    : 'Dry run complete: no provider calls.',
);
