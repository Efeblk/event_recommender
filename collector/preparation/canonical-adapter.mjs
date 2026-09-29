import { createHash } from 'node:crypto';
import { stableJson, validateSourceRecord } from './source-adapter.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' ? value.trim() : '';

export function canonicalRequestId(record) {
  return `canonical-request-${digest(stableJson({ provider: record?.source, providerRecordId: record?.id, record })).slice(0, 32)}`;
}

export function validateCanonicalRecord(record) {
  // sourceSessionIds is optional in the public EventRecord; its stable raw id is
  // sufficient for canonical identity lookup when no provider session ids exist.
  const errors = validateSourceRecord(record?.sourceSessionIds === undefined ? { ...record, sourceSessionIds: [record?.id] } : record);
  for (const key of ['id', 'category', 'city']) if (!text(record?.[key])) errors.push(`missing_${key}`);
  if (typeof record?.description !== 'string') errors.push('missing_description');
  if (record?.city !== 'İstanbul') errors.push('invalid_city');
  if (record?.canonicalProductionKey !== undefined && !text(record.canonicalProductionKey)) errors.push('invalid_canonicalProductionKey');
  return [...new Set(errors)];
}

/** Build the immutable input for SQL-owned conservative identity resolution. */
export function adaptCanonicalRecord(record, heads = []) {
  const requestId = canonicalRequestId(record), errors = validateCanonicalRecord(record);
  if (errors.length) return { status: 'quarantined', requestId, reason: 'invalid_source_record', details: errors };
  if (!Array.isArray(heads)) return { status: 'quarantined', requestId, reason: 'invalid_identity_lookup' };
  if (heads.length > 1) return { status: 'quarantined', requestId, reason: 'ambiguous_provider_identity', details: heads.map(h => h.sessionId).sort() };
  const head = heads[0] ?? {};
  const normalized = structuredClone(record);
  if (normalized.sourceSessionIds === undefined) normalized.sourceSessionIds = [String(normalized.id)];
  return { status: 'ready', requestId, payload: {
    requestId, adapterVersion: 'normalized-source-v1', normalizerVersion: 'canonical-base-v1',
    record: normalized, sourceUpdatedAt: null,
    expectedCanonicalRevisionId: head.canonicalRevisionId ?? null,
    expectedOfferRevisionId: head.offerRevisionId ?? null,
  } };
}
