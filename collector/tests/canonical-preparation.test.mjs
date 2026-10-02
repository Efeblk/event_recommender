import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptCanonicalRecord, canonicalRequestId } from '../preparation/canonical-adapter.mjs';
import { createCanonicalStore } from '../preparation/canonical-store.mjs';
import { prepareCanonicalSearch, runCanonicalWorker } from '../preparation/canonical-worker.mjs';

const record = { id: 'raw-283820', source: 'bubilet', sourceSessionIds: ['283820'], title: 'Bir Oyun', description: 'Dostluk üzerine bir oyun.',
  venue: 'Sahne', district: 'Kadıköy', address: 'Moda Caddesi', city: 'İstanbul', category: 'Tiyatro',
  startsAt: '2026-10-03T17:00:00.000Z', checkedAt: '2026-09-30T10:00:00.000Z', attendanceTiming: null,
  price: 19.99, currency: 'TRY', availability: 'available', url: 'https://www.bubilet.com.tr/istanbul/etkinlik/bir-oyun', imageUrl: '' };

test('canonical adapter preserves the validated observation and typed evidence without inventing clocks or fees', () => {
  const adapted = adaptCanonicalRecord(record, [{ sessionId: 'session', canonicalRevisionId: 'canonical-old', offerRevisionId: 'offer-old' }]);
  assert.equal(adapted.status, 'ready');
  assert.equal(adapted.payload.requestId, canonicalRequestId(record));
  assert.equal(adapted.payload.sourceUpdatedAt, null);
  assert.equal(adapted.payload.expectedCanonicalRevisionId, 'canonical-old');
  assert.equal(adapted.payload.expectedOfferRevisionId, 'offer-old');
  assert.equal(adapted.payload.record.price, 19.99);
  assert.equal(adapted.payload.record.attendanceTiming, null);
  assert.deepEqual(adapted.payload.record.sourceSessionIds, ['283820']);
  assert.equal('feeMinor' in adapted.payload.record, false);
});

test('new identities remain isolated by default while an explicit supported production key is passed through', () => {
  const isolated = adaptCanonicalRecord(record, []);
  assert.equal(isolated.status, 'ready');
  assert.equal(isolated.payload.expectedCanonicalRevisionId, null);
  assert.equal(isolated.payload.expectedOfferRevisionId, null);
  assert.equal(isolated.payload.record.canonicalProductionKey, undefined);
  const supported = adaptCanonicalRecord({ ...record, canonicalProductionKey: 'supported-title:bir-oyun' }, []);
  assert.equal(supported.payload.record.canonicalProductionKey, 'supported-title:bir-oyun');
  const { sourceSessionIds: _ids, ...withoutOptionalIds } = record;
  assert.equal(adaptCanonicalRecord({ ...withoutOptionalIds, description: '' }, []).status, 'ready');
});

test('title, venue, time and category changes produce distinct immutable requests for SQL CAS handling', () => {
  for (const changed of [{ title: 'Başka Oyun' }, { venue: 'Başka Sahne' }, { startsAt: '2026-10-03T18:00:00.000Z' }, { category: 'Konser' }])
    assert.notEqual(canonicalRequestId({ ...record, ...changed }), canonicalRequestId(record));
  assert.equal(adaptCanonicalRecord(record, [{ sessionId: 'a' }, { sessionId: 'b' }]).reason, 'ambiguous_provider_identity');
});

test('canonical document is semantic, deterministic, lexical-first and explicitly has no vector', () => {
  const input = { revisionId: 'revision', sessionId: 'session', dependencyHash: 'dependency', facts: record };
  const first = prepareCanonicalSearch(input);
  const commercialChange = prepareCanonicalSearch({ ...input, facts: { ...record, price: 999, availability: 'sold_out', sourceSessionIds: ['different'] } });
  assert.deepEqual(commercialChange, first);
  assert.equal(first.documentProfile, 'event-title-category-venue-description-v1');
  assert.equal(first.embeddingProfile, null); assert.equal(first.embedding, null);
  assert.ok(first.lexicalTokens.includes('oyun')); assert.ok(!first.documentText.includes('19.99'));
  assert.match(first.documentHash, /^[a-f0-9]{64}$/);
  const multiline = prepareCanonicalSearch({ ...input, facts: { ...record, description: 'İlk satır\n\nİkinci  satır' } });
  assert.equal(multiline.documentText, 'Title: Bir Oyun\nCategory: Tiyatro\nVenue: Sahne\nDescription: İlk satır\n\nİkinci  satır');
});

function memoryStore(count = 2) {
  const jobs = Array.from({ length: count }, (_, index) => ({ id: `job-${index}`, fencing_token: '1', checkpoint: { revisionId: `revision-${index}` } }));
  const calls = [];
  return { calls, claim: async () => { calls.push('claim'); return jobs.length ? [jobs.shift()] : []; },
    input: async job => { calls.push('input'); return { revisionId: job.checkpoint.revisionId, sessionId: 'session', dependencyHash: 'dependency', facts: record }; },
    activePublication: async () => { calls.push('base'); return 'publication-base'; },
    complete: async () => { calls.push('complete'); return { status: 'completed', basePublicationId: 'publication-base', resultPublicationId: 'publication-next' }; },
    fail: async () => { calls.push('fail'); return { status: 'failed' }; } };
}

test('worker claims one at a time and stops at the bounded item limit', async () => {
  const store = memoryStore(); const result = await runCanonicalWorker({ store, workerId: 'fixture', maxJobs: 1 });
  assert.equal(result.completed, 1); assert.equal(result.published, 1); assert.equal(result.stopped, 'item_limit');
  assert.deepEqual(store.calls, ['claim', 'input', 'base', 'complete']);
});

test('preexisting interruption and expired deadline make no claims', async () => {
  const store = memoryStore(), controller = new AbortController(); controller.abort();
  const interrupted = await runCanonicalWorker({ store, workerId: 'fixture', signal: controller.signal });
  assert.equal(interrupted.stopped, 'interrupted'); assert.deepEqual(store.calls, []);
  let tick = 0; const timed = await runCanonicalWorker({ store, workerId: 'fixture', timeBudgetMs: 1, now: () => tick++ });
  assert.equal(timed.stopped, 'time_budget'); assert.deepEqual(store.calls, []);
});

test('interruption after preparation persists retry state and never publishes', async () => {
  const store = memoryStore(1), controller = new AbortController();
  const result = await runCanonicalWorker({ store, workerId: 'fixture', signal: controller.signal,
    prepare: input => { controller.abort(); return prepareCanonicalSearch(input); } });
  assert.equal(result.completed, 0); assert.equal(result.failures[0].retryable, true);
  assert.deepEqual(store.calls, ['claim', 'input', 'fail']);
});

test('stale checkpoint and stale failure fence are explicit uncertain errors without retry loops', async () => {
  const store = memoryStore(1); store.input = async () => ({ revisionId: 'changed', sessionId: 'session', dependencyHash: 'hash', facts: record });
  store.fail = async () => { throw new Error('stale fence'); };
  const result = await runCanonicalWorker({ store, workerId: 'fixture' });
  assert.equal(result.completed, 0); assert.equal(result.failures[0].persistence, 'uncertain');
  assert.equal(store.calls.filter(call => call === 'claim').length, 1);
});

test('SQL adapter refuses lossy fences before querying', () => {
  const store = createCanonicalStore(() => { throw new Error('query must not run'); });
  assert.throws(() => store.complete({ id: 'job', fencing_token: Number('9007199254740993') }, 'worker', {}, null), /Unsafe/);
});
