import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { rankWithJev, buildJevRequest } from '../lib/jev.ts';
import { isEligible, rankEvents, uniqueEvents } from '../lib/search.ts';
import {
  evaluationCases,
  evaluationEvents,
  evaluationTime,
} from '../evals/jev-cases.ts';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});
const model = process.env.TYPESAFE_MODEL || 'jev-1.13.0';
const cases = evaluationCases.map((item) => ({
  ...item,
  candidates: uniqueEvents(
    rankEvents(
      evaluationEvents.filter((event) =>
        isEligible(event, item.filters, evaluationTime),
      ),
      item.message,
    ),
    16,
  ),
}));
for (const item of cases) buildJevRequest(model, item, item.candidates);
if (!values.live) {
  console.log(
    JSON.stringify(
      {
        status: 'not_run',
        model,
        cases: cases.length,
        networkCalls: 0,
        note: 'Fixture/request validation only. Use --live with TYPESAFE_API_KEY to measure model quality; this spends API credit.',
      },
      null,
      2,
    ),
  );
} else {
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
  const results = [];
  // Deliberately serial and bounded: at most 12 requests, no automatic retries.
  for (const item of cases) {
    const start = performance.now();
    try {
      const result = await rankWithJev(config, item, item.candidates);
      results.push({
        id: item.id,
        latencyMs: Math.round(performance.now() - start),
        model: result.model,
        usage: result.usage,
        baselineTop: item.candidates[0]?.id,
        acceptableTop: item.acceptableTop,
        ranking: result.ranked.map(({ event, score, confidence }) => ({
          id: event.id,
          score,
          confidence,
        })),
        top1Hit: item.acceptableTop.length
          ? item.acceptableTop.includes(result.ranked[0]?.event.id)
          : null,
      });
    } catch (error) {
      results.push({
        id: item.id,
        latencyMs: Math.round(performance.now() - start),
        error: error instanceof Error ? error.message : 'Evaluation failed',
      });
      // Authentication/rate-limit/service failure is actionable; don't keep spending blindly.
      break;
    }
  }
  const labeled = results.filter(
    (result) => result.top1Hit !== undefined && result.top1Hit !== null,
  );
  const report = {
    schemaVersion: 1,
    evaluatedAt: new Date().toISOString(),
    status: results.some((result) => result.error) ? 'incomplete' : 'completed',
    model: config.model,
    calls: results.length,
    plannedCalls: cases.length,
    top1Accuracy: labeled.length
      ? labeled.filter((result) => result.top1Hit).length / labeled.length
      : null,
    inputTokens: results.reduce(
      (sum, result) => sum + (result.usage?.inputTokens || 0),
      0,
    ),
    outputTokens: results.reduce(
      (sum, result) => sum + (result.usage?.outputTokens || 0),
      0,
    ),
    note: 'Small fictional Turkish evaluation, not production approval. Unsupported-preference cases require inspecting scores; confidence is not factual correctness. Live-catalog and user evaluations remain necessary.',
    results,
  };
  const output = JSON.stringify(report, null, 2) + '\n';
  if (values.out) await writeFile(values.out, output, { mode: 0o600 });
  console.log(output);
  if (report.status !== 'completed') process.exitCode = 1;
}
