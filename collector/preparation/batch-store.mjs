import { sqlLiteral as literal } from '../../web/lib/sql-literal.ts';

const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
function unsigned(value, name) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Unsafe ${name}`);
  const result = String(value); if (!/^\d+$/.test(result)) throw new Error(`Invalid ${name}`); return result;
}

/** Injectable SQL boundary for one coherent catalog preparation batch. */
export function createBatchStore(query = statement => import('./db.mjs').then(({ sql }) => sql(statement))) {
  const invoke = async expression => parse(await query(`SELECT ${expression}::text;`));
  const owner = (job, worker) => `${literal(job.id)},${literal(worker)},${unsigned(job.fencing_token, 'batch fence')}`;
  return {
    begin: payload => invoke(`biplan.begin_preparation_batch(${json(payload)})`),
    accept: (batchId, canonicalPayload) => invoke(`biplan.accept_batch_observation(${literal(batchId)},${json(canonicalPayload)})`),
    quarantine: (batchId, requestId, record, reason) => invoke(`biplan.record_batch_quarantine(${literal(batchId)},${literal(requestId)},${json(record)},${literal(reason)})`),
    seal: (batchId, receipt) => invoke(`biplan.seal_preparation_batch(${literal(batchId)},${json(receipt)})`),
    cancel: (batchId, reason) => invoke(`biplan.cancel_preparation_batch(${literal(batchId)},${literal(reason)})`),
    claimJobs: async (batchId, worker, limit, leaseSeconds) => parse(await query(`SELECT COALESCE(jsonb_agg(to_jsonb(j)||jsonb_build_object('fencing_token',j.fencing_token::text)),'[]'::jsonb)::text
      FROM biplan.claim_batch_preparation_jobs(${literal(batchId)},${literal(worker)},${unsigned(limit, 'batch claim limit')},make_interval(secs=>${unsigned(leaseSeconds, 'batch lease')})) j;`)),
    input: (job, worker) => invoke(`biplan.batch_preparation_input(${owner(job, worker)})`),
    complete: (job, worker, result) => invoke(`biplan.complete_batch_preparation_job(${owner(job, worker)},${json(result)})`),
    fail: (job, worker, error) => invoke(`biplan.fail_batch_preparation_job(${owner(job, worker)},${json(error)})`),
    claimPublication: async (batchId, worker, leaseSeconds) => parse(await query(`SELECT COALESCE((SELECT to_jsonb(j)||jsonb_build_object('fencing_token',j.fencing_token::text)
      FROM biplan.claim_batch_publication(${literal(batchId)},${literal(worker)},make_interval(secs=>${unsigned(leaseSeconds, 'publication lease')})) j LIMIT 1),'null'::jsonb)::text;`)),
    activePublication: () => query('SELECT publication_id FROM biplan.active_publication WHERE singleton;'),
    publish: (batchId, job, worker, expectedActivePublicationId) => invoke(`biplan.publish_preparation_batch(${literal(batchId)},${owner(job, worker)},${expectedActivePublicationId ? literal(expectedActivePublicationId) : 'NULL'})`),
  };
}
