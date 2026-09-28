import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyIntentState } from '../lib/input-state.ts';
import { intentSummary, requirementLabel } from '../lib/input-summary.ts';

void test('visible plan separates hard group budget and evidence requirements from outing preferences', () => {
  const state = emptyIntentState();
  state.filters = {
    ...state.filters, partySize: 2, totalBudget: 1000, maxPrice: 500,
    maxPriceExclusive: true, dateFrom: '2026-10-03', dateTo: '2026-10-03',
    excludedCategories: ['Konser'],
  };
  state.requirements = [{ kind: 'activity', value: 'seated', policy: 'require_support' }];
  state.preferences = { mood: 'calm', companion: 'partner', interests: ['romantik atmosfer'] };
  const summary = intentSummary(state, (n) => `${n} TL`);
  assert.deepEqual(summary.required, ['2026-10-03', '2 kişi', 'Toplam 1000 TL altı', 'Kişi başı 500 TL altı', 'Konser hariç', 'Oturma yeri']);
  assert.deepEqual(summary.preferred, ['Partnerle birlikte', 'Sakin bir plan', 'romantik atmosfer']);
  assert.ok(!summary.required.some((s) => /romantik|sessiz|sakin/i.test(s)));
});

void test('visible requirement wording preserves alternatives, conjunctions and exclusions', () => {
  assert.equal(requirementLabel({ kind: 'genre', value: 'jazz|blues', policy: 'require_support' }), 'Caz veya Blues');
  assert.equal(requirementLabel({ kind: 'content', value: 'swearing|sexual_content', policy: 'require_support' }), 'Küfür içermediği belirtilen ve Cinsel içerik içermediği belirtilen');
  assert.equal(requirementLabel({ kind: 'audience', value: 'age:7', policy: 'require_support' }), '7 yaşa uygun');
  assert.equal(requirementLabel({ kind: 'genre', value: 'rock', policy: 'exclude_positive_evidence' }), 'Rock olanlar hariç');
});
