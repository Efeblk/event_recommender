import { createHash } from 'node:crypto';
import type { EventRecord } from '../lib/types.ts';
import type { JevEvaluationCase } from './jev-cases.ts';

export interface RecommendationListEvaluation {
  acceptedIds: string[];
  acceptableAcceptedIds: string[];
  unacceptableAcceptedIds: string[];
  forbiddenAcceptedIds: string[];
  top1Hit: boolean | null;
  precision: number | null;
  expectedNoMatch: boolean;
  noMatchCorrect: boolean | null;
  wholeListCorrect: boolean;
}

export function evaluateRecommendationList(
  label: Pick<
    JevEvaluationCase,
    | 'acceptableRecommendationIds'
    | 'forbiddenRecommendationIds'
    | 'expectedNoMatch'
  >,
  acceptedIds: string[],
): RecommendationListEvaluation {
  const acceptable = new Set(label.acceptableRecommendationIds);
  const forbidden = new Set(label.forbiddenRecommendationIds);
  const acceptableAcceptedIds = acceptedIds.filter((id) => acceptable.has(id));
  const unacceptableAcceptedIds = acceptedIds.filter(
    (id) => !acceptable.has(id),
  );
  const forbiddenAcceptedIds = acceptedIds.filter((id) => forbidden.has(id));
  const top1Hit = label.expectedNoMatch
    ? null
    : acceptable.has(acceptedIds[0] ?? '');
  const noMatchCorrect = label.expectedNoMatch
    ? acceptedIds.length === 0
    : null;
  return {
    acceptedIds,
    acceptableAcceptedIds,
    unacceptableAcceptedIds,
    forbiddenAcceptedIds,
    top1Hit,
    precision: acceptedIds.length
      ? acceptableAcceptedIds.length / acceptedIds.length
      : null,
    expectedNoMatch: label.expectedNoMatch,
    noMatchCorrect,
    wholeListCorrect: label.expectedNoMatch
      ? acceptedIds.length === 0
      : top1Hit === true && unacceptableAcceptedIds.length === 0,
  };
}

export function candidateRecall(
  label: Pick<
    JevEvaluationCase,
    'acceptableRecommendationIds' | 'expectedNoMatch'
  >,
  candidateIds: string[],
): number | null {
  if (label.expectedNoMatch) return null;
  const candidates = new Set(candidateIds);
  return (
    label.acceptableRecommendationIds.filter((id) => candidates.has(id))
      .length / label.acceptableRecommendationIds.length
  );
}

export function summarizeEvaluations(
  evaluations: RecommendationListEvaluation[],
) {
  const positive = evaluations.filter(
    ({ expectedNoMatch }) => !expectedNoMatch,
  );
  const noMatch = evaluations.filter(({ expectedNoMatch }) => expectedNoMatch);
  const acceptedCount = evaluations.reduce(
    (sum, item) => sum + item.acceptedIds.length,
    0,
  );
  const acceptableAcceptedCount = evaluations.reduce(
    (sum, item) => sum + item.acceptableAcceptedIds.length,
    0,
  );
  return {
    cases: evaluations.length,
    wholeListCorrect: evaluations.filter((item) => item.wholeListCorrect)
      .length,
    wholeListAccuracy: evaluations.length
      ? evaluations.filter((item) => item.wholeListCorrect).length /
        evaluations.length
      : null,
    top1Hits: positive.filter((item) => item.top1Hit).length,
    top1Accuracy: positive.length
      ? positive.filter((item) => item.top1Hit).length / positive.length
      : null,
    acceptedCount,
    acceptableAcceptedCount,
    forbiddenAcceptedCount: evaluations.reduce(
      (sum, item) => sum + item.forbiddenAcceptedIds.length,
      0,
    ),
    unacceptableAcceptedCount: evaluations.reduce(
      (sum, item) => sum + item.unacceptableAcceptedIds.length,
      0,
    ),
    recommendationPrecision: acceptedCount
      ? acceptableAcceptedCount / acceptedCount
      : null,
    noMatchCases: noMatch.length,
    noMatchCorrect: noMatch.filter((item) => item.noMatchCorrect).length,
    noMatchFalsePositives: noMatch.filter(
      (item) => item.noMatchCorrect === false,
    ).length,
  };
}

export interface ReplayRankingItem {
  id: string;
  score: number;
  confidence: number;
  probabilities?: readonly [number, number, number, number];
  supportProbability?: number;
}

export interface ReplayCase {
  id: string;
  ranking: ReplayRankingItem[];
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function evaluationInputFingerprint(
  evaluationTime: Date,
  events: EventRecord[],
  cases: Pick<JevEvaluationCase, 'id' | 'message' | 'filters' | 'history'>[],
): string {
  const input = {
    evaluationTime: evaluationTime.toISOString(),
    events,
    cases: cases.map(({ id, message, filters, history }) => ({
      id,
      message,
      filters,
      history,
    })),
  };
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}

function record(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid replay snapshot ${description}.`);
  return value as Record<string, unknown>;
}

export interface ReplaySnapshot {
  kind: 'jev-offline-score-replay';
  model: string;
  evaluationInputSha256: string;
  provenance: unknown;
  cases: ReplayCase[];
}

export function validateReplaySnapshot(value: unknown): ReplaySnapshot {
  const snapshot = record(value, 'root');
  if (snapshot.kind !== 'jev-offline-score-replay')
    throw new Error('Unsupported replay snapshot kind.');
  if (
    typeof snapshot.model !== 'string' ||
    !/^jev-[a-z0-9.-]+$/.test(snapshot.model)
  )
    throw new Error('Invalid replay snapshot model.');
  if (
    typeof snapshot.evaluationInputSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(snapshot.evaluationInputSha256)
  )
    throw new Error('Invalid replay snapshot evaluation fingerprint.');
  if (!Array.isArray(snapshot.cases))
    throw new Error('Invalid replay snapshot cases.');
  const caseIds = new Set<string>();
  const cases = snapshot.cases.map((rawCase, caseIndex) => {
    const item = record(rawCase, `case ${caseIndex}`);
    if (typeof item.id !== 'string' || !item.id)
      throw new Error(`Invalid replay snapshot case ${caseIndex} ID.`);
    const caseId = item.id;
    if (caseIds.has(caseId))
      throw new Error(`Duplicate replay snapshot case ID: ${caseId}.`);
    caseIds.add(caseId);
    if (!Array.isArray(item.ranking))
      throw new Error(`Invalid replay snapshot ranking for ${caseId}.`);
    const candidateIds = new Set<string>();
    const ranking = item.ranking.map((rawRanking, rankingIndex) => {
      const ranked = record(
        rawRanking,
        `ranking ${rankingIndex} for ${caseId}`,
      );
      if (typeof ranked.id !== 'string' || !ranked.id)
        throw new Error(`Invalid replay candidate ID for ${caseId}.`);
      const candidateId = ranked.id;
      if (candidateIds.has(candidateId))
        throw new Error(
          `Duplicate replay candidate ID ${candidateId} for ${caseId}.`,
        );
      candidateIds.add(candidateId);
      if (
        typeof ranked.score !== 'number' ||
        !Number.isFinite(ranked.score) ||
        ranked.score < 0 ||
        ranked.score > 3
      )
        throw new Error(`Invalid replay score for ${caseId}/${candidateId}.`);
      const score = ranked.score;
      if (
        typeof ranked.confidence !== 'number' ||
        !Number.isFinite(ranked.confidence) ||
        ranked.confidence < 0 ||
        ranked.confidence > 1
      )
        throw new Error(
          `Invalid replay confidence for ${caseId}/${candidateId}.`,
        );
      const confidence = ranked.confidence;
      let probabilityFields: Pick<
        ReplayRankingItem,
        'probabilities' | 'supportProbability'
      > = {};
      if (ranked.probabilities !== undefined || ranked.supportProbability !== undefined) {
        if (
          !Array.isArray(ranked.probabilities) ||
          ranked.probabilities.length !== 4 ||
          !ranked.probabilities.every(
            (value) =>
              typeof value === 'number' &&
              Number.isFinite(value) &&
              value >= 0 &&
              value <= 1,
          ) ||
          Math.abs(
            ranked.probabilities.reduce(
              (sum: number, value: number) => sum + value,
              0,
            ) - 1,
          ) > 0.02 ||
          typeof ranked.supportProbability !== 'number' ||
          !Number.isFinite(ranked.supportProbability) ||
          Math.abs(
            ranked.supportProbability -
              (ranked.probabilities[2] + ranked.probabilities[3]),
          ) > 1e-9
        )
          throw new Error(
            `Invalid replay probabilities for ${caseId}/${candidateId}.`,
          );
        probabilityFields = {
          probabilities: ranked.probabilities as unknown as readonly [
            number,
            number,
            number,
            number,
          ],
          supportProbability: ranked.supportProbability,
        };
      }
      return {
        id: candidateId,
        score,
        confidence,
        ...probabilityFields,
      };
    });
    return { id: caseId, ranking };
  });
  return {
    kind: snapshot.kind,
    model: snapshot.model,
    evaluationInputSha256: snapshot.evaluationInputSha256,
    provenance: snapshot.provenance,
    cases,
  };
}

export function validateReplayCoverage(
  candidateIds: string[],
  ranking: ReplayRankingItem[],
) {
  const scoresById = new Map(ranking.map((item) => [item.id, item]));
  const candidates = new Set(candidateIds);
  return {
    unknownCandidateScoreIds: candidateIds.filter((id) => !scoresById.has(id)),
    staleScoreIds: ranking
      .map(({ id }) => id)
      .filter((id) => !candidates.has(id)),
  };
}
