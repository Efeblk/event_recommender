import assert from 'node:assert/strict';
import test from 'node:test';
import type { Condition, ParserInput, Plan, PreviousState } from '../parser/contract.ts';
import { buildFieldRequest, composeFields, numberCandidates } from '../parser/fields.ts';
import { semanticPlan } from '../parser/semantics.ts';
import { fieldAnswers } from './field-answers.ts';

// 2026-10-06 is a Tuesday.
const input = (utterance: string, previousState: PreviousState | null = null): ParserInput =>
  ({ utterance, language: 'tr', referenceDate: '2026-10-06', timezone: 'Europe/Istanbul', previousState });
const read = (utterance: string, picks: Record<string, string | number>, previousState: PreviousState | null = null) => {
  const built = buildFieldRequest(input(utterance, previousState));
  const resolved = Object.fromEntries(Object.entries(picks).map(([id, value]) =>
    [id, typeof value === 'string' && value.startsWith('#') ? `n${built.numbers.findIndex((n) => n.text === value.slice(1))}` : value]));
  return composeFields(input(utterance, previousState), built, fieldAnswers(built.questions, resolved));
};
const atom = (a: object): Condition => ({ type: 'atom', atom: a } as Condition);
const plan = (hard: Condition[], preferences: Condition[] = [], order: Plan['order'] = 'none'): unknown =>
  semanticPlan({ hard: { type: 'all', children: hard }, preferences, order });
const accepted = (result: ReturnType<typeof read>) => {
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  return result.status === 'accepted' ? semanticPlan(result.resultingPlan) : null;
};

void test('reads a relative day count, a neighbourhood and a companion from the whole message', () => {
  const result = read('iki gün sonra taksim civarı sevgilimle gidebileceğim etkinlik', {
    date: 'days_later', date_count: '2', place: 'in', district: 'Beyoğlu', neighborhood: 'Taksim', companion_partner: 'yes',
  });
  assert.deepEqual(accepted(result), plan([
    atom({ kind: 'date', from: '2026-10-08', to: '2026-10-08' }),
    atom({ kind: 'location', name: 'Beyoğlu', precision: 'district' }),
    atom({ kind: 'companion', value: 'partner' }),
  ], [atom({ kind: 'location', name: 'Taksim', precision: 'neighborhood' })]));
});

void test('an excluded event type and a party size stay hard conditions', () => {
  const result = read('yarın iki kişilik sevgilimle taksim civarı konser olmayan etkinlik', {
    date: 'tomorrow', place: 'in', district: 'Beyoğlu', neighborhood: 'Taksim', party: 'total', party_count: '2',
    companion_partner: 'yes', category_concert: 'exclude',
  });
  assert.deepEqual(accepted(result), plan([
    atom({ kind: 'date', from: '2026-10-07', to: '2026-10-07' }),
    atom({ kind: 'location', name: 'Beyoğlu', precision: 'district' }),
    atom({ kind: 'party', count: 2 }),
    atom({ kind: 'companion', value: 'partner' }),
    { type: 'not', child: atom({ kind: 'category', value: 'concert' }) },
  ], [atom({ kind: 'location', name: 'Taksim', precision: 'neighborhood' })]));
});

void test('a stated field that cannot be resolved asks instead of searching without it', () => {
  const missingCount = read('birkaç gün sonra konser', { date: 'days_later', date_count: 'none', category_concert: 'want' });
  assert.equal(missingCount.status === 'unsupported' && missingCount.reason, 'unreadable date');
  const impossible = read('30 şubatta konser', { date: 'calendar_date', date_day: '30', date_month: 'February' });
  assert.equal(impossible.status === 'unsupported' && impossible.reason, 'unreadable date');
  const impossibleRange = read('1-31 Kasım', { date: 'calendar_range', date_day: '1', date_month: 'November', date_day_end: '31' });
  assert.equal(impossibleRange.status === 'unsupported' && impossibleRange.reason, 'unreadable date');
  const otherDate = read('bayramda konser', { date: 'other' });
  assert.equal(otherDate.status === 'unsupported' && otherDate.reason, 'unreadable date');
  const place = read('o meşhur yerde konser', { place: 'unknown' });
  assert.equal(place.status === 'unsupported' && place.reason, 'unreadable place');
  const amount = read('ucuz olsun, bütçe belli', { budget: 'max' });
  assert.equal(amount.status === 'unsupported' && amount.reason, 'unreadable budget');
});

void test('a confident directly named neighbourhood repairs an unknown place judgment only', () => {
  const interpret = (utterance: string, neighborhoodProbability: number, excluded: Record<string, string> = {}) => {
    const parserInput = input(utterance);
    const built = buildFieldRequest(parserInput);
    const response = fieldAnswers(built.questions, {
      place: 'unknown',
      district: 'none',
      neighborhood: 'Harbiye',
      category_concert: 'want',
      ...excluded,
    });
    const place = response.answers.place;
    const neighborhood = response.answers.neighborhood;
    assert.equal(place.type, 'choice');
    assert.equal(neighborhood.type, 'choice');
    if (place.type === 'choice') {
      place.confidence = 0.41;
      place.probabilities = { in: 0.34, either: 0, unknown: 0.41, none: 0.25 };
    }
    if (neighborhood.type === 'choice') {
      neighborhood.confidence = neighborhoodProbability;
      neighborhood.probabilities = {
        ...neighborhood.probabilities,
        Harbiye: neighborhoodProbability,
        none: 1 - neighborhoodProbability,
      };
    }
    return composeFields(parserInput, built, response);
  };

  assert.deepEqual(
    accepted(interpret('harbiyede konser', 0.94)),
    plan(
      [
        atom({ kind: 'location', name: 'Şişli', precision: 'district' }),
        atom({ kind: 'category', value: 'concert' }),
      ],
      [atom({ kind: 'location', name: 'Harbiye', precision: 'neighborhood' })],
    ),
  );
  for (const result of [
    interpret('o meşhur yerde konser', 0.94),
    interpret('harbiyede konser', 0.79),
    interpret('harbiye olmasin, konser', 0.94, { excluded_neighborhood: 'Harbiye' }),
    interpret('harbiye olmasin, konser', 0.94, { excluded_district: '\u015ei\u015fli' }),
  ])
    assert.equal(result.status === 'unsupported' && result.reason, 'unreadable place');
});

void test('past dates, other cities and unsupported conditions are refused', () => {
  const past = read('dün akşam konser', { date: 'past' });
  assert.equal(past.status === 'unsupported' && past.reason, 'past date');
  const city = read('ankarada tiyatro', { outside_istanbul: 1 });
  assert.equal(city.status === 'unsupported' && city.reason, 'unsupported outside_location');
  const parking = read('otoparkı olan bir mekanda konser', { unsupported: 'unsupported' });
  assert.equal(parking.status === 'unsupported' && parking.reason, 'condition outside supported vocabulary');
});

void test('calendar math: weekdays, weekends, ranges, months and days of this month', () => {
  const date = (picks: Record<string, string>) => {
    const result = read('x', picks);
    return result.status === 'accepted' ? (result.resultingPlan.hard.type === 'all' ? result.resultingPlan.hard.children : [])[0] : result;
  };
  assert.deepEqual(date({ date: 'weekday', date_weekday: 'Saturday' }), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-10', to: '2026-10-10' } });
  assert.deepEqual(date({ date: 'weekday', date_weekday: 'Tuesday' }), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-06', to: '2026-10-06' } });
  assert.deepEqual(date({ date: 'weekday', date_weekday: 'Saturday', date_week: 'following_week' }), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-17', to: '2026-10-17' } });
  assert.deepEqual(date({ date: 'weekday', date_weekday: 'Monday', date_week: 'following_week' }), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-12', to: '2026-10-12' } });
  assert.deepEqual(date({ date: 'weekend' }), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-10', to: '2026-10-11' } });
  assert.deepEqual(date({ date: 'within_days', date_count: '3' }), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-06', to: '2026-10-09' } });
  assert.deepEqual(date({ date: 'next_week' }), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-12', to: '2026-10-18' } });
  assert.deepEqual(date({ date: 'calendar_range', date_day: '30', date_month: 'October', date_day_end: '2', date_month_end: 'November' }),
    { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-30', to: '2026-11-02' } });
  assert.deepEqual(date({ date: 'month', date_month: 'October', date_month_part: 'end' }), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-21', to: '2026-10-31' } });
  assert.deepEqual(date({ date: 'calendar_date', date_day: '20' }), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-20', to: '2026-10-20' } });
  assert.deepEqual(date({ date: 'calendar_date', date_day: '3' }), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-11-03', to: '2026-11-03' } });
  assert.deepEqual(date({ date: 'tomorrow', date_alt: 'day_after_tomorrow' }), { type: 'any', id: 'h0', children: [
    { type: 'atom', atom: { kind: 'date', from: '2026-10-07', to: '2026-10-07' } },
    { type: 'atom', atom: { kind: 'date', from: '2026-10-08', to: '2026-10-08' } },
  ] });
});

void test('this weekend keeps the full Saturday to Sunday interval on Sunday', () => {
  const parserInput: ParserInput = {
    ...input('hafta sonu'),
    referenceDate: '2026-10-04',
  };
  const date = (week: string) => {
    const built = buildFieldRequest(parserInput);
    const result = composeFields(parserInput, built, fieldAnswers(built.questions, { date: 'weekend', date_week: week }));
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    return result.status === 'accepted' && result.resultingPlan.hard.type === 'all'
      ? result.resultingPlan.hard.children[0]
      : null;
  };

  assert.deepEqual(date('this'), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-03', to: '2026-10-04' } });
  assert.deepEqual(date('following_week'), { type: 'atom', id: 'h0', atom: { kind: 'date', from: '2026-10-10', to: '2026-10-11' } });
});

void test('explicit years and arbitrary clock minutes are preserved', () => {
  const future = read('20 October 2027 at 19:10', {
    date: 'calendar_date', date_day: '20', date_month: 'October', date_year: '#2027',
    time: 'at', time_hour: '19', time_minute: '10',
  });
  assert.deepEqual(accepted(future), plan([
    atom({ kind: 'date', from: '2027-10-20', to: '2027-10-20' }),
    atom({ kind: 'time', from: '19:10', to: '19:10' }),
  ]));
  const past = read('20 October 2025', {
    date: 'calendar_date', date_day: '20', date_month: 'October', date_year: '#2025',
  });
  assert.equal(past.status === 'unsupported' && past.reason, 'past date');
  const month = read('October 2027', {
    date: 'month', date_month: 'October', date_month_part: 'whole', date_year: '#2027',
  });
  assert.deepEqual(accepted(month), plan([
    atom({ kind: 'date', from: '2027-10-01', to: '2027-10-31' }),
  ]));
});

void test('"next Saturday" early in the week offers both Saturdays', () => {
  const result = read('gelecek cumartesi konser', { date: 'weekday', date_weekday: 'Saturday', date_week: 'next' });
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.status === 'ambiguous' && result.alternatives.map((a) => JSON.stringify(a.resultingPlan.hard)),
    ['2026-10-10', '2026-10-17'].map((d) => JSON.stringify({ type: 'all', children: [{ type: 'atom', atom: { kind: 'date', from: d, to: d }, id: 'h0' }] })));
});

void test('a ruled-out neighbourhood excludes only itself, next to a wanted district', () => {
  const result = read("Kadıköy'de olsun, Taksim'de olmasın", { place: 'in', district: 'Kadıköy', excluded_neighborhood: 'Taksim' });
  assert.deepEqual(accepted(result), plan([
    atom({ kind: 'location', name: 'Kadıköy', precision: 'district' }),
    { type: 'not', child: atom({ kind: 'location', name: 'Taksim', precision: 'neighborhood' }) },
  ]));
});

void test('a bare price is a ticket price; with a group and no basis it asks', () => {
  const ticket = read('en fazla 700 TL', { budget: 'max', budget_amount: '#700', budget_basis: 'unstated' });
  assert.deepEqual(accepted(ticket), plan([atom({ kind: 'budget', comparison: 'lte', amount: 700, currency: 'TRY', basis: 'per_ticket' })]));
  const group = read('sevgilimle en fazla 700 TL', { budget: 'max', budget_amount: '#700', budget_basis: 'unstated', companion_partner: 'yes' });
  assert.equal(group.status, 'ambiguous');
  const range = read('300-600 tl arası', { budget: 'between', budget_amount: '#300', budget_amount_2: '#600', budget_basis: 'per_ticket' });
  assert.deepEqual(accepted(range), plan([
    atom({ kind: 'budget', comparison: 'gte', amount: 300, currency: 'TRY', basis: 'per_ticket' }),
    atom({ kind: 'budget', comparison: 'lte', amount: 600, currency: 'TRY', basis: 'per_ticket' }),
  ]));
  const free = read('ücretsiz sergi', { budget: 'free', category_exhibition: 'want' });
  assert.deepEqual(accepted(free), plan([
    atom({ kind: 'category', value: 'exhibition' }),
    atom({ kind: 'budget', comparison: 'lte', amount: 0, currency: 'TRY', basis: 'per_person' }),
  ]));
});

void test('wanted event types are alternatives; a generic show yields to a named type', () => {
  const result = read('tiyatro ya da stand-up, gösteri olabilir', { category_theatre: 'want', category_standup: 'want', category_show: 'want' });
  assert.deepEqual(accepted(result), plan([{ type: 'any', children: [atom({ kind: 'category', value: 'theatre' }), atom({ kind: 'category', value: 'standup' })] }]));
});

void test('event-type judgments bind negation to the named local clause', () => {
  const scoped = read('tiyatro veya stand-up, konser olmasın', {
    category_theatre: 'want',
    category_standup: 'want',
    category_concert: 'exclude',
  });
  assert.deepEqual(accepted(scoped), plan([
    {
      type: 'any',
      children: [
        atom({ kind: 'category', value: 'theatre' }),
        atom({ kind: 'category', value: 'standup' }),
      ],
    },
    { type: 'not', child: atom({ kind: 'category', value: 'concert' }) },
  ]));

  const shared = read('tiyatro veya stand-up olmasın', {
    category_theatre: 'exclude',
    category_standup: 'exclude',
  });
  assert.deepEqual(accepted(shared), plan([
    {
      type: 'not',
      child: {
        type: 'any',
        children: [
          atom({ kind: 'category', value: 'theatre' }),
          atom({ kind: 'category', value: 'standup' }),
        ],
      },
    },
  ]));

  const varied = read('workshop or exhibition; no festivals', {
    category_workshop: 'want',
    category_exhibition: 'want',
    category_festival: 'exclude',
  });
  assert.deepEqual(accepted(varied), plan([
    {
      type: 'any',
      children: [
        atom({ kind: 'category', value: 'workshop' }),
        atom({ kind: 'category', value: 'exhibition' }),
      ],
    },
    { type: 'not', child: atom({ kind: 'category', value: 'festival' }) },
  ]));

  const question = buildFieldRequest(input('tiyatro veya stand-up, konser olmasın'))
    .questions.category_theatre;
  assert.equal(question.type, 'choice');
  if (question.type === 'choice') {
    assert.match(String(question.instructions), /local clause or coordinated phrase/);
    assert.match(String(question.criteria.exclude), /separate clause.*different item/);
  }
});

void test('topic roles stay independent and dancing keeps exclusion polarity', () => {
  const mixed = read('jazz olsun ama rock olmasın', {
    topic: 'jazz', topic_role: 'want', topic_2: 'rock', topic_role_2: 'exclude',
  });
  assert.deepEqual(accepted(mixed), plan([
    atom({ kind: 'topic', value: 'jazz' }),
    { type: 'not', child: atom({ kind: 'topic', value: 'rock' }) },
  ]));
  const actualContrast = read('rock olsun ama rap olmasın', {
    topic: 'rock', topic_role: 'want', topic_2: 'rap', topic_role_2: 'exclude',
  });
  assert.deepEqual(accepted(actualContrast), plan([
    atom({ kind: 'topic', value: 'rock' }),
    { type: 'not', child: atom({ kind: 'topic', value: 'rap' }) },
  ]));
  const sharedNegation = read('rock veya rap olmasın', {
    topic: 'rock', topic_role: 'exclude', topic_2: 'rap', topic_role_2: 'exclude',
  });
  assert.deepEqual(accepted(sharedNegation), plan([
    {
      type: 'not',
      child: {
        type: 'any',
        children: [
          atom({ kind: 'topic', value: 'rock' }),
          atom({ kind: 'topic', value: 'rap' }),
        ],
      },
    },
  ]));
  const topicQuestions = buildFieldRequest(input('rock olsun ama rap olmasın')).questions;
  for (const id of ['topic_role', 'topic_role_2'] as const) {
    const question = topicQuestions[id];
    assert.equal(question.type, 'choice');
    if (question.type === 'choice') {
      assert.match(String(question.instructions), /local clause or coordinated phrase/);
      assert.match(String(question.criteria.exclude), /separate clause/);
    }
  }
  const both = read('hem jazz hem blues', {
    topic: 'jazz', topic_role: 'want', topic_2: 'blues', topic_role_2: 'want', topics_both: 1,
  });
  assert.deepEqual(accepted(both), plan([
    atom({ kind: 'topic', value: 'jazz' }),
    atom({ kind: 'topic', value: 'blues' }),
  ]));
  const noDancing = read('dans etmek istemiyorum', { category_dance: 'exclude', dance_activity: 1 });
  assert.deepEqual(accepted(noDancing), plan([
    { type: 'not', child: atom({ kind: 'topic', value: 'dancing' }) },
  ]));
});

void test('every separately named attendee age becomes a hard condition', () => {
  const result = read('6 ve 12 yaşındaki çocuklarla, bütçe 1000 TL', {
    age_0: 1, age_1: 1, companion_children: 'yes', budget: 'max', budget_amount: '#1000', budget_basis: 'per_person',
  });
  assert.deepEqual(accepted(result), plan([
    atom({ kind: 'age', years: 6 }),
    atom({ kind: 'age', years: 12 }),
    atom({ kind: 'companion', value: 'children' }),
    atom({ kind: 'budget', comparison: 'lte', amount: 1000, currency: 'TRY', basis: 'per_person' }),
  ]));
});

void test('the bounded field request stays below the transport limit', () => {
  const utterance = `${Array.from({ length: 24 }, (_, index) => index + 1).join(' ')} ${'x'.repeat(1125)}`;
  const built = buildFieldRequest(input(utterance));
  const bytes = new TextEncoder().encode(JSON.stringify({ model: 'jev-test', state: built.state, questions: built.questions })).byteLength;
  assert.ok(bytes <= 100_000, String(bytes));
});

const previous = (hard: Condition[], preferences: Condition[] = []): PreviousState => ({
  revision: 1, evidence: [],
  plan: { hard: { type: 'all', children: hard.map((c, i) => ({ ...c, id: `h${i}` })) }, preferences: preferences.map((c, i) => ({ ...c, id: `p${i}` })), order: 'none' },
});

void test('follow-ups change only the fields they address', () => {
  const prev = previous([atom({ kind: 'category', value: 'concert' }), atom({ kind: 'date', from: '2026-10-10', to: '2026-10-10' })]);
  const removed = read('konser koşulunu kaldır', { category_concert: 'removed' }, prev);
  assert.deepEqual(accepted(removed), plan([atom({ kind: 'date', from: '2026-10-10', to: '2026-10-10' })]));
  const moved = read('pazar olsun', { date: 'weekday', date_weekday: 'Sunday' }, prev);
  assert.deepEqual(accepted(moved), plan([atom({ kind: 'date', from: '2026-10-11', to: '2026-10-11' }), atom({ kind: 'category', value: 'concert' })]));
  const reset = read('hepsini unut, tiyatro', { reset: 'reset', category_theatre: 'want' }, prev);
  assert.deepEqual(accepted(reset), plan([atom({ kind: 'category', value: 'theatre' })]));
  const fewer = read('bir kişi gelemiyor', { party: 'fewer', party_count: '1' }, previous([atom({ kind: 'party', count: 4 })]));
  assert.deepEqual(accepted(fewer), plan([atom({ kind: 'party', count: 3 })]));
});

void test('a vague reference acts on one condition and branches when several fit', () => {
  const prev = previous([atom({ kind: 'location', name: 'Kadıköy', precision: 'district' }), atom({ kind: 'category', value: 'concert' })]);
  const both = read('bunu kaldır', { vague: 1, refers_0: 0.8, refers_1: 0.75, vague_action: 'remove' }, prev);
  assert.equal(both.status, 'ambiguous');
  const one = read('o semti kaldır', { vague: 1, refers_0: 0.9, refers_1: 0.1, vague_action: 'remove', place: 'remove' }, prev);
  assert.deepEqual(accepted(one), plan([atom({ kind: 'category', value: 'concert' })]));
  const strength = read('onu tercihe çevir', { vague: 1, refers_0: 0.9, refers_1: 0.1, vague_action: 'make_preferred' }, prev);
  assert.deepEqual(accepted(strength), plan([atom({ kind: 'category', value: 'concert' })], [atom({ kind: 'location', name: 'Kadıköy', precision: 'district' })]));
});

void test('number candidates cover digits, separators, shorthand and Turkish words', () => {
  assert.deepEqual(numberCandidates('1.500 tl, 2,5k ya da iki yüz elli').map((n) => n.value), [1500, 2500, 250]);
  // Units written without a space are still candidates.
  assert.deepEqual(numberCandidates('1000tl, 500₺, 750lira').map((n) => n.value), [1000, 500, 750]);
  assert.deepEqual(numberCandidates('üç gün sonra 1000tl kişi başı').map((n) => n.text), ['üç', '1000']);
});

void test('a plain amount with attached currency reads as a per-person limit', () => {
  const result = read('üç gün sonra sevgilimle gideceğimiz 1000tl kişi başı taksim civarı konser olmayan etkinlik', {
    date: 'days_later', date_count: '3', place: 'in', district: 'Beyoğlu', neighborhood: 'Taksim', companion_partner: 'yes',
    category_concert: 'exclude', budget: 'max', budget_amount: '#1000', budget_basis: 'per_person',
  });
  assert.deepEqual(accepted(result), plan([
    atom({ kind: 'date', from: '2026-10-09', to: '2026-10-09' }),
    atom({ kind: 'location', name: 'Beyoğlu', precision: 'district' }),
    atom({ kind: 'companion', value: 'partner' }),
    { type: 'not', child: atom({ kind: 'category', value: 'concert' }) },
    atom({ kind: 'budget', comparison: 'lte', amount: 1000, currency: 'TRY', basis: 'per_person' }),
  ], [atom({ kind: 'location', name: 'Taksim', precision: 'neighborhood' })]));
});
