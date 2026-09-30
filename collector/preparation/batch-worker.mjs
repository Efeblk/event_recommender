import { performance } from 'node:perf_hooks';
import { prepareCanonicalSearch } from './canonical-worker.mjs';

function integer(value, min, max, name) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`); }
function worker(value) { if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('Invalid batch worker'); }
const failure = (error, interrupted) => {
  const conflict = /deadlock|lock timeout|guard|base publication|dependency head/i.test(String(error?.message));
  const budget = error?.code === 'publication_budget';
  const publicationTimeout = error?.publicationTimeout === true;
  const connectionReset = error?.publicationResetFailed === true;
  return { code: interrupted ? 'worker_interrupted' : budget ? 'publication_budget' : publicationTimeout ? 'publication_timeout' : connectionReset ? 'publication_connection_reset' : conflict ? 'batch_conflict' : 'batch_error',
    retryable: interrupted || budget || publicationTimeout || connectionReset || conflict, message: String(error?.message ?? error).slice(0, 600) };
};

export async function runBatchPreparation({ store, batchId, workerId, maxJobs = 100, leaseSeconds = 120, timeBudgetMs = 30000, signal,
  now = () => performance.now(), prepare = prepareCanonicalSearch }) {
  integer(maxJobs, 0, 1000, 'batch job limit'); integer(leaseSeconds, 1, 900, 'batch lease'); integer(timeBudgetMs, 1, 60000, 'batch deadline'); worker(workerId);
  if (typeof batchId !== 'string' || !batchId.trim()) throw new Error('Invalid batch id');
  const started = now(), summary = { batchId, workerId, claimed: 0, completed: 0, failures: [], receipts: [], stopped: 'drained' };
  const eligible = () => !signal?.aborted && now() - started < timeBudgetMs;
  while (summary.claimed < maxJobs && eligible()) {
    const [job] = await store.claimJobs(batchId, workerId, 1, leaseSeconds); if (!job) break; summary.claimed++;
    try {
      const input = await store.input(job, workerId), result = await prepare(input, job);
      if (signal?.aborted) throw Object.assign(new Error('Batch worker interrupted before completion'), { code: 'worker_interrupted' });
      const receipt = await store.complete(job, workerId, result); summary.completed++; summary.receipts.push(receipt);
    } catch (error) {
      const detail = failure(error, signal?.aborted === true || error?.code === 'worker_interrupted'); let persistence = 'failed';
      try { const saved = await store.fail(job, workerId, detail); if (saved?.status === 'pending') persistence = 'retry_scheduled'; } catch { persistence = 'uncertain'; }
      summary.failures.push({ id: job.id, ...detail, persistence }); break;
    }
  }
  summary.stopped = signal?.aborted ? 'interrupted' : summary.failures.length ? 'error' : now() - started >= timeBudgetMs ? 'time_budget' : summary.claimed === maxJobs && maxJobs > 0 ? 'item_limit' : 'drained';
  summary.elapsedMs = Math.round((now() - started) * 100) / 100; return summary;
}

export async function runBatchPublication({ store, batchId, workerId, leaseSeconds = 120, signal,
  now = () => performance.now(), beforePublish }) {
  integer(leaseSeconds, 1, 900, 'publication lease'); worker(workerId);
  if (signal?.aborted) return { batchId, workerId, claimed: 0, published: 0, failures: [], stopped: 'interrupted' };
  const summary = { batchId, workerId, claimed: 0, published: 0, failures: [], receipt: null, stopped: 'not_ready' };
  const claimStarted = now();
  const job = await store.claimPublication(batchId, workerId, leaseSeconds); if (!job) return summary; summary.claimed = 1;
  try {
    const base = await store.activePublication();
    if (signal?.aborted) throw Object.assign(new Error('Batch publication interrupted before activation'), { code: 'worker_interrupted' });
    const admit = phase => beforePublish?.({ phase, signal, leaseRemainingMs: Math.max(0, leaseSeconds * 1000 - (now() - claimStarted)) });
    await admit('before_checkout');
    summary.receipt = await store.publish(batchId, job, workerId, base || null, () => admit('after_setup'));
    if (Number.isFinite(summary.receipt?.publicationSqlMs)) summary.publicationSqlMs = summary.receipt.publicationSqlMs;
    summary.published = 1; summary.stopped = 'completed';
  } catch (error) {
    const detail = failure(error, signal?.aborted === true || error?.code === 'worker_interrupted'); let persistence = 'failed';
    try { const saved = await store.fail(job, workerId, detail); if (saved?.status === 'pending') persistence = 'retry_scheduled'; } catch { persistence = 'uncertain'; }
    if (Number.isFinite(error?.publicationSqlMs)) summary.publicationSqlMs = error.publicationSqlMs;
    summary.failures.push({ id: job.id, ...detail, persistence }); summary.stopped = signal?.aborted ? 'interrupted' : 'error';
  }
  return summary;
}
