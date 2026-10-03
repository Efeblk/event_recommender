import assert from 'node:assert/strict';
import test from 'node:test';
import type { Condition, ParserInput, Plan } from '../parser/contract.ts';
import type { JevResponse, Question } from '../parser/jev.ts';
import { buildRequest, compose } from '../parser/parse.ts';
import { extract } from '../parser/extract.ts';
import { validateSearchPlan } from '../lib/plan-evidence.ts';

// Cases from the 2026-10-03 staging human test (reference date: Saturday).
const input = (utterance: string): ParserInput => ({
  utterance, language: 'tr', referenceDate: '2026-10-03', timezone: 'Europe/Istanbul', previousState: null,
});

function parsed(utterance: string, overrides: Record<string, string> = {}) {
  const request = input(utterance);
  const built = buildRequest(request);
  const answers: JevResponse['answers'] = {};
  for (const [id, question] of Object.entries(built.questions) as Array<[string, Question]>) {
    if (question.type === 'noul') { answers[id] = { type: 'noul', noul: 0 }; continue; }
    const options = Object.keys(question.criteria);
    const selected = overrides[id] ?? (id.startsWith('basis_') ? overrides.basis : undefined) ?? (id.startsWith('polarity_') ? 'wanted' : id.startsWith('link_') ? 'and'
      : id.startsWith('edit_') ? 'unchanged' : id.startsWith('hedge_') ? 'none' : id === 'action' ? 'continue'
      : id === 'order' ? 'unchanged' : options[0]);
    answers[id] = { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(options.map((o) => [o, o === selected ? 1 : 0])) };
  }
  return compose(request, built, { model: 'synthetic-offline-test', answers, usage: { input_tokens: 0, output_tokens: 0 } });
}

const atoms = (conditions: Condition[]) => conditions.flatMap((c) => (c.type === 'atom' ? [c.atom] : []));
const hard = (plan: Plan) => atoms(plan.hard.type === 'all' ? plan.hard.children : [plan.hard]);

void test('month parts and whole months become date ranges', () => {
  const dates = (utterance: string) => extract(utterance, '2026-10-03').mentions
    .filter((m) => m.kind === 'date').map((m) => m.kind === 'date' && [m.from, m.to]);
  assert.deepEqual(dates('ekim sonunda harbiyede açık hava konseri'), [['2026-10-21', '2026-10-31']]);
  assert.deepEqual(dates('kasım başında tiyatro'), [['2026-11-01', '2026-11-10']]);
  assert.deepEqual(dates('aralık ortasında stand up'), [['2026-12-11', '2026-12-20']]);
  assert.deepEqual(dates('ekimde caz'), [['2026-10-03', '2026-10-31']]);
  assert.deepEqual(dates('late october jazz'), [['2026-10-21', '2026-10-31']]);
  assert.deepEqual(dates('21 ekim konser'), [['2026-10-21', '2026-10-21']]);
  assert.deepEqual(dates('may be fun'), []);
});

void test('typo and musical vocabulary', () => {
  const kinds = (utterance: string) => extract(utterance, '2026-10-03').mentions
    .map((m) => `${m.kind}:${'value' in m ? m.value : ''}`);
  assert.ok(kinds('standap izlemek istiyorum').includes('category:standup'));
  assert.ok(kinds('müzikal izlemek istiyoruz').includes('topic:musical'));
  assert.ok(!kinds('müzikal izlemek istiyoruz').includes('category:theatre'));
});

void test('a bare price with no group is a ticket price, not a question', () => {
  const result = parsed('yarın 500 tl altı tiyatro', { basis: 'unstated' });
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') return;
  const budget = hard(result.resultingPlan).find((a) => a.kind === 'budget');
  assert.equal(budget?.kind === 'budget' && budget.basis, 'per_ticket');
});

void test('a mandatory neighbourhood requires its district and prefers the neighbourhood', () => {
  const result = parsed('harbiyede konser');
  assert.equal(result.status, 'accepted');
  if (result.status !== 'accepted') return;
  assert.deepEqual(hard(result.resultingPlan).filter((a) => a.kind === 'location'), [{ kind: 'location', name: 'Şişli', precision: 'district' }]);
  assert.deepEqual(atoms(result.resultingPlan.preferences).filter((a) => a.kind === 'location'), [{ kind: 'location', name: 'Harbiye', precision: 'neighborhood' }]);
  validateSearchPlan(result.resultingPlan);
});

void test('romantic is a preference, and open-air is a checkable requirement', () => {
  const romantic = parsed('romantik caz');
  assert.equal(romantic.status, 'accepted');
  if (romantic.status !== 'accepted') return;
  assert.ok(!hard(romantic.resultingPlan).some((a) => a.kind === 'experience'));
  assert.ok(atoms(romantic.resultingPlan.preferences).some((a) => a.kind === 'experience' && a.value === 'romantic'));
  const outdoors = parsed('açık hava konseri');
  assert.equal(outdoors.status, 'accepted');
  if (outdoors.status !== 'accepted') return;
  assert.ok(hard(outdoors.resultingPlan).some((a) => a.kind === 'experience' && a.value === 'outdoors'));
  validateSearchPlan(outdoors.resultingPlan);
});
