import test from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateRecall,
  evaluationInputFingerprint,
  evaluateRecommendationList,
  summarizeEvaluations,
  validateReplayCoverage,
  validateReplaySnapshot,
} from '../evals/jev-evaluation.ts';
import {
  evaluationCases,
  evaluationEvents,
  evaluationTime,
} from '../evals/jev-cases.ts';

const positiveLabel = {
  acceptableRecommendationIds: ['drama'],
  forbiddenRecommendationIds: ['children', 'comedy', 'rock'],
  expectedNoMatch: false,
};

await test('a correct top result still fails when a forbidden secondary is returned', () => {
  const result = evaluateRecommendationList(positiveLabel, ['drama', 'rock']);
  assert.equal(result.top1Hit, true);
  assert.equal(result.precision, 0.5);
  assert.deepEqual(result.forbiddenAcceptedIds, ['rock']);
  assert.equal(result.wholeListCorrect, false);

  assert.equal(
    evaluateRecommendationList(positiveLabel, ['drama', 'unseen'])
      .wholeListCorrect,
    false,
  );

  const summary = summarizeEvaluations([result]);
  assert.equal(summary.top1Accuracy, 1);
  assert.equal(summary.wholeListAccuracy, 0);
  assert.equal(summary.recommendationPrecision, 0.5);
  assert.equal(summary.forbiddenAcceptedCount, 1);
});

await test('expected no-match cases require an empty list and have no candidate recall', () => {
  const label = {
    acceptableRecommendationIds: [],
    forbiddenRecommendationIds: ['acoustic', 'unknown'],
    expectedNoMatch: true,
  };
  assert.equal(candidateRecall(label, ['acoustic']), null);
  assert.equal(evaluateRecommendationList(label, []).wholeListCorrect, true);
  const falsePositive = evaluateRecommendationList(label, ['acoustic']);
  assert.equal(falsePositive.noMatchCorrect, false);
  assert.equal(falsePositive.wholeListCorrect, false);
});

await test('replay coverage flags candidates without saved scores', () => {
  const coverage = validateReplayCoverage(
    ['drama', 'new-event'],
    [
      { id: 'drama', score: 3, confidence: 1 },
      { id: 'old-event', score: 0, confidence: 1 },
    ],
  );
  assert.deepEqual(coverage.unknownCandidateScoreIds, ['new-event']);
  assert.deepEqual(coverage.staleScoreIds, ['old-event']);
});

const validSnapshot = () => ({
  kind: 'jev-offline-score-replay',
  model: 'jev-1.13.0',
  evaluationInputSha256: 'a'.repeat(64),
  provenance: {},
  cases: [
    {
      id: 'case-1',
      ranking: [{ id: 'event-1', score: 2.5, confidence: 0.8 }],
    },
  ],
});

await test('replay snapshots reject duplicate and malformed saved scores', () => {
  assert.deepEqual(validateReplaySnapshot(validSnapshot()).cases[0].ranking, [
    { id: 'event-1', score: 2.5, confidence: 0.8 },
  ]);

  const duplicateCase = validSnapshot();
  duplicateCase.cases.push(structuredClone(duplicateCase.cases[0]));
  assert.throws(
    () => validateReplaySnapshot(duplicateCase),
    /Duplicate.*case/i,
  );

  const duplicateCandidate = validSnapshot();
  duplicateCandidate.cases[0].ranking.push({
    id: 'event-1',
    score: 1,
    confidence: 1,
  });
  assert.throws(
    () => validateReplaySnapshot(duplicateCandidate),
    /Duplicate.*candidate/i,
  );

  for (const [field, value] of [
    ['score', Number.NaN],
    ['score', 3.01],
    ['confidence', Number.POSITIVE_INFINITY],
    ['confidence', -0.01],
  ] as const) {
    const invalid = validSnapshot();
    invalid.cases[0].ranking[0][field] = value;
    assert.throws(
      () => validateReplaySnapshot(invalid),
      new RegExp(field, 'i'),
    );
  }
  const missingScore = validSnapshot() as unknown as {
    cases: { ranking: Record<string, unknown>[] }[];
  };
  delete missingScore.cases[0].ranking[0].score;
  assert.throws(() => validateReplaySnapshot(missingScore), /score/i);

  const withProbabilities = validSnapshot();
  Object.assign(withProbabilities.cases[0].ranking[0], {
    probabilities: [0, 0.1, 0.7, 0.2],
    supportProbability: 0.9,
  });
  assert.deepEqual(
    validateReplaySnapshot(withProbabilities).cases[0].ranking[0]
      .probabilities,
    [0, 0.1, 0.7, 0.2],
  );
  Object.assign(withProbabilities.cases[0].ranking[0], {
    supportProbability: 0.8,
  });
  assert.throws(
    () => validateReplaySnapshot(withProbabilities),
    /probabilities/i,
  );
});

await test('evaluation fingerprint tracks scored inputs but excludes labels and policy', () => {
  const fingerprint = evaluationInputFingerprint(
    evaluationTime,
    evaluationEvents,
    evaluationCases,
  );
  assert.equal(
    fingerprint,
    '62a230f98f3811bd97232a4cab1d0e2f8154f8cdd200daa0f9e49305e145824a',
  );
  const relabeled = structuredClone(evaluationCases);
  relabeled[0].acceptableRecommendationIds = ['rock'];
  relabeled[0].forbiddenRecommendationIds = ['acoustic'];
  assert.equal(
    evaluationInputFingerprint(evaluationTime, evaluationEvents, relabeled),
    fingerprint,
  );

  const changedRequest = structuredClone(evaluationCases);
  changedRequest[0].message += ' değişti';
  assert.notEqual(
    evaluationInputFingerprint(
      evaluationTime,
      evaluationEvents,
      changedRequest,
    ),
    fingerprint,
  );
  assert.notEqual(
    evaluationInputFingerprint(
      evaluationTime,
      [
        { ...evaluationEvents[0], description: 'değişti' },
        ...evaluationEvents.slice(1),
      ],
      evaluationCases,
    ),
    fingerprint,
  );
  assert.notEqual(
    evaluationInputFingerprint(
      new Date(evaluationTime.getTime() + 1),
      evaluationEvents,
      evaluationCases,
    ),
    fingerprint,
  );
});
