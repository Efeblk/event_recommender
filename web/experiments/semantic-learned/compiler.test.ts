import assert from 'node:assert/strict';
import test from 'node:test';
import type { ParserInput, PreviousState } from '../semantic-grammar/contract.ts';
import { compile } from './compiler.ts';
import { prepareInput, resolveLocation } from './values.ts';
import type { WireNode, WireOperation, WireResult } from './wire.ts';

const input = (utterance: string, language: 'en' | 'tr' = 'en', previousState: PreviousState | null = null): ParserInput => ({ utterance, language, previousState, referenceDate: '2026-10-01', timezone: 'Europe/Istanbul' });
const node = (values: Partial<WireNode> = {}): WireNode => ({ id: 'n0', type: 'atom', children: [], kind: 'category', value: 'concert', exact: [], refs: ['t0'], comparison: '', basis: '', ...values });
const operation = (values: Partial<WireOperation> = {}): WireOperation => ({ op: 'add', target: '', root: 'n0', strength: 'hard', value: '', refs: ['t0'], ...values });
const wire = (nodes: WireNode[] = [node()], operations: WireOperation[] = [operation()]): WireResult => ({ status: 'candidate', readings: [{ nodes, operations }], unresolved: [], discourse: [] });
function budget(utterance: string, basis: WireNode['basis'] = 'per_person', language: 'en' | 'tr' = 'en') {
  const request = input(utterance, language); const prepared = prepareInput(request);
  const refs = prepared.tokens.map(t => t.id); const value = prepared.values.find(v => v.kind === 'number')!;
  const output = wire([node({ kind: 'budget', value: '', exact: [value.id], refs, comparison: 'lte', basis })], [operation({ refs })]);
  return { request, prepared, output };
}
void test('copies exact source amount and preserves comparison and basis', () => {
  const { request, prepared, output } = budget('maximum 700 TL per person');
  const result = compile(request, prepared, output); assert.equal(result.status, 'accepted');
  if (result.status === 'accepted') assert.deepEqual(result.operations[0], { op: 'add', strength: 'hard', condition: { type: 'atom', atom: { kind: 'budget', amount: 700, currency: 'TRY', comparison: 'lte', basis: 'per_person' } } });
});
void test('omitted basis expands all three material interpretations', () => {
  const { request, prepared, output } = budget('maximum 700 TL', '');
  const result = compile(request, prepared, output); assert.equal(result.status, 'ambiguous');
  if (result.status === 'ambiguous') assert.equal(result.alternatives.length, 3);
});
void test('invented basis and contradictory explicit basis are refused', () => {
  for (const utterance of ['maximum 700 TL', 'maximum 700 TL total']) {
    const { request, prepared, output } = budget(utterance); assert.equal(compile(request, prepared, output).status, 'unsupported');
  }
});
void test('explicit basis cannot be hidden in operation refs to force another basis', () => {
  const { request, prepared, output } = budget('maximum 700 TL total', 'per_person');
  output.readings[0].nodes[0].refs = ['t0', 't1', 't2'];
  assert.equal(compile(request, prepared, output).status, 'unsupported');
});
void test('exact reference cannot invent value, use wrong type, or bind outside evidence', () => {
  for (const mutation of ['missing', 'outside', 'tampered']) {
    const { request, prepared, output } = budget('maximum 700 TL per person');
    if (mutation === 'missing') output.readings[0].nodes[0].exact = ['v999'];
    if (mutation === 'outside') output.readings[0].nodes[0].refs = ['t0'];
    if (mutation === 'tampered') prepared.values[0].number = 7;
    assert.equal(compile(request, prepared, output).status, 'unsupported');
  }
});
void test('source UTF16 offsets survive emoji and Turkish characters', () => {
  const request = input('🎭 Şişli’de iki kişi', 'tr'); const prepared = prepareInput(request);
  for (const token of prepared.tokens) assert.equal(request.utterance.slice(token.start, token.end), token.text);
  assert.equal(prepared.tokens[1].start, 3);
  assert.equal(prepared.values.find(v => v.text === 'iki')?.number, 2);
});
void test('numeric normalization is language-aware and rejects ambiguous separators', () => {
  assert.equal(prepareInput(input('1.500,50 TL', 'tr')).values[0].number, 1500.5);
  assert.equal(prepareInput(input('1,500.50 TL')).values[0].number, 1500.5);
  assert.equal(prepareInput(input('1.500 TL')).values.length, 0);
});
void test('attached TRY currency forms preserve full source-token evidence', () => {
  for (const literal of ['2350tl', '2350TRY', '2350lira', '2350lirası', '2.350,50TL']) {
    const request = input(literal, 'tr'); const prepared = prepareInput(request);
    const value = prepared.values.find(v => v.kind === 'number');
    assert.equal(value?.number, literal.includes(',') ? 2350.5 : 2350);
    assert.equal(value?.text, literal);
    assert.deepEqual(value?.refs, prepared.tokens.map(t => t.id));
  }
});
void test('uppercase English I can be harmless discourse', () => {
  const request = input('I want concert'); const prepared = prepareInput(request);
  const output = wire([node({ refs: ['t2'] })], [operation({ refs: ['t2'] })]);
  output.discourse = ['t0', 't1'];
  assert.equal(compile(request, prepared, output).status, 'accepted');
});
void test('date and clock normalization copies known expressions only', () => {
  const prepared = prepareInput(input('tomorrow this weekend next week 8 pm 20:30 2026-10-05'));
  assert.deepEqual(prepared.values.filter(v => v.kind === 'date').map(v => [v.text, v.from, v.to]), [
    ['2026-10-05', '2026-10-05', '2026-10-05'], ['tomorrow', '2026-10-02', '2026-10-02'],
    ['this weekend', '2026-10-03', '2026-10-04'], ['next week', '2026-10-05', '2026-10-11'],
  ]);
  assert.deepEqual(prepared.values.filter(v => v.kind === 'time').map(v => v.from), ['20:00', '20:30']);
  assert.equal(prepareInput(input('2026-02-30')).values.some(v => v.kind === 'date'), false);
});
void test('past this-week weekday is not silently moved to next week', () => {
  const request = input('this Monday'); const prepared = prepareInput(request); const value = prepared.values.find(v => v.kind === 'date')!;
  assert.equal(value.from, '2026-09-28');
  const refs = prepared.tokens.map(t => t.id);
  assert.equal(compile(request, prepared, wire([node({ kind: 'date', value: '', exact: [value.id], refs })], [operation({ refs })])).status, 'unsupported');
});
void test('composite negation and optional group scope are preserved', () => {
  const request = input('not concert or theatre'); const prepared = prepareInput(request);
  const nodes = [node({ id: 'neg', type: 'not', kind: '', value: '', children: ['alt'], refs: ['t0'] }),
    node({ id: 'alt', type: 'any', kind: '', value: '', children: ['a', 'b'], refs: ['t2'] }),
    node({ id: 'a', refs: ['t1'] }), node({ id: 'b', value: 'theatre', refs: ['t3'] })];
  const result = compile(request, prepared, wire(nodes, [operation({ root: 'neg', strength: 'preferred' })]));
  assert.equal(result.status, 'accepted');
  if (result.status === 'accepted') {
    assert.equal(result.resultingPlan.preferences[0].type, 'not');
    assert.equal(result.resultingPlan.hard.type === 'all' && result.resultingPlan.hard.children.length, 0);
  }
});
void test('cycle, unreachable nodes, duplicate IDs, shared nodes and arity reject', () => {
  const request = input('concert'); const prepared = prepareInput(request);
  for (const nodes of [
    [node({ type: 'not', kind: '', value: '', children: ['n0'] })],
    [node(), node({ id: 'unused' })], [node(), node()],
    [node({ type: 'any', kind: '', value: '', children: ['a', 'a'] }), node({ id: 'a' })],
    [node({ type: 'not', kind: '', value: '', children: [] })],
  ]) assert.equal(compile(request, prepared, wire(nodes)).status, 'unsupported');
});
void test('extra properties, wrong atom enum and unresolved candidate reject', () => {
  const request = input('concert'); const prepared = prepareInput(request);
  assert.equal(compile(request, prepared, { ...wire(), confidence: 1 }).status, 'unsupported');
  assert.equal(compile(request, prepared, wire([node({ value: 'partner' })])).status, 'unsupported');
  assert.equal(compile(request, prepared, { ...wire(), unresolved: ['t0'] }).status, 'unsupported');
});
void test('uncovered or falsely discarded material and unused numbers reject', () => {
  for (const request of [input('concert dangerous'), input('concert 700'), input('concert not')]) {
    const prepared = prepareInput(request); const output = wire();
    assert.equal(compile(request, prepared, output).status, 'unsupported');
    output.discourse = ['t1']; assert.equal(compile(request, prepared, output).status, 'unsupported');
  }
});
const prior: PreviousState = { revision: 4, evidence: [], plan: { hard: { type: 'all', children: [{ type: 'atom', id: 'h0', atom: { kind: 'party', count: 4 } }, { type: 'atom', id: 'h1', atom: { kind: 'category', value: 'concert' } }] }, preferences: [], order: 'soonest' } };
void test('party delta uses actual explicit prior count and requires exact replacement target', () => {
  const request = input('one person less', 'en', prior); const prepared = prepareInput(request); const delta = prepared.values.find(v => v.kind === 'party_delta')!;
  assert.equal(delta.number, 3); const refs = prepared.tokens.map(t => t.id);
  const output = wire([node({ kind: 'party', value: '', exact: [delta.id], refs })], [operation({ op: 'replace', target: 'h0', refs })]);
  const before = structuredClone(prior); const result = compile(request, prepared, output); assert.equal(result.status, 'accepted'); assert.deepEqual(prior, before);
  if (result.status === 'accepted') assert.equal(result.resultingPlan.order, 'soonest');
  output.readings[0].operations[0].target = 'h1'; assert.equal(compile(request, prepared, output).status, 'unsupported');
  assert.equal(prepareInput(input('one person less')).values.some(v => v.kind === 'party_delta'), false);
});
void test('late invalid operation preserves actual prior state atomically', () => {
  const request = input('remove concert', 'en', prior); const prepared = prepareInput(request); const refs = prepared.tokens.map(t => t.id);
  const output = wire([], [operation({ op: 'remove', target: 'h1', root: '', strength: '', refs }), operation({ op: 'remove', target: 'absent', root: '', strength: '', refs })]);
  const before = structuredClone(prior); assert.equal(compile(request, prepared, output).status, 'unsupported'); assert.deepEqual(prior, before);
});
void test('reset requires explicit source and preserves refusal state', () => {
  for (const [utterance, expected] of [['start over', 'accepted'], ['concert', 'unsupported']]) {
    const request = input(utterance, 'en', prior); const prepared = prepareInput(request); const refs = prepared.tokens.map(t => t.id);
    const result = compile(request, prepared, wire([], [operation({ op: 'reset', root: '', strength: '', refs })])); assert.equal(result.status, expected);
    if (result.status === 'accepted') assert.equal(result.resultingPlan.order, 'none');
  }
});
void test('ordering cannot be invented from a category source token', () => {
  const request = input('concert'); const prepared = prepareInput(request);
  assert.equal(compile(request, prepared, wire([], [operation({ op: 'order', root: '', strength: '', value: 'cheapest' })])).status, 'unsupported');
});
void test('temporal proximity sorts chronologically rather than geographically', () => {
  for (const utterance of ['en yakın tarih', 'en yakın zaman', 'en yakın gün']) {
    const request = input(utterance, 'tr'); const prepared = prepareInput(request); const refs = prepared.tokens.map(t => t.id);
    assert.equal(compile(request, prepared, wire([], [operation({ op: 'order', root: '', strength: '', value: 'soonest', refs })])).status, 'accepted');
    assert.equal(compile(request, prepared, wire([], [operation({ op: 'order', root: '', strength: '', value: 'nearest', refs })])).status, 'unsupported');
  }
});
void test('closed topics cannot carry unsupported free text', () => {
  const request = input('photography'); const prepared = prepareInput(request);
  assert.equal(compile(request, prepared, wire([node({ kind: 'topic', value: 'photography' })])).status, 'accepted');
  assert.equal(compile(request, prepared, wire([node({ kind: 'topic', value: 'concert' })])).status, 'unsupported');
});
void test('known Istanbul locations resolve Turkish suffix and precision in code', () => {
  assert.deepEqual(resolveLocation('kadıköy’de'), { name: 'Kadıköy', precision: 'district' });
  assert.deepEqual(resolveLocation('moda'), { name: 'Moda', precision: 'neighborhood' });
  assert.equal(resolveLocation('Somewhere'), undefined);
  const request = input('Kadıköy’de', 'tr'); const prepared = prepareInput(request); const refs = prepared.tokens.map(t => t.id);
  assert.equal(compile(request, prepared, wire([node({ kind: 'location', value: 'district', refs })], [operation({ refs })])).status, 'accepted');
});
