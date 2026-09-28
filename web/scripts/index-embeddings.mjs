import { open, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    'max-batches': { type: 'string' },
    'max-total-tokens': { type: 'string' },
    'expected-profile': { type: 'string' },
    'expected-pending': { type: 'string' },
    'interval-ms': { type: 'string', default: '1000' },
    report: { type: 'string' },
    origin: { type: 'string' },
    'allow-loopback-http': { type: 'boolean', default: false },
  },
});

const live = values.live;
const maxBatches = Number(values['max-batches'] ?? '100');
if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000)
  throw new Error('--max-batches must be an integer from 1 through 1000.');
const maxTotalTokens = Number(
  values['max-total-tokens'] ?? String(Number.MAX_SAFE_INTEGER),
);
if (!Number.isSafeInteger(maxTotalTokens) || maxTotalTokens < 1)
  throw new Error('--max-total-tokens must be a positive safe integer.');
const expectedPending = Number(values['expected-pending'] ?? '0');
if (!Number.isSafeInteger(expectedPending) || expectedPending < 0)
  throw new Error('--expected-pending must be a nonnegative safe integer.');
const expectedProfile = values['expected-profile']?.trim();
if (
  expectedProfile &&
  !/^voyage-embedding-v1\|endpoint=https:\/\/api\.voyageai\.com\/v1\/embeddings\|model=(?:voyage-4-large|voyage-4|voyage-4-lite)\|dimensions=(?:256|512|1024|2048)\|input_type=document\|text_profile=event-title-category-venue-description-v1$/.test(
    expectedProfile,
  )
)
  throw new Error('--expected-profile is invalid.');
const intervalMs = Number(values['interval-ms']);
if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60000)
  throw new Error('--interval-ms must be an integer from 0 through 60000.');

const rawOrigin = values.origin ?? process.env.BIPLAN_URL;
if (!rawOrigin) throw new Error('Set BIPLAN_URL or pass --origin.');
const origin = new URL(rawOrigin);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
const privateCloudRun =
  origin.protocol === 'https:' && origin.hostname.endsWith('.run.app');
if (
  origin.username ||
  origin.password ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash ||
  (origin.protocol !== 'https:' &&
    !(origin.protocol === 'http:' && loopback && values['allow-loopback-http']))
)
  throw new Error(
    'Destination must be HTTPS, or explicit HTTP loopback with --allow-loopback-http.',
  );
if (
  live &&
  privateCloudRun &&
  (!values['max-batches'] ||
    !values['max-total-tokens'] ||
    !values['expected-profile'] ||
    !values['expected-pending'] ||
    !values.report)
)
  throw new Error(
    'Live private Cloud Run indexing requires --max-batches, --max-total-tokens, --expected-profile, --expected-pending, and --report.',
  );

let token = process.env.SYNC_TOKEN?.trim();
if (!token && loopback) {
  try {
    token = parseEnv(
      await readFile(join(import.meta.dirname, '..', '.dev.vars'), 'utf8'),
    ).SYNC_TOKEN?.trim();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
if (!token) throw new Error('SYNC_TOKEN is required.');
const serverlessToken = process.env.SERVERLESS_ID_TOKEN?.trim();
if (privateCloudRun && !serverlessToken)
  throw new Error('SERVERLESS_ID_TOKEN is required for private Cloud Run.');

let reportHandle;
let observedTotalTokens = 0;
const report =
  live && values.report
    ? {
        schemaVersion: 1,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        target: origin.origin,
        expectedProfile,
        limits: { maxBatches, maxTotalTokens, expectedPending, intervalMs },
        initial: null,
        batches: [],
        final: null,
        postAttempts: 0,
        totalTokens: 0,
        outcome: 'running',
        error: null,
      }
    : null;
if (report) {
  const work = resolve(import.meta.dirname, '..', 'work');
  const reportPath = resolve(values.report);
  const child = relative(work, reportPath);
  if (!child || child.startsWith('..') || resolve(work, child) !== reportPath)
    throw new Error('--report must name a new file under web/work.');
  reportHandle = await open(reportPath, 'wx', 0o600);
  await appendReport('created');
}
async function appendReport(event) {
  if (!report || !reportHandle) return;
  await reportHandle.write(
    `${JSON.stringify({ event, at: new Date().toISOString(), state: report })}\n`,
  );
  await reportHandle.sync();
}
async function finishReport(outcome, error = null) {
  if (!report || !reportHandle) return;
  report.finishedAt = new Date().toISOString();
  report.outcome = outcome;
  report.error = error;
  await appendReport('finished');
  await reportHandle.close();
  reportHandle = undefined;
}

function validateStatus(body, method) {
  const counts = ['eligible', 'documents', 'indexed', 'pending'];
  if (
    typeof body?.configured !== 'boolean' ||
    counts.some((key) => !Number.isSafeInteger(body[key]) || body[key] < 0) ||
    body.documents > body.eligible ||
    body.indexed + body.pending !== body.documents ||
    (body.configured && typeof body.profile !== 'string')
  )
    throw new Error('Embedding endpoint returned an invalid status.');
  if (
    method === 'POST' &&
    (!Number.isSafeInteger(body.embedded) ||
      body.embedded < 0 ||
      body.embedded > 32 ||
      !Array.isArray(body.hashes) ||
      body.hashes.length !== body.embedded ||
      body.hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash)) ||
      !body.usage ||
      !Number.isSafeInteger(body.usage.totalTokens) ||
      body.usage.totalTokens < 0)
  )
    throw new Error('Embedding endpoint returned invalid batch evidence.');
  return body;
}
async function request(method) {
  const headers = { Authorization: `Bearer ${token}` };
  if (serverlessToken)
    headers['X-Serverless-Authorization'] = `Bearer ${serverlessToken}`;
  const response = await fetch(new URL('/api/admin/embeddings', origin), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers,
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `Embedding endpoint returned invalid JSON (${response.status}).`,
    );
  }
  if (!response.ok) {
    const safe =
      typeof body?.error === 'string' &&
      /^Voyage request failed \(HTTP [1-5]\d{2}\)\.; no retry was attempted$/.test(
        body.error,
      )
        ? body.error
        : null;
    throw new Error(safe ?? `Embedding endpoint failed (${response.status}).`);
  }
  return validateStatus(body, method);
}

try {
  let status = await request('GET');
  console.log(
    `Voyage index: configured=${Boolean(status.configured)} eligible=${status.eligible ?? 0} documents=${status.documents ?? 0} indexed=${status.indexed ?? 0} pending=${status.pending ?? 0}`,
  );
  if (!live) {
    console.log(
      'Dry run only. Pass --live with explicit limits to index pending documents.',
    );
    process.exit(0);
  }
  if (report) {
    report.initial = status;
    await appendReport('initial-status');
  }
  if (!status.configured) {
    console.log(
      'Voyage is not configured on the server; no provider request was made.',
    );
    await finishReport('not-configured');
    process.exit(0);
  }
  if (expectedProfile && status.profile !== expectedProfile)
    throw new Error('Embedding profile does not match --expected-profile.');
  if (values['expected-pending'] && status.pending !== expectedPending)
    throw new Error('Pending count does not match --expected-pending.');
  // A zero-pending catalog may still be pending publication. The first POST is
  // therefore required for server-side activation and consumes no Voyage call.
  for (
    let batch = 1;
    batch <= maxBatches && (status.pending > 0 || batch === 1);
    batch++
  ) {
    if (observedTotalTokens >= maxTotalTokens)
      throw new Error(
        'Observed Voyage token usage reached --max-total-tokens.',
      );
    if (report) {
      report.postAttempts++;
      await appendReport('post-attempt');
    }
    status = await request('POST');
    observedTotalTokens += status.usage.totalTokens;
    const totalTokens = observedTotalTokens;
    if (report) {
      report.totalTokens = totalTokens;
      report.batches.push({
        batch,
        embedded: status.embedded,
        indexed: status.indexed,
        pending: status.pending,
        hashes: status.hashes,
        usage: status.usage,
      });
      await appendReport('batch-receipt');
    }
    if (expectedProfile && status.profile !== expectedProfile)
      throw new Error('Embedding profile changed during indexing.');
    console.log(
      `Batch ${batch}: embedded=${status.embedded} tokens=${status.usage.totalTokens} totalTokens=${totalTokens} indexed=${status.indexed} pending=${status.pending}`,
    );
    if (totalTokens > maxTotalTokens)
      throw new Error(
        'Observed Voyage token usage exceeded --max-total-tokens.',
      );
    if (totalTokens === maxTotalTokens && status.pending > 0)
      throw new Error(
        'Observed Voyage token usage reached --max-total-tokens.',
      );
    if (!status.embedded && status.pending > 0)
      throw new Error('Indexing made no progress.');
    if (intervalMs && status.pending > 0 && batch < maxBatches)
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  if (report) report.final = status;
  if (status.pending > 0) {
    console.log(
      `Stopped at --max-batches with ${status.pending} document(s) still pending.`,
    );
    await finishReport('bounded-stop');
    process.exitCode = 2;
  } else await finishReport('complete');
} catch (error) {
  const message = error instanceof Error ? error.message : 'Indexing failed.';
  await finishReport('failed', message).catch(() => undefined);
  throw error;
}
