import assert from 'node:assert/strict';
import test from 'node:test';
import type { Plan } from '../parser/contract.ts';
import { planRetrievalQuery, planSummary } from '../lib/plan-query.ts';

void test('retrieval query contains positive concepts but no negative concepts', () => {
  const plan: Plan = {
    hard: {
      type: 'all',
      children: [
        { type: 'atom', atom: { kind: 'topic', value: 'jazz' } },
        {
          type: 'not',
          child: { type: 'atom', atom: { kind: 'category', value: 'theatre' } },
        },
      ],
    },
    preferences: [],
    order: 'none',
  };
  assert.equal(planRetrievalQuery(plan), 'jazz');
  assert.deepEqual(planSummary(plan).required, [
    'jazz',
    '(DE\u011e\u0130L tiyatro)',
  ]);
});

void test('double negatives restore retrieval polarity and summaries use user-facing comparisons and order', () => {
  const plan: Plan = {
    hard: {
      type: 'all',
      children: [
        {
          type: 'not',
          child: {
            type: 'not',
            child: { type: 'atom', atom: { kind: 'topic', value: 'jazz' } },
          },
        },
        {
          type: 'atom',
          atom: {
            kind: 'budget',
            comparison: 'lte',
            amount: 500,
            currency: 'TRY',
            basis: 'per_person',
          },
        },
      ],
    },
    preferences: [],
    order: 'soonest',
  };
  assert.equal(planRetrievalQuery(plan), 'jazz');
  assert.deepEqual(planSummary(plan), {
    required: [
      '(DE\u011e\u0130L (DE\u011e\u0130L jazz))',
      'ki\u015fi ba\u015f\u0131: 500 TRY veya alt\u0131',
    ],
    preferred: ['en yak\u0131n tarihli olanlar \u00f6nce'],
  });
});
