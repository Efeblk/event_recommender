import { literal, sql } from './db.mjs';

const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

/** query(sql) may be injected for tests/cloud adapters; the default is the task-owned local Docker DB. */
export function createSourceStore(query = sql) {
  return {
    async findExistingOffers(record) {
      const provider = literal(record.source), ids = json(record.sourceSessionIds.map(String));
      const statement = `SELECT COALESCE(jsonb_agg(row_to_json(found) ORDER BY found.offer_id),'[]'::jsonb)::text FROM (
        SELECT DISTINCT i.id AS offer_id,i.session_id,i.provider_record_id,i.provider_session_id,i.ticket_tier_id,
          r.ticket_tier_name,i.current_revision_id,p.title,s.starts_at,v.name AS venue,s.attendance_timing
          ,COALESCE((SELECT ps.eligibility_snapshot FROM biplan.active_publication active
            JOIN biplan.published_sessions ps ON ps.publication_id=active.publication_id AND ps.session_id=i.session_id
            WHERE active.singleton),r.source_payload) AS baseline_source_record
          ,ARRAY(SELECT DISTINCT x FROM unnest(COALESCE(r.source_session_ids,'{}') || ARRAY[
            i.provider_record_id,i.provider_session_id,r.source_payload->>'id']) x WHERE x IS NOT NULL) AS identity_source_ids
        FROM biplan.offer_identities i JOIN biplan.sessions s ON s.id=i.session_id
        JOIN biplan.productions p ON p.id=s.production_id LEFT JOIN biplan.venues v ON v.id=s.venue_id
        LEFT JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
        WHERE i.provider=${provider} AND (i.provider_record_id IN (SELECT jsonb_array_elements_text(${ids}))
          OR i.provider_session_id IN (SELECT jsonb_array_elements_text(${ids}))
          OR r.source_payload->>'id' IN (SELECT jsonb_array_elements_text(${ids}))
          OR COALESCE(r.source_session_ids,'{}') && ARRAY(SELECT jsonb_array_elements_text(${ids})))
      ) found;`;
      const rows = parse(await query(statement));
      return rows.map(row => ({ offerId: row.offer_id, sessionId: row.session_id, providerRecordId: row.provider_record_id,
        providerSessionId: row.provider_session_id, ticketTierId: row.ticket_tier_id, ticketTierName: row.ticket_tier_name,
        currentRevisionId: row.current_revision_id, title: row.title, startsAt: row.starts_at, venue: row.venue,
        attendanceTiming: row.attendance_timing, identitySourceIds: row.identity_source_ids,
        baselineSourceRecord: row.baseline_source_record }));
    },
    async accept(payload, expectedCurrentRevisionId) {
      const expected = expectedCurrentRevisionId === null ? 'NULL' : literal(expectedCurrentRevisionId);
      return parse(await query(`SELECT biplan.accept_offer_revision(${json(payload)},${expected})::text;`));
    },
  };
}
