BEGIN;

-- Batch the existing publisher's immutable projection work. Every surrounding
-- lock, eligibility guard, fence and all three validator invocations are retained.
-- Whole-body and dependency guards reject drift before replacing either function.
DO $migration$
DECLARE installed text; definition text; actual text; dependency record;
  old_integrity text:=$old_integrity$  IF EXISTS(SELECT 1 FROM biplan.sessions s LEFT JOIN biplan.preparation_batch_sessions bs ON bs.batch_id=b.id AND bs.session_id=s.id
    LEFT JOIN biplan.published_sessions ps ON ps.publication_id=active_id AND ps.session_id=s.id
    LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id LEFT JOIN biplan.canonical_revisions r ON r.id=h.revision_id
    WHERE s.id=ANY(target_ids) AND (NOT biplan.session_projection_integrity(s.id,COALESCE(r.facts,ps.eligibility_snapshot))
      OR (bs.session_id IS NULL AND (ps.session_id IS NULL OR h.revision_id IS DISTINCT FROM ps.eligibility_snapshot->>'canonicalRevisionId'
        OR s.production_id<>ps.production_id OR s.venue_id IS DISTINCT FROM ps.venue_id
        OR s.starts_at IS DISTINCT FROM (ps.eligibility_snapshot->>'startsAt')::timestamptz
        OR NULLIF(s.attendance_timing,'null'::jsonb) IS DISTINCT FROM NULLIF(ps.eligibility_snapshot->'attendanceTiming','null'::jsonb)))))
    THEN RAISE EXCEPTION 'canonical family integrity or prepared base dependency changed'; END IF;
$old_integrity$;
  new_integrity text:=$new_integrity$  IF EXISTS(WITH bulk_integrity AS MATERIALIZED (WITH cohort AS MATERIALIZED (
 SELECT s.id session_id,COALESCE(r.facts,snapshot_row.eligibility_snapshot) facts
 FROM biplan.sessions s LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id
 LEFT JOIN biplan.canonical_revisions r ON r.id=h.revision_id LEFT JOIN biplan.active_publication a ON a.singleton
 LEFT JOIN biplan.published_sessions snapshot_row ON snapshot_row.publication_id=a.publication_id AND snapshot_row.session_id=s.id
 WHERE s.id=ANY(target_ids) AND EXISTS(SELECT 1 FROM biplan.offer_identities i WHERE i.session_id=s.id)
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
SELECT cohort_row.session_id,COALESCE(v.usable,true) usable FROM cohort cohort_row LEFT JOIN verdicts v USING(session_id)) SELECT 1 FROM biplan.sessions s LEFT JOIN biplan.preparation_batch_sessions bs ON bs.batch_id=b.id AND bs.session_id=s.id
    LEFT JOIN biplan.published_sessions ps ON ps.publication_id=active_id AND ps.session_id=s.id
    LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id LEFT JOIN biplan.canonical_revisions r ON r.id=h.revision_id
    LEFT JOIN bulk_integrity integrity_row ON integrity_row.session_id=s.id
    WHERE s.id=ANY(target_ids) AND (NOT COALESCE(integrity_row.usable,true)
      OR (bs.session_id IS NULL AND (ps.session_id IS NULL OR h.revision_id IS DISTINCT FROM ps.eligibility_snapshot->>'canonicalRevisionId'
        OR s.production_id<>ps.production_id OR s.venue_id IS DISTINCT FROM ps.venue_id
        OR s.starts_at IS DISTINCT FROM (ps.eligibility_snapshot->>'startsAt')::timestamptz
        OR NULLIF(s.attendance_timing,'null'::jsonb) IS DISTINCT FROM NULLIF(ps.eligibility_snapshot->'attendanceTiming','null'::jsonb)))))
    THEN RAISE EXCEPTION 'canonical family integrity or prepared base dependency changed'; END IF;
$new_integrity$;
  old_snapshots text:=$old_snapshots$  INSERT INTO biplan.published_sessions(publication_id,session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot)
    SELECT target_id,s.id,s.production_id,s.venue_id,COALESCE(cp.document_id,old.search_document_id),md5(projected.value::text),projected.value
    FROM biplan.sessions s LEFT JOIN biplan.preparation_batch_sessions bs ON bs.batch_id=b.id AND bs.session_id=s.id
      LEFT JOIN biplan.canonical_preparations cp ON cp.revision_id=bs.revision_id
      LEFT JOIN biplan.published_sessions old ON old.publication_id=active_id AND old.session_id=s.id
      LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id LEFT JOIN biplan.canonical_revisions r ON r.id=h.revision_id
      CROSS JOIN LATERAL(SELECT CASE WHEN bs.session_id IS NOT NULL THEN biplan.batch_session_snapshot(bs.revision_id,cp.document_id,checked_at)
        ELSE old.eligibility_snapshot END||jsonb_build_object('canonicalDependencyHash',COALESCE(r.dependency_hash,s.content_hash)) value) facts
      CROSS JOIN LATERAL(SELECT biplan.projected_session_snapshot(target_id,s.id,facts.value,checked_at) value) projected WHERE s.id=ANY(target_ids);
$old_snapshots$;
  new_snapshots text:=$new_snapshots$  WITH pinned_rows AS MATERIALIZED (
 SELECT e.session_id,e.offer_id,r.id,r.source_payload,r.price_minor,r.source_url,jsonb_build_object('offerId',i.id,'revisionId',r.id,'provider',r.provider,
 'providerRecordId',r.provider_record_id,'sourceUrl',r.source_url,'ticketTierId',r.ticket_tier_id,
 'ticketTierName',r.ticket_tier_name,'currency',r.currency,
 'price',CASE WHEN r.price IS NULL THEN NULL ELSE to_jsonb(r.price::text) END,
 'priceMinor',CASE WHEN r.price_minor IS NULL THEN NULL ELSE to_jsonb(r.price_minor::text) END,
 'feeMinor',CASE WHEN r.fee_minor IS NULL THEN NULL ELSE to_jsonb(r.fee_minor::text) END,
 'priceKind',r.price_kind,'availability',r.availability,'observedAt',r.observed_at,
 'sourceUpdatedAt',r.source_updated_at,'validFrom',r.valid_from,'validUntil',r.valid_until)
 ||CASE WHEN e.disposition='unsupported' THEN '{"availability":"unknown","price":null,"priceMinor":null,"feeMinor":null,"priceKind":"unknown","sourceUrl":null}'::jsonb ELSE '{}'::jsonb END
 ||jsonb_build_object('evidenceVersion',1,'evidenceStatus',e.disposition,'evidenceReason',e.reason_code,
 'pageObservationId',e.page_observation_id,'evidenceDependencyHash',e.dependency_hash,'evidencePolicyVersion',e.policy_version,'evidenceObservedAt',e.evidence_observed_at) term,
 e.disposition='supported' AND r.currency='TRY' AND r.price_minor IS NOT NULL
 AND (r.price IS NULL OR r.price*100=r.price_minor) AND r.availability IN ('available','limited') AND r.price_kind<>'unknown'
 AND r.observed_at<=checked_at AND r.observed_at>=checked_at-interval '3 days'
 AND (r.valid_from IS NULL OR r.valid_from<=checked_at) AND (r.valid_until IS NULL OR r.valid_until>=checked_at) eligible
 FROM biplan.publication_offer_evidence e JOIN biplan.offer_revisions r ON r.id=e.offer_revision_id
 JOIN biplan.offer_identities i ON i.id=r.offer_id WHERE e.publication_id=target_id
 ), grouped_offers AS MATERIALIZED (
 SELECT session_id,jsonb_agg(term ORDER BY offer_id) terms,jsonb_agg(source_payload ORDER BY offer_id) raws,
 jsonb_build_object('availability',CASE WHEN bool_or(eligible) THEN 'available' ELSE 'unknown' END,
 'displayPrice',min(price_minor) FILTER(WHERE eligible)/100.0,'displayPriceMinor',(min(price_minor) FILTER(WHERE eligible))::text,
 'currency',CASE WHEN bool_or(eligible) THEN 'TRY' END,'displayPriceIsHardBudgetTotal',false,
 'sourceUrl',(array_agg(source_url ORDER BY price_minor,id) FILTER(WHERE eligible))[1]) summary
 FROM pinned_rows GROUP BY session_id
 ), facts_rows AS MATERIALIZED (
 SELECT s.id,s.production_id,s.venue_id,COALESCE(cp.document_id,old.search_document_id) document_id,
 CASE WHEN bs.session_id IS NOT NULL THEN biplan.batch_session_snapshot(bs.revision_id,cp.document_id,checked_at)
 ELSE old.eligibility_snapshot END||jsonb_build_object('canonicalDependencyHash',COALESCE(r.dependency_hash,s.content_hash)) facts
 FROM biplan.sessions s LEFT JOIN biplan.preparation_batch_sessions bs ON bs.batch_id=b.id AND bs.session_id=s.id
 LEFT JOIN biplan.canonical_preparations cp ON cp.revision_id=bs.revision_id
 LEFT JOIN biplan.published_sessions old ON old.publication_id=active_id AND old.session_id=s.id
 LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id LEFT JOIN biplan.canonical_revisions r ON r.id=h.revision_id WHERE s.id=ANY(target_ids)
 ), projected_rows AS MATERIALIZED (
 SELECT f.*,CASE WHEN g.terms IS NULL THEN biplan.projected_session_snapshot(target_id,f.id,f.facts,checked_at)
 ELSE f.facts||jsonb_build_object('offerTermsVersion',2,'offerTerms',g.terms,'offers',g.raws,'offerSummary',g.summary,
 'availability',g.summary->'availability','price',g.summary->'displayPrice','currency',g.summary->'currency','url',g.summary->'sourceUrl') END value
 FROM facts_rows f LEFT JOIN grouped_offers g ON g.session_id=f.id
 )
  INSERT INTO biplan.published_sessions(publication_id,session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot)
 SELECT target_id,id,production_id,venue_id,document_id,md5(value::text),value FROM projected_rows;
$new_snapshots$;
  old_terms text:=$old_terms$    OR EXISTS(SELECT 1 FROM biplan.published_sessions ps WHERE ps.publication_id=p.id AND (
      ps.eligibility_snapshot->>'offerTermsVersion' IS DISTINCT FROM '2'
      OR ps.eligibility_snapshot->'offerTerms' IS DISTINCT FROM (SELECT jsonb_agg(biplan.publication_offer_term(p.id,e.offer_id) ORDER BY e.offer_id)
        FROM biplan.publication_offer_evidence e WHERE e.publication_id=p.id AND e.session_id=ps.session_id)))$old_terms$;
  new_terms text:=$new_terms$    OR EXISTS(WITH terms AS MATERIALIZED (
 SELECT e.session_id,jsonb_agg(jsonb_build_object('offerId',i.id,'revisionId',r.id,'provider',r.provider,
 'providerRecordId',r.provider_record_id,'sourceUrl',r.source_url,'ticketTierId',r.ticket_tier_id,
 'ticketTierName',r.ticket_tier_name,'currency',r.currency,
 'price',CASE WHEN r.price IS NULL THEN NULL ELSE to_jsonb(r.price::text) END,
 'priceMinor',CASE WHEN r.price_minor IS NULL THEN NULL ELSE to_jsonb(r.price_minor::text) END,
 'feeMinor',CASE WHEN r.fee_minor IS NULL THEN NULL ELSE to_jsonb(r.fee_minor::text) END,
 'priceKind',r.price_kind,'availability',r.availability,'observedAt',r.observed_at,
 'sourceUpdatedAt',r.source_updated_at,'validFrom',r.valid_from,'validUntil',r.valid_until)
 ||CASE WHEN e.disposition='unsupported' THEN '{"availability":"unknown","price":null,"priceMinor":null,"feeMinor":null,"priceKind":"unknown","sourceUrl":null}'::jsonb ELSE '{}'::jsonb END
 ||jsonb_build_object('evidenceVersion',1,'evidenceStatus',e.disposition,'evidenceReason',e.reason_code,
 'pageObservationId',e.page_observation_id,'evidenceDependencyHash',e.dependency_hash,'evidencePolicyVersion',e.policy_version,'evidenceObservedAt',e.evidence_observed_at) ORDER BY e.offer_id) value
 FROM biplan.publication_offer_evidence e JOIN biplan.offer_revisions r ON r.id=e.offer_revision_id
 JOIN biplan.offer_identities i ON i.id=r.offer_id WHERE e.publication_id=p.id GROUP BY e.session_id
 ) SELECT 1 FROM biplan.published_sessions ps LEFT JOIN terms t ON t.session_id=ps.session_id
 WHERE ps.publication_id=p.id AND (ps.eligibility_snapshot->>'offerTermsVersion' IS DISTINCT FROM '2'
 OR ps.eligibility_snapshot->'offerTerms' IS DISTINCT FROM t.value))$new_terms$;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='012-bulk-seal-integrity' AND migration_hash='012-bulk-seal-integrity-v1') OR NOT EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='008-offer-evidence-projections' AND migration_hash='008-offer-evidence-projections-v1') THEN RAISE EXCEPTION 'bulk publication requires migrations 008 and 012'; END IF;
  SELECT migration_hash INTO installed FROM biplan.schema_migrations WHERE version='013-bulk-publication-projections';
  IF installed IS NOT NULL AND installed<>'013-bulk-publication-projections-v1' THEN RAISE EXCEPTION 'incompatible bulk publication migration'; END IF;
  FOR dependency IN SELECT * FROM (VALUES
    ('projected_session_snapshot(text,text,jsonb,timestamp with time zone)','095117ac49065f8d10e326786899f635df110f0a0d6c7eda9c896677fedb8e23'),
    ('publication_offer_term(text,text)','c96488627020ff27cc47d707a416c6f3ec2a8b7ccd91b9504ef90883c667eeca'),
    ('offer_revision_term(text)','6d4eb3de1aab12c9fddc11b937d6d7e616c5f63d1d2e9325ab2af8b1d84807ca'),
    ('session_projection_integrity(text,jsonb)','d2d329e1daaa793555cfc588babfd14e65a14bc616fe3fcc960373540d3f3d56'),
    ('canonical_offer_support_v5(text,jsonb)','21d9b96ea7ae2f42ca4259f977121d569885170a718bac3c0825992e7d44fb7d'),
    ('derive_offer_page_evidence(text,text)','1793c412df6526bb5510bf3d22e2c018e8c09f956a102cdc9a97632ef222d008')
  ) deps(signature,expected_hash) LOOP
    SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO actual FROM pg_proc WHERE oid=to_regprocedure('biplan.'||dependency.signature);
    IF actual IS DISTINCT FROM dependency.expected_hash THEN RAISE EXCEPTION 'bulk publication dependency implementation drifted: %',dependency.signature; END IF;
  END LOOP;
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO actual FROM pg_proc WHERE oid='biplan.publish_preparation_batch(text,text,text,bigint,text)'::regprocedure;
  IF actual IS DISTINCT FROM (CASE WHEN installed IS NULL THEN '93ad5f9f14ecd7a79d876feb51674bfc5f7f2bf738b1f57c94167602e7f2b08a' ELSE '823a173bcc33466ee060462c8137cd011b2b1c9f85d32c7a10e49078583a09ed' END) THEN RAISE EXCEPTION 'unexpected complete publisher function body; refusing stale migration or drift'; END IF;
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO actual FROM pg_proc WHERE oid='biplan.validate_publication_offers(text)'::regprocedure;
  IF actual IS DISTINCT FROM (CASE WHEN installed IS NULL THEN '377af676f1588bb40e6dedd2463d75ac2a39d30f13de470c53f9dafa59e4472b' ELSE 'e6ed3dced39d249d73379f3ced1d69544680bc12f6fb1892e0572b7fc53980ce' END) THEN RAISE EXCEPTION 'unexpected complete validator function body; refusing stale migration or drift'; END IF;
  IF installed IS NULL THEN
    SELECT replace(pg_get_functiondef('biplan.publish_preparation_batch(text,text,text,bigint,text)'::regprocedure),E'\r\n',E'\n') INTO definition;
    old_integrity:=replace(old_integrity,E'\r\n',E'\n'); new_integrity:=replace(new_integrity,E'\r\n',E'\n');
    IF position(old_integrity IN definition)=0 OR (length(definition)-length(replace(definition,old_integrity,'')))/length(old_integrity)<>1 THEN RAISE EXCEPTION 'unexpected unique integrity publication block'; END IF;
    definition:=replace(definition,old_integrity,new_integrity);
    old_snapshots:=replace(old_snapshots,E'\r\n',E'\n'); new_snapshots:=replace(new_snapshots,E'\r\n',E'\n');
    IF position(old_snapshots IN definition)=0 OR (length(definition)-length(replace(definition,old_snapshots,'')))/length(old_snapshots)<>1 THEN RAISE EXCEPTION 'unexpected unique snapshots publication block'; END IF;
    definition:=replace(definition,old_snapshots,new_snapshots);
    EXECUTE definition;
    SELECT replace(pg_get_functiondef('biplan.validate_publication_offers(text)'::regprocedure),E'\r\n',E'\n') INTO definition;
    old_terms:=replace(old_terms,E'\r\n',E'\n'); new_terms:=replace(new_terms,E'\r\n',E'\n');
    IF position(old_terms IN definition)=0 OR (length(definition)-length(replace(definition,old_terms,'')))/length(old_terms)<>1 THEN RAISE EXCEPTION 'unexpected unique terms publication block'; END IF;
    definition:=replace(definition,old_terms,new_terms);
    EXECUTE definition;
  END IF;
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO actual FROM pg_proc WHERE oid='biplan.publish_preparation_batch(text,text,text,bigint,text)'::regprocedure;
  IF actual IS DISTINCT FROM '823a173bcc33466ee060462c8137cd011b2b1c9f85d32c7a10e49078583a09ed' THEN RAISE EXCEPTION 'installed complete publisher function body differs from reviewed result'; END IF;
  SELECT encode(sha256(convert_to(replace(prosrc,E'\r\n',E'\n'),'UTF8')),'hex') INTO actual FROM pg_proc WHERE oid='biplan.validate_publication_offers(text)'::regprocedure;
  IF actual IS DISTINCT FROM 'e6ed3dced39d249d73379f3ced1d69544680bc12f6fb1892e0572b7fc53980ce' THEN RAISE EXCEPTION 'installed complete validator function body differs from reviewed result'; END IF;
END $migration$;
INSERT INTO biplan.schema_migrations(version,migration_hash) VALUES('013-bulk-publication-projections','013-bulk-publication-projections-v1') ON CONFLICT(version) DO NOTHING;
COMMIT;
