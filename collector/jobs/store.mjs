import { hash, transaction } from '../db/index.mjs';

export const jobIdentity = ({stage,subject,inputHash,version='1'}) => hash({stage,subject,inputHash,version});
export async function enqueue(client, collectionId, job) {
  const id = jobIdentity(job);
  await client.query(`INSERT INTO biplan_pipeline.jobs(id,stage,subject,input_hash,stage_version,input)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, [id,job.stage,job.subject,job.inputHash,job.version ?? '1',job.input]);
  if(typeof collectionId==='object') await client.query('INSERT INTO biplan_pipeline.raw_collection_jobs VALUES($1,$2) ON CONFLICT DO NOTHING',[collectionId.rawCollectionId,id]);
  else await client.query('INSERT INTO biplan_pipeline.collection_jobs VALUES($1,$2) ON CONFLICT DO NOTHING',[collectionId,id]);
  return id;
}
export function createJobStore(pool) {
  return {
    enqueue: (collectionId,job) => transaction(pool, client=>enqueue(client,collectionId,job)),
    async claim({collectionId,rawCollectionId,stage,owner,leaseMs=30000}) {
      if (!owner || !Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 300000) throw new Error('Invalid job lease');
      return transaction(pool, async client => {
        const rows = await client.query(`SELECT j.* FROM biplan_pipeline.jobs j
          JOIN biplan_pipeline.${rawCollectionId?'raw_collection_jobs':'collection_jobs'} c ON c.job_id=j.id
          WHERE c.${rawCollectionId?'raw_collection_id':'collection_id'}=$1 AND j.stage=$2 AND (j.state='queued' OR (j.state='running' AND j.lease_until<=clock_timestamp()))
          ORDER BY j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1`,[rawCollectionId??collectionId,stage]);
        if (!rows.rows.length) return null;
        const id = rows.rows[0].id;
        await client.query(`UPDATE biplan_pipeline.job_attempts SET completed_at=clock_timestamp(),outcome='lease_expired'
          WHERE job_id=$1 AND completed_at IS NULL`,[id]);
        const claimed = await client.query(`UPDATE biplan_pipeline.jobs SET state='running',fence=fence+1,
          lease_owner=$2,lease_until=clock_timestamp()+$3*interval '1 millisecond',attempt=attempt+1 WHERE id=$1 RETURNING *`,[id,owner,leaseMs]);
        const job = claimed.rows[0];
        await client.query('INSERT INTO biplan_pipeline.job_attempts(job_id,fence,owner) VALUES($1,$2,$3)',[id,job.fence,owner]);
        return job;
      });
    },
    async complete(job, output, {write=async()=>{},dependents=[],collectionId,costMicrousd=0,signal}={}) {
      if(signal?.aborted) throw Object.assign(new Error('Job interrupted before completion'),{code:'job_interrupted'});
      return transaction(pool, async client => {
        const held = await client.query(`SELECT * FROM biplan_pipeline.jobs WHERE id=$1 AND state='running'
          AND fence=$2 AND lease_owner=$3 AND lease_until>clock_timestamp() FOR UPDATE`,[job.id,job.fence,job.lease_owner]);
        if (!held.rows.length) throw Object.assign(new Error('Job lease or fencing token is stale'),{code:'stale_job'});
        if (held.rows[0].input_hash !== job.input_hash) throw new Error('Job dependencies changed');
        await write(client);
        if(signal?.aborted) throw Object.assign(new Error('Job interrupted during completion'),{code:'job_interrupted'});
        // Check again after work: acquiring the row does not make an expired lease valid.
        const completed = await client.query(`UPDATE biplan_pipeline.jobs SET state='completed',output=$4,
          lease_owner=NULL,lease_until=NULL WHERE id=$1 AND fence=$2 AND lease_owner=$3 AND lease_until>clock_timestamp() RETURNING id`,
          [job.id,job.fence,job.lease_owner,output]);
        if (!completed.rows.length) throw Object.assign(new Error('Job expired during commit'),{code:'stale_job'});
        for (const next of dependents) await enqueue(client,collectionId,next);
        await client.query(`UPDATE biplan_pipeline.job_attempts SET completed_at=clock_timestamp(),outcome='completed',cost_microusd=$3
          WHERE job_id=$1 AND fence=$2`,[job.id,job.fence,costMicrousd]);
      });
    },
    async fail(job,error,{retry=false,costMicrousd=0}={}) {
      return transaction(pool,async client=>{
        const result=await client.query(`UPDATE biplan_pipeline.jobs SET state=$4,lease_owner=NULL,lease_until=NULL
          WHERE id=$1 AND fence=$2 AND lease_owner=$3 AND state='running' AND lease_until>clock_timestamp() RETURNING id`,
          [job.id,job.fence,job.lease_owner,retry?'queued':'failed']);
        if(!result.rows.length) throw Object.assign(new Error('Cannot fail a stale job'),{code:'stale_job'});
        await client.query(`UPDATE biplan_pipeline.job_attempts SET completed_at=clock_timestamp(),outcome='failed',error_code=$3,cost_microusd=$4
          WHERE job_id=$1 AND fence=$2`,[job.id,job.fence,String(error?.code??'stage_failed').slice(0,80),costMicrousd]);
      });
    },
    async pending(collectionId,stage) {
      const raw=typeof collectionId==='object';
      const result=await pool.query(`SELECT count(*)::int count FROM biplan_pipeline.jobs j JOIN biplan_pipeline.${raw?'raw_collection_jobs':'collection_jobs'} c ON c.job_id=j.id
        WHERE c.${raw?'raw_collection_id':'collection_id'}=$1 AND j.stage=$2 AND j.state<>'completed'`,[raw?collectionId.rawCollectionId:collectionId,stage]);
      return result.rows[0].count;
    },
  };
}
