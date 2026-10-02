import assert from 'node:assert/strict';
import test from 'node:test';
import {
  emptyIntentState,
  intentQuery,
  validateIntentState,
} from '../lib/input-state.ts';

void test('creates independent empty state and validates canonical filters', () => {
  const state = emptyIntentState();
  assert.deepEqual(state, {
    version: 1,
    filters: { dateFrom: null, dateTo: null, maxPrice: null, category: null },
    requirements: [],
    preferences: { mood: null, companion: null, interests: [] },
  });
});

void test('rejects extra client state, filter, requirement and evidence keys', () => {
  const state = emptyIntentState();
  for (const malformed of [
    { ...state, verified: true },
    { ...state, filters: { ...state.filters, arbitrary: true } },
    {
      ...state,
      requirements: [
        { kind: 'genre', value: 'jazz', policy: 'require_support', evidence: [] },
      ],
    },
    { ...state, preferences: { ...state.preferences, inferred: true } },
  ])
    assert.throws(() => validateIntentState(malformed));
});

void test('validates requirement vocabulary, OR syntax, strict variants and child ages', () => {
  const state = validateIntentState({
    ...emptyIntentState(),
    requirements: [
      { kind: 'genre', value: 'jazz|blues', policy: 'require_support' },
      { kind: 'audience', value: 'children', policy: 'require_support' },
      { kind: 'audience', value: 'age:0', policy: 'require_support' },
      { kind: 'audience', value: 'age:17', policy: 'require_support' },
      {
        kind: 'content',
        value: 'swearing|sexual_content',
        policy: 'require_support',
      },
      {
        kind: 'accessibility',
        value: 'step_free|accessible_toilet',
        policy: 'require_support',
      },
    ],
  });
  assert.equal(state.requirements.length, 6);
  for (const value of ['jazz||blues', '|jazz', 'jazz|', 'jazz |blues', 'jazz|jazz'])
    assert.throws(() =>
      validateIntentState({
        ...emptyIntentState(),
        requirements: [{ kind: 'genre', value, policy: 'require_support' }],
      }),
    );
  for (const value of ['age:18', 'age:-1', 'verified_quiet'])
    assert.throws(() =>
      validateIntentState({
        ...emptyIntentState(),
        requirements: [{ kind: 'audience', value, policy: 'require_support' }],
      }),
    );
  assert.throws(() =>
    validateIntentState({
      ...emptyIntentState(),
      requirements: [
        { kind: 'audience', value: 'age:0|age:17', policy: 'require_support' },
      ],
    }),
  );
});

void test('rejects contradictory positive and negative constraints', () => {
  assert.throws(() =>
    validateIntentState({
      ...emptyIntentState(),
      requirements: [
        { kind: 'genre', value: 'jazz|blues', policy: 'require_support' },
        { kind: 'genre', value: 'rock|jazz', policy: 'exclude_positive_evidence' },
      ],
    }),
  );
  assert.throws(() =>
    validateIntentState({
      ...emptyIntentState(),
      filters: {
        ...emptyIntentState().filters,
        category: 'Konser',
        excludedCategories: ['Konser'],
      },
    }),
  );
});

void test('builds a canonical bounded positive query without excluded terms', () => {
  const state = validateIntentState({
    ...emptyIntentState(),
    filters: {
      ...emptyIntentState().filters,
      district: 'Kadıköy',
      category: 'Konser',
      excludedCategories: ['Stand-up'],
    },
    requirements: [
      { kind: 'genre', value: 'blues|rock', policy: 'require_support' },
      { kind: 'genre', value: 'jazz', policy: 'exclude_positive_evidence' },
      { kind: 'content', value: 'swearing', policy: 'exclude_positive_evidence' },
    ],
    preferences: {
      mood: 'calm',
      companion: 'partner',
      interests: ['acoustic music', 'jazz night'],
    },
  });
  const query = intentQuery(state);
  assert.equal(
    query,
    'category:Konser district:Kadıköy genre:blues|rock mood:calm companion:partner interest:acoustic music',
  );
  assert.ok(query.length <= 1200);
  assert.doesNotMatch(query, /jazz|swearing|Stand-up/);
});

void test('rejects malformed preferences and filter bounds', () => {
  const state = emptyIntentState();
  assert.throws(() =>
    validateIntentState({
      ...state,
      preferences: { ...state.preferences, mood: 'quiet' },
    }),
  );
  assert.throws(() =>
    validateIntentState({
      ...state,
      filters: { ...state.filters, dateFrom: '2026-02-30' },
    }),
  );
});

void test('uses a safe generic query and never favors content that must be absent', () => {
  assert.equal(intentQuery(emptyIntentState()), 'Istanbul events');
  const state = emptyIntentState();
  state.requirements = [
    {
      kind: 'content',
      value: 'swearing|sexual_content',
      policy: 'require_support',
    },
  ];
  assert.equal(intentQuery(state), 'Istanbul events');
});

void test('rejects activity pipes that the evidence checker cannot safely compose', () => {
  assert.throws(() =>
    validateIntentState({
      ...emptyIntentState(),
      requirements: [
        {
          kind: 'activity',
          value: 'alcohol_free|quiet',
          policy: 'require_support',
        },
      ],
    }),
  );
  const state = emptyIntentState();
  state.requirements = [
    { kind: 'activity', value: 'alcohol_free', policy: 'require_support' },
    { kind: 'activity', value: 'quiet', policy: 'require_support' },
  ];
  assert.equal(validateIntentState(state).requirements.length, 2);
});

void test('rejects reversed and exclusively empty time windows', () => {
  for (const filters of [
    { startTimeFrom: '22:00', startTimeTo: '18:00' },
    {
      startTimeFrom: '18:00',
      startTimeTo: '18:00',
      startTimeFromExclusive: true,
    },
    {
      startTimeFrom: '18:00',
      startTimeTo: '18:00',
      startTimeToExclusive: true,
    },
  ])
    assert.throws(() =>
      validateIntentState({
        ...emptyIntentState(),
        filters: { ...emptyIntentState().filters, ...filters },
      }),
    );

  const exactMinute = emptyIntentState({
    ...emptyIntentState().filters,
    startTimeFrom: '18:00',
    startTimeTo: '18:00',
  });
  assert.equal(exactMinute.filters.startTimeFrom, '18:00');
});

void test('validates the closed soonest order preference', () => {
  const state = emptyIntentState();
  state.preferences.order = 'soonest';
  assert.equal(validateIntentState(state).preferences.order, 'soonest');
  assert.throws(() => validateIntentState({
    ...state,
    preferences: { ...state.preferences, order: 'latest' },
  }));
});

void test('accepts old v1 state and validates bounded required primary topics', () => {
  const legacy = emptyIntentState();
  assert.equal(validateIntentState(legacy).primaryTopics, undefined);
  const current = validateIntentState({ ...legacy, primaryTopics: ['fotoğraf', 'seramik veya çini'] });
  assert.deepEqual(current.primaryTopics, ['fotoğraf', 'seramik veya çini']);
  assert.throws(() => validateIntentState({ ...legacy, primaryTopics: Array(9).fill('x') }));
});
