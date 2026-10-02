import { performance } from 'node:perf_hooks';

export const offerFactsProfile = 'offer-facts-v1';

function minor(value, name) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Unsafe ${name}`);
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new Error(`Invalid ${name}`);
  return BigInt(text).toString();
}

// Stable facts only: clocks and current eligibility belong to the pinned revision.
export function deriveOfferFacts(revision, job) {
  if (!revision || revision.offer_id !== job.subject_id || revision.acceptance_status !== 'accepted'
    || revision.semantic_content_hash !== job.input_hash || job.stage !== 'offer_revision_accepted' || job.stage_version !== '1')
    throw new Error('Offer derivation dependency does not match its job');
  const base = minor(revision.price_minor, 'base price'), fee = minor(revision.fee_minor, 'fee');
  const normalizedCurrency=typeof revision.currency==='string' ? revision.currency.trim().toUpperCase() : null;
  const currency = normalizedCurrency && /^[A-Z]{3}$/.test(normalizedCurrency) ? normalizedCurrency : null;
  const kind = ['exact','starting_at','range'].includes(revision.price_kind) ? revision.price_kind : 'unknown';
  return { schemaVersion:1, profile:offerFactsProfile, offerId:revision.offer_id, dependencyHash:job.input_hash,
    sourceRevisionId:revision.id, facts:{ currency, basePriceMinor:base, feeMinor:fee, priceKind:kind,
      availability:revision.availability,
      exactCheckoutPriceMinor:kind === 'exact' && currency && base !== null && fee !== null ? (BigInt(base)+BigInt(fee)).toString() : null,
      priceStatus:base !== null && currency ? kind : 'unknown', groupStock:'unknown', promotionStatus:'unknown' } };
}

function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
}
function failure(error,interrupted=false) { return { message:String(error?.message ?? error).slice(0,600),
  code:interrupted ? 'worker_interrupted' : 'local_worker_error', retryable:interrupted }; }

// One claim at a time avoids leasing work that a bounded invocation cannot reach.
// Derivation happens between store calls, outside any database transaction.
export async function runPreparationWorker({ store, workerId, maxJobs=8, maxEvents=8, leaseSeconds=120,
  timeBudgetMs=30000, signal, now=()=>performance.now(), derive=deriveOfferFacts }) {
  integer(maxJobs,0,100,'job limit'); integer(maxEvents,0,100,'event limit');
  integer(leaseSeconds,1,900,'lease'); integer(timeBudgetMs,1,60000,'time budget');
  if (typeof workerId !== 'string' || !workerId.trim() || workerId.length>200) throw new Error('Invalid worker identity');
  const started=now(), summary={workerId,claimedJobs:0,completedJobs:0,claimedEvents:0,deliveredEvents:0,failures:[],stopped:'drained'};
  const canContinue=()=>!signal?.aborted && now()-started<timeBudgetMs;
  // Alternate queues so pending derivations cannot starve revision notifications.
  let jobsDrained=maxJobs===0, eventsDrained=maxEvents===0;
  while (canContinue() && (!jobsDrained || !eventsDrained)) {
    if (!jobsDrained && summary.claimedJobs<maxJobs && canContinue()) {
      const [job]=await store.claimJobs(workerId,1,leaseSeconds);
      if (!job) jobsDrained=true;
      else {
        summary.claimedJobs++;
        try {
          const revision=await store.revisionForJob(job);
          const result=await derive(revision,job,signal);
          if (signal?.aborted) throw new Error('Worker interrupted before completion');
          await store.checkpointJob(job,workerId,{phase:'derived',profile:offerFactsProfile,dependencyHash:job.input_hash});
          await store.finishJob(job,workerId,result);
          summary.completedJobs++;
        } catch (error) {
          const detail=failure(error,signal?.aborted===true);
          let persistence='failed';
          try { const outcome=await store.failJob(job,workerId,detail); if (outcome?.status==='pending') persistence='retry_scheduled'; }
          catch { persistence='uncertain'; }
          summary.failures.push({id:job.id,queue:'preparation',...detail,persistence});
        }
        if (summary.claimedJobs>=maxJobs) jobsDrained=true;
      }
    }
    if (!eventsDrained && summary.claimedEvents<maxEvents && canContinue()) {
      const [event]=await store.claimEvents(workerId,1,leaseSeconds);
      if (!event) eventsDrained=true;
      else {
        summary.claimedEvents++;
        try { await store.deliverEvent(event,workerId); summary.deliveredEvents++; }
        catch (error) {
          let persistence='failed';
          try { await store.failEvent(event,workerId,failure(error)); }
          catch { persistence='uncertain'; }
          summary.failures.push({id:event.id,queue:'outbox',...failure(error),persistence});
        }
        if (summary.claimedEvents>=maxEvents) eventsDrained=true;
      }
    }
  }
  summary.stopped=signal?.aborted ? 'interrupted' : now()-started>=timeBudgetMs ? 'time_budget' :
    summary.claimedJobs===maxJobs && maxJobs>0 || summary.claimedEvents===maxEvents && maxEvents>0 ? 'item_limit' : 'drained';
  summary.elapsedMs=Math.round((now()-started)*100)/100;
  return summary;
}
