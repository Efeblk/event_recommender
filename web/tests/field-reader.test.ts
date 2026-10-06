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
  const otherDate = read('bayramda konser', { date: 'other' });
  assert.equal(otherDate.status === 'unsupported' && otherDate.reason, 'unreadable date');
  const place = read('o meşhur yerde konser', { place: 'unknown' });
  assert.equal(place.status === 'unsupported' && place.reason, 'unreadable place');
  const amount = read('ucuz olsun, bütçe belli', { budget: 'max' });
  assert.equal(amount.status === 'unsupported' && amount.reason, 'unreadable budget');
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
