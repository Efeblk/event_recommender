import { createHash } from 'node:crypto';
import { detailUrl } from '../adapters.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const text = value => typeof value === 'string' ? value.trim() : '';
const canonicalText = value => text(value).normalize('NFC').replace(/\s+/g, ' ');
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const priceMinorOf = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!parts) return null;
  const minor = BigInt(parts[1]) * 100n + BigInt((parts[2] ?? '').padEnd(2, '0'));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? String(minor) : null;
};

export function sourceRequestId(record) {
  const ids = Array.isArray(record?.sourceSessionIds) ? [...new Set(record.sourceSessionIds.map(String))].sort() : [];
  return `source-request-${hash(stable({ provider: record?.source, ids, checkedAt: instant(record?.checkedAt), contentHash: hash(stable(record)) })).slice(0, 32)}`;
}

export function validateSourceRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['invalid_record'];
  for (const key of ['source', 'title', 'venue', 'startsAt', 'checkedAt']) if (!text(record[key])) errors.push(`missing_${key}`);
  if (!instant(record.startsAt)) errors.push('invalid_startsAt');
  if (!instant(record.checkedAt)) errors.push('invalid_checkedAt');
  if (!Array.isArray(record.sourceSessionIds) || !record.sourceSessionIds.length || record.sourceSessionIds.some(id => !text(String(id)))) errors.push('missing_sourceSessionIds');
  if (!['biletix', 'bubilet', 'biletinial'].includes(record.source)) errors.push('invalid_source');
  if (!detailUrl(record.url, record.source)) errors.push('invalid_source_url');
  if (record.currency !== 'TRY') errors.push('invalid_currency');
  if (!['available', 'unknown', 'cancelled', 'sold_out'].includes(record.availability)) errors.push('invalid_availability');
  if (record.price !== null && record.price !== undefined && priceMinorOf(record.price) === null) errors.push('invalid_price');
  return [...new Set(errors)];
}

function mismatch(record, candidate) {
  if (canonicalText(record.title) !== canonicalText(candidate.title)) return 'canonical_title_changed';
  if (instant(record.startsAt) !== instant(candidate.startsAt)) return 'canonical_session_time_changed';
  if (canonicalText(record.venue) !== canonicalText(candidate.venue)) return 'canonical_venue_changed';
  if (stable(record.attendanceTiming ?? null) !== stable(candidate.attendanceTiming ?? null)) return 'canonical_attendance_changed';
  const baseline = candidate.baselineSourceRecord;
  const sourceFacts = ['category', 'district', 'address', 'description', 'imageUrl'];
  if (!baseline || typeof baseline !== 'object' || sourceFacts.some(field => !Object.hasOwn(baseline, field))) return 'search_fact_baseline_missing';
  for (const field of sourceFacts) {
    if (canonicalText(record[field]) !== canonicalText(baseline[field])) return 'unsupported_search_facts_changed';
  }
  return null;
}

/** Convert one normalized collector EventRecord into an immutable offer observation.
 * Candidates must come from exact provider raw-id lookup against existing identities.
 */
export function adaptSourceRecord(record, candidates) {
  const errors = validateSourceRecord(record);
  const requestId = sourceRequestId(record);
  if (errors.length) return { status: 'quarantined', requestId, reason: 'invalid_source_record', details: errors };
  if (!Array.isArray(candidates) || candidates.length === 0) return { status: 'quarantined', requestId, reason: 'existing_offer_identity_not_found' };
  if (candidates.length !== 1) return { status: 'quarantined', requestId, reason: 'ambiguous_existing_offer_identity', details: candidates.map(c => c.offerId).sort() };
  const candidate = candidates[0], changed = mismatch(record, candidate);
  const observedIds = new Set(record.sourceSessionIds.map(String));
  if (!Array.isArray(candidate.identitySourceIds) || !candidate.identitySourceIds.some(id => observedIds.has(String(id))))
    return { status: 'quarantined', requestId, reason: 'provider_raw_identity_mismatch', offerId: candidate.offerId, sessionId: candidate.sessionId };
  if (changed) return { status: 'quarantined', requestId, reason: changed, offerId: candidate.offerId, sessionId: candidate.sessionId };
  const raw = structuredClone(record);
  const contentHash = hash(stable(raw));
  const observedAt = instant(record.checkedAt);
  const revisionId = `source-revision-${hash(stable({ offerId: candidate.offerId, observedAt, contentHash })).slice(0, 32)}`;
  const priceMinor = record.price === null || record.price === undefined ? null : priceMinorOf(record.price);
  const availability = record.availability === 'available' ? 'available' : record.availability === 'sold_out' ? 'sold_out' : record.availability === 'cancelled' ? 'unavailable' : 'unknown';
  return { status: 'ready', requestId, payload: {
    revisionId, offerId: candidate.offerId, sessionId: candidate.sessionId, provider: record.source,
    providerRecordId: candidate.providerRecordId, providerSessionId: candidate.providerSessionId ?? null,
    sourceSessionIds: [...new Set(record.sourceSessionIds.map(String))].sort(), sourceUrl: text(record.url) || null,
    ticketTierId: candidate.ticketTierId ?? null, ticketTierName: candidate.ticketTierName ?? null,
    currency: priceMinor === null ? null : (text(record.currency) || null), price: priceMinor === null ? null : String(record.price),
    priceMinor, feeMinor: null, priceKind: priceMinor === null ? 'unknown' : 'starting_at', availability,
    observedAt, sourceUpdatedAt: null, validFrom: null, validUntil: null, contentHash, sourcePayload: raw,
  }, expectedCurrentRevisionId: candidate.currentRevisionId ?? null };
}

export { stable as stableJson };
