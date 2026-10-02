import { sql as localSql, literal } from './db.mjs';

const json=value=>`${literal(JSON.stringify(value))}::jsonb`;
const token=value=>{
  if (typeof value==='number' && !Number.isSafeInteger(value)) throw new Error('Unsafe integer token');
  const text=String(value);
  if (!/^\d+$/.test(text)) throw new Error('Invalid fencing token');
  return text;
};
export function createWorkerStore(query=localSql) {
  const rows=async statement=>JSON.parse(await query(`SELECT COALESCE(jsonb_agg(to_jsonb(row)),'[]'::jsonb)::text FROM (${statement}) row;`));
  const invoke=async statement=>JSON.parse(await query(`SELECT ${statement}::text;`));
  const owned=(item,worker)=>`${literal(item.id)},${literal(worker)},${token(item.fencing_token)}`;
  return {
    claimJobs:(worker,limit,seconds)=>rows(`SELECT j.*,j.fencing_token::text AS fencing_token FROM biplan.claim_offer_preparation_jobs(${literal(worker)},${token(limit)},make_interval(secs=>${token(seconds)})) j`),
    claimEvents:(worker,limit,seconds)=>rows(`SELECT e.*,e.fencing_token::text AS fencing_token FROM biplan.claim_offer_outbox(${literal(worker)},${token(limit)},make_interval(secs=>${token(seconds)})) e`),
    revisionForJob:async job=>{
      const result=await rows(`SELECT r.*,r.price_minor::text AS price_minor,r.fee_minor::text AS fee_minor FROM biplan.offer_revisions r
        WHERE r.offer_id=${literal(job.subject_id)} AND r.semantic_content_hash=${literal(job.input_hash)} AND r.acceptance_status='accepted'
        ORDER BY r.created_at,r.id LIMIT 1`);
      if (!result[0]) throw new Error('Missing accepted offer revision for derivation');
      return result[0];
    },
    checkpointJob:(job,worker,checkpoint)=>invoke(`biplan.checkpoint_offer_preparation_job(${owned(job,worker)},${json(checkpoint)})`),
    finishJob:(job,worker,result)=>invoke(`biplan.finish_offer_preparation_job(${owned(job,worker)},${json(result)})`),
    failJob:(job,worker,error)=>invoke(`biplan.fail_offer_preparation_job(${owned(job,worker)},${json(error)},NULL)`),
    deliverEvent:(event,worker)=>invoke(`biplan.deliver_offer_outbox(${owned(event,worker)})`),
    failEvent:(event,worker,error)=>invoke(`biplan.fail_offer_outbox(${owned(event,worker)},${json(error)},NULL)`),
  };
}
