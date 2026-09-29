import { sqlLiteral as literal } from '../../web/lib/sql-literal.ts';

const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
function unsigned(value, name) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Unsafe ${name}`);
  const result = String(value); if (!/^\d+$/.test(result)) throw new Error(`Invalid ${name}`); return result;
}

/** query(sql) is injectable; local Docker PostgreSQL remains the default. */
export function createCanonicalStore(query = statement => import('./db.mjs').then(({ sql }) => sql(statement))) {
  const invoke = async expression => parse(await query(`SELECT ${expression}::text;`));
  return {
    async findHeads(record) {
      const ids = [...new Set([record.id, ...(record.sourceSessionIds ?? [])].map(String))];
      return parse(await query(`WITH raw AS (
        SELECT DISTINCT i.session_id,i.current_revision_id offer_revision_id FROM biplan.offer_identities i
        WHERE i.provider=${literal(record.source)} AND (i.provider_record_id IN (SELECT jsonb_array_elements_text(${json(ids)}))
          OR i.provider_session_id IN (SELECT jsonb_array_elements_text(${json(ids)})))
        UNION SELECT DISTINCT m.session_id,i.current_revision_id FROM biplan.canonical_source_mappings m
          JOIN biplan.offer_identities i ON i.id=m.offer_id
          WHERE m.source_name=${literal(record.source)} AND m.source_record_id IN (SELECT jsonb_array_elements_text(${json(ids)}))
      ), resolved AS (
        SELECT session_id,offer_revision_id FROM raw UNION ALL
        SELECT s.id,NULL FROM biplan.sessions s JOIN biplan.productions p ON p.id=s.production_id JOIN biplan.venues v ON v.id=s.venue_id
        WHERE NOT EXISTS(SELECT 1 FROM raw)
          AND biplan.canonical_text(${literal(record.district ?? '')})<>'' AND biplan.canonical_text(${literal(record.address ?? '')})<>''
          AND (${record.canonicalProductionKey ? literal(record.canonicalProductionKey) : 'NULL'} IS NULL OR p.canonical_production_key IS NULL
            OR p.canonical_production_key=${record.canonicalProductionKey ? literal(record.canonicalProductionKey) : 'NULL'})
          AND biplan.canonical_text(p.title)=biplan.canonical_text(${literal(record.title)})
          AND s.starts_at=${literal(record.startsAt)}::timestamptz AND biplan.canonical_text(v.name)=biplan.canonical_text(${literal(record.venue)})
          AND biplan.canonical_text(v.district)=biplan.canonical_text(${literal(record.district ?? '')})
          AND biplan.canonical_text(v.address_text)=biplan.canonical_text(${literal(record.address ?? '')})
      ) SELECT COALESCE(jsonb_agg(jsonb_build_object('sessionId',r.session_id,'canonicalRevisionId',h.revision_id,
          'offerRevisionId',r.offer_revision_id) ORDER BY r.session_id),'[]'::jsonb)::text
        FROM resolved r LEFT JOIN biplan.canonical_heads h ON h.session_id=r.session_id;`));
    },
    accept: payload => invoke(`biplan.accept_canonical_observation(${json(payload)})`),
    claim: async (owner, limit, leaseSeconds) => parse(await query(`SELECT COALESCE(jsonb_agg(to_jsonb(j)||jsonb_build_object('fencing_token',j.fencing_token::text)),'[]'::jsonb)::text
      FROM biplan.claim_canonical_preparation_jobs(${literal(owner)},${unsigned(limit, 'claim limit')},make_interval(secs=>${unsigned(leaseSeconds, 'lease')})) j;`)),
    input: (job, owner) => invoke(`biplan.canonical_preparation_input(${literal(job.id)},${literal(owner)},${unsigned(job.fencing_token, 'canonical fence')})`),
    activePublication: () => query('SELECT publication_id FROM biplan.active_publication WHERE singleton;'),
    complete: (job, owner, result, expectedBasePublicationId) => invoke(`biplan.complete_canonical_preparation_job(${literal(job.id)},${literal(owner)},${unsigned(job.fencing_token, 'canonical fence')},${json(result)},${expectedBasePublicationId ? literal(expectedBasePublicationId) : 'NULL'})`),
    fail: (job, owner, error) => invoke(`biplan.fail_canonical_preparation_job(${literal(job.id)},${literal(owner)},${unsigned(job.fencing_token, 'canonical fence')},${json(error)})`),
  };
}
