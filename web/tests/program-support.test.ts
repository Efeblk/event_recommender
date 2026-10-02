import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProgramSupportRequest,
  composeProgramSupport,
  exclusionApplies,
  parseProgramSupportResponse,
  type ProgramSupportPredicate,
} from '../lib/program-support.ts';
import type { EventRecord } from '../lib/types.ts';

const event = (id: string, title: string, description: string): EventRecord => ({
  id,
  title,
  description,
  startsAt: '2026-10-03T10:00:00Z',
  checkedAt: '2026-10-01T09:00:00Z',
  venue: 'Source Venue',
  city: 'İstanbul',
  district: '',
  address: '',
  price: null,
  currency: 'TRY',
  url: `https://example.test/${id}`,
  imageUrl: '',
  category: 'Diğer',
  availability: 'available',
});

const predicates: ProgramSupportPredicate[] = [
  { id: 'photography', text: 'The attendee program is about photography.' },
];
const candidates = [
  event('exhibition', 'Exhibition', 'An exhibition of documentary photography projects.'),
  event('biography', 'Photography Star', 'The performer biography says she studied photography; the concert follows.'),
];

function response() {
  return {
    model: 'jev-1.13.0',
    usage: { input_tokens: 100, output_tokens: 12 },
    answers: {
      support_0_0: {
        type: 'choice',
        choice: 'supported',
        confidence: 0.8,
        probabilities: {
          supported: 0.8,
          contradicted: 0.05,
          insufficient_evidence: 0.15,
        },
      },
      support_1_0: {
        type: 'choice',
        choice: 'insufficient_evidence',
        confidence: 0.9,
        probabilities: {
          supported: 0.05,
          contradicted: 0.05,
          insufficient_evidence: 0.9,
        },
      },
    },
  };
}

void test('builds one isolated Choice for each candidate and mandatory predicate', () => {
  const body = buildProgramSupportRequest('jev-1.13.0', predicates, candidates);
  assert.deepEqual(Object.keys(body.questions), ['support_0_0', 'support_1_0']);
  assert.deepEqual(Object.keys(body.questions.support_0_0.criteria), [
    'supported',
    'contradicted',
    'insufficient_evidence',
  ]);
  assert.match(body.questions.support_0_0.instructions, /candidates\[0\]/);
  assert.match(body.questions.support_0_0.instructions, /mandatoryPredicates\[0\]/);
  assert.match(body.state.sourcePolicy.insufficientEvidence, /performer biography/);
  assert.match(body.state.sourcePolicy.insufficientEvidence, /incidental photo opportunity/);
  assert.equal('history' in body.state, false);
  assert.equal('optionalPreferences' in body.state, false);
  assert.equal('filters' in body.state, false);
});

void test('keeps title-only, biography, incidental photo, wrong-program, and missing evidence out of positive proof', () => {
  const controls = [
    event('title', 'Photography Night', 'A generic music performance.'),
    event('bio', 'Concert', 'The singer biography mentions a photography degree.'),
    event('incidental', 'Talk', 'Attendees may take a photo with the speaker afterward.'),
    event('wrong-program', 'Art Night', 'A painting workshop in a venue that also hosts photography.'),
    event('missing', 'Activity', 'Program details have not been announced.'),
  ];
  const body = buildProgramSupportRequest('jev-1.13.0', predicates, controls);
  assert.equal(Object.keys(body.questions).length, controls.length);
  for (const question of Object.values(body.questions)) {
    assert.match(question.criteria.insufficient_evidence, /related but different program/);
    assert.match(question.criteria.insufficient_evidence, /title, category, venue/i);
  }
});

void test('optional format cannot enter the request or veto mandatory topic support', () => {
  const body = buildProgramSupportRequest('jev-1.13.0', predicates, [candidates[0]]);
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /workshop would be nice|optionalPreferences|currentHistory/);
  assert.deepEqual(body.state.mandatoryPredicates, predicates);
});

void test('strict parser retains observed Choice probabilities and rejects malformed answer sets', () => {
  const parsed = parseProgramSupportResponse(response(), predicates, candidates);
  assert.equal(parsed.judgments[0].status, 'supported');
  assert.deepEqual(parsed.judgments[0].probabilities, {
    supported: 0.8,
    contradicted: 0.05,
    insufficient_evidence: 0.15,
  });
  assert.deepEqual(parsed.usage, { inputTokens: 100, outputTokens: 12 });

  const missing = structuredClone(response());
  delete (missing.answers as Record<string, unknown>).support_1_0;
  assert.throws(() => parseProgramSupportResponse(missing, predicates, candidates), /answer set/);
  const extra = structuredClone(response());
  (extra.answers as Record<string, unknown>).invented = extra.answers.support_0_0;
  assert.throws(() => parseProgramSupportResponse(extra, predicates, candidates), /answer set/);
  const malformed = structuredClone(response());
  malformed.answers.support_0_0.probabilities.supported = 0.9;
  assert.throws(() => parseProgramSupportResponse(malformed, predicates, candidates), /distribution/);
  const invented = structuredClone(response());
  (invented.answers.support_0_0.probabilities as Record<string, number>).unknown = 0;
  assert.throws(() => parseProgramSupportResponse(invented, predicates, candidates), /probability keys/);
  const contradictoryChoice = structuredClone(response());
  Object.assign(contradictoryChoice.answers.support_0_0, {
    choice: 'supported',
    probabilities: {
      supported: 0.1,
      contradicted: 0,
      insufficient_evidence: 0.9,
    },
  });
  assert.throws(
    () => parseProgramSupportResponse(contradictoryChoice, predicates, candidates),
    /choice contradicts/,
  );
  const tiedChoice = structuredClone(response());
  Object.assign(tiedChoice.answers.support_0_0, {
    choice: 'supported',
    probabilities: {
      supported: 0.5,
      contradicted: 0,
      insufficient_evidence: 0.5,
    },
  });
  assert.equal(
    parseProgramSupportResponse(tiedChoice, predicates, candidates).judgments[0].status,
    'supported',
  );
});

void test('bounds candidates, predicates, total questions, and serialized input', () => {
  assert.throws(() => buildProgramSupportRequest('jev-1.13.0', predicates, []));
  assert.throws(() => buildProgramSupportRequest('jev-1.13.0', [], candidates));
  const manyCandidates = Array.from({ length: 16 }, (_, index) =>
    event(`candidate-${index}`, 'Title', 'Description'),
  );
  const manyPredicates = Array.from({ length: 4 }, (_, index) => ({
    id: `predicate-${index}`,
    text: `Mandatory predicate ${index}`,
  }));
  assert.throws(
    () => buildProgramSupportRequest('jev-1.13.0', manyPredicates, manyCandidates),
    /at most 63 questions/,
  );
});

void test('composes AND, OR, and NOT with unknown never becoming true', () => {
  const statuses = new Map([
    ['a', 'supported' as const],
    ['b', 'insufficient_evidence' as const],
    ['c', 'contradicted' as const],
  ]);
  const predicate = (predicateId: string) => ({ op: 'predicate' as const, predicateId });
  assert.equal(
    composeProgramSupport({ op: 'and', operands: [predicate('a'), predicate('b')] }, statuses),
    'insufficient_evidence',
  );
  assert.equal(
    composeProgramSupport({ op: 'and', operands: [predicate('a'), predicate('c')] }, statuses),
    'contradicted',
  );
  assert.equal(
    composeProgramSupport({ op: 'or', operands: [predicate('b'), predicate('c')] }, statuses),
    'insufficient_evidence',
  );
  assert.equal(
    composeProgramSupport({ op: 'not', operand: predicate('b') }, statuses),
    'insufficient_evidence',
  );
  assert.equal(exclusionApplies('supported'), true);
  assert.equal(exclusionApplies('contradicted'), false);
  assert.equal(exclusionApplies('insufficient_evidence'), false);
});
