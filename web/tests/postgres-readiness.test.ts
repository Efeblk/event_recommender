import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessPostgresPreparedCatalogReadiness,
  postgresPreparedCatalogReadinessSql,
  readPostgresPreparedCatalogReadiness,
} from '../lib/postgres-readiness.node.ts';

const valid = (overrides: Record<string, unknown> = {}) => ({
  publicationId: 'publication-1', state: 'active', switchedAt: '2026-09-30T00:00:00Z',
  validatedAt: '2026-09-30T00:00:00Z', validationHash: 'validation-1',
  manifest: {
    requiredOfferCount: 3,
    collectorCoverage: { complete: true, failedPages: 0, unvisited: 0, verified: 3, finishedAt: new Date().toISOString() },
    preparationReceipt: { status: 'verified', publicationId: 'publication-1', receiptHash: 'receipt-1' },
  },
  requiredSessions: 2, requiredDocuments: 2, requiredOffers: '3',
  sessions: 2, documents: 2, offers: 3, missingReferences: 0, canceledSessions: 0,
  invalidOfferPins: 0, pendingEvaluations: 7, failedEvaluations: 2, staleEvaluations: 1,
  unknownEvaluations: 4, ...overrides,
});

void test('one pinned statement verifies publication integrity and reports optional enrichment separately', async () => {
  let calls = 0;
  const result = await readPostgresPreparedCatalogReadiness(async (sql) => {
    calls++;
    assert.equal(sql, postgresPreparedCatalogReadinessSql);
    assert.match(sql, /WITH active AS MATERIALIZED/);
    assert.doesNotMatch(sql, /GCS|checkpoint/i);
    return JSON.stringify(valid());
  });
  assert.equal(calls, 1);
  assert.equal(result.ready, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.publicationId, 'publication-1');
  assert.deepEqual(result.optionalEnrichment, { pending: 7, failed: 2, stale: 1, unknown: 4 });
});

void test('required publication, coverage, receipt, and offer integrity fail closed', () => {
  const result = assessPostgresPreparedCatalogReadiness(valid({
    state: 'superseded', validationHash: null, sessions: 1, documents: 1, offers: 2,
    missingReferences: 1, manifest: { requiredOfferCount: 3 },
  }));
  assert.deepEqual(result.reasons, [
    'postgres_publication_not_active', 'postgres_publication_not_validated',
    'postgres_session_count_mismatch', 'postgres_document_count_mismatch',
    'postgres_offer_count_mismatch', 'postgres_reference_integrity_failed',
    'collector_coverage_missing', 'preparation_receipt_missing',
  ]);
});

void test('failed refresh is distinct from incomplete coverage and optional evaluation failures', () => {
  const manifest = {
    requiredOfferCount: 3,
    collectorCoverage: { complete: false, failedPages: 2, unvisited: 5, finishedAt: new Date().toISOString() },
    preparationReceipt: { status: 'completed', publicationId: 'publication-1' },
  };
  const result = assessPostgresPreparedCatalogReadiness(valid({ manifest, failedEvaluations: 99 }));
  assert.deepEqual(result.reasons, ['source_refresh_failed', 'source_coverage_incomplete']);
  assert.equal(result.optionalEnrichment.failed, 99);
});

void test('missing active row returns an explicit PostgreSQL result without inventing provenance', async () => {
  const result = await readPostgresPreparedCatalogReadiness(async () => '');
  assert.equal(result.ready, false);
  assert.equal(result.backend, 'postgres');
  assert.equal(result.publicationId, null);
  assert.ok(result.reasons.includes('collector_coverage_missing'));
  assert.ok(result.reasons.includes('preparation_receipt_missing'));
});

void test('missing counts and stale or future source evidence cannot report readiness', () => {
  const now=Date.parse('2026-09-30T00:00:00.000Z');
  for(const finishedAt of ['2026-09-28T00:00:00.000Z','2026-10-01T00:00:00.000Z',null,'not-a-date']) {
    const raw=valid(); raw.manifest.collectorCoverage.finishedAt=finishedAt as string;
    const result=assessPostgresPreparedCatalogReadiness(raw,now);
    assert.equal(result.ready,false);
    assert.ok(result.reasons.some(reason=>reason==='collector_coverage_stale'||reason==='collector_coverage_time_invalid'));
  }
  const absent=assessPostgresPreparedCatalogReadiness(valid({requiredOffers:null,offers:0}));
  assert.ok(absent.reasons.includes('postgres_offer_count_missing'));
  const bad=valid(); bad.manifest.collectorCoverage.failedPages=null as unknown as number;
  assert.ok(assessPostgresPreparedCatalogReadiness(bad).reasons.includes('collector_coverage_invalid'));
});