import test from 'node:test';
import assert from 'node:assert/strict';

import { catalogAllowsRecommendations } from '../lib/catalog-readiness.ts';
import { groupFilterCount, groupFilterLabels } from '../lib/ui-filters.ts';
import { emptyFilters } from '../lib/types.ts';

await test('recommendations require an overall ready catalog', () => {
  assert.equal(catalogAllowsRecommendations('ready'), true);
  assert.equal(catalogAllowsRecommendations('stale'), false);
  assert.equal(catalogAllowsRecommendations('empty'), false);
});

await test('group filter summaries expose party and total budget independently', () => {
  const formatMoney = (value: number) => `${value} TL`;
  const group = {
    ...emptyFilters,
    partySize: 4,
    totalBudget: 1800,
    maxPrice: 450,
  };
  assert.equal(groupFilterCount(group), 2);
  assert.deepEqual(groupFilterLabels(group, formatMoney), [
    '4 kişi',
    'Toplam bütçe 1800 TL',
  ]);

  const waived = { ...group, maxPrice: null, totalBudget: undefined };
  assert.equal(groupFilterCount(waived), 1);
  assert.deepEqual(groupFilterLabels(waived, formatMoney), ['4 kişi']);
});
