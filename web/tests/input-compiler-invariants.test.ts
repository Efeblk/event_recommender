import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildInputInterpreterRequest, parseInputInterpreterProposal } from '../lib/input-interpreter.ts';
import { buildInputPlanAuditRequest, parseInputPlanAuditResponse } from '../lib/input-plan-audit.ts';
import { emptyIntentState } from '../lib/input-state.ts';

type FrozenCase = {
  input: { message: string; previous: ReturnType<typeof emptyIntentState> };
  firstResponseBytes: string;
  firstResponseSha256: string;
  auditResponseBytes?: string;
  auditResponseSha256?: string;
};
const fixture = JSON.parse(readFileSync(new URL('../fixtures/input-compiler-invariants-v1.json', import.meta.url), 'utf8')) as {
  version: number;
  cases: { exclusion: FrozenCase; quiet: FrozenCase };
};
const verifiedResponse = (bytes: string, expectedSha256: string) => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedSha256);
  return JSON.parse(bytes);
};
const response = (request: ReturnType<typeof buildInputInterpreterRequest>, overrides: Record<string, string>) => ({
  model: 'jev-test',
  answers: Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const options = Object.keys(question.criteria);
    const choice = overrides[id] ?? (id === 'action' ? 'search' : id === 'issue' ? 'none'
      : id === 'candidate_coverage' ? 'complete' : ['budget_basis', 'budget_boundary'].includes(id) ? 'none'
      : options.includes('keep') ? 'keep' : options.includes('skip') ? 'skip' : options[0]);
    return [id, { type: 'choice', choice, confidence: 1,
      probabilities: Object.fromEntries(options.map((option) => [option, Number(option === choice)])) }];
  })),
});

void test('saved exclusion judgment cannot be compiled into a positive subject plan', () => {
  assert.equal(fixture.version, 1);
  const turn = fixture.cases.exclusion.input;
  const firstJev = verifiedResponse(fixture.cases.exclusion.firstResponseBytes, fixture.cases.exclusion.firstResponseSha256);
  const proposal = parseInputInterpreterProposal(firstJev, {
    message: turn.message,
    previous: turn.previous,
    now: new Date('2026-09-30T09:00:00Z'),
  });

  assert.equal(firstJev.answers.issue.choice, 'unsupported_constraint');
  assert.equal(firstJev.answers.interest_i1.choice, 'excluded');
  assert.equal(firstJev.answers.interest_i1.probabilities.primary, 0.37);
  assert.deepEqual(proposal.plans, []);

  const temptingSkip = structuredClone(firstJev);
  temptingSkip.answers.interest_i1.probabilities.primary = 0.02;
  temptingSkip.answers.interest_i1.probabilities.skip = 0.35;
  assert.deepEqual(parseInputInterpreterProposal(temptingSkip, {
    message: turn.message,
    previous: turn.previous,
    now: new Date('2026-09-30T09:00:00Z'),
  }).plans, [], 'an unowned exclusion cannot disappear through a plausible skip branch');
});

void test('saved hard quiet judgment remains mandatory in every auditable plan', () => {
  const turn = fixture.cases.quiet.input;
  const firstJev = verifiedResponse(fixture.cases.quiet.firstResponseBytes, fixture.cases.quiet.firstResponseSha256);
  const input = {
    message: turn.message,
    previous: turn.previous,
    now: new Date('2026-09-30T09:00:00Z'),
  };
  // The ownership fix removes the old duplicate quiet/accessibility subject,
  // so replay the saved closed-field judgments with current source-candidate
  // IDs rather than assigning the obsolete residual answer to a new subject.
  const current = buildInputInterpreterRequest('jev-test', input);
  for (const candidate of current.state.sourceCandidates.interests) {
    const id = `interest_${candidate.id}` as keyof typeof current.questions;
    const options = Object.keys(current.questions[id].criteria);
    const choice = /Osmanlı tarihi/u.test(candidate.value) ? 'optional' : 'skip';
    firstJev.answers[id] = { type: 'choice', choice, confidence: 1,
      probabilities: Object.fromEntries(options.map((option) => [option, Number(option === choice)])) };
  }
  const proposal = parseInputInterpreterProposal(firstJev, input);

  assert.equal(firstJev.answers.req_activity_quiet.choice, 'require');
  assert.equal(firstJev.answers.req_accessibility_step_free.choice, 'require');
  assert.ok(proposal.plans.length > 0 && proposal.plans.length <= 8);
  for (const plan of proposal.plans) {
    assert.ok(plan.result.state.requirements.some((item) =>
      item.kind === 'activity' && item.value === 'quiet' && item.policy === 'require_support'));
    assert.ok(plan.result.state.requirements.some((item) =>
      item.kind === 'accessibility' && item.value === 'step_free' && item.policy === 'require_support'));
  }

  assert.ok(fixture.cases.quiet.auditResponseBytes && fixture.cases.quiet.auditResponseSha256);
  const savedAudit = verifiedResponse(
    fixture.cases.quiet.auditResponseBytes,
    fixture.cases.quiet.auditResponseSha256,
  );
  const auditOptions = Object.keys(buildInputPlanAuditRequest('jev-test', input, proposal).questions.faithful_plan.criteria);
  savedAudit.answers.faithful_plan.choice = 'plan_0';
  savedAudit.answers.faithful_plan.confidence = 0.55;
  savedAudit.answers.faithful_plan.probabilities = Object.fromEntries(auditOptions.map((option) =>
    [option, option === 'plan_0' ? 0.55 : option === 'no_supported_plan' ? 0.45 : 0]));
  const audit = parseInputPlanAuditResponse(savedAudit, proposal);
  assert.ok(audit.planId);
  const selected = proposal.plans.find((plan) => plan.id === audit.planId);
  assert.ok(selected?.result.state.requirements.some((item) =>
    item.kind === 'activity' && item.value === 'quiet' && item.policy === 'require_support'));
});

void test('explicit child and whole-family requirements survive every counterfactual plan', () => {
  const cases = [
    ['Çocuklara uygun olması zorunlu.', 'req_audience_children', 'children'],
    ['Tüm aileye uygun olması zorunlu.', 'req_audience_family_friendly', 'family_friendly'],
  ] as const;
  for (const [message, question, value] of cases) {
    const input = { message, previous: emptyIntentState(), now: new Date('2026-09-30T09:00:00Z') };
    const request = buildInputInterpreterRequest('jev-test', input);
    const proposal = parseInputInterpreterProposal(response(request, { [question]: 'require' }), input);
    assert.ok(proposal.plans.length > 0);
    assert.ok(proposal.plans.every((plan) => plan.result.state.requirements.some((item) =>
      item.kind === 'audience' && item.value === value && item.policy === 'require_support')),
    `${value} must survive every emitted plan`);
  }
});
