import type { EventRecord } from '../lib/types.ts';
import type { JevEvaluationCase } from './jev-cases.ts';

export const JEV_LABEL_POLICY_VERSION = 'strict-budget-boundary-v1';

export const JEV_LABEL_POLICY_REASON =
  'Corrects one historical label that treated an event priced exactly at 500 TL as satisfying the strict request “500 TL altında”. Original fixtures, saved scores, fingerprints, and reports remain unchanged.';

export interface JevLabelPolicy {
  version: string;
  reason: string;
  corrections: { caseId: string; reason: string }[];
}

const budgetCaseId = 'budget';
const budgetMessage = '500 TL altında akustik konser arıyorum.';
const originalAcceptable = ['acoustic'];

function sameStrings(actual: string[], expected: string[]) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export function applyJevLabelCorrections(
  cases: JevEvaluationCase[],
  events: EventRecord[],
): { cases: JevEvaluationCase[]; policy: JevLabelPolicy } {
  const target = cases.find(({ id }) => id === budgetCaseId);
  const acoustic = events.find(({ id }) => id === 'acoustic');
  const expectedForbidden = events
    .map(({ id }) => id)
    .filter((id) => id !== 'acoustic');
  if (
    !target ||
    target.message !== budgetMessage ||
    target.expectedNoMatch !== false ||
    !sameStrings(target.acceptableRecommendationIds, originalAcceptable) ||
    !sameStrings(target.forbiddenRecommendationIds, expectedForbidden) ||
    !acoustic ||
    acoustic.price !== 500 ||
    acoustic.currency !== 'TRY'
  )
    throw new Error(
      'Historical Jev budget label no longer matches its guarded source evidence; review the correction explicitly.',
    );

  const allEventIds = events.map(({ id }) => id);
  return {
    cases: cases.map((item) =>
      item.id === budgetCaseId
        ? {
            ...item,
            acceptableRecommendationIds: [],
            forbiddenRecommendationIds: allEventIds,
            expectedNoMatch: true,
          }
        : item,
    ),
    policy: {
      version: JEV_LABEL_POLICY_VERSION,
      reason: JEV_LABEL_POLICY_REASON,
      corrections: [
        {
          caseId: budgetCaseId,
          reason:
            'The acoustic event costs exactly 500 TL and therefore does not satisfy “500 TL altında”.',
        },
      ],
    },
  };
}
