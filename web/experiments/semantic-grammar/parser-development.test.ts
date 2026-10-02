import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from './parser.ts';
import { emptyPlan, type Atom, type Condition, type ParserInput } from './contract.ts';
import { semanticPlan, stable } from './semantics.ts';

const input = (utterance: string, previousState: ParserInput['previousState'] = null): ParserInput => ({
  utterance, language: /[çğıöşü]|konser|kisi|sevgili/iu.test(utterance) ? 'tr' : 'en', referenceDate: '2026-10-01', timezone: 'Europe/Istanbul', previousState,
});
const atom = (a: Atom): Condition => ({ type: 'atom', atom: a });
const category = (value: 'concert' | 'theatre' | 'museum'): Condition => atom({ kind: 'category', value });
const accepted = (text: string) => {
  const result = parse(input(text));
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  if (result.status !== 'accepted') throw new Error('not accepted');
  return result;
};
const plan = (hard: Condition[], preferences: Condition[] = []) => semanticPlan({ hard: { type: 'all', children: hard }, preferences, order: 'none' });

void test('complete English maximum expression preserves amount, operator and basis', () => {
  assert.equal(stable(semanticPlan(accepted('maximum 700 TL per person').resultingPlan)), stable(plan([
    atom({ kind: 'budget', comparison: 'lte', amount: 700, currency: 'TRY', basis: 'per_person' }),
  ])));
});
void test('complete Turkish maximum phrase preserves the same semantics', () => {
  assert.equal(stable(semanticPlan(accepted('kişi başı en fazla 700 TL').resultingPlan)), stable(plan([
    atom({ kind: 'budget', comparison: 'lte', amount: 700, currency: 'TRY', basis: 'per_person' }),
  ])));
});
void test('under is strict and grouped thousands stay numeric', () => {
  const r = accepted('under 1,000 TL per-ticket');
  assert.equal(stable(semanticPlan(r.resultingPlan)), stable(plan([
    atom({ kind: 'budget', comparison: 'lt', amount: 1000, currency: 'TRY', basis: 'per_ticket' }),
  ])));
});
void test('missing basis preserves three readings without guessing from companion', () => {
  const r = parse(input('maximum 700 TL'));
  assert.equal(r.status, 'ambiguous');
  if (r.status === 'ambiguous') assert.equal(r.alternatives.length, 3);
});
void test('minimum and approximate remain distinct symbolic comparisons', () => {
  for (const [text, comparison] of [['minimum', 'gte'], ['around', 'approx']] as const) {
    assert.equal(stable(semanticPlan(accepted(`${text} 500 TL total`).resultingPlan)), stable(plan([
      atom({ kind: 'budget', comparison, amount: 500, currency: 'TRY', basis: 'group_total' }),
    ])));
  }
});
void test('preference never weakens the concert constraint', () => {
  assert.equal(stable(semanticPlan(accepted('concert, preferably quiet').resultingPlan)), stable(plan([
    category('concert'),
  ], [atom({ kind: 'experience', value: 'quiet' })])));
});
void test('AND precedence stays inside the second OR branch', () => {
  assert.equal(stable(semanticPlan(accepted('concert or theatre and museum').resultingPlan)), stable(plan([
    { type: 'any', children: [category('concert'), { type: 'all', children: [category('theatre'), category('museum')] }] },
  ])));
});
void test('parentheses and negation preserve the complete subtree', () => {
  assert.equal(stable(semanticPlan(accepted('not (concert or theatre)').resultingPlan)), stable(plan([
    { type: 'not', child: { type: 'any', children: [category('concert'), category('theatre')] } },
  ])));
});
void test('mixed category/experience OR retains all branches', () => {
  assert.equal(stable(semanticPlan(accepted('concert or quiet or theatre').resultingPlan)), stable(plan([
    { type: 'any', children: [category('concert'), atom({ kind: 'experience', value: 'quiet' }), category('theatre')] },
  ])));
});
void test('negation can bind a date or an explicit district', () => {
  for (const [text, child] of [
    ['not tomorrow', atom({ kind: 'date', from: '2026-10-02', to: '2026-10-02' })],
    ['outside Kadıköy', atom({ kind: 'location', name: 'Kadıköy', precision: 'district' })],
  ] as const) assert.equal(stable(semanticPlan(accepted(text).resultingPlan)), stable(plan([{ type: 'not', child }])));
});
void test('unknowns between known terms and meaningful symbols are never swallowed', () => {
  for (const text of ['concert xyz theatre', 'maximum xyz 500 TL', 'concert 🚫', 'concert + theatre', 'do not reset']) {
    assert.equal(parse(input(text)).status, 'unsupported', text);
  }
});
void test('relative weekday and strict after-time compose', () => {
  assert.equal(stable(semanticPlan(accepted('Saturday and after 20:00').resultingPlan)), stable(plan([
    atom({ kind: 'date', from: '2026-10-03', to: '2026-10-03' }),
    atom({ kind: 'time', from: '20:00', fromExclusive: true }),
  ])));
});
void test('exact clock time is not turned into an open-ended lower bound', () => {
  assert.equal(stable(semanticPlan(accepted('at 19:00').resultingPlan)), stable(plan([
    atom({ kind: 'time', from: '19:00', to: '19:00' }),
  ])));
});
void test('reset and addition follow surface order', () => {
  const r = accepted('reset, concert');
  assert.equal(stable(semanticPlan(r.resultingPlan)), stable(plan([category('concert')])));
  const reversed = accepted('concert, reset');
  assert.equal(stable(semanticPlan(reversed.resultingPlan)), stable(semanticPlan(emptyPlan())));
});
void test('ambiguous correction targets stay enumerated and state is untouched', () => {
  const previous = { revision: 2, evidence: [], plan: { ...emptyPlan(), hard: { type: 'all' as const, children: [
    { ...category('concert'), id: 'h0' }, { ...atom({ kind: 'location', name: 'Kadıköy', precision: 'district' }), id: 'h1' },
  ] } } };
  const before = structuredClone(previous), r = parse(input('remove that condition', previous));
  assert.equal(r.status, 'ambiguous');
  if (r.status === 'ambiguous') assert.equal(r.alternatives.length, 2);
  assert.deepEqual(previous, before);
});
void test('UTF-16 evidence remains literal after Turkish normalization', () => {
  const text = 'KADIKÖY, maksimum 500 TL kişi başı';
  const r = parse(input(text));
  assert.equal(r.status, 'accepted', JSON.stringify(r));
  for (const span of r.evidence) assert.equal(text.slice(span.start, span.end), span.text);
});
void test('input, token, chart and alternative limits fail before unbounded insertion', () => {
  const char = parse(input('x'.repeat(2049))); assert.equal(char.diagnostics.guard, 'input_length');
  const token = parse(input('x '.repeat(129))); assert.equal(token.diagnostics.guard, 'token_limit');
  const repeated = parse(input('quiet concert '.repeat(30)));
  assert.equal(repeated.status, 'unsupported'); assert.equal(repeated.diagnostics.guard, 'chart_limit');
  const combinations = parse(input('maximum 1 TL, maximum 2 TL, maximum 3 TL'));
  assert.equal(combinations.status, 'unsupported');
  assert.ok(['chart_limit', 'alternative_limit'].includes(combinations.diagnostics.guard ?? ''));
});
void test('invalid reference clock refuses without throwing', () => {
  const r = parse({ ...input('Saturday'), referenceDate: '2026-02-30' });
  assert.equal(r.status, 'unsupported');
});
