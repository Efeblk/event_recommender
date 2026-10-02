import assert from 'node:assert/strict';
import test from 'node:test';
import type { Atom, Condition, ParserInput, Plan, PreviousState } from '../parser/contract.ts';
import type { JevResponse, Question } from '../parser/jev.ts';
import { buildRequest, compose, parse } from '../parser/parse.ts';

const input = (utterance: string, previousState: PreviousState | null = null): ParserInput => ({
  utterance,
  language: 'en',
  referenceDate: '2026-10-01',
  timezone: 'Europe/Istanbul',
  previousState,
});

const atom = (value: Atom): Condition => ({ type: 'atom', atom: value });
const plan = (hard: Condition[], preferences: Condition[] = []): Plan => ({ hard: { type: 'all', children: hard }, preferences, order: 'none' });
const category = (value: 'concert' | 'theatre' | 'workshop'): Condition => atom({ kind: 'category', value });

function responseFor(built: ReturnType<typeof buildRequest>, overrides: Record<string, string> = {}): JevResponse {
  for (const id of Object.keys(overrides)) assert.ok(built.questions[id], `override refers to missing question ${id}`);
  const answers: JevResponse['answers'] = {};
  for (const [id, question] of Object.entries(built.questions) as Array<[string, Question]>) {
    if (question.type === 'noul') {
      answers[id] = { type: 'noul', noul: 0 };
      continue;
    }
    const options = Object.keys(question.criteria);
    const selected = overrides[id]
      ?? (id.startsWith('polarity_') ? 'wanted'
        : id.startsWith('link_') ? 'and'
        : id.startsWith('edit_') ? 'unchanged'
        : id.startsWith('hedge_') ? 'none'
        : id === 'action' ? 'continue'
        : id === 'order' ? 'unchanged'
        : options[0]);
    assert.ok(options.includes(selected), `${id} does not offer ${selected}; options: ${options.join(', ')}`);
    answers[id] = {
      type: 'choice',
      choice: selected,
      confidence: 1,
      probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 1 : 0])),
    };
  }
  return { model: 'synthetic-offline-test', answers, usage: { input_tokens: 0, output_tokens: 0 } };
}

function parseWithAnswers(request: ParserInput, overrides: Record<string, string> = {}) {
  const built = buildRequest(request);
  const result = compose(request, built, responseFor(built, overrides));
  return { built, result };
}

function withoutIds(condition: Condition): Condition {
  if (condition.type === 'atom') return { type: 'atom', atom: condition.atom };
  if (condition.type === 'not') return { type: 'not', child: withoutIds(condition.child) };
  return { type: condition.type, children: condition.children.map(withoutIds) };
}

function semanticPlan(actual: Plan): Plan {
  assert.equal(actual.hard.type, 'all');
  return {
    hard: { type: 'all', children: actual.hard.children.map(withoutIds) },
    preferences: actual.preferences.map(withoutIds),
    order: actual.order,
  };
}

void test('cross-kind alternatives compose as one OR condition', () => {
  const { built, result } = parseWithAnswers(input('Either theatre or outdoors'), { link_m0_m1: 'or' });
  assert.ok(built.questions.link_m0_m1, 'cross-kind coordination must ask an explicit linkage question');
  assert.equal(result.status, 'accepted');
  assert.deepEqual(semanticPlan(result.resultingPlan), plan([
    { type: 'any', children: [category('theatre'), atom({ kind: 'experience', value: 'outdoors' })] },
  ]));
});

void test('time conjunction intersects bounds while disjunction preserves separate alternatives', () => {
  const bounded = parseWithAnswers(input('concert after 18:00 and before 21:00'), {
    clock_m1: 'after',
    clock_m2: 'before',
    link_m1_m2: 'and',
  });
  assert.ok(bounded.built.questions.link_m1_m2, 'time coordination must ask an explicit linkage question');
  assert.equal(bounded.result.status, 'accepted');
  assert.deepEqual(semanticPlan(bounded.result.resultingPlan), plan([
    atom({ kind: 'time', from: '18:00', to: '21:00', fromExclusive: true, toExclusive: true }),
    category('concert'),
  ]));

  const alternatives = parseWithAnswers(input('concert before 18:00 or after 21:00'), {
    clock_m1: 'before',
    clock_m2: 'after',
    link_m1_m2: 'or',
  });
  assert.equal(alternatives.result.status, 'accepted');
  assert.deepEqual(semanticPlan(alternatives.result.resultingPlan), plan([
    { type: 'any', children: [
      atom({ kind: 'time', to: '18:00', toExclusive: true }),
      atom({ kind: 'time', from: '21:00', fromExclusive: true }),
    ] },
    category('concert'),
  ]));
});

void test('an excluded exact clock remains a negated exact-time condition', () => {
  const { result } = parseWithAnswers(input('concert, not at 20:00'), {
    polarity_m1: 'unwanted',
    clock_m1: 'at',
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(semanticPlan(result.resultingPlan), plan([
    { type: 'not', child: atom({ kind: 'time', from: '20:00', to: '20:00' }) },
    category('concert'),
  ]));
});

void test('the winning hedge scope does not demote an unrelated required date', () => {
  const request = input('Saturday, jazz would be nice');
  const built = buildRequest(request);
  const response = responseFor(built, { hedge_0: 'run0' });
  const hedge = response.answers.hedge_0;
  assert.equal(hedge.type, 'choice');
  hedge.probabilities = { run0: 0.69, run1: 0.31, none: 0 };
  hedge.confidence = 0.69;
  const result = compose(request, built, response);
  assert.equal(result.status, 'accepted');
  assert.deepEqual(semanticPlan(result.resultingPlan), plan([
    atom({ kind: 'date', from: '2026-10-03', to: '2026-10-03' }),
  ], [atom({ kind: 'topic', value: 'jazz' })]));
});

void test('a same-amount correction can change a per-person budget to group total', () => {
  const previousState: PreviousState = {
    revision: 1,
    evidence: [],
    plan: plan([{ ...atom({ kind: 'budget', comparison: 'lt', amount: 500, currency: 'TRY', basis: 'per_person' }), id: 'h0' }]),
  };
  const { result } = parseWithAnswers(input('Change 500 TL per person to 500 TL total', previousState), {
    edit_h0: 'replace',
    polarity_m0: 'old_value',
    polarity_m1: 'wanted',
    basis_m0: 'per_person',
    basis_m1: 'group_total',
    cmp_m1: 'unchanged',
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.operations, [{
    op: 'replace',
    targetId: 'h0',
    condition: atom({ kind: 'budget', comparison: 'lt', amount: 500, currency: 'TRY', basis: 'group_total' }),
  }]);

  const explicitComparison = parseWithAnswers(input('Change 500 TL per person to at most 500 TL total', previousState), {
    edit_h0: 'replace',
    polarity_m0: 'old_value',
    polarity_m1: 'wanted',
    basis_m0: 'per_person',
    basis_m1: 'group_total',
    cmp_m1: 'lte',
  }).result;
  assert.equal(explicitComparison.status, 'accepted');
  assert.deepEqual(explicitComparison.operations, [{
    op: 'replace',
    targetId: 'h0',
    condition: atom({ kind: 'budget', comparison: 'lte', amount: 500, currency: 'TRY', basis: 'group_total' }),
  }]);
});

void test('a basis-only correction updates an existing budget without repeating its amount', () => {
  const previousState: PreviousState = {
    revision: 1,
    evidence: [],
    plan: plan([{ ...atom({ kind: 'budget', comparison: 'lte', amount: 500, currency: 'TRY', basis: 'per_person' }), id: 'h0' }]),
  };
  const { built, result } = parseWithAnswers(input('Make that the group total', previousState), {
    edit_h0: 'replace',
    basis_edit_h0: 'group_total',
  });
  assert.ok(built.questions.basis_edit_h0, 'an existing budget needs an explicit basis-edit judgment');
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.operations, [{
    op: 'replace',
    targetId: 'h0',
    condition: atom({ kind: 'budget', comparison: 'lte', amount: 500, currency: 'TRY', basis: 'group_total' }),
  }]);
});

void test('replacing a category alternative group with workshop replaces the whole group', () => {
  const previousState: PreviousState = {
    revision: 1,
    evidence: [],
    plan: plan([{
      type: 'any',
      id: 'h0',
      children: [category('concert'), category('theatre')],
    }]),
  };
  const { result } = parseWithAnswers(input('Replace concert or theatre with workshop', previousState), {
    edit_h0: 'replace',
    polarity_m0: 'old_value',
    polarity_m1: 'old_value',
    polarity_m2: 'wanted',
    link_m0_m1: 'or',
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.operations, [{ op: 'replace', targetId: 'h0', condition: category('workshop') }]);
});

void test('editing one member of a compound condition retains its date sibling', () => {
  const previousState: PreviousState = {
    revision: 1,
    evidence: [],
    plan: plan([{
      type: 'all',
      id: 'h0',
      children: [
        atom({ kind: 'location', name: 'Kadıköy', precision: 'district' }),
        atom({ kind: 'date', from: '2026-10-03', to: '2026-10-03' }),
      ],
    }]),
  };
  const { result } = parseWithAnswers(input('Change the location to Fatih', previousState), { edit_h0: 'replace' });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(semanticPlan(result.resultingPlan), plan([{
    type: 'all',
    children: [
      atom({ kind: 'location', name: 'Fatih', precision: 'district' }),
      atom({ kind: 'date', from: '2026-10-03', to: '2026-10-03' }),
    ],
  }]));
});

void test('removing a named member of a compound condition retains its date sibling', () => {
  const previousState: PreviousState = {
    revision: 1,
    evidence: [],
    plan: plan([{
      type: 'all',
      id: 'h0',
      children: [
        atom({ kind: 'location', name: 'Fatih', precision: 'district' }),
        atom({ kind: 'date', from: '2026-10-03', to: '2026-10-03' }),
      ],
    }]),
  };
  const { result } = parseWithAnswers(input('Remove Fatih', previousState), {
    edit_h0: 'remove',
    polarity_m0: 'old_value',
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.operations, [{
    op: 'replace',
    targetId: 'h0',
    condition: atom({ kind: 'date', from: '2026-10-03', to: '2026-10-03' }),
  }]);
});

void test('relative attendee changes survive the composition dry run', () => {
  const previousState: PreviousState = {
    revision: 1,
    evidence: [],
    plan: plan([{ ...atom({ kind: 'party', count: 3 }), id: 'h0' }]),
  };
  const { result } = parseWithAnswers(input('One more person is joining', previousState), {
    edit_h0: 'replace',
    delta_m0: 'more',
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.operations, [{
    op: 'replace',
    targetId: 'h0',
    condition: atom({ kind: 'party', count: 4 }),
  }]);
});

void test('missing or malformed required judgments are refused', () => {
  const request = input('concert');
  const built = buildRequest(request);
  const missing = compose(request, built, { model: 'missing-test', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } });
  assert.equal(missing.status, 'unsupported');

  const malformed = responseFor(built);
  malformed.answers.polarity_m0 = { type: 'choice', choice: 'wanted', confidence: 1, probabilities: { wanted: 0.4 } };
  assert.equal(compose(request, built, malformed).status, 'unsupported');
});

void test('an otherwise plausible answer with an incomplete probability map is refused', () => {
  const request = input('concert');
  const built = buildRequest(request);
  const response = responseFor(built);
  const polarity = response.answers.polarity_m0;
  assert.equal(polarity.type, 'choice');
  polarity.probabilities = { wanted: 1 };
  assert.equal(compose(request, built, response).status, 'unsupported');
});

void test('compose refuses an invalid calendar date without normalizing it', () => {
  const request = input('concert on 2027-02-30');
  const built = buildRequest(request);
  assert.deepEqual(built.invalidSpans, [{ start: 11, end: 21, text: '2027-02-30', reason: 'invalid_date' }]);
  const result = compose(request, built, { model: 'unused', answers: {}, usage: { input_tokens: 0, output_tokens: 0 } });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.reason, 'invalid calendar date');
  assert.deepEqual(result.unresolvedSpans, [{ start: 11, end: 21, text: '2027-02-30', reason: 'invalid_date' }]);
});

void test('parse refuses an invalid calendar date before any provider call', async () => {
  const originalFetch = globalThis.fetch;
  let fetchAttempts = 0;
  globalThis.fetch = (async () => {
    fetchAttempts++;
    throw new Error('invalid dates must be rejected before provider calls');
  }) as typeof fetch;
  try {
    const result = await parse(input('concert on 2027-02-30'));
    assert.equal(result.status, 'unsupported');
    assert.equal(result.reason, 'invalid calendar date');
    assert.deepEqual(result.unresolvedSpans, [{ start: 11, end: 21, text: '2027-02-30', reason: 'invalid_date' }]);
    assert.equal(fetchAttempts, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test('negated inverse experiences assert their canonical positive requirement', () => {
  for (const [utterance, value] of [
    ['kalabalık olmasın', 'uncrowded'],
    ['gürültülü olmasın', 'quiet'],
    ['ayakta olmasın', 'seated'],
  ] as const) {
    const { result } = parseWithAnswers(input(utterance), { polarity_m0: 'unwanted' });
    assert.equal(result.status, 'accepted', utterance);
    assert.deepEqual(semanticPlan(result.resultingPlan), plan([atom({ kind: 'experience', value })]), utterance);
  }
});

void test('olabilir keeps workshop optional in the original Turkish request', () => {
  const request = input('kişi başı maks 2000tl olan kız arkadaşımla gideceğim etkinlik konser veya tiyatro olmasın, workshop olabilir, en yakın tarih');
  const built = buildRequest(request);
  const workshop = built.mentions.find((mention) => mention.kind === 'category' && mention.value === 'workshop');
  assert.ok(workshop);
  const result = compose(request, built, responseFor(built, {
    polarity_m0: 'wanted',
    basis_m0: 'per_person',
    cmp_m0: 'lte',
    polarity_m1: 'wanted',
    polarity_m2: 'unwanted',
    polarity_m3: 'unwanted',
    polarity_m4: 'wanted',
    link_m2_m3: 'or',
    order: 'soonest',
    [`hedge_0`]: 'run0',
  }));
  assert.equal(result.status, 'accepted');
  const semantic = semanticPlan(result.resultingPlan);
  assert.equal(semantic.hard.type, 'all');
  assert.ok(semantic.preferences.some((condition) => condition.type === 'atom'
    && condition.atom.kind === 'category' && condition.atom.value === 'workshop'));
  assert.ok(!semantic.hard.children.some((condition) => JSON.stringify(condition).includes('workshop')));
});

void test('replacing an exact clock preserves its upper and lower bounds', () => {
  const previousState: PreviousState = {
    revision: 1, evidence: [],
    plan: plan([{ ...atom({ kind: 'time', from: '20:00', to: '20:00' }), id: 'h0' }]),
  };
  const { result } = parseWithAnswers(input('Change the time to 21:00', previousState), {
    edit_h0: 'replace', clock_m0: 'at',
  });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(result.operations, [{ op: 'replace', targetId: 'h0', condition: atom({ kind: 'time', from: '21:00', to: '21:00' }) }]);
});
