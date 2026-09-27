import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { bootstrapSummary, planGcpBootstrap } from '../lib/gcp-bootstrap.ts';

const { values } = parseArgs({ options: {
  checkpoint: { type: 'string' }, vectors: { type: 'string' }, apply: { type: 'boolean', default: false },
  'target-new': { type: 'boolean', default: false }, 'allow-omissions': { type: 'boolean', default: false },
  'batch-pages': { type: 'string', default: '32' },
} });
if (!values.checkpoint) throw new Error('--checkpoint is required.');
const batchPages = Number(values['batch-pages']);
if (!Number.isSafeInteger(batchPages) || batchPages < 1 || batchPages > 64) throw new Error('--batch-pages must be an integer from 1 to 64.');
const rawCheckpoint = await readFile(resolve(values.checkpoint), 'utf8');
const rawVectors = values.vectors ? await readFile(resolve(values.vectors), 'utf8') : undefined;
const plan = await planGcpBootstrap(rawCheckpoint, rawVectors);
const summary = bootstrapSummary(plan);
if (!values.apply) { console.log(JSON.stringify({ mode: 'dry-run', ...summary }, null, 2)); process.exit(0); }
if (!values['target-new']) throw new Error('--apply requires --target-new.');
if (plan.unsupportedUrlCount && !values['allow-omissions']) throw new Error('Unsupported event URLs require explicit --allow-omissions.');

const [{ createGcpClients }, { createGcpStore }] = await Promise.all([
  import('../lib/gcp-clients.node.ts'), import('../lib/store.gcp.ts'),
]);
const clients = await createGcpClients(process.env);
const namespace = process.env.DEPLOYMENT_ENV;
if (!namespace || !/^[A-Za-z0-9_-]{1,64}$/.test(namespace)) throw new Error('DEPLOYMENT_ENV is required.');
const store = createGcpStore({ ...clients, namespace });
const syncLease = await store.acquireLease('sync_lock', 3600000);
if (!syncLease) throw new Error('Catalog bootstrap lease is unavailable.');
let vectorLease = null;
let imported = 0, skipped = 0;
try {
  if (plan.vectors) {
    vectorLease = await store.acquireLease('voyage_index_lock', 3600000);
    if (!vectorLease) throw new Error('Vector bootstrap lease is unavailable.');
  }
  const [published, stagedSources, vectorProfiles] = await Promise.all([
    store.currentPublished(), clients.control.list(`biplan/${namespace}/sources`), clients.control.list(`biplan/${namespace}/vectorProfiles`),
  ]);
  if (published.checkpoint || published.catalog.stored || stagedSources.length || vectorProfiles.length) throw new Error('Target is not empty; bootstrap refuses to overwrite it.');
  await clients.blobs.putImmutable(`migration-audit/${namespace}/${plan.checkpointSha256}.json`, plan.rawCheckpoint);
  if (plan.vectors) await clients.blobs.putImmutable(`migration-audit/${namespace}/vectors-${plan.vectors.sha256}.json`, plan.vectors.raw);
  for (let offset = 0; offset < plan.pages.length; offset += batchPages) {
    const result = await store.importPages(plan.pages.slice(offset, offset + batchPages), syncLease);
    imported += result.imported; skipped += result.skipped;
  }
  await store.publishCheckpoint(plan.checkpoint.report, syncLease);
  if (plan.vectors && vectorLease) await store.saveVoyageVectors(plan.vectors.profile, plan.vectors.entries, vectorLease);
} finally {
  if (vectorLease) await store.releaseLease(vectorLease).catch(() => undefined);
  await store.releaseLease(syncLease).catch(() => undefined);
}
console.log(JSON.stringify({ mode: 'applied', ...summary, imported, skipped }, null, 2));
