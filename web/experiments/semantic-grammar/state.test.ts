import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPlan, type Condition, type PreviousState } from './contract.ts';
import { applyOperations, validatePlan } from './state.ts';
import { canonicalInterpretation, semanticPlan, stable } from './semantics.ts';

const category = (value: 'concert' | 'workshop'): Condition => ({ type: 'atom', atom: { kind: 'category', value } });
const seed: PreviousState = {
  revision: 3,
  evidence: [],
  plan: { hard: { type: 'all', children: [{ ...category('concert'), id: 'h0' }] }, preferences: [], order: 'soonest' },
};

void test('failed late correction is atomic and leaves original state intact', () => {
  const before = structuredClone(seed);
  assert.throws(() => applyOperations(seed, [
    { op: 'remove', targetId: 'h0' }, { op: 'remove', targetId: 'missing' },
  ]));
  assert.deepEqual(seed, before);
});

void test('grouped disjunction cannot be edited by a child ID', () => {
  const previous: PreviousState = { revision: 1, evidence: [], plan: {
    hard: { type: 'all', children: [{ type: 'any', id: 'h0', children: [
      { ...category('concert'), id: 'child0' }, category('workshop'),
    ] }] }, preferences: [], order: 'none',
  } };
  assert.throws(() => applyOperations(previous, [{ op: 'remove', targetId: 'child0' }]));
  assert.equal(previous.plan.hard.type, 'all');
});

void test('strength change keeps target identity and the remaining ordering', () => {
  const plan = applyOperations(seed, [{ op: 'replace', targetId: 'h0', condition: category('workshop'), strength: 'preferred' }]);
  assert.equal(plan.hard.type === 'all' && plan.hard.children.length, 0);
  assert.equal(plan.preferences[0].id, 'h0');
  assert.equal(plan.order, 'soonest');
});

void test('reset clears constraints and ordering before subsequent addition', () => {
  const plan = applyOperations(seed, [{ op: 'reset' }, { op: 'add', strength: 'hard', condition: category('workshop') }]);
  assert.equal(plan.order, 'none');
  assert.equal(plan.hard.type === 'all' && plan.hard.children.length, 1);
  assert.equal(plan.hard.type === 'all' && plan.hard.children[0].id, 'h1');
});

void test('identities remain unique after moving constraints between strengths', () => {
  const moved = applyOperations(seed, [{ op: 'replace', targetId: 'h0', condition: category('concert'), strength: 'preferred' }]);
  const plan = applyOperations({ ...seed, plan: moved }, [{ op: 'add', strength: 'hard', condition: category('workshop') }]);
  assert.equal(plan.preferences[0].id, 'h0');
  assert.equal(plan.hard.type === 'all' && plan.hard.children[0].id, 'h1');
});

void test('invalid exact dates, empty strict time bounds and duplicate IDs fail', () => {
  for (const condition of [
    { type: 'atom', atom: { kind: 'date', from: '2026-02-30', to: '2026-03-01' } },
    { type: 'atom', atom: { kind: 'time', from: '20:00', to: '20:00', fromExclusive: true } },
  ]) {
    assert.throws(() => validatePlan({ ...emptyPlan(), hard: { type: 'all', children: [condition as Condition] } }));
  }
  assert.throws(() => validatePlan({ ...emptyPlan(), hard: { type: 'all', children: [
    { ...category('concert'), id: 'h0' }, { ...category('workshop'), id: 'h0' },
  ] } }));
});

void test('semantic comparison preserves negation scope and preference strength', () => {
  const or: Condition = { type: 'any', children: [category('concert'), category('workshop')] };
  const a = applyOperations(null, [{ op: 'add', strength: 'hard', condition: { type: 'not', child: or } }]);
  const b = applyOperations(null, [{ op: 'add', strength: 'preferred', condition: { type: 'not', child: or } }]);
  assert.notEqual(stable(semanticPlan(a)), stable(semanticPlan(b)));
  const reverse = { ...or, children: [...or.children].reverse() };
  const c = applyOperations(null, [{ op: 'add', strength: 'hard', condition: { type: 'not', child: reverse } }]);
  assert.equal(stable(semanticPlan(a)), stable(semanticPlan(c)));
  const add = { op: 'add' as const, strength: 'hard' as const, condition: category('workshop') };
  assert.notEqual(canonicalInterpretation({ operations: [{ op: 'reset' }, add], resultingPlan: c }),
    canonicalInterpretation({ operations: [add, { op: 'reset' }], resultingPlan: c }));
});
