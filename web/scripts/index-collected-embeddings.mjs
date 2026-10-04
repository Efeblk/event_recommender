import { open } from 'node:fs/promises';
import { resolve, relative, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import {
  auditIndexLimits,
  auditPayloadIsSafe,
  dailyIndexWindow,
  parseAuditedIndexInput,
} from '../lib/audited-index.ts';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    report: { type: 'string' },
    'allow-loopback-http': { type: 'boolean', default: false },
  },
});
function checkedReportPath() {
  if (!values.report) throw new Error('--report is required');
  const work = resolve(import.meta.dirname, '../work'),
    reportPath = resolve(values.report),
    child = relative(work, reportPath);
  if (!child || child.startsWith('..') || resolve(work, child) !== reportPath)
    throw new Error('Report must be a new file under web/work');
  return reportPath;
}
// Default OFF. Do not load credentials or make even a status request when off.
if (process.env.GCP_STAGING_INDEXING_ENABLED !== 'true') {
  if (values.live && values.report) {
    const report = await open(checkedReportPath(), 'wx', 0o600);
    try {
      await report.write(
        JSON.stringify({
          type: 'finished',
          at: new Date().toISOString(),
          outcome: 'disabled',
          requests: 0,
          attempts: 0,
        }) + '\n',
      );
      await report.sync();
    } finally {
      await report.close();
    }
  }
  console.log('Collection embedding indexing is disabled; no requests made.');
  process.exit(0);
}
const profile =
  'voyage-embedding-v1|endpoint=https://api.voyageai.com/v1/embeddings|model=voyage-4-large|dimensions=1024|input_type=document|text_profile=event-title-category-venue-description-v1';
const input = parseAuditedIndexInput({
  runId: process.env.GITHUB_RUN_ID,
  expectedProfile: profile,
  expectedRevision: '0'.repeat(40),
  checkpointSha256: '0'.repeat(64),
  window:
    process.env.GCP_STAGING_INDEXING_UNTIL === 'open'
      ? dailyIndexWindow(Number(process.env.GCP_STAGING_INDEXING_MAX_CALLS))
      : {
          startedAt: process.env.GCP_STAGING_INDEXING_FROM,
          until: process.env.GCP_STAGING_INDEXING_UNTIL,
          maxCalls: Number(process.env.GCP_STAGING_INDEXING_MAX_CALLS),
        },
});
const origin = new URL(process.env.BIPLAN_URL ?? '');
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
if (
  origin.username ||
  origin.password ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash ||
  !(
    (origin.protocol === 'https:' && origin.hostname.endsWith('.run.app')) ||
    (values['allow-loopback-http'] && loopback && origin.protocol === 'http:')
  )
)
  throw new Error('An exact private Cloud Run origin is required');
if (!values.live) {
  console.log(
    JSON.stringify({
      mode: 'offline-plan',
      input: { ...input, checkpointSha256: 'read-and-pinned-only-on-live' },
      limits: auditIndexLimits,
      requests: 0,
    }),
  );
  process.exit(0);
}
const reportPath = checkedReportPath();
const sync = process.env.SYNC_TOKEN?.trim(),
  identity = process.env.SERVERLESS_ID_TOKEN?.trim();
if (!sync || !identity)
  throw new Error('Private collector HTTP credentials are required');
const secrets = [sync, identity],
  journal = await open(reportPath, 'wx', 0o600);
const note = async (value) => {
  await journal.write(
    JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n',
  );
  await journal.sync();
};
let requests = 0,
  attempts = 0,
  totalTokens = 0,
  lastStart = 0;
async function request(method) {
  if (++requests > 5) throw new Error('HTTP request cap reached');
  await note({
    type: 'http-attempt',
    method,
    requests,
    postAttempts: attempts,
  });
  const response = await fetch(
    new URL('/api/admin/embeddings?audited=1', origin),
    {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${sync}`,
        'X-Serverless-Authorization': `Bearer ${identity}`,
        ...(method === 'POST'
          ? {
              'x-biplan-audited-index': '1',
              'Content-Type': 'application/json',
            }
          : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(input) } : {}),
    },
  );
  const reader = response.body?.getReader(),
    chunks = [];
  let size = 0;
  if (reader)
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new Error('HTTP evidence cap exceeded');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  const raw = Buffer.concat(chunks, size).toString('utf8');
  if (!auditPayloadIsSafe(Buffer.from(raw, 'utf8'), secrets)) {
    await note({
      type: 'http-response-suppressed',
      requests,
      status: response.status,
      credentialSuppressed: true,
      bytes: size,
      complete: false,
    });
    throw new Error('Credential reflection suppressed');
  }
  const file = resolve(
      dirname(reportPath),
      `${basename(reportPath)}-http-${requests}.json`,
    ),
    evidence = await open(file, 'wx', 0o600);
  try {
    await evidence.write(raw);
    await evidence.sync();
  } finally {
    await evidence.close();
  }
  await note({
    type: 'http-response',
    requests,
    status: response.status,
    file: basename(file),
    bytes: size,
  });
  if (!response.ok)
    throw new Error(`Audited indexing HTTP ${response.status}; no retry`);
  const body = JSON.parse(raw);
  if (
    !body.configured ||
    body.profile !== profile ||
    !/^[a-f0-9]{64}$/.test(body.checkpointSha256 ?? '') ||
    !/^[a-f0-9]{40}$/.test(body.deploymentRevision ?? '') ||
    !['eligible', 'documents', 'indexed', 'pending'].every(
      (k) => Number.isSafeInteger(body[k]) && body[k] >= 0,
    ) ||
    body.indexed + body.pending !== body.documents
  )
    throw new Error('Invalid audited status');
  return body;
}
try {
  await note({
    type: 'started',
    limits: auditIndexLimits,
    window: input.window,
    runId: input.runId,
    automaticRetries: 0,
    tokenLimitIsObserved: true,
  });
  let status = await request('GET');
  input.checkpointSha256 = status.checkpointSha256;
  input.expectedRevision = status.deploymentRevision;
  await note({ type: 'initial', status });
  // A newly published catalog can already have complete vector coverage while
  // still waiting in pendingSearch. One POST lets the server perform the
  // lease-fenced activation without making a provider request.
  while (
    (status.pending || attempts === 0) &&
    attempts < auditIndexLimits.callsPerRun
  ) {
    // More conservative than the server's21s minimum: one minute separates
    // batches, retaining the existing rolling token headroom without retries.
    if (lastStart)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, lastStart + 61000 - Date.now())),
      );
    parseAuditedIndexInput(input);
    if (totalTokens >= auditIndexLimits.observedTokensPerRun)
      throw new Error('Observed token threshold reached');
    attempts++;
    lastStart = Date.now();
    await note({ type: 'post-attempt', attempts, input });
    const next = await request('POST');
    if (
      next.checkpointSha256 !== input.checkpointSha256 ||
      next.deploymentRevision !== input.expectedRevision ||
      !Number.isSafeInteger(next.embedded) ||
      next.embedded < 0 ||
      next.embedded > 32 ||
      !Array.isArray(next.hashes) ||
      next.hashes.length !== next.embedded ||
      next.hashes.some((h) => !/^[a-f0-9]{64}$/.test(h)) ||
      !Number.isSafeInteger(next.usage?.totalTokens) ||
      next.usage.totalTokens < 0
    )
      throw new Error('Invalid audited batch receipt');
    totalTokens += next.usage.totalTokens;
    status = next;
    await note({ type: 'batch', attempts, totalTokens, status });
    if (status.outcome === 'bounded-stop') break;
    if (
      (!status.embedded && status.pending) ||
      totalTokens > auditIndexLimits.observedTokensPerRun
    )
      throw new Error('Audited indexing stopped without further attempts');
  }
  await note({
    type: 'finished',
    outcome: status.pending ? 'bounded-stop' : 'complete',
    requests,
    attempts,
    totalTokens,
    pending: status.pending,
  });
  if (status.pending) process.exitCode = 2;
  console.log(
    JSON.stringify({
      outcome: status.pending ? 'bounded-stop' : 'complete',
      attempts,
      totalTokens,
      pending: status.pending,
    }),
  );
} catch (error) {
  await note({
    type: 'finished',
    outcome: 'failed',
    requests,
    attempts,
    totalTokens,
    error:
      error instanceof Error &&
      /^Audited indexing HTTP \d{3}; no retry$/.test(error.message)
        ? error.message
        : 'Indexing stopped; inspect preserved HTTP and private audit evidence. No automatic retry.',
  });
  process.exitCode = 1;
  console.error(
    'Collection embedding indexing stopped. No automatic retry; original evidence retained.',
  );
} finally {
  await journal.close();
}
