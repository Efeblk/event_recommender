import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const clean = value => typeof value === 'string' ? value.normalize('NFC').replace(/\s+/g, ' ').trim() : '';
const trim = value => typeof value === 'string' ? value.trim() : '';
const fold = value => clean(value).toLocaleLowerCase('tr-TR').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
const stop = new Set('bir biraz icin olsun bana gore olan var neler ne bu ve ile etkinlik istiyorum plan daha tl lira hafta sonu'.split(' '));

export function prepareCanonicalSearch(input) {
  if (!input || typeof input !== 'object' || !clean(input.sessionId) || !clean(input.dependencyHash)) throw new Error('Invalid canonical preparation input');
  const facts = input.facts ?? {};
  const documentText = [`Title: ${trim(facts.title)}`, `Category: ${trim(facts.category)}`, `Venue: ${trim(facts.venue)}`, `Description: ${trim(facts.description)}`].join('\n').slice(0, 10000);
  if (!clean(facts.title) || !clean(facts.category) || !clean(facts.venue)) throw new Error('Canonical preparation has incomplete semantic facts');
  const lexicalTokens = fold([facts.title, facts.category, facts.venue, facts.description].map(clean).join(' ')).split(/[^a-z0-9]+/).filter(token => token.length > 2 && !stop.has(token));
  return { documentProfile: 'event-title-category-venue-description-v1', documentText,
    documentHash: createHash('sha256').update(documentText).digest('hex'), dependencyHash: input.dependencyHash,
    lexicalTokens, embeddingProfile: null, embedding: null };
}

function integer(value, min, max, name) { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`); }
export async function runCanonicalWorker({ store, workerId, maxJobs = 8, leaseSeconds = 120, timeBudgetMs = 30000, signal, now = () => performance.now(), prepare = prepareCanonicalSearch }) {
  integer(maxJobs, 0, 100, 'canonical job limit'); integer(leaseSeconds, 1, 900, 'canonical lease'); integer(timeBudgetMs, 1, 60000, 'canonical deadline');
  if (typeof workerId !== 'string' || !workerId.trim() || workerId.length > 200) throw new Error('Invalid canonical worker');
  const started = now(), summary = { workerId, claimed: 0, completed: 0, published: 0, failures: [], receipts: [], stopped: 'drained' };
  const eligible = () => !signal?.aborted && now() - started < timeBudgetMs;
  while (summary.claimed < maxJobs && eligible()) {
    const [job] = await store.claim(workerId, 1, leaseSeconds); if (!job) break; summary.claimed++;
    try {
      const input = await store.input(job, workerId);
      if (job.checkpoint?.revisionId && job.checkpoint.revisionId !== input.revisionId) throw new Error('Canonical checkpoint dependency changed');
      const result = await prepare(input, job);
      if (signal?.aborted) throw Object.assign(new Error('Canonical worker interrupted before completion'), { code: 'worker_interrupted' });
      const base = await store.activePublication();
      if (signal?.aborted) throw Object.assign(new Error('Canonical worker interrupted before publication'), { code: 'worker_interrupted' });
      const receipt = await store.complete(job, workerId, result, base || null);
      summary.completed++; if (receipt?.resultPublicationId && receipt.resultPublicationId !== receipt.basePublicationId) summary.published++;
      summary.receipts.push(receipt);
    } catch (error) {
      const interrupted = signal?.aborted === true || error?.code === 'worker_interrupted';
      const retryable = interrupted || /deadlock|lock timeout|guard|base publication|checkpoint dependency/i.test(String(error?.message));
      const detail = { code: interrupted ? 'worker_interrupted' : retryable ? 'canonical_conflict' : 'canonical_error', retryable, message: String(error?.message ?? error).slice(0, 600) };
      let persistence = 'failed';
      try { const saved = await store.fail(job, workerId, detail); if (saved?.status === 'pending') persistence = 'retry_scheduled'; } catch { persistence = 'uncertain'; }
      summary.failures.push({ id: job.id, ...detail, persistence }); break;
    }
  }
  summary.stopped = signal?.aborted ? 'interrupted' : summary.failures.length ? 'error' : now() - started >= timeBudgetMs ? 'time_budget' : summary.claimed === maxJobs && maxJobs > 0 ? 'item_limit' : 'drained';
  summary.elapsedMs = Math.round((now() - started) * 100) / 100; return summary;
}
