BEGIN;

-- Replace only the global cohort check. All surrounding collection, inventory,
-- source-clock, page-head, quarantine and job guards remain byte-for-byte intact.
DO $migration$
DECLARE definition text; installed text; body_hash text;
  old_guard text:=$old_guard$IF EXISTS(SELECT 1 FROM biplan.sessions s LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id
    LEFT JOIN biplan.canonical_revisions r ON r.id=h.revision_id LEFT JOIN biplan.active_publication a ON a.singleton
    LEFT JOIN biplan.published_sessions ps ON ps.publication_id=a.publication_id AND ps.session_id=s.id
    WHERE s.status='scheduled' AND EXISTS(SELECT 1 FROM biplan.offer_identities i WHERE i.session_id=s.id)
      AND NOT biplan.session_projection_integrity(s.id,COALESCE(r.facts,ps.eligibility_snapshot))) THEN blocked:=blocked+1; END IF;$old_guard$;
  bulk_query text:=$bulk_query$WITH cohort AS MATERIALIZED (
 SELECT s.id session_id,COALESCE(r.facts,snapshot_row.eligibility_snapshot) facts
 FROM biplan.sessions s LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id
 LEFT JOIN biplan.canonical_revisions r ON r.id=h.revision_id LEFT JOIN biplan.active_publication a ON a.singleton
 LEFT JOIN biplan.published_sessions snapshot_row ON snapshot_row.publication_id=a.publication_id AND snapshot_row.session_id=s.id
 WHERE s.status='scheduled' AND EXISTS(SELECT 1 FROM biplan.offer_identities i WHERE i.session_id=s.id)
), current_offers AS MATERIALIZED (
 SELECT i.id,i.session_id,i.provider,i.provider_record_id,r.source_session_ids,r.availability,
   binding_row.evidence_basis,binding_row.evidence_observed_at,binding_row.evidence_source_updated_at,
   COALESCE(binding_row.facts,biplan.legacy_offer_occurrence(r.id)) bound,
   CASE WHEN r.acceptance_status='accepted' AND ph.page_id IS NULL THEN 'unsupported'
     ELSE biplan.derive_offer_page_evidence(r.id,ph.page_id)->>'disposition' END page_disposition
 FROM cohort cohort_row JOIN biplan.offer_identities i ON i.session_id=cohort_row.session_id
 JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
 LEFT JOIN biplan.offer_occurrence_bindings binding_row ON binding_row.offer_revision_id=r.id
 LEFT JOIN biplan.source_page_heads ph ON ph.provider=i.provider AND ph.source_url=r.source_url
), unresolved AS MATERIALIZED (
 SELECT d.session_id,d.offer_id FROM biplan.canonical_occurrence_disputes d JOIN cohort cohort_row ON cohort_row.session_id=d.session_id
 WHERE NOT EXISTS(SELECT 1 FROM current_offers proof WHERE proof.session_id=d.session_id AND proof.provider=d.source_name
   AND (proof.id=d.offer_id OR proof.provider_record_id=d.source_record_id OR d.source_record_id=ANY(proof.source_session_ids))
   AND proof.evidence_basis='full_source_record' AND (
     (d.source_updated_at IS NOT NULL AND proof.evidence_source_updated_at>d.source_updated_at)
     OR (d.source_updated_at IS NULL AND proof.evidence_observed_at>d.observed_at)
     OR (proof.evidence_source_updated_at IS NOT DISTINCT FROM d.source_updated_at AND proof.evidence_observed_at>d.observed_at)))
), classified AS MATERIALIZED (
 SELECT o.*,EXISTS(SELECT 1 FROM unresolved d WHERE d.session_id=o.session_id AND (d.offer_id=o.id OR d.offer_id IS NULL)) disputed
 FROM current_offers o
), occurrences AS MATERIALIZED (
 SELECT cohort_row.session_id,biplan.canonical_occurrence(cohort_row.facts) occurrence FROM cohort cohort_row
 WHERE EXISTS(SELECT 1 FROM classified o WHERE o.session_id=cohort_row.session_id AND NOT o.disputed
   AND o.availability NOT IN ('sold_out','unavailable') AND o.bound IS NOT NULL)
), statuses AS MATERIALIZED (
 SELECT o.session_id,o.id,o.page_disposition,CASE
   WHEN o.disputed THEN 'disputed'
   WHEN o.availability IN ('sold_out','unavailable') THEN 'not_selectable'
   WHEN o.bound IS NULL THEN 'unknown_occurrence'
   WHEN o.bound IS DISTINCT FROM cohort_row.occurrence THEN 'occurrence_mismatch'
   ELSE 'supported' END support FROM classified o LEFT JOIN occurrences cohort_row ON cohort_row.session_id=o.session_id
), verdicts AS (
 SELECT session_id,NOT COALESCE(bool_or(support IN ('disputed','occurrence_mismatch')
   OR (support='unknown_occurrence' AND page_disposition='supported') OR page_disposition='family_hold'),false) usable
 FROM statuses GROUP BY session_id
)
SELECT cohort_row.session_id,COALESCE(v.usable,true) usable FROM cohort cohort_row LEFT JOIN verdicts v USING(session_id)$bulk_query$;
  new_guard text;
BEGIN
  old_guard:=replace(old_guard,E'\r\n',E'\n');
  bulk_query:=replace(bulk_query,E'\r\n',E'\n');
  IF NOT EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='010-offer-identity-session-index' AND migration_hash='010-offer-identity-session-index-v1') OR NOT EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='008-offer-evidence-projections' AND migration_hash='008-offer-evidence-projections-v1') THEN
    RAISE EXCEPTION 'bulk seal integrity requires migration 010';
  END IF;
  SELECT migration_hash INTO installed FROM biplan.schema_migrations WHERE version='012-bulk-seal-integrity';
  IF installed IS NOT NULL AND installed<>'012-bulk-seal-integrity-v1' THEN RAISE EXCEPTION 'incompatible bulk seal integrity migration'; END IF;
  SELECT pg_get_functiondef('biplan.seal_preparation_batch_v2(text,jsonb)'::regprocedure) INTO definition;
  definition:=replace(definition,E'\r\n',E'\n');
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO body_hash FROM pg_proc WHERE oid='biplan.seal_preparation_batch_v2(text,jsonb)'::regprocedure;
  IF body_hash IS DISTINCT FROM (CASE WHEN installed IS NULL THEN '5191c3af792c80d47eb85da125a80be095495370d8442fcb55621bfb23238ee1' ELSE 'a574382ca07144c743309f9ef1b7a2829bb066276fd37045aa304b32572760a5' END) THEN
    RAISE EXCEPTION 'unexpected complete seal function body; refusing stale migration or drift';
  END IF;
  new_guard:='IF EXISTS(SELECT 1 FROM ('||bulk_query||') bulk_global_projection_integrity_v1 WHERE NOT usable) THEN blocked:=blocked+1; END IF;';
  IF installed IS NULL THEN
    IF position(old_guard IN definition)=0 OR (length(definition)-length(replace(definition,old_guard,'')))/length(old_guard)<>1 THEN
      RAISE EXCEPTION 'unexpected seal global integrity implementation';
    END IF;
    EXECUTE replace(definition,old_guard,new_guard);
  ELSIF position(new_guard IN definition)=0 THEN
    RAISE EXCEPTION 'installed bulk seal integrity implementation drifted';
  END IF;
END $migration$;

INSERT INTO biplan.schema_migrations(version,migration_hash)
VALUES('012-bulk-seal-integrity','012-bulk-seal-integrity-v1') ON CONFLICT(version) DO NOTHING;
COMMIT;
