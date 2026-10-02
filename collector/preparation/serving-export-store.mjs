import { sqlLiteral as literal } from '../../web/lib/sql-literal.ts';

const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const unsigned = value => {
  const result=String(value);
  if (!/^[1-9]\d*$/.test(result) || (typeof value==='number' && !Number.isSafeInteger(value))) throw new Error('Invalid export fence or limit');
  return result;
};

export function createServingExportStore(query) {
  const invoke=async expression=>JSON.parse(await query(`SELECT ${expression}::text;`));
  const owner=(job,worker)=>`${literal(job.id)},${literal(worker)},${unsigned(job.fencing_token)}`;
  return {
    begin:(publicationId,bucket)=>invoke(`biplan.begin_publication_serving_export(${literal(publicationId)},${literal(bucket)})`),
    claim:(publicationId,worker,leaseSeconds)=>invoke(`biplan.claim_publication_serving_export(${literal(publicationId)},${literal(worker)},${unsigned(leaseSeconds)})`),
    page:(job,worker,after,limit)=>invoke(`biplan.read_publication_serving_export_page(${owner(job,worker)},${literal(after)},${unsigned(limit)})`),
    checkpoint:(job,worker,value)=>invoke(`biplan.checkpoint_publication_serving_export(${owner(job,worker)},${json(value)})`),
    complete:(job,worker,object)=>invoke(`biplan.complete_publication_serving_export(${owner(job,worker)},${json(object)})`),
    fail:(job,worker,error)=>invoke(`biplan.fail_publication_serving_export(${owner(job,worker)},${json(error)})`),
  };
}
