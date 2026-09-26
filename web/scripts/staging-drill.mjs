import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = /^[0-9a-f]{40}$/;
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;
const TABLES = ['events', 'embeddings', 'voyage_embeddings', 'metadata', 'request_limits'];
const TABLE_COLUMNS = {
  events: ['id', 'starts_at', 'checked_at', 'category', 'price', 'source_url', 'payload'],
  embeddings: ['event_id', 'hash', 'model', 'vector'],
  voyage_embeddings: ['profile', 'hash', 'vector'],
  metadata: ['key', 'value'],
  request_limits: ['key', 'count', 'expires_at'],
};
const TABLE_ORDER = {
  events: 'id',
  embeddings: 'event_id',
  voyage_embeddings: 'profile,hash',
  metadata: 'key',
  request_limits: 'key',
};
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 20 * 1024 * 1024;
const DIGEST_PAGE_SIZE = 50;
const R2_DRILL_PREFIX = 'drills/checkpoint-restore/';
const CORRUPT_CHECKPOINT = Buffer.from('{"schemaVersion":0,"kind":"intentional-staging-drill-corruption"}\n');

const sha256Bytes = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function createR2DrillKey(revision, suffix = randomBytes(16).toString('hex')) {
  if (!SHA.test(revision) || !/^[0-9a-f]{32}$/.test(suffix))
    throw new Error('R2 drill object identity requires a revision and random hexadecimal suffix.');
  return `${R2_DRILL_PREFIX}${revision}/${suffix}.json`;
}

function checkpointSemantics(bytes) {
  const value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  if (value?.schemaVersion !== 1 || typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt)) || !Array.isArray(value.events))
    throw new Error('Checkpoint copy does not have the expected schema.');
  return { schemaVersion: value.schemaVersion, savedAt: value.savedAt, events: value.events.length };
}

export function verifyR2RestorePhase(original, candidate, phase) {
  const originalBytes = Buffer.from(original), candidateBytes = Buffer.from(candidate);
  if (phase === 'corrupted') {
    assert.equal(candidateBytes.equals(CORRUPT_CHECKPOINT), true, 'Isolated R2 object did not contain the deliberate corrupt fixture.');
    assert.notEqual(sha256Bytes(candidateBytes), sha256Bytes(originalBytes), 'Corrupt fixture unexpectedly matched the checkpoint.');
    return { phase, bytes: candidateBytes.length, sha256: sha256Bytes(candidateBytes), semanticEquivalent: false };
  }
  if (!['backup', 'restored'].includes(phase)) throw new Error(`Unknown R2 restore phase: ${phase}`);
  assert.equal(sha256Bytes(candidateBytes), sha256Bytes(originalBytes), `${phase} R2 checkpoint hash differs from the saved checkpoint.`);
  assert.deepEqual(checkpointSemantics(candidateBytes), checkpointSemantics(originalBytes), `${phase} R2 checkpoint semantics differ from the saved checkpoint.`);
  return { phase, bytes: candidateBytes.length, sha256: sha256Bytes(candidateBytes), semanticEquivalent: true };
}

export function parseArgs(argv) {
  const options = { execute: false, load: false, maxLoadRequests: 7 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--execute') options.execute = true;
    else if (arg === '--load') options.load = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
      options[key] = key === 'maxLoadRequests' ? Number(value) : value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function validateOptions(options) {
  const required = ['origin', 'expectedRevision', 'sourceD1', 'recoveryD1', 'r2Bucket', 'config'];
  for (const key of required)
    if (!String(options[key] ?? '').trim()) throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required.`);
  const origin = new URL(options.origin);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/')
    throw new Error('--origin must be an HTTPS origin without credentials or a path.');
  if (!SHA.test(options.expectedRevision))
    throw new Error('--expected-revision must be a lowercase 40-character commit SHA.');
  for (const key of ['sourceD1', 'recoveryD1', 'r2Bucket']) {
    const value = options[key];
    if (!SAFE_NAME.test(value) || !value.includes('staging'))
      throw new Error(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a safe staging-named resource.`);
  }
  if (options.sourceD1 === options.recoveryD1)
    throw new Error('Recovery D1 must be a new database, never the source database.');
  if (!/(?:drill|recovery|restore)/.test(options.recoveryD1))
    throw new Error('Recovery D1 name must include drill, recovery, or restore.');
  if (!Number.isSafeInteger(options.maxLoadRequests) || options.maxLoadRequests < 1 || options.maxLoadRequests > 12)
    throw new Error('--max-load-requests must be an integer from 1 through 12.');
  if (options.load && !options.execute)
    throw new Error('--load requires --execute.');
  return { ...options, origin: origin.origin };
}

export function buildPlan(options) {
  const artifactDir = resolve(
    options.artifactDir ??
      `work/staging-drill-${options.expectedRevision.slice(0, 12)}`,
  );
  return {
    mode: options.execute ? 'execute' : 'dry-run',
    environment: 'staging',
    origin: options.origin,
    expectedRevision: options.expectedRevision,
    sourceD1: options.sourceD1,
    recoveryD1: options.recoveryD1,
    r2Bucket: options.r2Bucket,
    configPath: resolve(options.config),
    artifactDir,
    load: options.load,
    maxLoadRequests: options.maxLoadRequests,
    commands: [
      ['wrangler', 'd1', 'list', '--json'],
      ['wrangler', 'd1', 'export', options.sourceD1, '--remote', '--output', '<artifact>/source.sql'],
      ['wrangler', 'd1', 'create', options.recoveryD1],
      ['wrangler', 'd1', 'execute', options.recoveryD1, '--remote', '--file', '<artifact>/source.sql', '--yes'],
      ...TABLES.flatMap((table) => [
        ['wrangler', 'd1', 'execute', options.sourceD1, '--remote', '--json', '--command', `SELECT COUNT(*) AS count FROM ${table}`],
        ['wrangler', 'd1', 'execute', options.recoveryD1, '--remote', '--json', '--command', `SELECT COUNT(*) AS count FROM ${table}`],
      ]),
      ['GET', `${options.origin}/api/health`],
      ['GET', `${options.origin}/api/ready`],
      ['GET', `${options.origin}/api/admin/collection`, 'Authorization: Bearer <redacted>'],
      ['wrangler', 'r2', 'object', 'put|get|delete', `${options.r2Bucket}/<generated-${R2_DRILL_PREFIX}key>`, '--remote'],
    ],
  };
}

function run(command, args, { capture = true } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      shell: false,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    });
    let stdout = '', stderr = '', outputBytes = 0, settled = false;
    const collect = (stream, append) =>
      stream?.setEncoding('utf8').on('data', (chunk) => {
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill();
          if (!settled) {
            settled = true;
            reject(new Error(`${command} output exceeded the ${MAX_COMMAND_OUTPUT_BYTES}-byte limit.`));
          }
          return;
        }
        append(chunk);
      });
    collect(child.stdout, (chunk) => (stdout += chunk));
    collect(child.stderr, (chunk) => (stderr += chunk));
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolvePromise({ stdout, stderr });
      else reject(new Error(`${command} ${args.slice(0, 3).join(' ')} failed with exit ${code}.`));
    });
  });
}

function wrangler(args) {
  const cli = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
  return run(process.execPath, [cli, ...args]);
}

async function getJson(url, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = null; }
  return { response, body, text };
}

function findCount(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const count = findCount(item);
      if (count !== undefined) return count;
    }
  } else if (value && typeof value === 'object') {
    if (Number.isSafeInteger(value.count)) return value.count;
    for (const item of Object.values(value)) {
      const count = findCount(item);
      if (count !== undefined) return count;
    }
  }
  return undefined;
}

function findResults(value) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const results = findResults(item);
      if (results) return results;
    }
  } else if (value && typeof value === 'object') {
    if (Array.isArray(value.results)) return value.results;
    for (const item of Object.values(value)) {
      const results = findResults(item);
      if (results) return results;
    }
  }
  return undefined;
}

export function digestRows(rows, columns) {
  const hash = createHash('sha256');
  for (const row of rows)
    hash.update(JSON.stringify(columns.map((column) => row[column])) + '\n');
  return hash.digest('hex');
}

async function tableCount(database, table) {
  const { stdout } = await wrangler(['d1', 'execute', database, '--remote', '--json', '--command', `SELECT COUNT(*) AS count FROM ${table}`]);
  const count = findCount(JSON.parse(stdout));
  if (!Number.isSafeInteger(count)) throw new Error(`Could not read ${table} count from ${database}.`);
  return count;
}

async function tableDigest(database, table) {
  const count = await tableCount(database, table);
  const columns = TABLE_COLUMNS[table];
  const hash = createHash('sha256');
  let read = 0;
  while (read < count) {
    const query = `SELECT ${columns.join(',')} FROM ${table} ORDER BY ${TABLE_ORDER[table]} LIMIT ${DIGEST_PAGE_SIZE} OFFSET ${read}`;
    const { stdout } = await wrangler(['d1', 'execute', database, '--remote', '--json', '--command', query]);
    const rows = findResults(JSON.parse(stdout));
    if (!Array.isArray(rows) || !rows.length || rows.length > DIGEST_PAGE_SIZE)
      throw new Error(`Could not read a bounded ${table} digest page from ${database}.`);
    for (const row of rows)
      hash.update(JSON.stringify(columns.map((column) => row[column])) + '\n');
    read += rows.length;
  }
  if (read !== count) throw new Error(`${table} changed while it was being digested.`);
  return { count, sha256: hash.digest('hex') };
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function exerciseIsolatedR2Restore(plan, checkpointPath) {
  const objectKey = createR2DrillKey(plan.expectedRevision);
  const identity = `${plan.r2Bucket}/${objectKey}`;
  const evidencePath = resolve(plan.artifactDir, 'r2-restore.json');
  const corruptPath = resolve(plan.artifactDir, 'r2-corrupt-fixture.json');
  const backupReadbackPath = resolve(plan.artifactDir, 'r2-backup-readback.json');
  const corruptReadbackPath = resolve(plan.artifactDir, 'r2-corrupt-readback.json');
  const restoredReadbackPath = resolve(plan.artifactDir, 'r2-restored-readback.json');
  const original = await readFile(checkpointPath);
  const evidence = {
    schemaVersion: 1,
    kind: 'isolated-r2-checkpoint-restore',
    object: { bucket: plan.r2Bucket, key: objectKey, canonical: false },
    commands: [],
    phases: [],
    cleanup: { attempted: false, deleted: false },
    limitation: 'This restores an isolated drill object containing actual checkpoint bytes; it does not alter or fail over the live canonical checkpoint key.',
  };
  const persist = () => writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  const command = async (args) => {
    evidence.commands.push(['wrangler', ...args]);
    await persist();
    return wrangler(args);
  };
  await writeFile(corruptPath, CORRUPT_CHECKPOINT);
  await persist();
  try {
    await command(['r2', 'object', 'put', identity, '--remote', '--file', checkpointPath]);
    await command(['r2', 'object', 'get', identity, '--remote', '--file', backupReadbackPath]);
    evidence.phases.push(verifyR2RestorePhase(original, await readFile(backupReadbackPath), 'backup'));
    await persist();

    await command(['r2', 'object', 'put', identity, '--remote', '--file', corruptPath]);
    await command(['r2', 'object', 'get', identity, '--remote', '--file', corruptReadbackPath]);
    evidence.phases.push(verifyR2RestorePhase(original, await readFile(corruptReadbackPath), 'corrupted'));
    await persist();

    await command(['r2', 'object', 'put', identity, '--remote', '--file', checkpointPath]);
    await command(['r2', 'object', 'get', identity, '--remote', '--file', restoredReadbackPath]);
    evidence.phases.push(verifyR2RestorePhase(original, await readFile(restoredReadbackPath), 'restored'));
    await persist();

    evidence.cleanup.attempted = true;
    await persist();
    await command(['r2', 'object', 'delete', identity, '--remote']);
    evidence.cleanup.deleted = true;
    await persist();
    return evidence;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message.slice(0, 300) : 'R2 restore drill failed.';
    await persist();
    throw error;
  }
}

export function validateLoadResponse(body) {
  const errors = [];
  if (!body || typeof body !== 'object') return ['Response is not a JSON object.'];
  if (body.mode !== 'jev') errors.push(`Expected Jev mode; received ${String(body.mode)}.`);
  if (body.status !== 'results') errors.push(`Expected result status; received ${String(body.status)}.`);
  if (!Array.isArray(body.recommendations) || !body.recommendations.length)
    errors.push('Recommendations must be a non-empty array.');
  const seen = new Set();
  for (const recommendation of Array.isArray(body.recommendations) ? body.recommendations : []) {
    const event = recommendation?.event;
    if (!event || typeof event !== 'object') {
      errors.push('Recommendation has no event.');
      continue;
    }
    if (event.category !== 'Konser') errors.push(`${event.id ?? 'unknown'} is not a concert.`);
    if (typeof event.price !== 'number' || event.price > 1000)
      errors.push(`${event.id ?? 'unknown'} lacks supported price at or below 1000 TL.`);
    if (typeof event.url !== 'string' || !event.url.startsWith('https://'))
      errors.push(`${event.id ?? 'unknown'} lacks an HTTPS source URL.`);
    const sources = [event.source, ...(Array.isArray(event.offers) ? event.offers.map((offer) => offer?.source) : [])];
    if (!sources.some((source) => ['biletinial', 'bubilet', 'biletix'].includes(source)))
      errors.push(`${event.id ?? 'unknown'} lacks a recognized provider source.`);
    const identity = JSON.stringify([event.title, event.startsAt, event.venue]);
    if (seen.has(identity)) errors.push(`Duplicate card identity: ${identity}.`);
    seen.add(identity);
  }
  return errors;
}

async function runLoad(plan) {
  const results = [];
  let remaining = plan.maxLoadRequests;
  const queries = [
    '1000 TL alt\u0131nda konser \u00f6ner',
    '1000 TL b\u00fct\u00e7eyle konser \u00f6ner',
    'En fazla 1000 TL olan bir konser \u00f6ner',
  ];
  const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
  let batchNumber = 0;
  for (const concurrency of [1, 2, 4, 4, 4]) {
    if (!remaining) break;
    if (batchNumber) await sleep(65_000);
    const size = Math.min(concurrency, remaining);
    const batch = await Promise.all(
      Array.from({ length: size }, async (_, index) => {
        const input = { message: queries[(results.length + index) % queries.length] };
        const started = Date.now();
        try {
          const response = await fetch(plan.origin + '/api/recommend', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(input),
            redirect: 'manual',
            signal: AbortSignal.timeout(45_000),
          });
          const text = await response.text();
          let body = null;
          let parseError = null;
          try { body = JSON.parse(text); } catch (error) { parseError = error instanceof Error ? error.message : 'Invalid JSON.'; }
          const errors = [
            ...(response.status === 200 ? [] : ['HTTP ' + response.status + '.']),
            ...(parseError ? ['JSON parse failed: ' + parseError] : validateLoadResponse(body)),
          ];
          return { input, concurrency, status: response.status, durationMs: Date.now() - started, body, rawBody: body ? undefined : text, errors, ok: errors.length === 0 };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Request failed.';
          return { input, concurrency, status: null, durationMs: Date.now() - started, body: null, errors: [message], ok: false };
        }
      }),
    );
    results.push(...batch);
    remaining -= size;
    batchNumber++;
  }
  return results;
}

export async function execute(plan, syncToken) {
  if (!syncToken) throw new Error('STAGING_SYNC_TOKEN is required only with --execute.');
  await mkdir(dirname(plan.artifactDir), { recursive: true });
  await mkdir(plan.artifactDir, { recursive: false });
  const config = JSON.parse(await readFile(plan.configPath, 'utf8'));
  assert.equal(config.vars?.DEPLOYMENT_ENV, 'staging', 'Compiled config must target staging.');
  assert.equal(config.vars?.DEPLOYMENT_SHA, plan.expectedRevision, 'Compiled config revision must match --expected-revision.');
  assert.ok(
    config.d1_databases?.some((binding) => binding.binding === 'DB' && binding.database_name === plan.sourceD1),
    'Compiled config DB binding must match --source-d1.',
  );
  assert.ok(
    config.r2_buckets?.some((binding) => binding.binding === 'COLLECTION_STATE' && binding.bucket_name === plan.r2Bucket),
    'Compiled config COLLECTION_STATE binding must match --r2-bucket.',
  );
  const health = await getJson(`${plan.origin}/api/health`);
  assert.equal(health.response.status, 200, 'Staging health must return 200.');
  assert.equal(health.body?.deployment?.environment, 'staging');
  assert.equal(health.body?.deployment?.revision, plan.expectedRevision);
  const ready = await getJson(`${plan.origin}/api/ready`);
  assert.equal(ready.response.status, 200, 'Staging readiness must return 200.');
  assert.equal(ready.body?.ready, true);

  const listed = await wrangler(['d1', 'list', '--json']);
  const databases = JSON.parse(listed.stdout);
  if (!Array.isArray(databases)) throw new Error('Unexpected Wrangler D1 list response.');
  if (databases.some((database) => database?.name === plan.recoveryD1))
    throw new Error('Recovery D1 already exists; choose a new disposable staging drill name.');
  if (!databases.some((database) => database?.name === plan.sourceD1))
    throw new Error('Source staging D1 was not found.');

  const sourceBefore = {};
  for (const table of TABLES)
    sourceBefore[table] = await tableDigest(plan.sourceD1, table);
  const sqlPath = resolve(plan.artifactDir, 'source.sql');
  await wrangler(['d1', 'export', plan.sourceD1, '--remote', '--output', sqlPath]);
  const sqlInfo = await stat(sqlPath);
  if (!sqlInfo.size) throw new Error('D1 export is empty.');
  const sourceAfter = {};
  for (const table of TABLES) {
    sourceAfter[table] = await tableDigest(plan.sourceD1, table);
    assert.deepEqual(
      sourceAfter[table],
      sourceBefore[table],
      `${table} changed during export; no snapshot-integrity claim can be made.`,
    );
  }
  await wrangler(['d1', 'create', plan.recoveryD1]);
  await wrangler(['d1', 'execute', plan.recoveryD1, '--remote', '--file', sqlPath, '--yes']);
  const integrity = {};
  for (const table of TABLES) {
    const recovered = await tableDigest(plan.recoveryD1, table);
    assert.deepEqual(recovered, sourceAfter[table], `${table} content differs after restore.`);
    integrity[table] = { source: sourceAfter[table], recovered };
  }

  const checkpoint = await getJson(`${plan.origin}/api/admin/collection`, {
    headers: { authorization: `Bearer ${syncToken}` },
  });
  assert.equal(checkpoint.response.status, 200, 'Protected checkpoint readback must return 200.');
  assert.equal(checkpoint.response.headers.get('cache-control'), 'no-store');
  assert.equal(checkpoint.body?.schemaVersion, 1);
  assert.ok(Array.isArray(checkpoint.body?.events));
  assert.ok(Buffer.byteLength(checkpoint.text) <= MAX_CHECKPOINT_BYTES, 'Checkpoint response exceeds the application checkpoint limit.');
  assert.equal(checkpoint.body.events.length, ready.body.checkpoint.events);
  assert.equal(checkpoint.body.savedAt, ready.body.checkpoint.savedAt);
  const checkpointPath = resolve(plan.artifactDir, 'checkpoint.json');
  await writeFile(checkpointPath, checkpoint.text);
  const r2Restore = await exerciseIsolatedR2Restore(plan, checkpointPath);
  const load = plan.load ? await runLoad(plan) : [];
  const loadOk = load.every((request) => request.ok);
  const modes = load.reduce((counts, request) => {
    const mode = request.body?.mode ?? 'unavailable';
    counts[mode] = (counts[mode] ?? 0) + 1;
    return counts;
  }, {});
  const artifact = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environment: 'staging',
    revision: plan.expectedRevision,
    origin: plan.origin,
    resources: { sourceD1: plan.sourceD1, recoveryD1: plan.recoveryD1, r2Bucket: plan.r2Bucket },
    d1: { exportBytes: sqlInfo.size, exportSha256: await sha256File(sqlPath), sourceStableDuringExport: true, integrity },
    checkpoint: { bytes: Buffer.byteLength(checkpoint.text), sha256: createHash('sha256').update(checkpoint.text).digest('hex'), savedAt: checkpoint.body.savedAt, events: checkpoint.body.events.length },
    r2Restore,
    load: {
      requested: plan.load,
      ok: loadOk,
      requestCount: load.length,
      providerTransportUpperBound: load.length,
      modes,
      requests: load,
    },
    limitations: ['Wall time is not Cloudflare Worker CPU time.', 'The disposable recovery D1 is intentionally not deleted automatically.', 'The R2 drill restores only its generated isolated object; it does not alter or fail over the live canonical checkpoint key.'],
  };
  await writeFile(resolve(plan.artifactDir, 'result.json'), JSON.stringify(artifact, null, 2));
  return artifact;
}

async function main() {
  const options = validateOptions(parseArgs(process.argv.slice(2)));
  const plan = buildPlan(options);
  if (!options.execute) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  const result = await execute(plan, process.env.STAGING_SYNC_TOKEN);
  if (!result.load.ok) throw new Error(`Staging load validation failed; evidence was preserved in ${plan.artifactDir}.`);
  console.log(JSON.stringify({ ok: true, artifactDir: plan.artifactDir, revision: result.revision, loadRequests: result.load.requestCount }, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Staging drill failed.');
    process.exitCode = 1;
  });
