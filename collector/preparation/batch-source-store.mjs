import { sqlLiteral as literal } from '../../web/lib/sql-literal.ts';
import { createBatchStore } from './batch-store.mjs';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

/** Ingestion store with one bounded immutable-item checkpoint read per resume. */
export function createBatchSourceStore(query = statement => import('./db.mjs').then(({ sql }) => sql(statement))) {
  const store = createBatchStore(query);
  return {
    ...store,
    checkpoints: async batchId => parse(await query(`SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'requestId',x.request_id,'status',x.status,'receipt',x.receipt) ORDER BY x.request_id),'[]'::jsonb)::text
      FROM (SELECT request_id,status,receipt FROM biplan.preparation_batch_items
        WHERE batch_id=${literal(batchId)} ORDER BY request_id LIMIT 20001) x;`)),
  };
}
