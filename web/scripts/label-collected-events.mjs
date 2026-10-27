// Collection-time event labeling (Phase 1R, R4). Repeats bounded label
// batches on the private staging service until no document is pending, the
// durable token cap stops it, or the run time ends. No paid call is retried:
// the server halts its ledger after a provider failure.
import { appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    report: { type: 'string' },
    'max-minutes': { type: 'string', default: '40' },
    resume: { type: 'boolean', default: false },
  },
});
const tokenCap = Number(process.env.GCP_STAGING_LABELING_TOKEN_CAP ?? '');
if (!Number.isSafeInteger(tokenCap) || tokenCap < 1) {
  console.log('Event labeling is disabled; no requests made.');
  process.exit(0);
}
const origin = new URL(process.env.BIPLAN_URL ?? '');
if (origin.protocol !== 'https:' || !origin.hostname.endsWith('.run.app') || origin.pathname !== '/')
  throw new Error('An exact private Cloud Run origin is required');
const sync = process.env.SYNC_TOKEN?.trim(),
  identity = process.env.SERVERLESS_ID_TOKEN?.trim();
if (!sync || !identity) throw new Error('SYNC_TOKEN and SERVERLESS_ID_TOKEN are required');
const until = Date.now() + Number(values['max-minutes']) * 60_000;
const record = async (entry) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log(line);
  if (values.report) await appendFile(values.report, line + '\n');
};

let resume = values.resume;
for (;;) {
  if (Date.now() > until) {
    await record({ type: 'finished', outcome: 'time' });
    process.exit(2);
  }
  const response = await fetch(new URL('/api/admin/labels', origin), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${sync}`,
      'X-Serverless-Authorization': `Bearer ${identity}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ tokenCap, maxCalls: 48, ...(resume ? { resume: true } : {}) }),
    redirect: 'manual',
  });
  resume = false;
  const body = await response.json().catch(() => ({}));
  const { documents, labeled, pending, calls, saved, invalid, failed, usage, outcome, reason } = body;
  await record({ type: 'batch', status: response.status, documents, labeled, pending, calls, saved, invalid, failed, usage, outcome, reason, error: body.error });
  if (!response.ok) process.exit(1);
  if (outcome === 'complete') process.exit(0);
  if (outcome === 'bounded-stop' && reason !== 'time' && reason !== 'lease') process.exit(2);
}
