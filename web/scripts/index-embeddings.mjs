import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    'max-batches': { type: 'string', default: '100' },
    'interval-ms': { type: 'string', default: '0' },
    origin: { type: 'string' },
    'allow-loopback-http': { type: 'boolean', default: false },
  },
});
const maxBatches = Number(values['max-batches']);
if (!Number.isInteger(maxBatches) || maxBatches < 1 || maxBatches > 1000)
  throw new Error('--max-batches must be an integer from 1 through 1000.');
const intervalMs = Number(values['interval-ms']);
if (!Number.isSafeInteger(intervalMs) || intervalMs < 0 || intervalMs > 60000)
  throw new Error('--interval-ms must be an integer from 0 through 60000.');

const rawOrigin = values.origin ?? process.env.BIPLAN_URL;
if (!rawOrigin) throw new Error('Set BIPLAN_URL or pass --origin.');
const origin = new URL(rawOrigin);
const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
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

async function request(method) {
  const response = await fetch(new URL('/api/admin/embeddings', origin), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}` },
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
    const safeProviderError =
      typeof body?.error === 'string' &&
      /^Voyage request failed \(HTTP [1-5]\d{2}\)\.; no retry was attempted$/.test(
        body.error,
      )
        ? body.error
        : null;
    throw new Error(
      safeProviderError ?? `Embedding endpoint failed (${response.status}).`,
    );
  }
  const counts = ['eligible', 'documents', 'indexed', 'pending'];
  if (
    typeof body?.configured !== 'boolean' ||
    counts.some((key) => !Number.isSafeInteger(body[key]) || body[key] < 0) ||
    body.documents > body.eligible ||
    body.indexed + body.pending !== body.documents ||
    (method === 'POST' &&
      (!Number.isSafeInteger(body.embedded) ||
        body.embedded < 0 ||
        body.embedded > 32))
  )
    throw new Error('Embedding endpoint returned an invalid status.');
  return body;
}

let status = await request('GET');
console.log(
  `Voyage index: configured=${Boolean(status.configured)} eligible=${status.eligible ?? 0} documents=${status.documents ?? 0} indexed=${status.indexed ?? 0} pending=${status.pending ?? 0}`,
);
if (!values.live) {
  console.log('Dry run only. Pass --live to index pending documents.');
  process.exit(0);
}
if (!status.configured) {
  console.log(
    'Voyage is not configured on the server; no provider request was made.',
  );
  process.exit(0);
}

for (let batch = 1; batch <= maxBatches && status.pending > 0; batch++) {
  status = await request('POST');
  console.log(
    `Batch ${batch}: embedded=${status.embedded ?? 0} indexed=${status.indexed ?? 0} pending=${status.pending ?? 0}`,
  );
  if (!status.embedded && status.pending > 0)
    throw new Error('Indexing made no progress.');
  if (intervalMs && status.pending > 0 && batch < maxBatches)
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
if (status.pending > 0) {
  console.log(
    `Stopped at --max-batches with ${status.pending} document(s) still pending.`,
  );
  process.exitCode = 2;
}
