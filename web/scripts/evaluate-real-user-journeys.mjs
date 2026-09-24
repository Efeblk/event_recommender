import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isAlternativesRequest } from '../lib/intent.ts';

const execFileAsync = promisify(execFile);
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(webRoot, '..');
const defaultFixturePath = resolve(
  webRoot,
  'evals/cases/2026-09-24-real-user-journeys.json',
);
const casesRoot = resolve(webRoot, 'evals/cases');
const defaultMaxHttpRequests = 16;
const customMaxHttpRequests = 24;
const requestSpacingMs = 25_000;
const requestTimeoutMs = 45_000;

function usage() {
  return [
    'Usage:',
    '  node scripts/evaluate-real-user-journeys.mjs',
    '  node scripts/evaluate-real-user-journeys.mjs [--cases web/evals/cases/file.json]',
    '  node scripts/evaluate-real-user-journeys.mjs --live --out <report.json> [--cases web/evals/cases/file.json] [--origin http://127.0.0.1:3001]',
  ].join('\n');
}

function parseArgs(argv) {
  const options = {
    live: false,
    origin: 'http://127.0.0.1:3001',
    out: null,
    cases: null,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--live') options.live = true;
    else if (['--out', '--origin', '--cases'].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith('--'))
        throw new Error(`Missing value for ${argument}.`);
      if (argument === '--out') options.out = value;
      else if (argument === '--origin') options.origin = value;
      else options.cases = value;
    } else if (argument === '--help' || argument === '-h') {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.live && !options.out)
    throw new Error('--out is required with --live.');

  const origin = new URL(options.origin);
  if (
    origin.protocol !== 'http:' ||
    !['localhost', '127.0.0.1'].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error(
      '--origin must be an HTTP origin on localhost or 127.0.0.1.',
    );
  options.origin = origin.origin;
  if (options.cases) {
    if (options.cases.startsWith('/') || !options.cases.endsWith('.json'))
      throw new Error(
        '--cases must be a repo-relative JSON file under evals/cases.',
      );
    const resolvedCases = resolve(repoRoot, options.cases);
    if (!resolvedCases.startsWith(`${casesRoot}${sep}`))
      throw new Error('--cases must stay under evals/cases.');
    options.cases = resolvedCases;
  }
  return options;
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds),
  );
}

const options = parseArgs(process.argv.slice(2));
const fixturePath = options.cases ?? defaultFixturePath;
const maxHttpRequests = options.cases
  ? customMaxHttpRequests
  : defaultMaxHttpRequests;
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (!Array.isArray(fixture.cases) || fixture.cases.length > maxHttpRequests)
  throw new Error(`Fixture must contain at most ${maxHttpRequests} cases.`);

const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
  cwd: webRoot,
});
const codeRevision = stdout.trim();
if (!/^[0-9a-f]{40}$/.test(codeRevision))
  throw new Error('Could not resolve the current Git revision.');
const { stdout: statusOutput } = await execFileAsync(
  'git',
  ['status', '--porcelain'],
  { cwd: webRoot },
);
const dirtyWorktree = statusOutput.length > 0;

if (!options.live) {
  console.log(
    JSON.stringify(
      {
        mode: 'dry-run',
        fixture: relative(repoRoot, fixturePath),
        origin: options.origin,
        codeRevision,
        dirtyWorktree,
        cases: fixture.cases.length,
        maxHttpRequests,
        automaticRetries: 0,
        requestSpacingMs,
        message: 'No HTTP requests were sent and no report was written.',
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const outputPath = resolve(process.cwd(), options.out);
const report = {
  ...fixture,
  fixture: relative(repoRoot, fixturePath),
  codeRevision,
  dirtyWorktree,
  startedAt: new Date().toISOString(),
  maxHttpRequests,
  automaticRetries: 0,
  origin: options.origin,
  results: [],
};
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
  flag: 'wx',
});

for (const [caseIndex, journeyCase] of fixture.cases.entries()) {
  const parent = report.results.find(
    (result) => result.id === journeyCase.parent,
  );
  const input = {
    message: journeyCase.message,
    history: parent?.nextHistory ?? [],
    filters: parent?.body?.filters ?? {
      dateFrom: null,
      dateTo: null,
      maxPrice: null,
      category: null,
    },
    excludeIds: [],
  };
  if (parent && isAlternativesRequest(journeyCase.message)) {
    input.excludeIds = [
      ...new Set([
        ...parent.input.excludeIds,
        ...(parent.body?.recommendations ?? []).flatMap(({ event }) =>
          [
            event.id,
            event.canonicalProductionKey,
            event.canonicalShowKey,
          ].filter(Boolean),
        ),
      ]),
    ].slice(-100);
  }

  const result = {
    id: journeyCase.id,
    input,
    syntheticLoopbackVisitor: `127.0.1.${
      Number.isInteger(journeyCase.visitor) &&
      journeyCase.visitor >= 1 &&
      journeyCase.visitor <= 254
        ? journeyCase.visitor
        : caseIndex + 1
    }`,
  };
  const start = performance.now();
  try {
    const response = await fetch(`${options.origin}/api/recommend`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': result.syntheticLoopbackVisitor,
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    result.httpStatus = response.status;
    result.body = await response.json();
  } catch (error) {
    result.error = error instanceof Error ? error.name : 'UnknownError';
  }
  result.durationMs = Math.round(performance.now() - start);
  result.nextHistory = ['needs_input', 'unsupported_location'].includes(
    result.body?.status,
  )
    ? input.history
    : [...input.history, { role: 'user', content: journeyCase.message }].slice(
        -10,
      );
  report.results.push(result);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(
    JSON.stringify({
      id: journeyCase.id,
      http: result.httpStatus,
      status: result.body?.status,
      mode: result.body?.mode,
      filters: result.body?.filters,
      events: result.body?.recommendations?.map(({ event }) => ({
        title: event.title,
        venue: event.venue,
        startsAt: event.startsAt,
        price: event.price,
      })),
      notice: result.body?.notice,
      error: result.error,
    }),
  );
  if (result.error || result.httpStatus !== 200) break;
  if (caseIndex < fixture.cases.length - 1) await sleep(requestSpacingMs);
}

report.finishedAt = new Date().toISOString();
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
