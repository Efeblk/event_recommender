import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, parseArgs, parseEnv } from 'node:util';

import eventsJson from '../data/events.json' with { type: 'json' };
import { rankWithJev, jevConfigFrom } from '../lib/jev.ts';
import { mergeEventSessions } from '../lib/event-merge.ts';
import { recommend } from '../lib/recommend.ts';
import { deriveRequirements, meetsRequirements } from '../lib/requirements.ts';
import { interpretConstraints, isEligible } from '../lib/search.ts';
import {
  embedWithVoyage,
  voyageCacheKey,
  voyageConfigFrom,
  voyageDocumentText,
} from '../lib/voyage.ts';
import { emptyFilters } from '../lib/types.ts';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '..');
const repoRoot = resolve(webRoot, '..');
const casesRoot = resolve(webRoot, 'evals/cases');

function usage() {
  return 'Usage: node --experimental-strip-types web/scripts/trace-recommendation.mjs --cases web/evals/cases/file.json --case <id> --out <report.json> [--live]';
}

const { values } = parseArgs({
  options: {
    cases: { type: 'string' },
    case: { type: 'string' },
    out: { type: 'string' },
    live: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (values.help) {
  console.log(usage());
  process.exit(0);
}
if (!values.cases || !values.case || !values.out) throw new Error(usage());
if (values.cases.startsWith('/') || !values.cases.endsWith('.json'))
  throw new Error(
    '--cases must be a repo-relative JSON file under web/evals/cases.',
  );
const casesPath = resolve(repoRoot, values.cases);
if (!casesPath.startsWith(`${casesRoot}${sep}`))
  throw new Error('--cases must stay under web/evals/cases.');
const outputPath = resolve(process.cwd(), values.out);
try {
  await access(outputPath);
  throw new Error(
    'Output already exists; choose a new report path before making provider calls.',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

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
  throw new Error(
    'No local read-only D1 database with voyage_embeddings found.',
  );
}

function cachedVectorReader(db, config, evidence) {
  const profile = voyageCacheKey(config);
  return async (events) => {
    const documents = events.map((event) => ({
      id: event.id,
      hash: hash(voyageDocumentText(event)),
    }));
    const hashes = [...new Set(documents.map((item) => item.hash))];
    const rows = new Map();
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
    evidence.cacheCoverage = {
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

async function sourceState(fixtureText) {
  const { stdout: revision } = await execFileAsync(
    'git',
    ['rev-parse', 'HEAD'],
    {
      cwd: repoRoot,
    },
  );
  const { stdout: status } = await execFileAsync(
    'git',
    ['status', '--porcelain'],
    { cwd: repoRoot },
  );
  const dirtyTypeScript = {};
  for (const line of status.split(/\r?\n/).filter(Boolean)) {
    const rawPath = line.slice(3).split(' -> ').at(-1);
    if (!rawPath?.endsWith('.ts')) continue;
    const path = resolve(repoRoot, rawPath);
    try {
      dirtyTypeScript[rawPath] = hash(await readFile(path));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      dirtyTypeScript[rawPath] = null;
    }
  }
  return {
    codeRevision: revision.trim(),
    dirtyWorktree: status.length > 0,
    dirtyTypeScriptSha256: dirtyTypeScript,
    fixtureSha256: hash(fixtureText),
    eventsSha256: hash(await readFile(resolve(webRoot, 'data/events.json'))),
  };
}

function lineage(cases, selected) {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const result = [];
  const seen = new Set();
  let current = selected;
  while (current) {
    if (seen.has(current.id)) throw new Error('Case parent cycle detected.');
    seen.add(current.id);
    result.unshift(current);
    if (!current.parent) break;
    current = byId.get(current.parent);
    if (!current) throw new Error(`Missing parent case: ${result[0].parent}.`);
  }
  return result;
}

const fixtureText = await readFile(casesPath, 'utf8');
const fixture = JSON.parse(fixtureText);
if (!Array.isArray(fixture.cases)) throw new Error('Cases fixture is invalid.');
const selected = fixture.cases.find((item) => item.id === values.case);
if (!selected) throw new Error(`Case not found: ${values.case}.`);
const chain = lineage(fixture.cases, selected);
const now = new Date();
let previousFilters = emptyFilters;
const history = [];
for (const item of chain.slice(0, -1)) {
  const interpreted = interpretConstraints(item.message, previousFilters, now);
  if (interpreted.issue)
    throw new Error(`Parent case ${item.id} has issue ${interpreted.issue}.`);
  previousFilters = interpreted.filters;
  history.push({ role: 'user', content: item.message });
}

const env = await localEnv();
const secretValues = [env.TYPESAFE_API_KEY, env.VOYAGE_API_KEY].filter(
  (value) => typeof value === 'string' && value.length > 0,
);
function redactSecrets(value) {
  let safe = String(value).replace(
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
    'Bearer [REDACTED]',
  );
  for (const secret of secretValues)
    safe = safe.replaceAll(secret, '[REDACTED]');
  return safe;
}
function capturedResponse(text) {
  const safe = redactSecrets(text);
  try {
    return JSON.parse(safe);
  } catch {
    return { text: safe };
  }
}
const voyageConfig = voyageConfigFrom(env);
if (!voyageConfig)
  throw new Error(
    'VOYAGE_API_KEY/config is required to identify the cached profile.',
  );
const { db, path: databasePath } = await findVoyageDatabase();
const evidence = {
  cacheCoverage: null,
  queryEmbedding: null,
  filteredCandidates: [],
  shortlist: [],
  jev: {
    request: null,
    response: null,
    responseStatus: null,
    ranking: [],
    usage: null,
  },
};
const vectors = cachedVectorReader(db, voyageConfig, evidence);
let queryEmbeddingCalls = 0;
let jevCalls = 0;

const interpreted = interpretConstraints(
  selected.message,
  previousFilters,
  now,
);
if (interpreted.issue)
  throw new Error(`Selected case has constraint issue: ${interpreted.issue}.`);
const requirements = deriveRequirements(selected.message, history);
const filtered = mergeEventSessions(
  eventsJson.filter((event) => isEligible(event, emptyFilters, now)),
).filter(
  (event) =>
    isEligible(event, interpreted.filters, now) &&
    meetsRequirements(event, requirements),
);
evidence.filteredCandidates = filtered.map((event) => ({
  id: event.id,
  title: event.title,
  category: event.category,
  venue: event.venue,
  district: event.district,
  startsAt: event.startsAt,
  price: event.price,
}));
await vectors(filtered);

const deps = {
  now,
  candidates: async () => eventsJson,
  config: null,
  embeddingConfig: null,
};
if (values.live) {
  const jevConfig = jevConfigFrom(env);
  if (!jevConfig)
    throw new Error(
      'TYPESAFE_API_KEY/config is required for --live. No request was made.',
    );
  deps.config = jevConfig;
  deps.embeddingConfig = voyageConfig;
  deps.vectors = vectors;
  deps.embed = async (...args) => {
    queryEmbeddingCalls += 1;
    if (queryEmbeddingCalls > 1)
      throw new Error('Query embedding call ceiling exceeded.');
    const vectors = await embedWithVoyage(...args);
    evidence.queryEmbedding = { input: args[1], vectors };
    return vectors;
  };
  deps.rank = async (config, input, candidates) => {
    jevCalls += 1;
    if (jevCalls > 1) throw new Error('Jev call ceiling exceeded.');
    evidence.shortlist = candidates.map((event) => ({
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
    const fetcher = async (url, init) => {
      evidence.jev.request = JSON.parse(init.body);
      const response = await fetch(url, init);
      evidence.jev.responseStatus = response.status;
      evidence.jev.response = capturedResponse(await response.clone().text());
      return response;
    };
    const ranking = await rankWithJev(config, input, candidates, fetcher);
    evidence.jev.ranking = ranking.ranked.map(
      ({ event, score, confidence, probabilities, supportProbability }) => ({
        id: event.id,
        score,
        confidence,
        probabilities,
        supportProbability,
      }),
    );
    evidence.jev.usage = ranking.usage;
    evidence.jev.model = ranking.model;
    return ranking;
  };
}

let result = null;
let recommendationError = null;
try {
  result = await recommend(
    {
      message: selected.message,
      history,
      filters: previousFilters,
      excludeIds: [],
    },
    deps,
  );
} catch (error) {
  recommendationError = {
    name: error instanceof Error ? error.name : 'Error',
    message: redactSecrets(
      error instanceof Error ? error.message : 'Recommendation failed.',
    ),
  };
} finally {
  db.close();
}

const report = {
  schemaVersion: 1,
  kind: 'recommendation-trace',
  mode: values.live ? 'live-single-case' : 'dry-run',
  generatedAt: new Date().toISOString(),
  evaluationTime: now.toISOString(),
  case: selected,
  lineage: chain.map(({ id }) => id),
  source: {
    ...(await sourceState(fixtureText)),
    cases: relative(repoRoot, casesPath),
    events: 'web/data/events.json',
    localD1: relative(webRoot, databasePath),
  },
  calls: { voyageQuery: queryEmbeddingCalls, jev: jevCalls },
  automaticRetries: 0,
  evidence,
  recommendationError,
  result: result
    ? {
        mode: result.mode,
        status: result.status,
        notice: result.notice,
        filters: result.filters,
        totalCandidates: result.totalCandidates,
        recommendationIds: result.recommendations.map(({ event }) => event.id),
      }
    : null,
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
  flag: 'wx',
  mode: 0o600,
});
console.log(`Wrote ${outputPath}`);
console.log(
  values.live
    ? `Paid calls: ${queryEmbeddingCalls} Voyage query, ${jevCalls} Jev.`
    : 'Dry run complete: no provider calls.',
);
