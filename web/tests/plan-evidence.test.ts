import assert from 'node:assert/strict';
import test from 'node:test';
import type { Plan } from '../parser/contract.ts';
import type { EventRecord } from '../lib/types.ts';
import { evaluatePlan, validateSearchPlan } from '../lib/plan-evidence.ts';

const event: EventRecord = {
  id: 'e',
  title: 'Quiet jazz night',
  description: 'A jazz concert. No profanity.',
  startsAt: '2026-10-03T17:00:00Z',
  venue: 'Salon',
  city: '\u0130stanbul',
  district: 'Kad\u0131k\u00f6y',
  address: 'Kad\u0131k\u00f6y',
  price: 300,
  currency: 'TRY',
  url: 'https://example.test',
  imageUrl: '',
  category: 'Konser',
  availability: 'available',
  attendanceTiming: {
    kind: 'timed_session',
    evidence: 'provider_sessions_and_source_text',
  },
  checkedAt: '2026-10-02T08:00:00Z',
};
const plan = (hard: Plan['hard']): Plan => ({
  hard,
  preferences: [],
  order: 'none',
});

void test('nested OR and NOT preserve unknown instead of guessing', () => {
  const value = plan({
    type: 'all',
    children: [
      {
        type: 'any',
        children: [
          { type: 'atom', atom: { kind: 'topic', value: 'jazz' } },
          {
            type: 'not',
            child: {
              type: 'atom',
              atom: { kind: 'experience', value: 'outdoors' },
            },
          },
        ],
      },
    ],
  });
  assert.equal(
    evaluatePlan(event, value, new Date('2026-10-02T09:00:00Z')).status,
    'supported',
  );
  const unknownNot = plan({
    type: 'all',
    children: [
      {
        type: 'not',
        child: {
          type: 'atom',
          atom: { kind: 'experience', value: 'outdoors' },
        },
      },
    ],
  });
  assert.equal(evaluatePlan(event, unknownNot).status, 'unknown');
});

void test('source negatives support absence constraints through natural NOT', () => {
  const value = plan({
    type: 'all',
    children: [
      {
        type: 'not',
        child: { type: 'atom', atom: { kind: 'content', value: 'profanity' } },
      },
    ],
  });
  assert.equal(evaluatePlan(event, value).status, 'supported');
});

void test('conflicting positive and negative text remains unknown under NOT', () => {
  const notJazz = plan({
    type: 'all',
    children: [
      {
        type: 'not',
        child: { type: 'atom', atom: { kind: 'topic', value: 'jazz' } },
      },
    ],
  });
  const notQuiet = plan({
    type: 'all',
    children: [
      {
        type: 'not',
        child: { type: 'atom', atom: { kind: 'experience', value: 'quiet' } },
      },
    ],
  });
  assert.equal(
    evaluatePlan(
      { ...event, title: 'Jazz concert', description: 'Not jazz.' },
      notJazz,
    ).status,
    'unknown',
  );
  assert.equal(
    evaluatePlan(
      { ...event, title: 'Quiet venue', description: 'Loud venue.' },
      notQuiet,
    ).status,
    'unknown',
  );
});

void test('an unrecognized source category remains unknown under NOT', () => {
  const notConcert = plan({
    type: 'all',
    children: [
      {
        type: 'not',
        child: { type: 'atom', atom: { kind: 'category', value: 'concert' } },
      },
    ],
  });
  assert.equal(
    evaluatePlan({ ...event, category: 'Di\u011fer' }, notConcert).status,
    'unknown',
  );
});

void test('group totals require exactly one unconditional party count', () => {
  const budget = {
    type: 'atom' as const,
    atom: {
      kind: 'budget' as const,
      comparison: 'lte' as const,
      amount: 1000,
      currency: 'TRY' as const,
      basis: 'group_total' as const,
    },
  };
  assert.doesNotThrow(() =>
    validateSearchPlan(
      plan({
        type: 'all',
        children: [{ type: 'atom', atom: { kind: 'party', count: 3 } }, budget],
      }),
    ),
  );
  assert.throws(() =>
    validateSearchPlan(plan({ type: 'all', children: [budget] })),
  );
  assert.throws(() =>
    validateSearchPlan(
      plan({
        type: 'all',
        children: [
          {
            type: 'any',
            children: [
              { type: 'atom', atom: { kind: 'party', count: 2 } },
              { type: 'atom', atom: { kind: 'party', count: 4 } },
            ],
          },
          budget,
        ],
      }),
    ),
  );
  const forThree = plan({
    type: 'all',
    children: [{ type: 'atom', atom: { kind: 'party', count: 3 } }, budget],
  });
  const forFour = plan({
    type: 'all',
    children: [{ type: 'atom', atom: { kind: 'party', count: 4 } }, budget],
  });
  const nestedThree = plan({
    type: 'all',
    children: [
      {
        type: 'all',
        children: [{ type: 'atom', atom: { kind: 'party', count: 3 } }],
      },
      budget,
    ],
  });
  assert.equal(evaluatePlan(event, forThree).status, 'supported');
  assert.equal(evaluatePlan(event, forFour).status, 'contradicted');
  assert.equal(evaluatePlan(event, nestedThree).status, 'supported');
});

void test('canonical different districts contradict while unclear district evidence stays unknown', () => {
  const kadikoy = plan({
    type: 'all',
    children: [
      {
        type: 'atom',
        atom: {
          kind: 'location',
          name: 'Kad\u0131k\u00f6y',
          precision: 'district',
        },
      },
    ],
  });
  const fatih = {
    ...event,
    district: 'Fatih',
    address: 'Fatih',
    venue: 'Fatih salonu',
  };
  assert.equal(
    evaluatePlan(fatih, kadikoy, new Date('2026-10-02T09:00:00Z')).status,
    'contradicted',
  );
  assert.equal(
    evaluatePlan(
      { ...fatih, district: 'Avrupa Yakası', address: '' },
      kadikoy,
      new Date('2026-10-02T09:00:00Z'),
    ).status,
    'unknown',
  );
  assert.throws(() =>
    validateSearchPlan(
      plan({
        type: 'all',
        children: [
          {
            type: 'atom',
            atom: { kind: 'location', name: 'Atlantis', precision: 'district' },
          },
        ],
      }),
    ),
  );
});

void test('unsupported optional evidence remains optional', () => {
  const value: Plan = {
    hard: { type: 'all', children: [] },
    preferences: [
      { type: 'atom', atom: { kind: 'experience', value: 'outdoors' } },
    ],
    order: 'none',
  };
  assert.doesNotThrow(() => validateSearchPlan(value));
});

void test('conflicting unconditional party counts are rejected without a budget', () => {
  const value = plan({
    type: 'all',
    children: [
      { type: 'atom', atom: { kind: 'party', count: 2 } },
      {
        type: 'all',
        children: [{ type: 'atom', atom: { kind: 'party', count: 3 } }],
      },
    ],
  });
  assert.throws(
    () => validateSearchPlan(value),
    /conflicting unconditional party counts/,
  );
});
