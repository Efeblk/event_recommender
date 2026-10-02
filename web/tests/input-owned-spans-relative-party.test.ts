import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInputCandidates } from '../lib/input-candidates.ts';
import { buildInputInterpreterRequest, parseInputInterpreterResponse } from '../lib/input-interpreter.ts';
import { emptyIntentState } from '../lib/input-state.ts';

const now = new Date('2026-10-01T06:00:00Z');
const response = (request: ReturnType<typeof buildInputInterpreterRequest>, overrides: Record<string, string>) => ({
  model: 'jev-test',
  answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const options = Object.keys(question.criteria);
    const choice = overrides[id] ?? (id === 'action' ? 'search' : id === 'issue' ? 'none'
      : id === 'candidate_coverage' ? 'complete' : ['budget_basis', 'budget_boundary'].includes(id) ? 'none'
      : options.includes('keep') ? 'keep' : options.includes('skip') ? 'skip' : options[0]);
    assert.ok(options.includes(choice), `${id} supports ${choice}`);
    return [id, { type: 'choice', choice, confidence: 1,
      probabilities: Object.fromEntries(options.map((option) => [option, Number(option === choice)])) }];
  })),
});

void test('lexical numbers survive while only the locally owned price becomes an amount', () => {
  const message = "Cumartesi 2000'ler müziği olsa güzel olur ama şart değil; konser veya stand-up, kişi başı en çok 900 TL.";
  const pool = buildInputCandidates(message, now, emptyIntentState());
  assert.deepEqual(pool.amounts.map((item) => item.value), [900]);
  assert.ok(pool.interests.some((item) => item.value.includes("2000'ler müziği")));
  assert.ok(!pool.interests.some((item) => item.value.startsWith("'ler")));
  assert.ok(!pool.interests.some((item) => /kişi başı en çok/u.test(item.value)));
});

void test('closed quiet and category-negation clauses do not become duplicate open subjects', () => {
  const pool = buildInputCandidates('Cumartesi mutlaka sessiz bir etkinlik; konser istemiyorum.', now, emptyIntentState());
  assert.deepEqual(pool.interests.map((item) => item.scope?.ownership?.references), [['req_activity_quiet']]);
});

void test('relative party operation is applied to prior state and recomputes a retained total budget', () => {
  const previous = emptyIntentState();
  previous.filters.partySize = 4;
  previous.filters.totalBudget = 2000;
  previous.filters.maxPrice = 500;
  const input = { message: 'Bir kişi gelmiyor; toplam bütçe aynı kalsın.', previous, now };
  const request = buildInputInterpreterRequest('jev-test', input);
  const candidate = request.state.sourceCandidates.partySizes[0];
  assert.deepEqual(candidate.operation, { kind: 'delta', delta: -1 });
  const result = parseInputInterpreterResponse(response(request, { party: candidate.id }), input);
  assert.equal(result.issue, null);
  assert.equal(result.state.filters.partySize, 3);
  assert.equal(result.state.filters.totalBudget, 2000);
  assert.equal(result.state.filters.maxPrice, 2000 / 3);

  const noPrior = { message: 'One person is not coming.', previous: emptyIntentState(), now };
  const noPriorRequest = buildInputInterpreterRequest('jev-test', noPrior);
  const noPriorCandidate = noPriorRequest.state.sourceCandidates.partySizes[0];
  assert.equal(parseInputInterpreterResponse(response(noPriorRequest, { party: noPriorCandidate.id }), noPrior).issue, 'constraint_ambiguous');
});
