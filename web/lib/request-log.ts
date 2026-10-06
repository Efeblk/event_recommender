import type { RecommendInput } from './recommend.ts';
import type { SearchResult } from './types.ts';

/**
 * Request log for parser evaluation and later model training. It records
 * only during an approved staging test window, when the page tells testers.
 * No IP address, account or device identifier is stored.
 */
export const REQUEST_LOG_VERSION = 'request-log.v1';

export interface RequestLogEnv {
  DEPLOYMENT_ENV?: string;
  BIPLAN_PREVIEW_TESTING?: string;
}

export function requestLogEnabled(env: RequestLogEnv) {
  return env.DEPLOYMENT_ENV === 'staging' && env.BIPLAN_PREVIEW_TESTING === 'true';
}

export interface RequestLogEntry {
  version: typeof REQUEST_LOG_VERSION;
  id: string;
  at: string;
  deploymentSha: string | null;
  message: string;
  /** Earlier requests of the same search, oldest first. */
  previousRequests: string[];
  previousPlan: unknown;
  pendingReason: string | null;
  /** Field reader judgments (top answers with probabilities): the training labels. */
  parse: { status: string; reason: string | null; answers: Record<string, string> } | null;
  status: SearchResult['status'];
  notice: string | null;
  plan: unknown;
  recommendationIds: string[];
}

export function requestLogEntry(options: {
  id: string;
  at: Date;
  deploymentSha?: string;
  input: RecommendInput;
  parse?: { status: string; reason?: string; debug?: { answers: Record<string, string> } } | null;
  result: SearchResult;
}): RequestLogEntry {
  const { input, result, parse } = options;
  return {
    version: REQUEST_LOG_VERSION,
    id: options.id,
    at: options.at.toISOString(),
    deploymentSha: options.deploymentSha ?? null,
    message: input.message,
    previousRequests: input.planState?.requests ?? [],
    previousPlan: input.planState?.plan ?? null,
    pendingReason: input.pendingInput?.reason ?? null,
    parse: parse ? { status: parse.status, reason: parse.reason ?? null, answers: parse.debug?.answers ?? {} } : null,
    status: result.status,
    notice: result.notice,
    plan: result.planState?.plan ?? null,
    recommendationIds: result.recommendations.map((recommendation) => recommendation.event.id),
  };
}

/** One immutable object per request, grouped by UTC day. */
export function requestLogKey(namespace: string, entry: RequestLogEntry) {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(namespace) || !/^[a-f0-9-]{36}$/u.test(entry.id))
    throw new Error('Invalid request log key');
  return `biplan/${namespace}/requestLog/${entry.at.slice(0, 10)}/${entry.at.replace(/[:.]/gu, '-')}-${entry.id}.json`;
}
