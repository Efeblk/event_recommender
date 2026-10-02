import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectorPageReceiptFromReport } from './collector-page-receipt.mjs';
import { assertOwned } from './db.mjs';
import { ingestPageBatchSource } from './page-batch-source.mjs';

async function main() {
  const path = process.argv[2], batchId = process.argv[3], collectionRunId = process.argv[4];
  if (!path || !batchId || !collectionRunId) throw new Error('usage: node run-page-batch-source.mjs REPORT.json BATCH_ID COLLECTION_RUN_ID');
  const report = JSON.parse(await readFile(resolve(path), 'utf8'));
  const envelope = collectorPageReceiptFromReport(report, { batchId, collectionRunId });
  const controller = new AbortController(); process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  await assertOwned();
  const result = await ingestPageBatchSource(envelope, { limit: Number(process.env.CATALOG_PAGE_BATCH_MAX_ITEMS ?? 8), signal: controller.signal });
  process.stdout.write(`${JSON.stringify({ batchId, processed: result.processed, replayed: result.replayed, remaining: result.remaining,
    interrupted: result.interrupted, sealed: result.sealed, status: result.seal?.status ?? result.begin?.status })}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
