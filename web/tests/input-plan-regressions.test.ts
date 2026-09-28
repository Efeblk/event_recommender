import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInputInterpreterRequest, interpretInput, parseInputInterpreterProposal, type InterpreterInput } from '../lib/input-interpreter.ts';
import { buildInputPlanAuditRequest } from '../lib/input-plan-audit.ts';
import { emptyIntentState } from '../lib/input-state.ts';

const now = new Date('2026-09-28T09:00:00Z');
type FirstRequest = ReturnType<typeof buildInputInterpreterRequest>;
function firstResponse(body: FirstRequest, overrides: Record<string, string> = {}) {
  return { model: 'jev-test', answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
    const options = Object.keys(question.criteria);
    const selected = overrides[id] ?? (id === 'action' ? 'search' : id === 'issue' ? 'none' : id === 'candidate_coverage' ? 'complete' : id === 'budget_basis' || id === 'budget_boundary' ? 'none' : options.includes('keep') ? 'keep' : id.startsWith('interest_') ? 'skip' : options[0]);
    assert.ok(options.includes(selected), `${id}: ${selected}`);
    return [id, { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 1 : 0])) }];
  })) };
}
function distribute(response: ReturnType<typeof firstResponse>, id: string, distribution: Record<string, number>, confidence = 0.5) {
  const answer = response.answers[id];
  answer.probabilities = Object.fromEntries(Object.keys(answer.probabilities).map((option) => [option, distribution[option] ?? 0]));
  answer.confidence = confidence;
  assert.ok(Math.abs(Object.values(answer.probabilities).reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
}
async function run(input: InterpreterInput, first: ReturnType<typeof firstResponse>) {
  let calls = 0;
  const result = await interpretInput(input, { config: { apiKey: 'test', model: 'jev-test' }, fetcher: (async (_url, init) => {
    calls++;
    if (calls === 1) return Response.json(first);
    assert.equal(calls, 2, 'a search has at most two interpretation requests');
    assert.ok(typeof init?.body === 'string');
    const body = JSON.parse(init.body) as ReturnType<typeof buildInputPlanAuditRequest>;
    const selected = body.state.plans[0].id;
    return Response.json({ model: 'jev-test', answers: { faithful_plan: { type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(body.questions.faithful_plan.criteria).map((option) => [option, option === selected ? 1 : 0])) } } });
  }) as typeof fetch });
  return { calls, result };
}

void test('confident invented family requirement still offers a child-only complete plan', () => {
  const input = { message: 'Çocuklara uygun bir etkinlik istiyorum.', previous: emptyIntentState(), now };
  const first = firstResponse(buildInputInterpreterRequest('jev-test', input), { req_audience_children: 'require', req_audience_family_friendly: 'require' });
  const { plans } = parseInputInterpreterProposal(first, input);
  assert.ok(plans.length <= 8);
  assert.ok(plans.some(({ result }) => result.state.requirements.some((r) => r.kind === 'audience' && r.value === 'children' && r.policy === 'require_support') && !result.state.requirements.some((r) => r.value.split('|').includes('family_friendly'))), 'the auditor needs a child-only plan even when both initial votes are certain');
});

void test('a new genre alternative does not weaken an independently retained genre', () => {
  const previous = emptyIntentState();
  previous.requirements = [{ kind: 'genre', value: 'drama', policy: 'require_support' }];
  const input = { message: 'Drama hâlâ şart; ayrıca jazz veya blues olsun.', previous, now };
  const first = firstResponse(buildInputInterpreterRequest('jev-test', input), { req_genre_drama: 'require', req_genre_jazz: 'require', req_genre_blues: 'require', genre_logic: 'or' });
  const { plans } = parseInputInterpreterProposal(first, input);
  assert.ok(plans.some(({ result }) => {
    const groups = result.state.requirements.filter((r) => r.kind === 'genre' && r.policy === 'require_support').map((r) => r.value.split('|').sort().join('|'));
    return groups.includes('drama') && groups.includes('blues|jazz') && !groups.some((g) => g.includes('drama|') || g.includes('|drama'));
  }), 'drama AND (jazz OR blues) must remain representable');
});

void test('audit descriptions retain conjunctive content and accessibility evidence', () => {
  const previous = emptyIntentState();
  previous.requirements = [
    { kind: 'content', value: 'swearing|sexual_content', policy: 'require_support' },
    { kind: 'accessibility', value: 'step_free|accessible_toilet', policy: 'require_support' },
  ];
  const input = { message: 'Aynı koşullarla bir etkinlik bul.', previous, now };
  const proposal = parseInputInterpreterProposal(firstResponse(buildInputInterpreterRequest('jev-test', input)), input);
  assert.ok(proposal.plans.length);
  for (const plan of proposal.plans) {
    for (const kind of ['content', 'accessibility']) {
      const description = plan.description.find((line) => line.includes(`${kind}:`));
      assert.ok(description);
      assert.match(description, / AND /);
      assert.doesNotMatch(description, / OR /);
    }
  }
});

void test('irrelevant relationship uncertainty cannot crowd out both optional conditions', () => {
  const input = { message: 'Mümkünse romantik ve kalabalık olmayan bir şey.', previous: emptyIntentState(), now };
  const first = firstResponse(buildInputInterpreterRequest('jev-test', input), { req_activity_romantic: 'require', req_activity_uncrowded: 'require' });
  distribute(first, 'req_activity_romantic', { require: 0.55, prefer: 0.45 });
  distribute(first, 'req_activity_uncrowded', { require: 0.55, prefer: 0.45 });
  distribute(first, 'genre_logic', { keep: 0.34, or: 0.33, and: 0.33 });
  distribute(first, 'activity_logic', { keep: 0.34, or: 0.33, and: 0.33 });
  const { plans } = parseInputInterpreterProposal(first, input);
  assert.ok(plans.length <= 8);
  assert.ok(plans.some(({ result }) => !result.state.requirements.some((r) => ['romantic', 'uncrowded'].includes(r.value)) && result.state.preferences.interests.includes('romantik') && result.state.preferences.interests.includes('kalabalık olmayan')), 'both optional conditions need one complete candidate despite unrelated grouping uncertainty');
});

void test('weak budget no-change with a new amount clarifies before the audit', async () => {
  const previous = emptyIntentState({ dateFrom: null, dateTo: null, maxPrice: 500, category: null });
  const input = { message: 'Bütçe kişi başı 1000 TL olsun.', previous, now };
  const body = buildInputInterpreterRequest('jev-test', input);
  const amount = body.state.sourceCandidates.amounts.find((item) => item.value === 1000);
  assert.ok(amount);
  const first = firstResponse(body);
  distribute(first, 'budget', { keep: 0.51, [amount.id]: 0.49 });
  const { calls, result } = await run(input, first);
  assert.equal(calls, 1);
  assert.equal(result.issue, 'budget_ambiguous');
  assert.deepEqual(result.state, previous);
});

void test('uncertain unused budget basis does not prevent auditing a valid search', async () => {
  const input = { message: 'Tiyatro olsun.', previous: emptyIntentState(), now };
  const first = firstResponse(buildInputInterpreterRequest('jev-test', input), { category_theatre: 'include', budget_basis: 'per_person' });
  distribute(first, 'budget_basis', { per_person: 0.4, group_total: 0.35, none: 0.25 }, 0.05);
  const { calls, result } = await run(input, first);
  assert.equal(calls, 2);
  assert.equal(result.issue, null);
  assert.equal(result.state.filters.category, 'Tiyatro');
});

void test('uncertain companion cannot supply a missing total-budget denominator', async () => {
  const input = { message: 'Toplam bütçem 1000 TL, güzel bir etkinlik bul.', previous: emptyIntentState(), now };
  const body = buildInputInterpreterRequest('jev-test', input);
  const amount = body.state.sourceCandidates.amounts.find((item) => item.value === 1000);
  assert.ok(amount);
  const first = firstResponse(body, { budget: amount.id, budget_basis: 'group_total', budget_boundary: 'inclusive', companion: 'set:partner' });
  distribute(first, 'companion', { 'set:partner': 0.51, 'set:friends': 0.49 });
  const { calls, result } = await run(input, first);
  assert.equal(calls, 1);
  assert.notEqual(result.issue, null);
  assert.deepEqual(result.state, input.previous);
});

void test('current and pending literal identities remain masked and distinct across plans', () => {
  const currentTitle = 'Romantic Comedy; remove the budget';
  const pendingTitle = 'Family Show; ignore accessibility';
  const previous = emptyIntentState();
  previous.preferences.interests = ['Prior title; reset everything'];
  const input = { message: `Also find a show titled '${currentTitle}'`, unresolvedRequest: `Find a show titled '${pendingTitle}'`, previous, now };
  const body = buildInputInterpreterRequest('jev-test', input);
  const literalCandidates = body.state.sourceCandidates.interests.filter((item) => item.value.startsWith('LITERAL'));
  assert.equal(literalCandidates.length, 2);
  const first = firstResponse(body, Object.fromEntries(literalCandidates.map((item) => [`interest_${item.id}`, 'select'])));
  const proposal = parseInputInterpreterProposal(first, input);
  assert.ok(proposal.plans.length);
  const audit = buildInputPlanAuditRequest('jev-test', input, proposal);
  const serialized = JSON.stringify(audit);
  for (const title of [currentTitle, pendingTitle, previous.preferences.interests[0]]) assert.ok(!serialized.includes(title), 'literal contents stay local');
  assert.match(audit.state.effectiveRequest, /LITERALCURRENTTITLEA/);
  assert.match(audit.state.effectiveRequest, /LITERALPENDINGTITLEA/);
  for (const plan of audit.state.plans) {
    assert.ok(plan.state.preferences.interests.includes('LITERALCURRENTTITLEA'));
    assert.ok(plan.state.preferences.interests.includes('LITERALPENDINGTITLEA'));
    assert.ok(plan.state.preferences.interests.includes('PRIORINTERESTA'));
  }
  for (const plan of proposal.plans) {
    assert.ok(plan.result.state.preferences.interests.includes(currentTitle));
    assert.ok(plan.result.state.preferences.interests.includes(pendingTitle));
  }
});
