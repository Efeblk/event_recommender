import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { adaptSourceRecord, sourceRequestId, validateSourceRecord } from './source-adapter.mjs';
import { createSourceStore } from './source-store.mjs';
import { work } from './db.mjs';

export async function replaySourceRecords(records, { store, receipt = { version: 1, decisions: {} }, limit = 8, signal } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('source replay limit must be between 1 and 100');
  const next = structuredClone(receipt), decisions = [], sourceStore = store ?? createSourceStore();
  let processed = 0, replayed = 0, remaining = 0;
  next.version = 1; next.decisions ??= {};
  for (const record of records) {
    const requestId = sourceRequestId(record);
    if (next.decisions[requestId]) { decisions.push({ ...next.decisions[requestId], replayed: true }); replayed++; continue; }
    if (processed >= limit || signal?.aborted) { remaining++; continue; }
    const validation = validateSourceRecord(record);
    const adapted = validation.length
      ? { status: 'quarantined', requestId, reason: 'invalid_source_record', details: validation }
      : adaptSourceRecord(record, await sourceStore.findExistingOffers(record));
    let decision = adapted.status === 'quarantined' ? { ...adapted, sourceRecord: structuredClone(record) } : adapted;
    if (adapted.status === 'ready') decision = { requestId: adapted.requestId, ...(await sourceStore.accept(adapted.payload, adapted.expectedCurrentRevisionId)) };
    next.decisions[adapted.requestId] = decision;
    decisions.push(decision);
    processed++;
  }
  return { receipt: next, decisions, processed, replayed, interrupted: Boolean(signal?.aborted), remaining };
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function main() {
  const input = process.argv[2], receiptPath = resolve(process.argv[3] ?? resolve(work, 'source-replay.json'));
  if (!input) throw new Error('usage: node run-source.mjs INPUT.json [RECEIPT.json]');
  const body = JSON.parse(await readFile(resolve(input), 'utf8'));
  const records = Array.isArray(body) ? body : body.pages?.flatMap(page => page.events ?? []);
  if (!Array.isArray(records)) throw new Error('input must be EventRecord[] or a collector report with pages');
  let receipt;
  try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const controller = new AbortController(); process.once('SIGINT', () => controller.abort()); process.once('SIGTERM', () => controller.abort());
  const result = await replaySourceRecords(records, { receipt, limit: Number(process.env.CATALOG_SOURCE_MAX_RECORDS ?? 8), signal: controller.signal });
  await atomicJson(receiptPath, result.receipt);
  process.stdout.write(`${JSON.stringify({ processed: result.processed, replayed: result.replayed, interrupted: result.interrupted, remaining: result.remaining, receiptPath })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
