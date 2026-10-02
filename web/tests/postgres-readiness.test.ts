import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessPostgresPreparedCatalogReadiness,
  postgresPreparedCatalogReadinessSql,
  readPostgresPreparedCatalogReadiness,
} from '../lib/postgres-readiness.node.ts';

const coverage = () => {
  const now = Date.now(), oldest = now - 60000;
  return {
    schemaVersion: 2, scope: 'full', complete: true, finishedAt: new Date(now).toISOString(),
    startedAt: new Date(now - 120000).toISOString(), horizonStart: new Date(now).toISOString(),
    horizonEnd: new Date(now + 7 * 86400000).toISOString(), providers: ['bubilet'],
    collectionRunId: 'cycle-1', inputHash: '1'.repeat(64),
    scopeEvidence: { geography: 'Istanbul', listingConfigHash: '2'.repeat(64) },
    discovery: { unit: 'detail_url', listingConfigHash: '2'.repeat(64), inventoryHash: '3'.repeat(64), exhausted: true,
      urls: [{provider:'bubilet',url:'https://www.bubilet.com.tr/istanbul/etkinlik/test'}] },
    inventory: [{ provider: 'bubilet', known: 1, attemptedThisRun: 1, verifiedThisRun: 1,
      retiredThisRun: 0, failedThisRun: 0, quarantinedThisRun: 0, unattemptedThisRun: 0,
      neverVisited: 0, stale: 0, outstandingFailures: 0 }],
    records: { unit: 'event_record', submitted: 3, currentRun: 3, recovered: 0, carried: 5, sourceQuarantined: 0 },
    freshness: { maxSourceAgeMs: 86400000, oldestResolvedAt: new Date(oldest).toISOString(), validUntil: new Date(oldest + 86400000).toISOString() },
  };
};
const valid = (overrides: Record<string, unknown> = {}) => ({
  publicationId: 'publication-1', state: 'active', switchedAt: '2026-09-30T00:00:00Z',
  validatedAt: '2026-09-30T00:00:00Z', validationHash: 'validation-1',
  manifest: {
    requiredOfferCount: 3,
    collectorCoverage: coverage(),
    preparationReceipt: { status: 'verified', publicationId: 'publication-1', version:'canonical-batch-v1',
      batchId:'batch-1', inputHash:'1'.repeat(64) },
  },
  requiredSessions: 2, requiredDocuments: 2, requiredOffers: '3', requiredOfferEvidence: null as string | null,
  sessions: 2, documents: 2, offers: 3, missingReferences: 0, canceledSessions: 0,
  invalidOfferPins: 0, unresolvedPageOffers: 0, pendingEvaluations: 7, failedEvaluations: 2, staleEvaluations: 1,
  unknownEvaluations: 4, ...overrides,
});

void test('one pinned statement verifies publication integrity and reports optional enrichment separately', async () => {
  let calls = 0;
  const result = await readPostgresPreparedCatalogReadiness(async (sql) => {
    calls++;
    assert.equal(sql, postgresPreparedCatalogReadinessSql);
    assert.match(sql, /WITH active AS MATERIALIZED/);
    assert.match(sql, /publication_offer_evidence_current\(a\.id,r\.offer_id\)/);
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
    collectorCoverage: { ...coverage(), complete: false,
      discovery:{...coverage().discovery,urls:Array.from({length:8},(_,i)=>({provider:'bubilet',url:`https://www.bubilet.com.tr/istanbul/etkinlik/test-${i}`}))},
      inventory: [{ provider: 'bubilet', known: 8,
      attemptedThisRun: 3, verifiedThisRun: 1, retiredThisRun: 0, failedThisRun: 2, quarantinedThisRun: 0,
      unattemptedThisRun: 5, neverVisited: 5, stale: 0, outstandingFailures: 2 }] },
    preparationReceipt: { status: 'completed', publicationId: 'publication-1',version:'canonical-batch-v1',batchId:'batch-1',inputHash:'1'.repeat(64) },
  };
  const result = assessPostgresPreparedCatalogReadiness(valid({ manifest, failedEvaluations: 99 }));
  assert.deepEqual([...result.reasons].sort(), ['source_refresh_failed', 'source_coverage_incomplete'].sort());
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
  const bad=valid(); bad.manifest.collectorCoverage.inventory[0].failedThisRun=null as unknown as number;
  assert.ok(assessPostgresPreparedCatalogReadiness(bad).reasons.includes('collector_coverage_invalid'));
});

void test('record counts cannot substitute for URL coverage and legacy receipts cannot qualify', () => {
  const good=valid();
  assert.equal(assessPostgresPreparedCatalogReadiness(good).ready,true, 'one URL may produce three records');
  const legacy=valid({manifest:{...good.manifest,collectorCoverage:{complete:true,failedPages:0,unvisited:0,finishedAt:new Date().toISOString()}}});
  assert.ok(assessPostgresPreparedCatalogReadiness(legacy).reasons.includes('collector_coverage_version_unsupported'));
  const changed=valid(); changed.manifest.collectorCoverage.records.currentRun=4;
  assert.ok(assessPostgresPreparedCatalogReadiness(changed).reasons.includes('collector_coverage_invalid'));
});

void test('coverage expires with its oldest source observation even after a recent publication', () => {
  const raw=valid(), now=Date.now();
  raw.manifest.collectorCoverage.freshness.oldestResolvedAt=new Date(now-86400001).toISOString();
  raw.manifest.collectorCoverage.freshness.validUntil=new Date(now-1).toISOString();
  assert.ok(assessPostgresPreparedCatalogReadiness(raw,now).reasons.includes('collector_coverage_stale'));
  const forged=valid(); forged.manifest.collectorCoverage.freshness.validUntil=new Date(now+2*86400000).toISOString();
  assert.ok(assessPostgresPreparedCatalogReadiness(forged,now).reasons.includes('collector_coverage_freshness_invalid'));
});

void test('missing, duplicate or substituted URL inventory cannot qualify as full coverage', () => {
  for (const urls of [[], null,
    [{provider:'biletix',url:'https://www.biletix.com/test'}],
    [coverage().discovery.urls[0],coverage().discovery.urls[0]]]) {
    const raw=valid(); raw.manifest.collectorCoverage.discovery.urls=urls as typeof raw.manifest.collectorCoverage.discovery.urls;
    assert.ok(assessPostgresPreparedCatalogReadiness(raw).reasons.includes('collector_coverage_inventory_invalid'));
  }
});

void test('active publication and complete receipts cannot mask current adverse page evidence', () => {
  assert.ok(assessPostgresPreparedCatalogReadiness(valid({unresolvedPageOffers:1})).reasons.includes('provider_page_reconciliation_required'));
  const raw=valid(); raw.manifest.preparationReceipt.inputHash='4'.repeat(64);
  assert.ok(assessPostgresPreparedCatalogReadiness(raw).reasons.includes('preparation_receipt_invalid'));
});

void test('projection readiness accepts coherent unsupported evidence but rejects missing or drifted evidence', () => {
  const projected = valid();
  projected.requiredOfferEvidence = '3';
  Object.assign(projected.manifest, { offerProjectionVersion: 1, requiredOfferEvidenceCount: 3,
    preparationReceipt: { status: 'verified', publicationId: 'publication-1', version: 'provider-page-offer-v1',
      batchId: 'batch-1', inputHash: '1'.repeat(64), acceptedRecords: 3, pageAffectedSessions: 2,
      checkedAt: new Date().toISOString(), optionalEmbeddingsRequired: false } });
  assert.equal(assessPostgresPreparedCatalogReadiness(projected).ready, true,
    'the reviewed helper treats intact intentionally unsupported pins as coherent');
  const drift = structuredClone(projected); drift.unresolvedPageOffers = 1;
  assert.ok(assessPostgresPreparedCatalogReadiness(drift).reasons.includes('provider_page_reconciliation_required'));
  const missingCount = structuredClone(projected); missingCount.requiredOfferEvidence = '2';
  assert.ok(assessPostgresPreparedCatalogReadiness(missingCount).reasons.includes('postgres_offer_evidence_count_mismatch'));
});

void test('projection versions and preparation receipt versions cannot cross legacy boundaries', () => {
  const unknown = valid(); Object.assign(unknown.manifest, { offerProjectionVersion: 2, requiredOfferEvidenceCount: 3 });
  unknown.requiredOfferEvidence = '3';
  assert.ok(assessPostgresPreparedCatalogReadiness(unknown).reasons.includes('postgres_offer_projection_unsupported'));
  assert.ok(assessPostgresPreparedCatalogReadiness(unknown).reasons.includes('preparation_receipt_invalid'));
  const projectedWithLegacyReceipt = valid(); Object.assign(projectedWithLegacyReceipt.manifest, { offerProjectionVersion: 1, requiredOfferEvidenceCount: 3 });
  projectedWithLegacyReceipt.requiredOfferEvidence = '3';
  assert.ok(assessPostgresPreparedCatalogReadiness(projectedWithLegacyReceipt).reasons.includes('preparation_receipt_invalid'));
  const legacyWithProjectedReceipt = valid(); legacyWithProjectedReceipt.manifest.preparationReceipt.version = 'provider-page-offer-v1';
  assert.ok(assessPostgresPreparedCatalogReadiness(legacyWithProjectedReceipt).reasons.includes('preparation_receipt_invalid'));
});
