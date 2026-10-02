import { createHash } from 'node:crypto';
import { adaptCanonicalRecord, canonicalRequestId, validateCanonicalRecord } from './canonical-adapter.mjs';
import { createCanonicalStore } from './canonical-store.mjs';
import { discoveryInventoryHash, pageBatchInputHash } from './collector-page-receipt.mjs';
import { createPageBatchSourceStore } from './page-batch-source-store.mjs';
import { stableJson } from './source-adapter.mjs';

const sha = value => createHash('sha256').update(stableJson(value)).digest('hex');
const exactIso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
export const pagePayloadHash = page => sha(page);

export function validatePageBatchEnvelope(envelope, { now = () => new Date() } = {}) {
  if (!envelope || !envelope.header || !Array.isArray(envelope.pages) || !Array.isArray(envelope.records) || !envelope.collectorCoverage)
    throw new Error('invalid page batch envelope');
  const { header, pages, records, collectorCoverage: coverage } = envelope;
  if (header.schemaVersion !== 2 || !header.batchId || !header.collectionRunId || !['full', 'incremental', 'legacy_incremental'].includes(header.scope) ||
      !Array.isArray(header.providers) || !header.providers.length || stableJson(header.providers) !== stableJson([...new Set(header.providers)].sort()) ||
      !exactIso(header.startedAt) || header.scopeEvidence?.geography !== 'Istanbul' || !/^[0-9a-f]{64}$/.test(header.scopeEvidence?.listingConfigHash ?? ''))
    throw new Error('invalid page batch header');
  if (header.scope === 'legacy_incremental') {
    if (header.horizonStart !== null || header.horizonEnd !== null) throw new Error('legacy horizon must remain unknown');
  } else if (!exactIso(header.horizonStart) || !exactIso(header.horizonEnd) || Date.parse(header.horizonEnd) <= Date.parse(header.horizonStart))
    throw new Error('invalid page batch horizon');
  const current = now(); if (!(current instanceof Date) || !Number.isFinite(current.getTime())) throw new Error('invalid validation clock');
  if (pages.length > 20000 || records.length > 20000) throw new Error('page batch input exceeds 20000 items');
  const byRequest = new Map();
  for (const record of records) {
    if (!record || !header.providers.includes(record.source)) throw new Error('record outside page batch provider scope');
    const id = canonicalRequestId(record); if (byRequest.has(id)) throw new Error('duplicate page batch record'); byRequest.set(id, record);
  }
  const pageIds = new Set(), referenced = new Set();
  for (const page of pages) {
    if (!page || !page.pageId || pageIds.has(page.pageId) || !header.providers.includes(page.provider) || !Array.isArray(page.records) ||
        !exactIso(page.observedAt) || (page.sourceUpdatedAt !== null && !exactIso(page.sourceUpdatedAt)) || !/^[0-9a-f]{64}$/.test(page.evidenceHash ?? '') ||
        (page.rawResponseHash !== undefined && !/^[0-9a-f]{64}$/.test(page.rawResponseHash)) ||
        !['raw_response', 'normalized_page'].includes(page.evidenceKind) || !['verified', 'retired', 'quarantined', 'failed'].includes(page.status) ||
        !['current_run', 'recovered'].includes(page.origin) || (page.origin === 'current_run' ? page.originRunId !== header.collectionRunId : page.originRunId !== null) ||
        typeof page.complete !== 'boolean') throw new Error('invalid source page observation');
    try { if (new URL(page.url).protocol !== 'https:') throw new Error(); } catch { throw new Error('invalid source page URL'); }
    if (page.status !== 'verified' && page.records.length) throw new Error('non-verified page references records');
    if (Date.parse(page.observedAt) > current.getTime() + 300000) throw new Error('future source page observation');
    if (page.origin === 'current_run' && Date.parse(page.observedAt) < Date.parse(header.startedAt)) throw new Error('current page predates cycle');
    for (const ref of page.records) {
      const record = byRequest.get(ref?.requestId);
      if (!record || String(record.id) !== ref.sourceRecordId || record.source !== page.provider || record.url !== page.url || referenced.has(ref.requestId))
        throw new Error('invalid page record reference');
      if (!exactIso(record.checkedAt) || Math.abs(Date.parse(record.checkedAt) - Date.parse(page.observedAt)) > 60000)
        throw new Error('page record observation time mismatch');
      referenced.add(ref.requestId);
    }
    pageIds.add(page.pageId);
  }
  if (referenced.size !== records.length) throw new Error('every submitted record requires exactly one page reference');
  if (coverage.schemaVersion !== 2 || typeof coverage.complete !== 'boolean' || !exactIso(coverage.finishedAt) ||
      coverage.discovery?.unit !== 'detail_url' || coverage.discovery.listingConfigHash !== header.scopeEvidence.listingConfigHash ||
      !Array.isArray(coverage.inventory) ||
      coverage.records?.unit !== 'event_record' || coverage.records.submitted !== records.length)
    throw new Error('invalid page batch coverage');
  if (coverage.discovery.urls === undefined) {
    if (coverage.complete || coverage.discovery.inventoryHash !== null) throw new Error('missing page URL inventory');
  } else {
    if (!Array.isArray(coverage.discovery.urls) || !/^[0-9a-f]{64}$/.test(coverage.discovery.inventoryHash ?? '') ||
        coverage.discovery.urls.some(item => !header.providers.includes(item?.provider) || typeof item.url !== 'string') ||
        new Set(coverage.discovery.urls.map(item => `${item.provider}\t${item.url}`)).size !== coverage.discovery.urls.length ||
        coverage.discovery.inventoryHash !== discoveryInventoryHash(coverage.discovery.urls)) throw new Error('page inventory hash mismatch');
  }
  if (!Array.isArray(coverage.inventory) || coverage.inventory.length !== header.providers.length) throw new Error('invalid provider inventory');
  if (new Set(coverage.inventory.map(entry => entry?.provider)).size !== header.providers.length ||
      header.providers.some(provider => !coverage.inventory.some(entry => entry?.provider === provider))) throw new Error('duplicate or missing provider inventory');
  for (const entry of coverage.inventory) {
    for (const field of ['known', 'attemptedThisRun', 'verifiedThisRun', 'retiredThisRun', 'failedThisRun', 'quarantinedThisRun',
      'unattemptedThisRun', 'neverVisited', 'stale', 'outstandingFailures'])
      if (!header.providers.includes(entry.provider) || !Number.isSafeInteger(entry[field]) || entry[field] < 0) throw new Error('invalid provider inventory');
    if (entry.known !== entry.attemptedThisRun + entry.unattemptedThisRun || entry.attemptedThisRun !==
        entry.verifiedThisRun + entry.retiredThisRun + entry.failedThisRun + entry.quarantinedThisRun ||
        [entry.neverVisited, entry.stale, entry.outstandingFailures].some(value => value > entry.known)) throw new Error('invalid provider inventory partition');
  }
  if (coverage.discovery.urls) {
    if (coverage.discovery.urls.length !== coverage.inventory.reduce((sum, entry) => sum + entry.known, 0) ||
        coverage.inventory.some(entry => coverage.discovery.urls.filter(item => item.provider === entry.provider).length !== entry.known) ||
        pages.some(page => !coverage.discovery.urls.some(item => item.provider === page.provider && item.url === page.url)))
      throw new Error('URL inventory count mismatch');
  }
  for (const field of ['submitted', 'currentRun', 'recovered', 'carried', 'sourceQuarantined'])
    if (!Number.isSafeInteger(coverage.records[field]) || coverage.records[field] < 0) throw new Error('invalid record coverage count');
  const currentRecords = pages.filter(page => page.origin === 'current_run').reduce((sum, page) => sum + page.records.length, 0);
  const recoveredRecords = pages.filter(page => page.origin === 'recovered').reduce((sum, page) => sum + page.records.length, 0);
  if (coverage.records.currentRun !== currentRecords || coverage.records.recovered !== recoveredRecords ||
      coverage.records.currentRun + coverage.records.recovered !== records.length) throw new Error('record coverage mismatch');
  if (coverage.complete && header.scope !== 'full') throw new Error('only full scope can be complete');
  if (coverage.complete && coverage.discovery.exhausted !== true) throw new Error('coverage exhaustion mismatch');
  if (!Number.isSafeInteger(coverage.freshness?.maxSourceAgeMs) || coverage.freshness.maxSourceAgeMs < 1 || coverage.freshness.maxSourceAgeMs > 86400000)
    throw new Error('invalid page freshness');
  if (coverage.complete) {
    if (recoveredRecords || pages.some(page => page.origin !== 'current_run')) throw new Error('complete coverage cannot use recovered pages');
    const oldest = new Date(Math.min(...pages.map(page => Date.parse(page.observedAt)), ...records.map(record => Date.parse(record.checkedAt)))).toISOString();
    if (coverage.freshness.oldestResolvedAt !== oldest || coverage.freshness.validUntil !==
        new Date(Date.parse(oldest) + coverage.freshness.maxSourceAgeMs).toISOString()) throw new Error('complete page freshness mismatch');
    if (Date.parse(coverage.freshness.validUntil) <= current.getTime()) throw new Error('complete page freshness expired');
  } else if ((coverage.freshness.oldestResolvedAt === null) !== (coverage.freshness.validUntil === null)) throw new Error('incomplete page freshness mismatch');
  if (Date.parse(coverage.finishedAt) > current.getTime() + 300000) throw new Error('future page coverage receipt');
  if (Date.parse(coverage.finishedAt) < Date.parse(header.startedAt)) throw new Error('page coverage predates cycle');
  if (header.inputHash !== pageBatchInputHash(envelope)) throw new Error('page batch input hash mismatch');
  return structuredClone(envelope);
}

export async function ingestPageBatchSource(envelope, { store = createPageBatchSourceStore(), canonicalStore = createCanonicalStore(), limit = 8, signal, now } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('page batch source limit must be between 1 and 100');
  const input = validatePageBatchEnvelope(envelope, { ...(now ? { now } : {}) });
  const begin = await store.beginV2(input.header), snapshot = await store.checkpoints(input.header.batchId);
  if (!snapshot || !Array.isArray(snapshot.pages) || !Array.isArray(snapshot.records) || snapshot.pages.length > 20000 || snapshot.records.length > 20000)
    throw new Error('invalid page batch checkpoint snapshot');
  const inputPages = new Map(input.pages.map(page => [page.pageId, page])), pageCheckpoints = new Map();
  for (const row of snapshot.pages) {
    if (!inputPages.has(row?.pageId) || pageCheckpoints.has(row.pageId) || !['accepted', 'held', 'stale'].includes(row.status) ||
        stableJson(row.payload) !== stableJson(inputPages.get(row.pageId)) || !row.receipt || row.receipt.pageId !== row.pageId ||
        row.receipt.status !== row.status || typeof row.receipt.idempotent !== 'boolean')
      throw new Error('invalid page batch checkpoint snapshot');
    pageCheckpoints.set(row.pageId, row.receipt);
  }
  const inputRecords = new Set(input.records.map(canonicalRequestId)), recordCheckpoints = new Map();
  for (const row of snapshot.records) {
    if (!inputRecords.has(row?.requestId) || recordCheckpoints.has(row.requestId) || !['accepted', 'held', 'quarantined'].includes(row.status) ||
        !row.receipt || (row.receipt.requestId !== undefined && row.receipt.requestId !== row.requestId) ||
        row.receipt.batchId !== input.header.batchId || row.receipt.status !== row.status ||
        typeof row.receipt.idempotent !== 'boolean') throw new Error('invalid page batch checkpoint snapshot');
    recordCheckpoints.set(row.requestId, { requestId: row.requestId, ...row.receipt });
  }
  let processed = 0, replayed = 0; const decisions = [];
  for (const page of input.pages) {
    const prior = pageCheckpoints.get(page.pageId);
    if (prior) { replayed++; decisions.push({ kind: 'page', ...prior, idempotent: true }); continue; }
    if (signal?.aborted || processed >= limit) break;
    if (begin?.status !== 'collecting') throw new Error('non-collecting page batch has incomplete checkpoints');
    const receipt = await store.recordPage(input.header.batchId, page); processed++; decisions.push({ kind: 'page', ...receipt });
    pageCheckpoints.set(page.pageId, receipt);
  }
  // Records are admitted only after every page definition is durable.
  if (pageCheckpoints.size === input.pages.length) for (const record of input.records) {
    const requestId = canonicalRequestId(record), prior = recordCheckpoints.get(requestId);
    if (prior) { replayed++; decisions.push({ kind: 'record', ...prior, idempotent: true }); continue; }
    if (signal?.aborted || processed >= limit) break;
    if (begin?.status !== 'collecting') throw new Error('non-collecting page batch has incomplete checkpoints');
    const errors = validateCanonicalRecord(record); let receipt;
    if (errors.length) receipt = await store.quarantine(input.header.batchId, requestId, record, 'invalid_source_record');
    else {
      const adapted = adaptCanonicalRecord(record, await canonicalStore.findHeads(record));
      receipt = adapted.status === 'ready' ? await store.accept(input.header.batchId, adapted.payload)
        : await store.quarantine(input.header.batchId, requestId, record, adapted.reason);
    }
    processed++; decisions.push({ kind: 'record', ...receipt }); recordCheckpoints.set(requestId, receipt);
  }
  const allReached = pageCheckpoints.size === input.pages.length && recordCheckpoints.size === input.records.length;
  const seal = allReached && !signal?.aborted ? await store.sealV2(input.header.batchId, { inputHash: input.header.inputHash,
    pageCount: input.pages.length, recordCount: input.records.length, collectorCoverage: input.collectorCoverage }) : null;
  return { batchId: input.header.batchId, begin, processed, replayed, decisions, remaining: input.pages.length + input.records.length - pageCheckpoints.size - recordCheckpoints.size,
    interrupted: Boolean(signal?.aborted), sealed: Boolean(seal), seal };
}
