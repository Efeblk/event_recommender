import { sqlLiteral as literal } from '../../web/lib/sql-literal.ts';
import { createBatchStore } from './batch-store.mjs';

const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
export function createPageBatchSourceStore(query = statement => import('./db.mjs').then(({ sql }) => sql(statement))) {
  const invoke = async expression => parse(await query(`SELECT ${expression}::text;`));
  return { ...createBatchStore(query),
    beginV2: header => invoke(`biplan.begin_preparation_batch_v2(${json(header)})`),
    recordPage: (batchId, page) => invoke(`biplan.record_batch_page(${literal(batchId)},${json(page)})`),
    sealV2: (batchId, seal) => invoke(`biplan.seal_preparation_batch_v2(${literal(batchId)},${json(seal)})`),
    checkpoints: async batchId => parse(await query(`SELECT jsonb_build_object(
      'pages',COALESCE((SELECT jsonb_agg(jsonb_build_object('pageId',p.id,'status',p.receipt->>'status','receipt',p.receipt,'payload',p.payload,'pageHash',p.page_hash) ORDER BY p.id)
        FROM (SELECT p.id,p.receipt,p.payload,p.page_hash FROM biplan.preparation_batch_pages bp
          JOIN biplan.source_page_observations p ON p.id=bp.page_id WHERE bp.batch_id=${literal(batchId)} ORDER BY p.id LIMIT 20001) p),'[]'::jsonb),
      'records',COALESCE((SELECT jsonb_agg(jsonb_build_object('requestId',i.request_id,'status',i.status,'receipt',i.receipt) ORDER BY i.request_id)
        FROM (SELECT i.request_id,i.status,i.receipt FROM biplan.preparation_batch_items i
          WHERE i.batch_id=${literal(batchId)} ORDER BY i.request_id LIMIT 20001) i),'[]'::jsonb))::text;`)),
  };
}
