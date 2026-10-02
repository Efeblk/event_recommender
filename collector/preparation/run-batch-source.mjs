import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ingestBatchSource } from './batch-source.mjs';
import { assertOwned } from './db.mjs';

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error('usage: node run-batch-source.mjs BATCH_INPUT.json');
  const envelope = JSON.parse(await readFile(resolve(path), 'utf8'));
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  await assertOwned();
  const result = await ingestBatchSource(envelope, {
    limit: Number(process.env.CATALOG_BATCH_SOURCE_MAX_RECORDS ?? 8), signal: controller.signal,
  });
  process.stdout.write(`${JSON.stringify({ batchId: result.batchId, processed: result.processed, replayed: result.replayed,
    remaining: result.remaining, interrupted: result.interrupted, sealed: result.sealed, status: result.seal?.status ?? result.begin?.status })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
