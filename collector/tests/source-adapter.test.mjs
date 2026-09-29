import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptSourceRecord, sourceRequestId } from '../preparation/source-adapter.mjs';
import { replaySourceRecords } from '../preparation/run-source.mjs';

const record = {
  id: 'compatibility-session-id', source: 'bubilet', sourceSessionIds: ['283820'],
  title: 'Bir Oyun', venue: 'Sahne', startsAt: '2026-10-03T17:00:00.000Z',
  attendanceTiming: { doorsOpenMinutesBefore: 30 }, checkedAt: '2026-09-30T10:00:00.000Z',
  price: 1500, currency: 'TRY', availability: 'available', url: 'https://www.bubilet.com.tr/istanbul/etkinlik/bir-oyun',
};
const candidate = { offerId: 'offer-raw-283820', sessionId: 'prepared-session', providerRecordId: 'raw-283820',
  providerSessionId: '283820', currentRevisionId: 'old-revision', title: 'Bir Oyun', venue: 'Sahne',
  startsAt: record.startsAt, attendanceTiming: record.attendanceTiming, identitySourceIds: ['raw-283820', '283820'],
  baselineSourceRecord: { category: undefined, district: undefined, address: undefined, description: undefined, imageUrl: undefined } };

test('maps actual normalized record to starting-price evidence without inventing source clocks or fees', () => {
  const result = adaptSourceRecord(record, [candidate]);
  assert.equal(result.status, 'ready');
  assert.equal(result.payload.offerId, candidate.offerId);
  assert.equal(result.payload.observedAt, record.checkedAt);
  assert.equal(result.payload.sourceUpdatedAt, null);
  assert.equal(result.payload.priceKind, 'starting_at');
  assert.equal(result.payload.priceMinor, '150000');
  assert.equal(result.payload.feeMinor, null);
  assert.deepEqual(result.payload.sourcePayload, record);
  assert.equal(result.expectedCurrentRevisionId, 'old-revision');
});

test('unknown prices remain unknown and deterministic ids include observation time', () => {
  const unknown = adaptSourceRecord({ ...record, price: null }, [candidate]);
  assert.equal(unknown.payload.priceKind, 'unknown');
  assert.equal(unknown.payload.currency, null);
  assert.equal(unknown.payload.priceMinor, null);
  assert.equal(adaptSourceRecord({ ...record, price: null }, [candidate]).payload.revisionId, unknown.payload.revisionId);
  assert.notEqual(adaptSourceRecord({ ...record, price: null, checkedAt: '2026-09-30T11:00:00.000Z' }, [candidate]).payload.revisionId, unknown.payload.revisionId);
  assert.notEqual(sourceRequestId(record), sourceRequestId({ ...record, price: 1600 }));
});

test('decimal ticket prices preserve cents without binary floating-point rounding', () => {
  const result = adaptSourceRecord({ ...record, price: 19.99 }, [candidate]);
  assert.equal(result.status, 'ready');
  assert.equal(result.payload.priceMinor, '1999');
  assert.equal(adaptSourceRecord({ ...record, price: 19.999 }, [candidate]).status, 'quarantined');
});

test('quarantines absent, ambiguous and changed canonical identities without guessed merge', () => {
  assert.equal(adaptSourceRecord(record, []).reason, 'existing_offer_identity_not_found');
  assert.equal(adaptSourceRecord(record, [candidate, { ...candidate, offerId: 'other' }]).reason, 'ambiguous_existing_offer_identity');
  assert.equal(adaptSourceRecord(record, [{ ...candidate, identitySourceIds: ['different'] }]).reason, 'provider_raw_identity_mismatch');
  assert.equal(adaptSourceRecord({ ...record, title: 'Başka Oyun' }, [candidate]).reason, 'canonical_title_changed');
  assert.equal(adaptSourceRecord({ ...record, startsAt: '2026-10-03T18:00:00.000Z' }, [candidate]).reason, 'canonical_session_time_changed');
  assert.equal(adaptSourceRecord({ ...record, venue: 'Başka Sahne' }, [candidate]).reason, 'canonical_venue_changed');
  assert.equal(adaptSourceRecord({ ...record, attendanceTiming: { doorsOpenMinutesBefore: 15 } }, [candidate]).reason, 'canonical_attendance_changed');
  const { attendanceTiming: _omitted, ...withoutAttendance } = record;
  assert.equal(adaptSourceRecord(withoutAttendance, [candidate]).reason, 'canonical_attendance_changed');
  assert.equal(adaptSourceRecord({ ...record, description: 'changed' }, [{ ...candidate, baselineSourceRecord: { ...candidate.baselineSourceRecord, description: 'original' } }]).reason, 'unsupported_search_facts_changed');
  assert.equal(adaptSourceRecord(record, [{ ...candidate, baselineSourceRecord: {} }]).reason, 'search_fact_baseline_missing');
});

test('rejects invalid money, provider URLs and typed offer fields before adaptation', () => {
  for (const changed of [
    { price: '1500' }, { price: 0.001 }, { price: Number.POSITIVE_INFINITY },
    { url: 'https://evil.invalid/event' }, { currency: 'USD' }, { availability: 'yes' },
  ]) assert.equal(adaptSourceRecord({ ...record, ...changed }, [candidate]).reason, 'invalid_source_record');
});

test('exact observation replay skips acceptance using durable receipt decision', async () => {
  let accepts = 0;
  const store = { findExistingOffers: async () => [candidate], accept: async payload => { accepts++; return { status: 'accepted', revisionId: payload.revisionId }; } };
  const first = await replaySourceRecords([record], { store });
  const second = await replaySourceRecords([record], { store, receipt: first.receipt });
  assert.equal(accepts, 1);
  assert.equal(second.decisions[0].replayed, true);
  assert.equal(Object.keys(first.receipt.decisions)[0], sourceRequestId(record));
});

test('bounded interruption retains completed decisions for restart', async () => {
  const controller = new AbortController(); let accepts = 0;
  const store = { findExistingOffers: async () => [candidate], accept: async payload => { accepts++; controller.abort(); return { status: 'accepted', revisionId: payload.revisionId }; } };
  const nextRecord = { ...record, checkedAt: '2026-09-30T11:00:00.000Z' };
  const stopped = await replaySourceRecords([record, nextRecord], { store, signal: controller.signal });
  assert.equal(accepts, 1);
  assert.equal(stopped.interrupted, true);
  assert.equal(stopped.remaining, 1);
  const resumed = await replaySourceRecords([record, nextRecord], { store, receipt: stopped.receipt });
  assert.equal(resumed.decisions[0].replayed, true);
  assert.equal(accepts, 2);
});

test('replayed receipts do not consume the new-decision limit or starve later records', async () => {
  let accepts = 0;
  const store = { findExistingOffers: async () => [candidate], accept: async payload => ({ status: 'accepted', revisionId: payload.revisionId, sequence: ++accepts }) };
  const records = [record, { ...record, checkedAt: '2026-09-30T11:00:00.000Z' }, { ...record, checkedAt: '2026-09-30T12:00:00.000Z' }];
  const first = await replaySourceRecords(records, { store, limit: 1 });
  assert.deepEqual({ processed: first.processed, replayed: first.replayed, remaining: first.remaining }, { processed: 1, replayed: 0, remaining: 2 });
  const second = await replaySourceRecords(records, { store, receipt: first.receipt, limit: 1 });
  assert.deepEqual({ processed: second.processed, replayed: second.replayed, remaining: second.remaining }, { processed: 1, replayed: 1, remaining: 1 });
  const third = await replaySourceRecords(records, { store, receipt: second.receipt, limit: 1 });
  assert.deepEqual({ processed: third.processed, replayed: third.replayed, remaining: third.remaining }, { processed: 1, replayed: 2, remaining: 0 });
  assert.equal(accepts, 3);
});

test('malformed records quarantine without querying identity storage', async () => {
  let lookups = 0;
  const malformed = { ...record, sourceSessionIds: [] };
  const result = await replaySourceRecords([malformed], { store: { findExistingOffers: async () => { lookups++; return []; }, accept: async () => assert.fail() } });
  assert.equal(lookups, 0);
  assert.equal(result.decisions[0].reason, 'invalid_source_record');
});

test('crash-after-accept replay sends the same immutable revision for database idempotency', async () => {
  const seen = new Set(); let accepts = 0;
  const store = { findExistingOffers: async () => [candidate], accept: async payload => {
    accepts++; const idempotent = seen.has(payload.revisionId); seen.add(payload.revisionId);
    return { status: 'accepted', revisionId: payload.revisionId, idempotent };
  } };
  const beforeReceipt = await replaySourceRecords([record], { store });
  const afterCrash = await replaySourceRecords([record], { store });
  assert.equal(beforeReceipt.decisions[0].revisionId, afterCrash.decisions[0].revisionId);
  assert.equal(afterCrash.decisions[0].idempotent, true);
  assert.equal(accepts, 2);
});

test('quarantine receipt retains the complete source record for offline review', async () => {
  const result = await replaySourceRecords([record], { store: { findExistingOffers: async () => [], accept: async () => assert.fail('must not accept') } });
  assert.deepEqual(result.decisions[0].sourceRecord, record);
  assert.deepEqual(result.receipt.decisions[sourceRequestId(record)].sourceRecord, record);
});
