import { createHash } from 'node:crypto';
import { adaptCanonicalRecord, canonicalRequestId, validateCanonicalRecord } from './canonical-adapter.mjs';
import { createCanonicalStore } from './canonical-store.mjs';
import { createBatchSourceStore } from './batch-source-store.mjs';
import { stableJson } from './source-adapter.mjs';

const providers = new Set(['biletix', 'bubilet', 'biletinial']);
const integer = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid ${name}`);
  return value;
};
const instant = (value, name) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value)
    throw new Error(`invalid ${name}`);
  return value;
};

/** Hash the complete immutable collection input without its self-referential hash field. */
export function batchInputHash(envelope) {
  const header = { ...envelope?.header };
  delete header.inputHash;
  return createHash('sha256').update(stableJson({ header, records: envelope?.records, collectorCoverage: envelope?.collectorCoverage })).digest('hex');
}

/** Validate the whole envelope before begin() can create any durable database state. */
export function validateBatchEnvelope(envelope, { now = () => new Date() } = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('invalid batch input envelope');
  const { header, records, collectorCoverage: coverage } = envelope;
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw new Error('invalid batch header');
  for (const field of ['batchId', 'collectionRunId'])
    if (typeof header[field] !== 'string' || !header[field].trim() || header[field].length > 250) throw new Error(`invalid batch ${field}`);
  if (!['full', 'incremental'].includes(header.scope)) throw new Error('invalid batch scope');
  if (!Array.isArray(header.providers) || !header.providers.length || header.providers.some(value => !providers.has(value)) ||
      new Set(header.providers).size !== header.providers.length || stableJson(header.providers) !== stableJson([...header.providers].sort()))
    throw new Error('invalid batch providers');
  instant(header.horizonStart, 'batch horizonStart'); instant(header.horizonEnd, 'batch horizonEnd');
  if (Date.parse(header.horizonEnd) <= Date.parse(header.horizonStart)) throw new Error('invalid batch horizon');
  if (!Array.isArray(records) || records.length > 20000) throw new Error('batch records must be an array of at most 20000 records');
  const counts = new Map(header.providers.map(provider => [provider, 0])), requestIds = new Set();
  for (const record of records) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || !counts.has(record.source)) throw new Error('batch record is outside provider scope');
    const requestId = canonicalRequestId(record);
    if (requestIds.has(requestId)) throw new Error('duplicate canonical request in batch input');
    requestIds.add(requestId); counts.set(record.source, counts.get(record.source) + 1);
  }
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage) || typeof coverage.complete !== 'boolean' ||
      !Array.isArray(coverage.inventory)) throw new Error('invalid collector coverage');
  instant(coverage.finishedAt, 'collector coverage finishedAt');
  const current = now();
  if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new Error('invalid validation clock');
  if (Date.parse(coverage.finishedAt) > current.getTime() + 5 * 60 * 1000) throw new Error('future collector coverage finishedAt');
  const failedPages = integer(coverage.failedPages, 'collector failedPages');
  const unvisited = integer(coverage.unvisited, 'collector unvisited');
  const seen = new Set(); let failedTotal = 0, unvisitedTotal = 0, verifiedTotal = 0;
  for (const entry of coverage.inventory) {
    if (!entry || typeof entry !== 'object' || !counts.has(entry.provider) || seen.has(entry.provider)) throw new Error('invalid provider coverage');
    seen.add(entry.provider);
    for (const field of ['discovered', 'verified', 'retired', 'quarantined', 'unvisited', 'failedPages']) integer(entry[field], `provider ${field}`);
    if (entry.discovered !== entry.verified + entry.retired + entry.quarantined + entry.unvisited || entry.verified !== counts.get(entry.provider))
      throw new Error('collector coverage does not match input records');
    failedTotal += entry.failedPages; unvisitedTotal += entry.unvisited; verifiedTotal += entry.verified;
  }
  if (seen.size !== header.providers.length || failedTotal !== failedPages || unvisitedTotal !== unvisited || verifiedTotal !== records.length)
    throw new Error('collector coverage totals do not match input records');
  if (coverage.complete && (header.scope !== 'full' || failedPages || unvisited || coverage.inventory.some(entry => entry.quarantined)))
    throw new Error('complete collector coverage has unresolved inventory');
  const inputHash = batchInputHash(envelope);
  if (header.inputHash !== inputHash) throw new Error('batch input hash mismatch');
  return { header: structuredClone(header), records: structuredClone(records), collectorCoverage: structuredClone(coverage), inputHash };
}

export async function ingestBatchSource(envelope, {
  batchStore = createBatchSourceStore(), canonicalStore = createCanonicalStore(), limit = 8, signal, now,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('batch source limit must be between 1 and 100');
  const input = validateBatchEnvelope(envelope, { ...(now ? { now } : {}) });
  const begin = await batchStore.begin(input.header);
  const rows = await batchStore.checkpoints(input.header.batchId);
  if (!Array.isArray(rows) || rows.length > 20000) throw new Error('invalid batch checkpoint snapshot');
  const inputIds = new Set(input.records.map(canonicalRequestId)), checkpoints = new Map();
  for (const row of rows) {
    const receipt = row?.receipt;
    if (!row || typeof row.requestId !== 'string' || !inputIds.has(row.requestId) || checkpoints.has(row.requestId) ||
        !['accepted', 'held', 'quarantined'].includes(row.status) || !receipt || typeof receipt !== 'object' ||
        receipt.requestId !== row.requestId || receipt.batchId !== input.header.batchId || receipt.status !== row.status ||
        typeof receipt.idempotent !== 'boolean')
      throw new Error('invalid batch checkpoint snapshot');
    checkpoints.set(row.requestId, structuredClone(receipt));
  }
  const decisions = []; let processed = 0, replayed = 0, reached = 0;
  for (const record of input.records) {
    const requestId = canonicalRequestId(record), prior = checkpoints.get(requestId);
    if (prior) { decisions.push({ ...prior, idempotent: true }); replayed++; reached++; continue; }
    if (signal?.aborted || processed >= limit) break;
    if (begin?.status !== 'collecting') throw new Error('non-collecting batch has incomplete checkpoints');
    const errors = validateCanonicalRecord(record);
    let receipt;
    if (errors.length) receipt = await batchStore.quarantine(input.header.batchId, requestId, record, 'invalid_source_record');
    else {
      const adapted = adaptCanonicalRecord(record, await canonicalStore.findHeads(record));
      receipt = adapted.status === 'ready'
        ? await batchStore.accept(input.header.batchId, adapted.payload)
        : await batchStore.quarantine(input.header.batchId, requestId, record, adapted.reason);
    }
    decisions.push(receipt); reached++;
    processed++;
  }
  const allReached = reached === input.records.length;
  const seal = allReached && !signal?.aborted
    ? await batchStore.seal(input.header.batchId, { inputHash: input.inputHash, recordCount: input.records.length, collectorCoverage: input.collectorCoverage })
    : null;
  return { batchId: input.header.batchId, begin, decisions, processed, replayed, remaining: input.records.length - reached,
    interrupted: Boolean(signal?.aborted), sealed: Boolean(seal), seal };
}
