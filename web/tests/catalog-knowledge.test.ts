import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluatePromotionPrice, prepareCatalogKnowledge } from '../lib/catalog-knowledge.ts';
import type { EventRecord } from '../lib/types.ts';

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'biletix:session-1', title: 'Hamlet', description: 'Provider synopsis',
    startsAt: '2026-10-10T17:00:00.000Z', venue: 'Sahne', city: 'İstanbul',
    district: 'Kadıköy', address: 'Moda Cd. 1', price: 500, currency: 'TRY',
    url: 'https://example.test/1', imageUrl: 'https://example.test/1.jpg',
    category: 'Tiyatro', availability: 'available', source: 'biletix',
    sourceVersion: 'fixture-v1', sourceSessionIds: ['source-session-exact'],
    checkedAt: '2026-09-29T09:00:00.000Z', ...overrides,
  };
}

await test('preparation preserves IDs and raw provenance without inventing work, people, or quality', () => {
  const input = event({
    offers: [{ id: 'provider-offer-exact', sourceSessionIds: ['offer-session-exact'], source: 'biletix',
      url: 'https://example.test/tier', price: 450, currency: 'TRY',
      checkedAt: '2026-09-29T09:00:00.000Z', category: 'Balkon', venue: 'Sahne', availability: 'available' }],
  });
  const result = prepareCatalogKnowledge([input]);
  assert.equal(result.sessions[0].id, input.id);
  assert.deepEqual(result.sessions[0].sourceSessionIds, ['source-session-exact']);
  assert.equal(result.providerOffers[0].id, 'provider-offer-exact');
  assert.deepEqual(result.providerOffers[0].sourceSessionIds, ['offer-session-exact']);
  assert.deepEqual(result.sourceObservations[0].raw, input);
  assert.equal(result.productions[0].workId, null);
  assert.deepEqual(result.productions[0].personIds, []);
  assert.ok(result.evaluations.every(item => item.status === 'pending' && item.score === null && item.evidenceClaimIds.length === 0));
});

await test('only an existing canonical production key merges production identity', () => {
  const first = event({ id: 'a', title: 'Same title' });
  const second = event({ id: 'b', title: 'Same title' });
  const isolated = prepareCatalogKnowledge([first, second]);
  assert.equal(isolated.productions.length, 2);
  const keyed = prepareCatalogKnowledge([
    { ...first, canonicalProductionKey: 'reviewed:hamlet-production' },
    { ...second, canonicalProductionKey: 'reviewed:hamlet-production' },
  ]);
  assert.equal(keyed.productions.length, 1);
  assert.equal(keyed.productions[0].canonicalProductionKey, 'reviewed:hamlet-production');
});

await test('input hash and rows are deterministic across input order', () => {
  const first = event({ id: 'a' });
  const second = event({ id: 'b', venue: 'Other Venue' });
  assert.deepEqual(prepareCatalogKnowledge([first, second]), prepareCatalogKnowledge([second, first]));
});

await test('complete scores require component, rubric, model, and evidence IDs', () => {
  assert.throws(() => prepareCatalogKnowledge([event()], { evaluations: [{
    id: 'invalid', subject: { type: 'production', id: 'p' }, dimension: 'production_reputation',
    status: 'complete', score: 0, components: [], rubricVersion: null, modelVersion: null,
    evidenceClaimIds: [], inputHash: 'hash',
  }] }), /requires a score, components, rubric, model, and evidence IDs/);
});

await test('evaluations and claims cannot reference fabricated evidence or subjects', () => {
  const prepared = prepareCatalogKnowledge([event()]);
  const observationId = prepared.sourceObservations[0].id;
  const productionId = prepared.productions[0].id;
  assert.throws(() => prepareCatalogKnowledge([event()], { sourceClaims: [{
    id: 'claim', subject: { type: 'person', id: 'invented' }, field: 'review', value: 'good',
    sourceObservationIds: [observationId],
  }] }), /unknown subject/);
  assert.throws(() => prepareCatalogKnowledge([event()], { sourceClaims: [{
    id: 'claim', subject: { type: 'production', id: productionId }, field: 'review', value: 'good',
    sourceObservationIds: ['invented-observation'],
  }] }), /known source observations/);
  assert.throws(() => prepareCatalogKnowledge([event()], { evaluations: [{
    id: 'evaluation', subject: { type: 'production', id: productionId }, dimension: 'production_reputation',
    status: 'complete', score: 0.8, components: [{ id: 'reviews', score: 0.8, weight: 1 }],
    rubricVersion: 'rubric-v1', modelVersion: 'model-v1', evidenceClaimIds: ['invented-claim'],
    inputHash: 'a'.repeat(64),
  }] }), /unknown evidence claim/);
});

await test('pending evaluation IDs and hashes follow content while production identity stays stable', () => {
  const first = prepareCatalogKnowledge([event({ description: 'First observation' })]);
  const second = prepareCatalogKnowledge([event({ description: 'Changed observation' })]);
  const repeated = prepareCatalogKnowledge([event({ description: 'First observation' })]);
  assert.equal(first.productions[0].id, second.productions[0].id);
  assert.notEqual(first.evaluations[0].inputHash, second.evaluations[0].inputHash);
  assert.notEqual(first.evaluations[0].id, second.evaluations[0].id);
  assert.equal(first.evaluations[0].inputHash, repeated.evaluations[0].inputHash);
  assert.equal(first.evaluations[0].id, repeated.evaluations[0].id);
});

await test('duplicate provider offer IDs fail closed across sessions or contradictory raw data', () => {
  const shared = { id: 'offer-id', url: 'https://example.test/offer', price: 100, currency: 'TRY',
    checkedAt: '2026-09-29T09:00:00.000Z', category: 'Tier', venue: 'Sahne', availability: 'available' as const };
  assert.throws(() => prepareCatalogKnowledge([
    event({ id: 'session-a', offers: [shared] }), event({ id: 'session-b', offers: [shared] }),
  ]), /conflicting session or raw data/);
  assert.throws(() => prepareCatalogKnowledge([event({ offers: [shared, { ...shared, price: 90 }] })]),
    /conflicting session or raw data/);
});

await test('percentage and fixed benefits discount only qualifying tickets and preserve fees', () => {
  const percentage = evaluatePromotionPrice({ unitPrice: 100, ticketCount: 4, qualifyingTicketCount: 2,
    eligibility: 'eligible', benefit: { kind: 'percentage', percent: 50, cap: null },
    mandatoryFeePerTicket: 10, stacking: 'not_applicable' });
  assert.deepEqual({ checkout: percentage.checkoutTotal, discount: percentage.discountAtCheckout }, { checkout: 340, discount: 100 });
  const fixed = evaluatePromotionPrice({ unitPrice: 100, ticketCount: 4, qualifyingTicketCount: 2,
    eligibility: 'eligible', benefit: { kind: 'fixed', amount: 30, cap: 50 },
    mandatoryFeePerTicket: 0, stacking: 'not_applicable' });
  assert.equal(fixed.checkoutTotal, 350);
});

await test('BOGO, unknown eligibility, unknown quantities, and cashback remain accurately conditional', () => {
  const bogo = evaluatePromotionPrice({ unitPrice: 100, ticketCount: 5, qualifyingTicketCount: 5,
    eligibility: 'eligible', benefit: { kind: 'buy_get', buy: 1, get: 1, capFreeTickets: null },
    mandatoryFeePerTicket: 0, stacking: 'unsupported' });
  assert.equal(bogo.checkoutTotal, 300);
  const unknown = evaluatePromotionPrice({ unitPrice: 100, ticketCount: 3, qualifyingTicketCount: null,
    eligibility: 'unknown', benefit: { kind: 'percentage', percent: 20, cap: null },
    mandatoryFeePerTicket: null, stacking: 'unknown' });
  assert.equal(unknown.status, 'conditional');
  assert.equal(unknown.checkoutTotal, null);
  assert.equal(unknown.usableForHardBudget, false);
  const unknownFees = evaluatePromotionPrice({ unitPrice: 100, ticketCount: 2, qualifyingTicketCount: 2,
    eligibility: 'eligible', benefit: { kind: 'percentage', percent: 10, cap: null },
    mandatoryFeePerTicket: null, stacking: 'not_applicable' });
  assert.equal(unknownFees.status, 'conditional');
  assert.equal(unknownFees.checkoutTotal, null);
  assert.equal(unknownFees.usableForHardBudget, false);
  const cashback = evaluatePromotionPrice({ unitPrice: 100, ticketCount: 2, qualifyingTicketCount: 2,
    eligibility: 'eligible', benefit: { kind: 'cashback', percent: 25, cap: 40 },
    mandatoryFeePerTicket: 0, stacking: 'not_applicable' });
  assert.equal(cashback.checkoutTotal, 200);
  assert.equal(cashback.cashback, 40);
  assert.equal(cashback.discountAtCheckout, 0);
});

await test('promotion terms reject non-finite values and invalid bounds', () => {
  const base = { unitPrice: 100, ticketCount: 2, qualifyingTicketCount: 2,
    eligibility: 'eligible' as const, mandatoryFeePerTicket: 0, stacking: 'not_applicable' as const };
  assert.throws(() => evaluatePromotionPrice({ ...base,
    benefit: { kind: 'percentage', percent: 101, cap: null } }), /Invalid promotion price input/);
  assert.throws(() => evaluatePromotionPrice({ ...base, unitPrice: Number.NaN,
    benefit: { kind: 'fixed', amount: 10, cap: null } }), /Invalid promotion price input/);
  assert.throws(() => evaluatePromotionPrice({ ...base,
    benefit: { kind: 'buy_get', buy: 0, get: 1, capFreeTickets: null } }), /Invalid promotion price input/);
});
