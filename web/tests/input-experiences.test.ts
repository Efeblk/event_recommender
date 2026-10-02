import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInputInterpreterRequest, parseInputInterpreterProposal, parseInputInterpreterResponse } from '../lib/input-interpreter.ts';
import { emptyIntentState, intentQuery, validateIntentState } from '../lib/input-state.ts';

const now = new Date('2026-09-28T12:00:00+03:00');

function response(message: string, overrides: Record<string, string> = {}, previous = emptyIntentState()) {
  const request = buildInputInterpreterRequest('jev-test', { message, previous, now });
  const answers = Object.fromEntries(Object.entries(request.questions).map(([id, question]) => {
    const options = Object.keys(question.criteria);
    const choice = overrides[id] ?? (id === 'action' ? 'search' : id === 'issue' ? 'none' : id === 'candidate_coverage' ? 'complete' :
      id === 'budget_basis' || id === 'budget_boundary' ? 'none' : options.includes('keep') ? 'keep' : id.startsWith('interest_') ? 'skip' : options[0]);
    return [id, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(options.map((option) => [option, option === choice ? 1 : 0])) }];
  }));
  return { request, value: { model: 'jev-test', answers } };
}

void test('v1 states remain compatible while experience values are strict and canonical empty is omitted', () => {
  const old = emptyIntentState();
  assert.equal(Object.hasOwn(old.preferences, 'experiences'), false);
  assert.deepEqual(validateIntentState(old), old);
  assert.deepEqual(validateIntentState({ ...old, preferences: { ...old.preferences, experiences: [] } }), old);
  assert.throws(() => validateIntentState({ ...old, preferences: { ...old.preferences, experiences: ['laughter', 'laughter'] } }));
  assert.throws(() => validateIntentState({ ...old, preferences: { ...old.preferences, experiences: ['fun'] } }));
});

void test('TR and EN experience desires stay soft and do not invent categories or genres', () => {
  for (const [message, key] of [['Gülmek istiyorum', 'laughter'], ['I want something interactive', 'participation']] as const) {
    const { value } = response(message, { [`experience_${key}`]: 'include' });
    const parsed = parseInputInterpreterResponse(value, { message, previous: emptyIntentState(), now });
    assert.deepEqual(parsed.state.preferences.experiences, [key]);
    assert.equal(parsed.state.filters.category, null);
    assert.deepEqual(parsed.state.requirements, []);
  }
});

void test('follow-ups preserve experiences, reset clears them, and reset can establish a new one', () => {
  const previous = emptyIntentState(); previous.preferences.experiences = ['laughter'];
  const kept = response('Kadıköy olsun', {}, previous).value;
  assert.deepEqual(parseInputInterpreterResponse(kept, { message: 'Kadıköy olsun', previous, now }).state.preferences.experiences, ['laughter']);
  const reset = response('Sıfırla', { action: 'reset' }, previous).value;
  assert.equal(parseInputInterpreterResponse(reset, { message: 'Sıfırla', previous, now }).state.preferences.experiences, undefined);
  const changed = response('Sıfırla, dans etmek istiyorum', { action: 'reset', experience_dancing: 'include' }, previous).value;
  assert.deepEqual(parseInputInterpreterResponse(changed, { message: 'Sıfırla, dans etmek istiyorum', previous, now }).state.preferences.experiences, ['dancing']);
});

void test('low-confidence proposal mutations become keep before plan reduction', () => {
  const previous = emptyIntentState(); previous.preferences.experiences = ['learning'];
  const built = response('Belki dans edebilirim', { experience_dancing: 'include' }, previous);
  const answer = built.value.answers.experience_dancing;
  answer.confidence = 0.05; answer.probabilities = { keep: 0.3, include: 0.6, remove: 0.1 };
  const proposal = parseInputInterpreterProposal(built.value, { message: 'Belki dans edebilirim', previous, now });
  assert.ok(proposal.plans.length);
  assert.ok(proposal.plans.every((plan) => !plan.result.state.preferences.experiences?.includes('dancing')));
  assert.ok(proposal.plans.every((plan) => plan.result.state.preferences.experiences?.includes('learning')));
});

void test('cancellation of an arbitrary laughter paraphrase leaves no stale query or interest', () => {
  const previous = emptyIntentState(); previous.preferences.experiences = ['laughter'];
  const message = 'Artık bol bol güleyim isteğini kaldır';
  const removal = response(message, { experience_laughter: 'remove' }, previous).value;
  const parsed = parseInputInterpreterResponse(removal, { message, previous, now });
  assert.equal(parsed.state.preferences.experiences, undefined);
  assert.deepEqual(parsed.state.preferences.interests, []);
  assert.doesNotMatch(parsed.query, /experience:/);
});

void test('typed interest classification is atomic unless reliable and free of removal conflicts', () => {
  const message = 'Bol bol güleyim';
  const built = response(message, { experience_laughter: 'include' });
  const interest = built.request.state.sourceCandidates.interests[0];
  assert.ok(interest);
  const id = `interest_${interest.id}`;
  const questions = built.request.questions as Record<string, { criteria: Record<string, string> }>;
  const choose = (choice: string) => {
    built.value.answers[id].choice = choice;
    built.value.answers[id].probabilities = Object.fromEntries(Object.keys(questions[id].criteria).map((option) => [option, option === choice ? 1 : 0]));
  };
  choose('experience_laughter');
  assert.deepEqual(parseInputInterpreterResponse(built.value, { message, previous: emptyIntentState(), now }).state.preferences.interests, []);
  choose('experience_learning');
  built.value.answers.experience_learning.choice = 'remove';
  built.value.answers.experience_learning.probabilities = { keep: 0, include: 0, remove: 1 };
  const mismatch = parseInputInterpreterResponse(built.value, { message, previous: emptyIntentState(), now });
  assert.equal(mismatch.issue, 'constraint_ambiguous');
  assert.deepEqual(mismatch.state, emptyIntentState());
  choose('experience_laughter');
  built.value.answers[id].confidence = 0.05;
  const uncertain = parseInputInterpreterResponse(built.value, { message, previous: emptyIntentState(), now });
  assert.equal(uncertain.issue, 'constraint_ambiguous');
  assert.deepEqual(uncertain.state, emptyIntentState());
  const proposal = parseInputInterpreterProposal(built.value, { message, previous: emptyIntentState(), now });
  assert.deepEqual(proposal.plans, []);
});

void test('literal titles remain interests even under a confident matching experience classification', () => {
  const message = '"Dance" adlı etkinliği istiyorum';
  const built = response(message, { experience_dancing: 'include' });
  const interest = built.request.state.sourceCandidates.interests[0];
  assert.ok(interest);
  const questions = built.request.questions as Record<string, { criteria: Record<string, string> }>;
  built.value.answers[`interest_${interest.id}`].choice = 'experience_dancing';
  built.value.answers[`interest_${interest.id}`].probabilities = Object.fromEntries(Object.keys(questions[`interest_${interest.id}`].criteria).map((option) => [option, option === 'experience_dancing' ? 1 : 0]));
  const title = parseInputInterpreterResponse(built.value, { message, previous: emptyIntentState(), now });
  assert.deepEqual(title.state.preferences.interests, ['Dance']);
  assert.equal(intentQuery(title.state).includes('interest:Dance'), true);
});

void test('clear preferences removes only soft state and applies new wishes afterward', () => {
  const previous = emptyIntentState();
  previous.filters.district = 'Kadıköy'; previous.preferences.mood = 'calm'; previous.preferences.companion = 'friends';
  previous.preferences.interests = ['history']; previous.preferences.experiences = ['learning'];
  const cleared = response('Tüm tercihlerimi temizle', { interest_clear: 'remove_preferences' }, previous).value;
  const first = parseInputInterpreterResponse(cleared, { message: 'Tüm tercihlerimi temizle', previous, now }).state;
  assert.deepEqual(first.preferences, { mood: null, companion: null, interests: [] });
  assert.equal(first.filters.district, 'Kadıköy');

  const message = 'Tüm tercihlerimi temizle, şimdi dans etmek istiyorum';
  const changed = response(message, { interest_clear: 'remove_preferences', experience_dancing: 'include' }, previous).value;
  const second = parseInputInterpreterResponse(changed, { message, previous, now }).state;
  assert.deepEqual(second.preferences.experiences, ['dancing']);
  assert.equal(second.filters.district, 'Kadıköy');
});

void test('reliable add then remove leaves no generic residue while concrete and legacy interests survive', () => {
  const addMessage = 'Bol bol güleyim';
  const add = response(addMessage, { experience_laughter: 'include' });
  const generic = add.request.state.sourceCandidates.interests[0]; assert.ok(generic);
  const genericId = `interest_${generic.id}`;
  add.value.answers[genericId].choice = 'experience_laughter';
  add.value.answers[genericId].probabilities = Object.fromEntries(Object.keys((add.request.questions as Record<string, { criteria: Record<string, string> }>)[genericId].criteria).map((option) => [option, option === 'experience_laughter' ? 1 : 0]));
  const added = parseInputInterpreterResponse(add.value, { message: addMessage, previous: emptyIntentState(), now }).state;
  assert.deepEqual(added.preferences.experiences, ['laughter']); assert.deepEqual(added.preferences.interests, []);

  const removeMessage = 'Gülme isteğini kaldır, arkeoloji ilgim kalsın';
  added.preferences.interests = ['opaque legacy phrase'];
  const remove = response(removeMessage, { experience_laughter: 'remove' }, added);
  const concrete = remove.request.state.sourceCandidates.interests.find((item) => item.value.toLocaleLowerCase('tr-TR').includes('arkeoloji'));
  assert.ok(concrete);
  remove.value.answers[`interest_${concrete.id}`].choice = 'optional';
  remove.value.answers[`interest_${concrete.id}`].probabilities = Object.fromEntries(Object.keys((remove.request.questions as Record<string, { criteria: Record<string, string> }>)[`interest_${concrete.id}`].criteria).map((option) => [option, option === 'optional' ? 1 : 0]));
  const removed = parseInputInterpreterResponse(remove.value, { message: removeMessage, previous: added, now });
  assert.equal(removed.issue, null); assert.equal(removed.state.preferences.experiences, undefined);
  assert.ok(removed.state.preferences.interests.includes('opaque legacy phrase'));
  assert.ok(removed.state.preferences.interests.some((value) => value.toLocaleLowerCase('tr-TR').includes('arkeoloji')));
  assert.doesNotMatch(removed.query, /experience:laughter/);
});

void test('low-confidence clear-all proposal preserves every prior soft preference', () => {
  const previous = emptyIntentState();
  previous.preferences.mood = 'calm'; previous.preferences.companion = 'friends';
  previous.preferences.interests = ['"Reset" adlı oyun']; previous.preferences.experiences = ['learning'];
  const message = 'Belki tercihlerimi temizlerim';
  const built = response(message, { interest_clear: 'remove_preferences' }, previous);
  built.value.answers.interest_clear.confidence = 0.05;
  built.value.answers.interest_clear.probabilities = { keep: 0.3, remove: 0.1, remove_preferences: 0.6 };
  const proposal = parseInputInterpreterProposal(built.value, { message, previous, now });
  assert.ok(proposal.plans.length);
  for (const plan of proposal.plans) assert.deepEqual(plan.result.state.preferences, previous.preferences);
});

void test('reset cannot bypass typed experience atomicity when the source role is uncertain', () => {
  const previous = emptyIntentState(); previous.preferences.mood = 'calm'; previous.preferences.interests = ['legacy'];
  const message = 'Sıfırla, dans edeyim';
  const built = response(message, { action: 'reset', experience_dancing: 'include' }, previous);
  const interest = built.request.state.sourceCandidates.interests[0]; assert.ok(interest);
  const id = `interest_${interest.id}`;
  const criteria = (built.request.questions as Record<string, { criteria: Record<string, string> }>)[id].criteria;
  built.value.answers[id].choice = 'experience_dancing';
  built.value.answers[id].probabilities = Object.fromEntries(Object.keys(criteria).map((option) => [option, option === 'experience_dancing' ? 1 : 0]));
  built.value.answers[id].confidence = 0.05;
  const direct = parseInputInterpreterResponse(built.value, { message, previous, now });
  assert.equal(direct.issue, 'constraint_ambiguous'); assert.deepEqual(direct.state, previous);
  assert.deepEqual(parseInputInterpreterProposal(built.value, { message, previous, now }).plans, []);
});

void test('a literal title classified as an experience survives reset exactly', () => {
  const previous = emptyIntentState(); previous.preferences.mood = 'calm';
  const message = 'Sıfırla, "Dance" adlı etkinliği bul';
  const built = response(message, { action: 'reset' }, previous);
  const interest = built.request.state.sourceCandidates.interests.find((item) => item.value.startsWith('LITERAL')); assert.ok(interest);
  const id = `interest_${interest.id}`;
  const criteria = (built.request.questions as Record<string, { criteria: Record<string, string> }>)[id].criteria;
  built.value.answers[id].choice = 'experience_dancing';
  built.value.answers[id].probabilities = Object.fromEntries(Object.keys(criteria).map((option) => [option, option === 'experience_dancing' ? 1 : 0]));
  const parsed = parseInputInterpreterResponse(built.value, { message, previous, now });
  assert.equal(parsed.issue, null); assert.deepEqual(parsed.state.preferences.interests, ['Dance']);
  assert.equal(parsed.state.preferences.mood, null);
});
