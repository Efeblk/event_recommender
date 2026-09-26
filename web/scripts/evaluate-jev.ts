import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { buildJevRequest, rankWithJev, type JevRanking } from '../lib/jev.ts';
import { interpretConstraints, isEligible } from '../lib/search.ts';
import {
  MIN_JEV_SUPPORT_PROBABILITY,
  selectJevEvents,
} from '../lib/recommend.ts';
import { searchContext, shortlistEvents } from '../lib/retrieval.ts';
import { deriveRequirements, meetsRequirements } from '../lib/requirements.ts';
import { mergeEventSessions } from '../lib/event-merge.ts';
import { emptyFilters } from '../lib/types.ts';
import {
  evaluationCases,
  evaluationEvents,
  evaluationTime,
} from '../evals/jev-cases.ts';
import {
  candidateRecall,
  evaluationInputFingerprint,
  evaluateRecommendationList,
  summarizeEvaluations,
  validateReplayCoverage,
  validateReplaySnapshot,
} from '../evals/jev-evaluation.ts';

const DEFAULT_REPLAY = new URL(
  '../evals/replays/2026-09-24-jev-1.13.0-probabilities.json',
  import.meta.url,
);
const MAX_LIVE_CALLS = 12;
const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    replay: { type: 'string' },
    out: { type: 'string' },
  },
});
if (values.live && values.replay)
  throw new Error('--live and --replay are mutually exclusive.');

const model = process.env.TYPESAFE_MODEL || 'jev-1.13.0';
const cases = evaluationCases.map((item) => {
  const interpreted = interpretConstraints(
    item.message,
    item.filters,
    evaluationTime,
  );
  if (interpreted.issue)
    throw new Error(
      `Evaluation case ${item.id} cannot reach Jev: ${interpreted.issue}.`,
    );
  const context = searchContext(item.message, item.history);
  const requirements = deriveRequirements(item.message, context.history);
  const candidates = shortlistEvents(
    mergeEventSessions(
      evaluationEvents.filter((event) =>
        isEligible(event, emptyFilters, evaluationTime),
      ),
    ).filter(
      (event) =>
        isEligible(event, interpreted.filters, evaluationTime) &&
        meetsRequirements(event, requirements),
    ),
    item.message,
    item.history,
    16,
  );
  const prepared = {
    ...item,
    filters: interpreted.filters,
    history: context.history,
    requirements,
    candidates,
  };
  if (candidates.length) buildJevRequest(model, prepared, candidates);
  return prepared;
});

const plan = cases.map((item) => ({
  id: item.id,
  shortlistCount: item.candidates.length,
  acceptableCandidateIds: item.acceptableRecommendationIds.filter((id) =>
    item.candidates.some((candidate) => candidate.id === id),
  ),
  candidateRecall: candidateRecall(
    item,
    item.candidates.map(({ id }) => id),
  ),
}));
const positivePlan = plan.filter((item) => item.candidateRecall !== null);

type CaseResult = ReturnType<typeof evaluateRecommendationList> & {
  id: string;
  model?: string;
  ranking?: {
    id: string;
    score: number;
    confidence: number;
    probabilities: readonly [number, number, number, number];
    supportProbability: number;
  }[];
  unknownCandidateScoreIds?: string[];
  staleScoreIds?: string[];
  latencyMs?: number;
  usage?: JevRanking['usage'];
  error?: string;
  deterministic?: boolean;
  calledJev?: boolean;
};

function makeReport(
  results: CaseResult[],
  mode: 'live-rescore' | 'saved-score-replay',
  requestedModel: string,
) {
  const completed = results.filter((item) => !item.error);
  const responseModels = [
    ...new Set(completed.flatMap((item) => item.model ?? [])),
  ];
  return {
    schemaVersion: 2,
    evaluatedAt: new Date().toISOString(),
    status: completed.length === cases.length ? 'completed' : 'incomplete',
    mode,
    requestedModel,
    responseModels,
    model: responseModels.length === 1 ? responseModels[0] : null,
    calls: results.filter((item) => item.calledJev).length,
    plannedCalls:
      mode === 'live-rescore'
        ? cases.filter((item) => item.candidates.length).length
        : 0,
    minJevSupportProbability: MIN_JEV_SUPPORT_PROBABILITY,
    candidateRecall: positivePlan.length
      ? positivePlan.reduce(
          (sum, item) => sum + (item.candidateRecall ?? 0),
          0,
        ) / positivePlan.length
      : null,
    candidateRecallNoMatchCases: 'not_applicable',
    ...summarizeEvaluations(completed),
    inputTokens: results.reduce(
      (sum, item) => sum + (item.usage?.inputTokens ?? 0),
      0,
    ),
    outputTokens: results.reduce(
      (sum, item) => sum + (item.usage?.outputTokens ?? 0),
      0,
    ),
    note:
      mode === 'saved-score-replay'
        ? 'Historical score replay applies current candidate filtering, mandatory-evidence gates and production acceptance to previously saved scores. Saved scores use the historical rubric and cannot validate the current rubric or model quality. Empty filtered pools are deterministic zero-call results. Cases with unseen candidates are flagged instead of receiving guessed scores.'
        : 'Small fictional Turkish evaluation, not production approval. Live-catalog and user evaluations remain necessary.',
    plan,
    results,
  };
}

async function emit(value: unknown) {
  const output = JSON.stringify(value, null, 2) + '\n';
  if (values.out) await writeFile(values.out, output, { mode: 0o600 });
  console.log(output);
}

if (!values.live) {
  const replayUrl = values.replay
    ? new URL(values.replay, `file://${process.cwd()}/`)
    : DEFAULT_REPLAY;
  const snapshot = validateReplaySnapshot(
    JSON.parse(await readFile(replayUrl, 'utf8')),
  );
  const currentFingerprint = evaluationInputFingerprint(
    evaluationTime,
    evaluationEvents,
    evaluationCases,
  );
  if (snapshot.evaluationInputSha256 !== currentFingerprint)
    throw new Error(
      `Replay fixture/request fingerprint mismatch (saved ${snapshot.evaluationInputSha256}, current ${currentFingerprint}). Saved scores cannot be reused; make a new live snapshot. No request was made.`,
    );
  const replayById = new Map(snapshot.cases.map((item) => [item.id, item]));
  const results: CaseResult[] = cases.map((item) => {
    if (!item.candidates.length)
      return {
        id: item.id,
        deterministic: true,
        ...evaluateRecommendationList(item, []),
      };
    const saved = replayById.get(item.id);
    if (!saved)
      return {
        id: item.id,
        ...evaluateRecommendationList(item, []),
        error: 'Replay snapshot has no scores for this case.',
      };
    const coverage = validateReplayCoverage(
      item.candidates.map(({ id }) => id),
      saved.ranking,
    );
    if (coverage.unknownCandidateScoreIds.length)
      return {
        id: item.id,
        ...evaluateRecommendationList(item, []),
        ...coverage,
        error:
          'Current shortlist contains candidates absent from the saved score snapshot; filtering replay is unknown.',
      };
    if (
      saved.ranking.some(
        (item) => !item.probabilities || item.supportProbability === undefined,
      )
    )
      return {
        id: item.id,
        ...evaluateRecommendationList(item, []),
        ...coverage,
        error:
          'Replay snapshot predates Jev probability retention; current support-probability admission is unknown.',
      };
    const byId = new Map(
      item.candidates.map((candidate) => [candidate.id, candidate]),
    );
    const ranking: JevRanking = {
      model: snapshot.model,
      usage: { inputTokens: 0, outputTokens: 0 },
      ranked: saved.ranking
        .filter(({ id }) => byId.has(id))
        .map(({ id, score, confidence, probabilities, supportProbability }) => ({
          event: byId.get(id)!,
          score,
          confidence,
          probabilities: probabilities!,
          supportProbability: supportProbability!,
        })),
    };
    const acceptedIds = selectJevEvents(item.candidates, ranking).map(
      ({ id }) => id,
    );
    return {
      id: item.id,
      model: snapshot.model,
      ...evaluateRecommendationList(item, acceptedIds),
      ...coverage,
      ranking: saved.ranking.map((item) => ({
        id: item.id,
        score: item.score,
        confidence: item.confidence,
        probabilities: item.probabilities!,
        supportProbability: item.supportProbability!,
      })),
    };
  });
  const output = makeReport(results, 'saved-score-replay', snapshot.model);
  await emit({
    ...output,
    replay: { source: replayUrl.pathname, provenance: snapshot.provenance },
  });
  if (output.status !== 'completed' || output.wholeListAccuracy !== 1)
    process.exitCode = 1;
} else {
  const plannedCalls = cases.filter((item) => item.candidates.length).length;
  if (plannedCalls > MAX_LIVE_CALLS)
    throw new Error(
      `Live evaluation suite requires ${plannedCalls} calls; the hard ceiling is ${MAX_LIVE_CALLS}. No request was made.`,
    );
  const local: Record<string, string> = {};
  for (const name of ['.env', '.dev.vars']) {
    try {
      const parsed = parseEnv(
        await readFile(new URL(`../${name}`, import.meta.url), 'utf8'),
      );
      for (const key of ['TYPESAFE_API_KEY', 'TYPESAFE_MODEL'])
        if (parsed[key]) local[key] = parsed[key];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const apiKey = process.env.TYPESAFE_API_KEY || local.TYPESAFE_API_KEY || '';
  if (!apiKey)
    throw new Error(
      'Set TYPESAFE_API_KEY in the environment or ignored web/.dev.vars; never paste it into chat. No request was made.',
    );
  const config = {
    apiKey,
    model: process.env.TYPESAFE_MODEL || local.TYPESAFE_MODEL || model,
  };
  const results: CaseResult[] = [];
  // Fixed suite only, deliberately serial, at most 12 calls, no retries.
  for (const item of cases) {
    if (!item.candidates.length) {
      results.push({
        id: item.id,
        deterministic: true,
        ...evaluateRecommendationList(item, []),
      });
      continue;
    }
    const start = performance.now();
    try {
      const ranking = await rankWithJev(config, item, item.candidates);
      const acceptedIds = selectJevEvents(item.candidates, ranking).map(
        ({ id }) => id,
      );
      results.push({
        id: item.id,
        calledJev: true,
        model: ranking.model,
        ...evaluateRecommendationList(item, acceptedIds),
        latencyMs: Math.round(performance.now() - start),
        usage: ranking.usage,
        ranking: ranking.ranked.map(
          ({ event, score, confidence, probabilities, supportProbability }) => ({
          id: event.id,
          score,
          confidence,
          probabilities,
          supportProbability,
        }),
        ),
      });
    } catch (error) {
      results.push({
        id: item.id,
        calledJev: true,
        ...evaluateRecommendationList(item, []),
        latencyMs: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : 'Evaluation failed',
      });
      break;
    }
  }
  const output = makeReport(results, 'live-rescore', config.model);
  await emit(output);
  if (output.status !== 'completed' || output.wholeListAccuracy !== 1)
    process.exitCode = 1;
}
