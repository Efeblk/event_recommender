import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPlanState, validatePlanState } from '../lib/plan-state.ts';
import { applyOperations } from '../parser/state.ts';
import type { Condition } from '../parser/contract.ts';

void test('v2 plan state accepts its empty canonical value', () => {
  assert.deepEqual(validatePlanState(emptyPlanState()), emptyPlanState());
});

void test('v2 plan state rejects unknown keys at every level', () => {
  assert.throws(() => validatePlanState({ ...emptyPlanState(), extra: true }));
  const state = emptyPlanState() as unknown as {
    plan: { hard: { children: unknown[] } };
  };
  state.plan.hard.children.push({
    type: 'atom',
    atom: { kind: 'party', count: 2, extra: true },
  });
  assert.throws(() => validatePlanState(state));
});

void test('restating a condition the plan holds does not duplicate it', () => {
  const party: Condition = { type: 'atom', atom: { kind: 'party', count: 3 } };
  const plan = applyOperations(
    { revision: 1, plan: { hard: { type: 'all', children: [{ ...party, id: 'h0' }] }, preferences: [], order: 'none' }, evidence: [] },
    [{ op: 'add', strength: 'hard', condition: party }],
  );
  assert.equal(plan.hard.type === 'all' ? plan.hard.children.length : 0, 1);
});
