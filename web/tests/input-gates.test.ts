import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInputInterpreterRequest, interpretInput, type InterpreterInput } from '../lib/input-interpreter.ts';
import { buildInputPlanAuditRequest } from '../lib/input-plan-audit.ts';
import { emptyIntentState } from '../lib/input-state.ts';

const now = new Date('2026-09-30T09:00:00Z');

function proposal(input: InterpreterInput, overrides: Record<string, string> = {}) {
  const body = buildInputInterpreterRequest('jev-test', input);
  return { body, response: { model: 'jev-test', answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    const options = Object.keys(question.criteria);
    const selected = overrides[id] ?? (id === 'action' ? 'search' : id === 'issue' ? 'none' : id === 'candidate_coverage' ? 'complete' : id === 'budget_basis' || id === 'budget_boundary' ? 'none' : options.includes('keep') ? 'keep' : id.startsWith('interest_') ? 'skip' : options[0]);
    assert.ok(options.includes(selected), `${id}: ${selected}`);
    return [id, { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 1 : 0])) }];
  })) } };
}

function distribution(response: ReturnType<typeof proposal>['response'], id: string, values: Record<string, number>, confidence = 0.5) {
  const target = response.answers[id];
  target.probabilities = Object.fromEntries(Object.keys(target.probabilities).map((option) => [option, values[option] ?? 0]));
  target.confidence = confidence;
  target.choice = Object.entries(values).sort((a, b) => b[1] - a[1])[0][0];
}

async function interpretWithAudit(input: InterpreterInput, first: ReturnType<typeof proposal>['response'], auditChoice: 'first' | 'none' = 'first') {
  let calls = 0;
  const result = await interpretInput(input, { config: { apiKey: 'test', model: 'jev-test' }, fetcher: (async (_url, init) => {
    calls++;
    if (calls === 1) return Response.json(first);
    assert.equal(typeof init?.body, 'string');
    const body = JSON.parse(init?.body as string) as ReturnType<typeof buildInputPlanAuditRequest>;
    const selected = auditChoice === 'first' ? body.state.plans[0].id : 'no_supported_plan';
    const options = Object.keys(body.questions.faithful_plan.criteria);
    return Response.json({ model: 'jev-test', answers: { faithful_plan: { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 1 : 0])) } } });
  }) as typeof fetch });
  return { calls, result };
}

void test('coarse issue and coverage votes defer to an exact complete-plan audit', async () => {
  const previous = emptyIntentState({ dateFrom: null, dateTo: null, maxPrice: null, category: null });
  previous.filters.excludedCategories = ['Konser'];
  const input = { message: '2 Ekim tiyatro olsun, kişi başı en fazla 2000 TL; konser olmasın.', previous, now };
  const { body, response } = proposal(input, { category_theatre: 'include', category_concert: 'exclude', budget_basis: 'per_person', budget_boundary: 'inclusive' });
  const amount = body.state.sourceCandidates.amounts.find((item) => item.value === 2000);
  const date = body.state.sourceCandidates.dates[0];
  assert.ok(amount && date);
  response.answers.budget.choice = amount.id;
  response.answers.budget.probabilities = Object.fromEntries(Object.keys(response.answers.budget.probabilities).map((option) => [option, option === amount.id ? 1 : 0]));
  response.answers.date.choice = date.id;
  response.answers.date.probabilities = Object.fromEntries(Object.keys(response.answers.date.probabilities).map((option) => [option, option === date.id ? 1 : 0]));
  distribution(response, 'issue', { unsupported_constraint: 0.65, none: 0.35 });
  distribution(response, 'candidate_coverage', { unsupported: 0.49, complete: 0.47, ambiguous: 0.04 });

  const { calls, result } = await interpretWithAudit(input, response);
  assert.equal(calls, 2);
  assert.equal(result.issue, null);
  assert.equal(result.state.filters.maxPrice, 2000);
  assert.equal(result.state.filters.category, 'Tiyatro');
  assert.deepEqual(result.state.filters.excludedCategories, ['Konser']);
  assert.equal(result.state.filters.dateFrom, '2026-10-02');
});

void test('a coarse optional-location issue can be corrected by the complete plan', async () => {
  const input = { message: 'Cumartesi tiyatro; Anadolu yakası tercihimiz.', previous: emptyIntentState(), now };
  const { body, response } = proposal(input, { category_theatre: 'include' });
  const date = body.state.sourceCandidates.dates[0];
  assert.ok(date);
  response.answers.date.choice = date.id;
  response.answers.date.probabilities = Object.fromEntries(Object.keys(response.answers.date.probabilities).map((option) => [option, option === date.id ? 1 : 0]));
  distribution(response, 'issue', { unsupported_constraint: 0.95, none: 0.05 });
  distribution(response, 'district', { unsupported: 0.36, none: 0.27, ambiguous: 0.18, keep: 0.17, remove: 0.02 }, 0.19);

  const { calls, result } = await interpretWithAudit(input, response);
  assert.equal(calls, 2);
  assert.equal(result.issue, null);
  assert.equal(result.state.filters.category, 'Tiyatro');
  assert.equal(result.state.filters.dateFrom, '2026-10-03');
  assert.equal(result.state.filters.district, undefined);
});

void test('an optional side preference preserves an inherited exact district', async () => {
  const previous = emptyIntentState();
  previous.filters.district = 'Kadıköy';
  const input = { message: 'Mümkünse Anadolu yakası tercihimiz.', previous, now };
  const { response } = proposal(input, { issue: 'unsupported_constraint', district: 'unsupported' });
  const { calls, result } = await interpretWithAudit(input, response);
  assert.equal(calls, 2);
  assert.equal(result.issue, null);
  assert.equal(result.state.filters.district, 'Kadıköy');
});

void test('an optional side preference cannot hide a separate mandatory neighborhood', async () => {
  const previous = emptyIntentState({ dateFrom: null, dateTo: null, maxPrice: null, category: 'Tiyatro' });
  const input = { message: 'Mümkünse Anadolu yakası; Taksim’de olması şart.', previous, now };
  const { response } = proposal(input, { issue: 'unsupported_constraint', district: 'unsupported' });
  const { calls, result } = await interpretWithAudit(input, response, 'none');
  assert.equal(calls, 2);
  assert.equal(result.issue, 'constraint_ambiguous');
  assert.deepEqual(result.state, previous);
});

void test('a mandatory district correction survives a generic coarse issue vote', async () => {
  const previous = emptyIntentState();
  previous.filters.district = 'Beşiktaş';
  const input = { message: 'Aslında Beşiktaş değil Kadıköy olsun.', previous, now };
  const { body, response } = proposal(input);
  const district = body.state.sourceCandidates.districts.find((item) => item.value === 'Kadıköy');
  assert.ok(district);
  response.answers.district.choice = district.id;
  response.answers.district.probabilities = Object.fromEntries(Object.keys(response.answers.district.probabilities).map((option) => [option, option === district.id ? 1 : 0]));
  distribution(response, 'issue', { unsupported_constraint: 0.65, none: 0.35 });

  const { calls, result } = await interpretWithAudit(input, response);
  assert.equal(calls, 2);
  assert.equal(result.issue, null);
  assert.equal(result.state.filters.district, 'Kadıköy');
});

void test('explicitly unsupported mandatory location remains an exact pre-audit stop', async () => {
  const previous = emptyIntentState({ dateFrom: null, dateTo: null, maxPrice: 700, category: 'Konser' });
  const input = { message: 'Taksim’de tiyatro olsun.', previous, now };
  const { response } = proposal(input, { category_theatre: 'include', issue: 'unsupported_constraint', district: 'unsupported' });
  const { calls, result } = await interpretWithAudit(input, response, 'none');
  assert.equal(calls, 1, 'an explicit unsupported exact district remains a pre-audit hard stop');
  assert.equal(result.issue, 'unsupported_constraint');
  assert.deepEqual(result.state, previous);
});

void test('missing required topic coverage reaches audit but cannot partially update', async () => {
  const previous = emptyIntentState({ dateFrom: null, dateTo: null, maxPrice: null, category: 'Konser' });
  const input = { message: 'Konser yerine sadece uzay fotoğrafçılığı atölyesi olsun.', previous, now };
  const { response } = proposal(input, { category_concert: 'exclude', candidate_coverage: 'unsupported' });
  const { calls, result } = await interpretWithAudit(input, response, 'none');
  assert.equal(calls, 2);
  assert.equal(result.issue, 'constraint_ambiguous');
  assert.deepEqual(result.state, previous);
});

void test('unsupported mandatory fee semantics reach audit but cannot disappear', async () => {
  const previous = emptyIntentState({ dateFrom: null, dateTo: null, maxPrice: 600, category: 'Tiyatro' });
  const input = { message: '600 TL sınırı tüm hizmet bedelleri dahil kesin olsun.', previous, now };
  const { response } = proposal(input, { issue: 'unsupported_constraint' });
  const { calls, result } = await interpretWithAudit(input, response, 'none');
  assert.equal(calls, 2);
  assert.equal(result.issue, 'constraint_ambiguous');
  assert.deepEqual(result.state, previous);
});
