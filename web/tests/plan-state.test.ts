import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPlanState, validatePlanState } from '../lib/plan-state.ts';

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
