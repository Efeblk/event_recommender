import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { adaptCanonicalRecord, canonicalRequestId, validateCanonicalRecord } from './canonical-adapter.mjs';
import { createCanonicalStore } from './canonical-store.mjs';
import { assertOwned, work } from './db.mjs';
import { stableJson } from './source-adapter.mjs';

const RECEIPT_VERSION = 1;
const ADAPTER_VERSION = 'normalized-source-v1';
const digest = value => createHash('sha256').update(value).digest('hex');

export function canonicalRecordsFrom(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object' || !Array.isArray(body.pages))
    throw new Error('input must be EventRecord[] or a collector report with pages');
  const records = [];
  for (const page of body.pages) {
    if (!page || typeof page !== 'object' || !Array.isArray(page.events))
      throw new Error('collector report pages must each contain an events array');
    records.push(...page.events);
  }
  return records;
}

export function canonicalInputProvenance(records) {
  return { contentHash: digest(stableJson(records)), recordCount: records.length };
}

function receiptFor(records, receipt) {
  const input = canonicalInputProvenance(records);
  if (receipt === undefined) return {
    version: RECEIPT_VERSION,
    adapterVersion: ADAPTER_VERSION,
    consumerMode: 'single',
    input,
    decisions: {},
  };
  if (!receipt || receipt.version !== RECEIPT_VERSION || receipt.adapterVersion !== ADAPTER_VERSION ||
      receipt.consumerMode !== 'single' || stableJson(receipt.input) !== stableJson(input) ||
      !receipt.decisions || typeof receipt.decisions !== 'object' || Array.isArray(receipt.decisions))
    throw new Error('canonical replay receipt is incompatible with this adapter or input');
  return structuredClone(receipt);
}

export async function replayCanonicalRecords(records, {
  store = createCanonicalStore(), receipt, limit = 8, signal, checkpoint = async () => {},
} = {}) {
  if (!Array.isArray(records)) throw new Error('canonical replay records must be an array');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error('canonical replay limit must be between 1 and 100');
  const next = receiptFor(records, receipt), decisions = [];
  let processed = 0, replayed = 0, remaining = 0;
  for (const record of records) {
    const requestId = canonicalRequestId(record);
    if (next.decisions[requestId]) {
      decisions.push({ ...next.decisions[requestId], replayed: true });
      replayed++;
      continue;
    }
    if (processed >= limit || signal?.aborted) { remaining++; continue; }
    const errors = validateCanonicalRecord(record);
    const adapted = errors.length
      ? { status: 'quarantined', requestId, reason: 'invalid_source_record', details: errors }
      : adaptCanonicalRecord(record, await store.findHeads(record));
    let decision;
    if (adapted.status === 'ready') {
      decision = { requestId, ...(await store.accept(adapted.payload)) };
      if (decision.status === 'held' || decision.status === 'quarantined')
        decision.sourceRecord = structuredClone(record);
    } else decision = { ...adapted, sourceRecord: structuredClone(record) };
    next.decisions[requestId] = decision;
    decisions.push(decision);
    processed++;
    // The database commit intentionally precedes this durable file checkpoint.
    // A lost response replays the deterministic request through SQL idempotency.
    await checkpoint(structuredClone(next), decision);
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
  const inputPath = process.argv[2];
  const receiptPath = resolve(process.argv[3] ?? resolve(work, 'canonical-source-replay.json'));
  if (!inputPath) throw new Error('usage: node run-canonical-source.mjs INPUT.json [RECEIPT.json]');
  const records = canonicalRecordsFrom(JSON.parse(await readFile(resolve(inputPath), 'utf8')));
  const inputHash = canonicalInputProvenance(records).contentHash;
  await mkdir(dirname(receiptPath), { recursive: true });
  const lockPath = `${receiptPath}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(
      `canonical replay receipt already has a consumer; inspect ${lockPath}, verify its owner is no longer running, then remove the stale lock manually`,
    );
    throw error;
  }
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), inputHash })}\n`);
    // Receipt state must be loaded inside the exclusive section. A waiting
    // consumer can never resume from a snapshot captured before its predecessor.
    let receipt;
    try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await assertOwned();
    const result = await replayCanonicalRecords(records, {
      receipt,
      limit: Number(process.env.CATALOG_CANONICAL_SOURCE_MAX_RECORDS ?? 8),
      signal: controller.signal,
      checkpoint: next => atomicJson(receiptPath, next),
    });
    if (result.processed === 0 && receipt === undefined) await atomicJson(receiptPath, result.receipt);
    process.stdout.write(`${JSON.stringify({ processed: result.processed, replayed: result.replayed, interrupted: result.interrupted, remaining: result.remaining, receiptPath })}\n`);
  } finally {
    await lock.close();
    await unlink(lockPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
