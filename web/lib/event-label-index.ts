/**
 * Bounded event labeling (Phase 1R, R4). Each call labels a batch of pending
 * documents with Jev and saves the labels by label hash. A durable ledger in
 * the control store reserves tokens before each paid call and keeps failed
 * reservations charged. A provider failure stops the run; there are no retries.
 */
import { withDeadline } from './deadline.ts';
import type { JevConfig } from './jev.ts';
import { buildLabelRequest, composeLabels, labelHash, unknownLabels, type EventLabels } from './event-labels.ts';
import type { ControlStore, HighLevelStore, Lease } from './storage-contract.ts';
import type { EventRecord } from './types.ts';
import type { JevResponse } from '../parser/parse-core.ts';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MAX_RESPONSE_BYTES = 200_000;
/** Reserved tokens per call (input and output). The pilot used about 4,700. */
export const LABEL_TOKENS_PER_CALL = 9_000;
export const labelIndexLimits = Object.freeze({
  maxCallsPerBatch: 48,
  maxTokenCap: 40_000_000,
  concurrency: 6,
  timeBudgetMs: 120_000,
  callTimeoutMs: 30_000,
});

export interface LabelIndexInput {
  /** Durable cap on all reserved tokens for this label profile. */
  tokenCap: number;
  maxCalls: number;
  /** Clears a halt after a reviewed provider failure. */
  resume?: boolean;
}
interface Ledger {
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens charged for calls without reported usage. */
  chargedTokens: number;
  halted: boolean;
  updatedAt: string;
}
interface Dependencies {
  store: HighLevelStore;
  control: ControlStore;
  namespace: string;
  now?: () => number;
  fetcher?: typeof fetch;
}

export function parseLabelIndexInput(value: unknown): LabelIndexInput {
  const v = value as Partial<LabelIndexInput> | null;
  if (
    !v ||
    !Number.isSafeInteger(v.tokenCap) ||
    v.tokenCap! < 1 ||
    v.tokenCap! > labelIndexLimits.maxTokenCap ||
    !Number.isSafeInteger(v.maxCalls) ||
    v.maxCalls! < 1 ||
    v.maxCalls! > labelIndexLimits.maxCallsPerBatch
  )
    throw new Error('Invalid label index input');
  if (v.resume !== undefined && typeof v.resume !== 'boolean') throw new Error('Invalid label index input');
  return { tokenCap: v.tokenCap!, maxCalls: v.maxCalls!, ...(v.resume ? { resume: true } : {}) };
}

const spent = (ledger: Ledger) => ledger.inputTokens + ledger.outputTokens + ledger.chargedTokens;

async function readBounded(response: Response): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES)
    throw new Error('Label response too large');
  return JSON.parse(text);
}

function validEnvelope(value: unknown): value is JevResponse {
  const v = value as Partial<JevResponse> | null;
  return Boolean(
    v &&
      typeof v.model === 'string' &&
      v.answers &&
      typeof v.answers === 'object' &&
      v.usage &&
      Number.isSafeInteger(v.usage.input_tokens) &&
      Number.isSafeInteger(v.usage.output_tokens),
  );
}

async function labelOne(
  config: JevConfig,
  event: EventRecord,
  fetcher: typeof fetch,
): Promise<{ labels: EventLabels | null; usage: JevResponse['usage'] | null }> {
  const built = buildLabelRequest(event);
  const body = JSON.stringify({ model: config.model, state: built.state, questions: built.questions });
  try {
    const value = await withDeadline(labelIndexLimits.callTimeoutMs, 'Label call timed out', async (signal) => {
      const response = await fetcher(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body,
        redirect: 'manual',
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error('Label call failed');
      }
      return readBounded(response);
    });
    if (!validEnvelope(value)) return { labels: null, usage: null };
    return { labels: composeLabels(built, value), usage: value.usage };
  } catch {
    return { labels: null, usage: null };
  }
}

export async function labelStatus(store: HighLevelStore, control: ControlStore, namespace: string, at: Date) {
  const pending = await pendingDocuments(store, at);
  const ledger = await control.get<Ledger>(`biplan/${namespace}/eventLabels/ledger`);
  return { ...pending.counts, ledger };
}

async function pendingDocuments(store: HighLevelStore, at: Date) {
  const events = await store.embeddingCandidates(at);
  const documents = new Map<string, EventRecord>();
  for (const event of events) {
    const hash = await labelHash(event);
    if (!documents.has(hash)) documents.set(hash, event);
  }
  const cached = (await store.eventLabelsByHash?.([...documents.keys()])) ?? new Map();
  const pending = [...documents]
    .filter(([hash]) => !cached.has(hash))
    .sort(([a], [b]) => a.localeCompare(b));
  return { pending, counts: { documents: documents.size, labeled: cached.size, pending: pending.length } };
}

export async function labelEventBatch(
  config: JevConfig,
  input: LabelIndexInput,
  lease: Lease,
  deps: Dependencies,
) {
  input = parseLabelIndexInput(input);
  if (lease.key !== 'label_index_lock') throw new Error('Wrong label lease');
  if (!deps.store.saveEventLabels) throw new Error('Label storage is unavailable');
  const now = deps.now ?? Date.now,
    fetcher = deps.fetcher ?? fetch,
    started = now();
  const ledgerPath = `biplan/${deps.namespace}/eventLabels/ledger`;
  const { pending, counts } = await pendingDocuments(deps.store, new Date(now()));
  const result = { ...counts, labeled: counts.labeled, calls: 0, saved: 0, invalid: 0, failed: 0, usage: { inputTokens: 0, outputTokens: 0 } };
  if (!pending.length) return { ...result, outcome: 'complete' as const };
  const queue = pending.slice(0, input.maxCalls);
  let stop: string | null = null;
  const saved: { hash: string; labels: EventLabels }[] = [];
  while (queue.length && !stop) {
    if (now() - started > labelIndexLimits.timeBudgetMs) {
      stop = 'time';
      break;
    }
    if (lease.expiresAt <= now() + labelIndexLimits.callTimeoutMs + 15_000) {
      stop = 'lease';
      break;
    }
    const batch = queue.splice(0, labelIndexLimits.concurrency);
    // Reserve the whole batch before any paid call.
    const reserved = await deps.control.transaction(async (tx) => {
      const ledger = (await tx.get<Ledger>(ledgerPath)) ?? {
        calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0, chargedTokens: 0, halted: false, updatedAt: '',
      };
      if (ledger.halted && !input.resume) return 'halted' as const;
      input.resume = false;
      if (spent(ledger) + batch.length * LABEL_TOKENS_PER_CALL > input.tokenCap) return 'budget' as const;
      tx.set(ledgerPath, {
        ...ledger,
        halted: false,
        calls: ledger.calls + batch.length,
        chargedTokens: ledger.chargedTokens + batch.length * LABEL_TOKENS_PER_CALL,
        updatedAt: new Date(now()).toISOString(),
      });
      return 'ok' as const;
    });
    if (reserved !== 'ok') {
      stop = reserved;
      break;
    }
    const outcomes = await Promise.all(batch.map(([, event]) => labelOne(config, event, fetcher)));
    result.calls += batch.length;
    let input_ = 0,
      output = 0,
      failed = 0;
    outcomes.forEach((outcome, i) => {
      if (!outcome.usage) {
        failed++;
        return;
      }
      input_ += outcome.usage.input_tokens;
      output += outcome.usage.output_tokens;
      // An invalid answer set is stored as unknown labels, so it is not paid for again.
      if (!outcome.labels) result.invalid++;
      saved.push({ hash: batch[i][0], labels: outcome.labels ?? unknownLabels() });
    });
    result.failed += failed;
    result.usage.inputTokens += input_;
    result.usage.outputTokens += output;
    // Settle reported usage. A failed call keeps its reservation charged.
    await deps.control.transaction(async (tx) => {
      const ledger = (await tx.get<Ledger>(ledgerPath))!;
      const settled = batch.length - failed;
      tx.set(ledgerPath, {
        ...ledger,
        failedCalls: ledger.failedCalls + failed,
        inputTokens: ledger.inputTokens + input_,
        outputTokens: ledger.outputTokens + output,
        chargedTokens: ledger.chargedTokens - settled * LABEL_TOKENS_PER_CALL,
        halted: ledger.halted || failed > 0,
        updatedAt: new Date(now()).toISOString(),
      });
    });
    if (failed) stop = 'provider';
  }
  if (saved.length) {
    await deps.store.saveEventLabels(saved, lease);
    result.saved = saved.length;
  }
  const remaining = counts.pending - saved.length;
  return {
    ...result,
    labeled: counts.labeled + saved.length,
    pending: remaining,
    outcome: stop ? ('bounded-stop' as const) : remaining ? ('partial' as const) : ('complete' as const),
    ...(stop ? { reason: stop } : {}),
  };
}
