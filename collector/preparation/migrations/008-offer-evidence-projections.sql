BEGIN;
DO $$ DECLARE name text; definition text; signature text; BEGIN
  IF NOT EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='007-page-receipts') THEN RAISE EXCEPTION 'offer projections require migration 007'; END IF;
  FOREACH signature IN ARRAY ARRAY['record_batch_page(text,jsonb)','seal_preparation_batch_v2(text,jsonb)',
    'publish_preparation_batch(text,text,text,bigint,text)','validate_publication_offers(text)',
    'current_publication_offer_status(text,text,timestamp with time zone,interval)'] LOOP
    name:=split_part(signature,'(',1);
    IF to_regprocedure('biplan.'||replace(signature,name,name||'_v7')) IS NULL THEN
      SELECT pg_get_functiondef(('biplan.'||signature)::regprocedure) INTO definition;
      EXECUTE replace(definition,'FUNCTION biplan.'||name||'(','FUNCTION biplan.'||name||'_v7(');
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION biplan.projected_session_snapshot(p_publication text,p_session text,p_facts jsonb,p_checked_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE terms jsonb; raws jsonb; summary jsonb;
BEGIN
  SELECT jsonb_agg(biplan.publication_offer_term(e.publication_id,e.offer_id) ORDER BY e.offer_id),jsonb_agg(r.source_payload ORDER BY e.offer_id)
    INTO terms,raws FROM biplan.publication_offer_evidence e JOIN biplan.offer_revisions r ON r.id=e.offer_revision_id
    WHERE e.publication_id=p_publication AND e.session_id=p_session;
  IF terms IS NULL THEN RAISE EXCEPTION 'projection session has no immutable offer pins'; END IF;
  SELECT jsonb_build_object('availability',CASE WHEN bool_or(eligible) THEN 'available' ELSE 'unknown' END,
    'displayPrice',min(price_minor) FILTER(WHERE eligible)/100.0,'displayPriceMinor',(min(price_minor) FILTER(WHERE eligible))::text,
    'currency',CASE WHEN bool_or(eligible) THEN 'TRY' END,'displayPriceIsHardBudgetTotal',false,
    'sourceUrl',(array_agg(source_url ORDER BY price_minor,id) FILTER(WHERE eligible))[1]) INTO summary
  FROM (SELECT r.*,e.disposition='supported' AND r.currency='TRY' AND r.price_minor IS NOT NULL
    AND (r.price IS NULL OR r.price*100=r.price_minor) AND r.availability IN ('available','limited') AND r.price_kind<>'unknown'
    AND r.observed_at<=p_checked_at AND r.observed_at>=p_checked_at-interval '3 days'
    AND (r.valid_from IS NULL OR r.valid_from<=p_checked_at) AND (r.valid_until IS NULL OR r.valid_until>=p_checked_at) eligible
    FROM biplan.publication_offer_evidence e JOIN biplan.offer_revisions r ON r.id=e.offer_revision_id
    WHERE e.publication_id=p_publication AND e.session_id=p_session) rows;
  RETURN p_facts||jsonb_build_object('offerTermsVersion',2,'offerTerms',terms,'offers',raws,'offerSummary',summary,
    'availability',summary->'availability','price',summary->'displayPrice','currency',summary->'currency','url',summary->'sourceUrl');
END $$;
CREATE TABLE IF NOT EXISTS biplan.preparation_batch_page_sessions (
  batch_id text NOT NULL REFERENCES biplan.preparation_batches(id),session_id text NOT NULL REFERENCES biplan.sessions(id),
  canonical_revision_id text REFERENCES biplan.canonical_revisions(id),canonical_content_hash text NOT NULL,
  PRIMARY KEY(batch_id,session_id)
);
CREATE TABLE IF NOT EXISTS biplan.publication_offer_evidence (
  publication_id text NOT NULL REFERENCES biplan.publications(id),session_id text NOT NULL REFERENCES biplan.sessions(id),
  offer_id text NOT NULL REFERENCES biplan.offer_identities(id),offer_revision_id text NOT NULL REFERENCES biplan.offer_revisions(id),
  page_observation_id text REFERENCES biplan.source_page_observations(id),canonical_dependency_hash text NOT NULL,
  disposition text NOT NULL CHECK(disposition IN ('supported','unsupported')),
  reason_code text NOT NULL CHECK(reason_code IN ('verified_record','legacy_unobserved','page_retired','refresh_failed','incomplete_page','session_absent')),
  policy_version text NOT NULL CHECK(policy_version='provider-page-offer-v1'),
  evidence_observed_at timestamptz,dependency_hash text NOT NULL CHECK(dependency_hash ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY(publication_id,offer_id),
  FOREIGN KEY(publication_id,session_id,offer_revision_id) REFERENCES biplan.publication_offers(publication_id,session_id,offer_revision_id)
);
CREATE INDEX IF NOT EXISTS publication_offer_evidence_session_idx ON biplan.publication_offer_evidence(publication_id,session_id);
CREATE OR REPLACE TRIGGER publication_offer_evidence_immutable BEFORE UPDATE OR DELETE ON biplan.publication_offer_evidence
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();
CREATE OR REPLACE TRIGGER publication_offer_evidence_candidate BEFORE INSERT ON biplan.publication_offer_evidence
FOR EACH ROW EXECUTE FUNCTION biplan.protect_candidate_publication_offer();

CREATE OR REPLACE FUNCTION biplan.record_batch_page(p_batch_id text,p_page jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
  IF p_page?'reasonCode' AND (jsonb_typeof(p_page->'reasonCode')<>'string' OR length(p_page->>'reasonCode')>200) THEN RAISE EXCEPTION 'invalid page reason code'; END IF;
  result:=biplan.record_batch_page_v7(p_batch_id,p_page);
  IF EXISTS(SELECT 1 FROM biplan.preparation_batches WHERE id=p_batch_id AND state='collecting') THEN
    INSERT INTO biplan.preparation_batch_page_sessions(batch_id,session_id,canonical_revision_id,canonical_content_hash)
      SELECT DISTINCT p_batch_id,s.id,h.revision_id,s.content_hash FROM biplan.offer_identities i
        JOIN biplan.offer_revisions r ON r.id=i.current_revision_id JOIN biplan.sessions s ON s.id=i.session_id
        LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id
      WHERE i.provider=p_page->>'provider' AND r.source_url=p_page->>'url' ON CONFLICT DO NOTHING;
  END IF;
  RETURN result;
END $$;

-- Pure derivation from immutable inputs. No current head is read by this helper.
CREATE OR REPLACE FUNCTION biplan.derive_offer_page_evidence(p_revision_id text,p_page_id text) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE r biplan.offer_revisions%ROWTYPE; p biplan.source_page_observations%ROWTYPE; disposition text; reason text;
BEGIN
  SELECT * INTO r FROM biplan.offer_revisions WHERE id=p_revision_id;
  IF NOT FOUND OR r.acceptance_status<>'accepted' THEN RAISE EXCEPTION 'missing accepted offer evidence'; END IF;
  SELECT * INTO p FROM biplan.source_page_observations WHERE id=p_page_id;
  IF p_page_id IS NULL THEN disposition:='unsupported'; reason:='legacy_unobserved';
  ELSIF p.id IS NULL OR p.provider<>r.provider OR p.source_url<>r.source_url THEN RAISE EXCEPTION 'page does not bind this provider offer';
  ELSIF p.receipt->>'status'<>'accepted' THEN disposition:='family_hold'; reason:='page_source_clock_conflict';
  ELSIF p.status='quarantined' THEN disposition:='family_hold'; reason:=CASE WHEN p.payload->>'reasonCode' IN
    ('session_time_conflict','venue_conflict','title_conflict','attendance_conflict','cancellation_conflict') THEN p.payload->>'reasonCode' ELSE 'unclassified_quarantine' END;
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(p.payload->'records') ref JOIN biplan.canonical_requests cr ON cr.id=ref->>'requestId'
    WHERE ref->>'sourceRecordId'=r.provider_record_id AND cr.receipt->>'status'<>'accepted')
    THEN disposition:='family_hold'; reason:='record_integrity_conflict';
  ELSIF p.status='retired' THEN disposition:='unsupported'; reason:='page_retired';
  ELSIF p.status='failed' THEN disposition:='unsupported'; reason:='refresh_failed';
  ELSIF p.payload->>'complete'<>'true' THEN disposition:='unsupported'; reason:='incomplete_page';
  ELSIF EXISTS(SELECT 1 FROM jsonb_array_elements(p.payload->'records') ref JOIN biplan.canonical_requests cr ON cr.id=ref->>'requestId'
    WHERE cr.receipt->>'status'='accepted' AND cr.receipt->>'offerRevisionId'=r.id
      AND cr.payload#>>'{record,id}'=ref->>'sourceRecordId' AND cr.payload#>>'{record,source}'=p.provider
      AND cr.payload#>>'{record,url}'=p.source_url AND abs(extract(epoch FROM (cr.payload#>>'{record,checkedAt}')::timestamptz-p.observed_at))<=60)
    THEN disposition:='supported'; reason:='verified_record';
  ELSE disposition:='unsupported'; reason:='session_absent'; END IF;
  RETURN jsonb_build_object('disposition',disposition,'reasonCode',reason,'pageObservationId',p.id,'observedAt',p.observed_at);
END $$;
CREATE OR REPLACE FUNCTION biplan.current_offer_page_evidence(p_offer_id text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT biplan.derive_offer_page_evidence(r.id,h.page_id) FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
    LEFT JOIN biplan.source_page_heads h ON h.provider=i.provider AND h.source_url=r.source_url WHERE i.id=p_offer_id
$$;
CREATE OR REPLACE FUNCTION biplan.session_projection_integrity(p_session_id text,p_facts jsonb) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(biplan.canonical_offer_support_v5(p_session_id,p_facts)->'offers') o
    WHERE o->>'support' IN ('disputed','occurrence_mismatch')
      OR (o->>'support'='unknown_occurrence' AND biplan.current_offer_page_evidence(o->>'offerId')->>'disposition'='supported'))
    AND NOT EXISTS(SELECT 1 FROM biplan.offer_identities i WHERE i.session_id=p_session_id
      AND biplan.current_offer_page_evidence(i.id)->>'disposition'='family_hold')
$$;
CREATE OR REPLACE FUNCTION biplan.offer_evidence_hash(p_revision text,p_page text,p_canonical text,p_disposition text,p_reason text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(jsonb_build_array('provider-page-offer-v1',p_revision,p_page,p_canonical,p_disposition,p_reason)::text,'UTF8')),'hex')
$$;
CREATE OR REPLACE FUNCTION biplan.publication_offer_term(p_publication_id text,p_offer_id text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT biplan.offer_revision_term(e.offer_revision_id)
    ||CASE WHEN e.disposition='unsupported' THEN '{"availability":"unknown","price":null,"priceMinor":null,"feeMinor":null,"priceKind":"unknown","sourceUrl":null}'::jsonb ELSE '{}'::jsonb END
    ||jsonb_build_object('evidenceVersion',1,'evidenceStatus',e.disposition,'evidenceReason',e.reason_code,
      'pageObservationId',e.page_observation_id,'evidenceDependencyHash',e.dependency_hash,'evidencePolicyVersion',e.policy_version,'evidenceObservedAt',e.evidence_observed_at)
  FROM biplan.publication_offer_evidence e WHERE e.publication_id=p_publication_id AND e.offer_id=p_offer_id
$$;
CREATE OR REPLACE FUNCTION biplan.publication_offer_evidence_current(p_publication_id text,p_offer_id text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT i.current_revision_id=e.offer_revision_id AND h.page_id IS NOT DISTINCT FROM e.page_observation_id
    AND e.canonical_dependency_hash=COALESCE(c.dependency_hash,s.content_hash)
    AND biplan.current_offer_page_evidence(i.id)->>'disposition'<>'family_hold'
    FROM biplan.publication_offer_evidence e JOIN biplan.offer_identities i ON i.id=e.offer_id
      JOIN biplan.offer_revisions r ON r.id=i.current_revision_id JOIN biplan.sessions s ON s.id=i.session_id
      LEFT JOIN biplan.canonical_heads ch ON ch.session_id=s.id LEFT JOIN biplan.canonical_revisions c ON c.id=ch.revision_id
      LEFT JOIN biplan.source_page_heads h ON h.provider=i.provider AND h.source_url=r.source_url
    WHERE e.publication_id=p_publication_id AND e.offer_id=p_offer_id),false)
$$;

CREATE OR REPLACE FUNCTION biplan.validate_publication_offers(p_publication_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE p biplan.publications%ROWTYPE;
BEGIN
  SELECT * INTO p FROM biplan.publications WHERE id=p_publication_id;
  IF p.manifest->>'offerProjectionVersion' IS DISTINCT FROM '1' THEN PERFORM biplan.validate_publication_offers_v7(p_publication_id); RETURN; END IF;
  IF (p.manifest->>'requiredOfferCount')::integer<>(SELECT count(*) FROM biplan.publication_offers WHERE publication_id=p.id)
    OR (p.manifest->>'requiredOfferEvidenceCount')::integer<>(SELECT count(*) FROM biplan.publication_offer_evidence WHERE publication_id=p.id)
    OR EXISTS(SELECT 1 FROM biplan.publication_offers po JOIN biplan.offer_revisions r ON r.id=po.offer_revision_id
      LEFT JOIN biplan.publication_offer_evidence e ON e.publication_id=po.publication_id AND e.offer_id=r.offer_id
      LEFT JOIN biplan.published_sessions ps ON ps.publication_id=po.publication_id AND ps.session_id=po.session_id
      WHERE po.publication_id=p.id AND (e.offer_id IS NULL OR e.offer_revision_id<>r.id OR e.session_id<>po.session_id
        OR ps.session_id IS NULL OR r.acceptance_status<>'accepted'
        OR e.canonical_dependency_hash IS DISTINCT FROM COALESCE(ps.eligibility_snapshot->>'canonicalDependencyHash',
          (SELECT content_hash FROM biplan.sessions WHERE id=ps.session_id))
        OR e.dependency_hash<>biplan.offer_evidence_hash(r.id,e.page_observation_id,e.canonical_dependency_hash,e.disposition,e.reason_code)
        OR e.disposition IS DISTINCT FROM biplan.derive_offer_page_evidence(r.id,e.page_observation_id)->>'disposition'
        OR e.reason_code IS DISTINCT FROM biplan.derive_offer_page_evidence(r.id,e.page_observation_id)->>'reasonCode'))
    OR EXISTS(SELECT 1 FROM biplan.published_sessions ps WHERE ps.publication_id=p.id AND (
      ps.eligibility_snapshot->>'offerTermsVersion' IS DISTINCT FROM '2'
      OR ps.eligibility_snapshot->'offerTerms' IS DISTINCT FROM (SELECT jsonb_agg(biplan.publication_offer_term(p.id,e.offer_id) ORDER BY e.offer_id)
        FROM biplan.publication_offer_evidence e WHERE e.publication_id=p.id AND e.session_id=ps.session_id)))
    THEN RAISE EXCEPTION 'publication offer evidence pins or typed projections are incomplete or inconsistent'; END IF;
END $$;

CREATE OR REPLACE FUNCTION biplan.seal_preparation_batch_v2(p_batch_id text,p_seal jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE b biplan.preparation_batches%ROWTYPE; c jsonb:=p_seal->'collectorCoverage'; e jsonb; field text; ps text[];
  total integer; pages integer; blocked integer; current_records integer; recovered_records integer;
  counts record; declared_urls jsonb; actual_hash text; known_total bigint:=0; attempted_total bigint:=0;
  v_full boolean; oldest timestamptz; expires timestamptz; max_age bigint; finished timestamptz; result jsonb; pub_job text;
BEGIN
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR b.header->>'schemaVersion' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'v2 batch required'; END IF;
  IF b.seal IS NOT NULL THEN
    IF b.seal<>p_seal THEN RAISE EXCEPTION 'sealed v2 batch input changed'; END IF;
    RETURN b.receipt||'{"idempotent":true}'::jsonb;
  END IF;
  IF b.state<>'collecting' THEN RAISE EXCEPTION 'batch cannot be sealed'; END IF;
  PERFORM biplan.check_preparation_storage();
  LOCK TABLE biplan.offer_identities IN SHARE MODE;
  SELECT count(*),count(*) FILTER(WHERE status<>'accepted') INTO total,blocked FROM biplan.preparation_batch_items WHERE batch_id=b.id;
  SELECT count(*) INTO pages FROM biplan.preparation_batch_pages WHERE batch_id=b.id;
  IF p_seal->>'inputHash' IS DISTINCT FROM b.input_hash OR COALESCE(p_seal->>'recordCount','') !~ '^\d+$'
    OR (p_seal->>'recordCount')::bigint<>total OR COALESCE(p_seal->>'pageCount','') !~ '^\d+$' OR (p_seal->>'pageCount')::bigint<>pages
    OR c->>'schemaVersion' IS DISTINCT FROM '2' OR jsonb_typeof(c->'complete') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(c->'inventory') IS DISTINCT FROM 'array' OR c#>>'{discovery,unit}' IS DISTINCT FROM 'detail_url'
    OR c#>>'{records,unit}' IS DISTINCT FROM 'event_record'
    OR c#>>'{discovery,listingConfigHash}' IS DISTINCT FROM b.header#>>'{scopeEvidence,listingConfigHash}'
    OR jsonb_typeof(c#>'{discovery,exhausted}') IS DISTINCT FROM 'boolean'
    OR COALESCE(c->>'finishedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    THEN RAISE EXCEPTION 'invalid v2 seal or coverage units'; END IF;
  finished:=(c->>'finishedAt')::timestamptz; v_full:=(c->>'complete')::boolean;
  IF NOT isfinite(finished) OR finished>clock_timestamp()+interval '5 minutes' OR finished<(b.header->>'startedAt')::timestamptz THEN RAISE EXCEPTION 'invalid v2 coverage finish'; END IF;
  IF EXISTS(SELECT 1 FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id
    WHERE bp.batch_id=b.id AND p.observed_at>finished+interval '1 minute') THEN RAISE EXCEPTION 'page evidence after collection finish'; END IF;
  IF EXISTS(SELECT 1 FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id
    WHERE bp.batch_id=b.id GROUP BY p.provider,p.source_url HAVING count(*)<>1) THEN RAISE EXCEPTION 'multiple page observations for one URL in sealed input'; END IF;
  -- Every normalized record belongs to exactly one immutable page observation.
  IF EXISTS(SELECT 1 FROM biplan.preparation_batch_items i WHERE i.batch_id=b.id AND 1<>(
    SELECT count(*) FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id
      CROSS JOIN LATERAL jsonb_array_elements(p.payload->'records') ref WHERE bp.batch_id=b.id AND ref->>'requestId'=i.request_id))
    OR EXISTS(SELECT 1 FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id
      CROSS JOIN LATERAL jsonb_array_elements(p.payload->'records') ref
      LEFT JOIN biplan.preparation_batch_items i ON i.batch_id=bp.batch_id AND i.request_id=ref->>'requestId'
      LEFT JOIN biplan.canonical_requests cr ON cr.id=i.request_id
      WHERE bp.batch_id=b.id AND (i.request_id IS NULL OR (i.status='accepted' AND (
        cr.payload#>>'{record,id}' IS DISTINCT FROM ref->>'sourceRecordId' OR cr.payload#>>'{record,source}' IS DISTINCT FROM p.provider
        OR cr.payload#>>'{record,url}' IS DISTINCT FROM p.source_url
        OR abs(extract(epoch FROM (cr.payload#>>'{record,checkedAt}')::timestamptz-p.observed_at))>60))))
    THEN RAISE EXCEPTION 'v2 page record membership mismatch'; END IF;
  SELECT COALESCE(sum(jsonb_array_length(p.payload->'records')) FILTER(WHERE p.payload->>'origin'='current_run'),0),
    COALESCE(sum(jsonb_array_length(p.payload->'records')) FILTER(WHERE p.payload->>'origin'='recovered'),0)
    INTO current_records,recovered_records FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id WHERE bp.batch_id=b.id;
  FOREACH field IN ARRAY ARRAY['submitted','currentRun','recovered','carried','sourceQuarantined'] LOOP
    IF COALESCE(c#>>ARRAY['records',field],'') !~ '^\d+$' THEN RAISE EXCEPTION 'invalid normalized record count'; END IF;
  END LOOP;
  IF (c#>>'{records,submitted}')::bigint<>total OR (c#>>'{records,currentRun}')::bigint<>current_records
    OR (c#>>'{records,recovered}')::bigint<>recovered_records THEN RAISE EXCEPTION 'v2 normalized record counts differ from durable input'; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(c->'inventory') LOOP
    FOREACH field IN ARRAY ARRAY['known','attemptedThisRun','verifiedThisRun','retiredThisRun','failedThisRun','quarantinedThisRun','unattemptedThisRun','neverVisited','stale','outstandingFailures'] LOOP
      IF COALESCE(e->>field,'') !~ '^\d+$' THEN RAISE EXCEPTION 'invalid URL coverage count'; END IF;
    END LOOP;
    IF COALESCE(e->>'provider','')<>ALL(b.providers)
      OR (e->>'known')::bigint<>(e->>'attemptedThisRun')::bigint+(e->>'unattemptedThisRun')::bigint
      OR (e->>'attemptedThisRun')::bigint<>(e->>'verifiedThisRun')::bigint+(e->>'retiredThisRun')::bigint+(e->>'failedThisRun')::bigint+(e->>'quarantinedThisRun')::bigint
      OR (e->>'neverVisited')::bigint>(e->>'known')::bigint OR (e->>'stale')::bigint>(e->>'known')::bigint
      OR (e->>'outstandingFailures')::bigint>(e->>'known')::bigint THEN RAISE EXCEPTION 'inconsistent URL coverage partition'; END IF;
    ps:=array_append(ps,e->>'provider'); known_total:=known_total+(e->>'known')::bigint; attempted_total:=attempted_total+(e->>'attemptedThisRun')::bigint;
    SELECT count(*) FILTER(WHERE p.status='verified') verified,count(*) FILTER(WHERE p.status='retired') retired,
      count(*) FILTER(WHERE p.status='failed') failed,count(*) FILTER(WHERE p.status='quarantined') quarantined INTO counts
      FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id
      WHERE bp.batch_id=b.id AND p.provider=e->>'provider' AND p.payload->>'origin'='current_run';
    IF counts.verified>(e->>'verifiedThisRun')::bigint OR counts.retired>(e->>'retiredThisRun')::bigint
      OR counts.failed>(e->>'failedThisRun')::bigint OR counts.quarantined>(e->>'quarantinedThisRun')::bigint
      OR (v_full AND (counts.verified<>(e->>'verifiedThisRun')::bigint OR counts.retired<>(e->>'retiredThisRun')::bigint
        OR (e->>'failedThisRun')::bigint<>0 OR (e->>'quarantinedThisRun')::bigint<>0 OR (e->>'unattemptedThisRun')::bigint<>0
        OR (e->>'neverVisited')::bigint<>0 OR (e->>'stale')::bigint<>0 OR (e->>'outstandingFailures')::bigint<>0))
      THEN RAISE EXCEPTION 'URL coverage lacks matching page evidence'; END IF;
  END LOOP;
  SELECT array_agg(x ORDER BY x) INTO ps FROM unnest(ps)x;
  IF ps IS DISTINCT FROM b.providers THEN RAISE EXCEPTION 'v2 provider coverage differs from declared scope'; END IF;
  declared_urls:=c#>'{discovery,urls}';
  IF declared_urls IS NOT NULL AND declared_urls<>'null'::jsonb THEN
    IF jsonb_typeof(declared_urls)<>'array' OR jsonb_array_length(declared_urls)>20000 OR jsonb_array_length(declared_urls)<>known_total
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(declared_urls) u WHERE COALESCE(u->>'provider','')<>ALL(b.providers)
        OR COALESCE(u->>'url','')='' OR (u->>'url') ~ E'[\n\r\t]')
      OR (SELECT count(DISTINCT jsonb_build_array(u->>'provider',u->>'url')) FROM jsonb_array_elements(declared_urls)u)<>known_total
      THEN RAISE EXCEPTION 'invalid declared URL inventory'; END IF;
    SELECT encode(sha256(convert_to(COALESCE(string_agg((u->>'provider')||E'\t'||(u->>'url')||E'\n','' ORDER BY (u->>'provider') COLLATE "C",(u->>'url') COLLATE "C"),''),'UTF8')),'hex')
      INTO actual_hash FROM jsonb_array_elements(declared_urls)u;
    IF c#>>'{discovery,inventoryHash}' IS DISTINCT FROM actual_hash THEN RAISE EXCEPTION 'declared URL inventory hash mismatch'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(c->'inventory') inventory_entry WHERE (inventory_entry->>'known')::bigint<>(SELECT count(*) FROM jsonb_array_elements(declared_urls)u WHERE u->>'provider'=inventory_entry->>'provider'))
      OR EXISTS(SELECT 1 FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id
        WHERE bp.batch_id=b.id AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(declared_urls)u WHERE u->>'provider'=p.provider AND u->>'url'=p.source_url))
      THEN RAISE EXCEPTION 'page evidence outside declared URL inventory'; END IF;
  ELSIF v_full OR c#>>'{discovery,inventoryHash}' IS NOT NULL THEN RAISE EXCEPTION 'full coverage requires declared URL identities'; END IF;
  IF COALESCE(c#>>'{freshness,maxSourceAgeMs}','') !~ '^\d+$' THEN RAISE EXCEPTION 'invalid source freshness policy'; END IF;
  max_age:=(c#>>'{freshness,maxSourceAgeMs}')::bigint;
  IF max_age NOT BETWEEN 1 AND 86400000 THEN RAISE EXCEPTION 'unsupported source freshness policy'; END IF;
  IF v_full THEN
    IF b.scope<>'full' OR c#>>'{discovery,exhausted}'<>'true' OR known_total=0 OR pages<>known_total OR recovered_records<>0
      OR (c#>>'{records,sourceQuarantined}')::bigint<>0
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(declared_urls)u WHERE NOT EXISTS(
        SELECT 1 FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id
          JOIN biplan.source_page_heads h ON h.page_id=p.id WHERE bp.batch_id=b.id AND p.provider=u->>'provider' AND p.source_url=u->>'url'
          AND p.receipt->>'status'='accepted' AND p.status IN ('verified','retired') AND p.payload->>'complete'='true'
          AND p.payload->>'origin'='current_run' AND p.observed_at>=(b.header->>'startedAt')::timestamptz))
      THEN RAISE EXCEPTION 'full URL inventory is not resolved in declared collection cycle'; END IF;
    SELECT min(stamp) INTO oldest FROM (
      SELECT p.observed_at stamp FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id WHERE bp.batch_id=b.id
      UNION ALL SELECT (cr.payload#>>'{record,checkedAt}')::timestamptz FROM biplan.preparation_batch_items i JOIN biplan.canonical_requests cr ON cr.id=i.request_id WHERE i.batch_id=b.id AND i.status='accepted') observations;
    expires:=oldest+max_age*interval '1 millisecond';
    IF (c#>>'{freshness,oldestResolvedAt}')::timestamptz IS DISTINCT FROM oldest OR (c#>>'{freshness,validUntil}')::timestamptz IS DISTINCT FROM expires
      OR expires<=clock_timestamp() THEN RAISE EXCEPTION 'full source coverage freshness expired or misstated'; END IF;
    -- A small declared inventory cannot upgrade unobserved eligible legacy offers
    -- into a fully refreshed catalog. The horizon is half-open and provider-scoped.
    IF EXISTS(SELECT 1 FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
      JOIN biplan.sessions s ON s.id=i.session_id WHERE i.provider=ANY(b.providers) AND r.acceptance_status='accepted'
        AND r.availability IN ('available','limited') AND s.status='scheduled' AND s.starts_at>=b.horizon_start AND s.starts_at<b.horizon_end
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(declared_urls) u
          JOIN biplan.source_page_heads h ON h.provider=u->>'provider' AND h.source_url=u->>'url'
          JOIN biplan.source_page_observations p ON p.id=h.page_id
          JOIN biplan.preparation_batch_pages bp ON bp.page_id=p.id AND bp.batch_id=b.id
          WHERE u->>'provider'=i.provider AND u->>'url'=r.source_url AND p.receipt->>'status'='accepted'
            AND p.status IN ('verified','retired') AND p.payload->>'complete'='true' AND p.payload->>'origin'='current_run'
            AND p.payload->>'originRunId'=b.collection_run_id AND p.observed_at>=(b.header->>'startedAt')::timestamptz
            AND biplan.current_offer_page_evidence(i.id)->>'disposition'<>'family_hold'))
      THEN RAISE EXCEPTION 'full coverage omits an eligible provider offer or its current-cycle page evidence'; END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id
    LEFT JOIN biplan.source_page_heads h ON h.provider=p.provider AND h.source_url=p.source_url
    WHERE bp.batch_id=b.id AND (p.receipt->>'status'<>'accepted' OR h.page_id IS DISTINCT FROM p.id OR p.status='quarantined')) THEN blocked:=blocked+1; END IF;
  IF (c#>>'{records,sourceQuarantined}')::bigint>0 THEN blocked:=blocked+1; END IF;
  IF EXISTS(SELECT 1 FROM biplan.sessions s LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id
    LEFT JOIN biplan.canonical_revisions r ON r.id=h.revision_id LEFT JOIN biplan.active_publication a ON a.singleton
    LEFT JOIN biplan.published_sessions ps ON ps.publication_id=a.publication_id AND ps.session_id=s.id
    WHERE s.status='scheduled' AND EXISTS(SELECT 1 FROM biplan.offer_identities i WHERE i.session_id=s.id)
      AND NOT biplan.session_projection_integrity(s.id,COALESCE(r.facts,ps.eligibility_snapshot))) THEN blocked:=blocked+1; END IF;
  c:=c||jsonb_build_object('scope',b.scope,'providers',to_jsonb(b.providers),'horizonStart',b.header->'horizonStart','horizonEnd',b.header->'horizonEnd',
    'collectionRunId',b.collection_run_id,'inputHash',b.input_hash,'startedAt',b.header->'startedAt','scopeEvidence',b.header->'scopeEvidence');
  UPDATE biplan.preparation_jobs j SET state='canceled',last_error='{"code":"superseded_within_batch"}'::jsonb
    WHERE j.stage='canonical-batch' AND j.checkpoint->>'batchId'=b.id AND j.state='pending'
      AND NOT EXISTS(SELECT 1 FROM biplan.preparation_batch_sessions s WHERE s.batch_id=b.id AND s.job_id=j.id);
  pub_job:='batch-publication:'||md5(b.id);
  INSERT INTO biplan.preparation_jobs(id,stage,stage_version,subject_type,subject_id,input_hash,priority,checkpoint)
    VALUES(pub_job,'canonical-batch-publication','1','batch',b.id,md5(p_seal::text),50,jsonb_build_object('batchId',b.id));
  result:=jsonb_build_object('batchId',b.id,'status',CASE WHEN blocked>0 THEN 'blocked' ELSE 'sealed' END,'records',total,'pages',pages,'blockedRecords',blocked,'publicationJobId',pub_job,'idempotent',false);
  UPDATE biplan.preparation_batches SET state=result->>'status',seal=p_seal,coverage=c,sealed_at=clock_timestamp(),receipt=result WHERE id=b.id;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION biplan.publish_preparation_batch(p_batch_id text,p_job_id text,p_worker_id text,p_fence bigint,p_expected_base_publication_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
#variable_conflict use_variable
DECLARE b biplan.preparation_batches%ROWTYPE; j biplan.preparation_jobs%ROWTYPE; base biplan.publications%ROWTYPE;
  active_id text; target_id text; target_ids text[]; checked_at timestamptz:=clock_timestamp(); manifest jsonb; receipt jsonb; preparation_receipt jsonb;
  storage jsonb; offer_count integer; evaluation_count integer; previous_coverage jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('biplan.active_publication',0));
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=p_batch_id FOR UPDATE;
  IF b.header->>'schemaVersion' IS DISTINCT FROM '2' THEN RETURN biplan.publish_preparation_batch_v7(p_batch_id,p_job_id,p_worker_id,p_fence,p_expected_base_publication_id); END IF;
  LOCK TABLE biplan.offer_identities IN SHARE MODE;
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.stage<>'canonical-batch-publication' OR j.stage_version<>'1' OR j.subject_id<>b.id
    OR j.checkpoint->>'batchId' IS DISTINCT FROM b.id THEN RAISE EXCEPTION 'unsupported projection publication job'; END IF;
  IF b.state='published' AND j.state='succeeded' AND j.fencing_token=p_fence AND EXISTS(SELECT 1 FROM biplan.job_attempts
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker_id AND outcome='succeeded') THEN RETURN b.receipt||'{"idempotent":true}'::jsonb; END IF;
  IF b.state<>'sealed' OR j.state<>'leased' OR j.lease_owner IS DISTINCT FROM p_worker_id OR j.fencing_token IS DISTINCT FROM p_fence
    OR j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale or unsealed projection publication'; END IF;
  storage:=biplan.check_preparation_storage();
  SELECT publication_id INTO active_id FROM biplan.active_publication WHERE singleton FOR UPDATE;
  IF active_id IS DISTINCT FROM p_expected_base_publication_id THEN RAISE EXCEPTION 'active publication guard failed for projection batch'; END IF;
  SELECT * INTO base FROM biplan.publications WHERE id=active_id;
  IF base.required_embedding_profile IS DISTINCT FROM b.embedding_profile THEN RAISE EXCEPTION 'batch embedding profile changed'; END IF;
  IF b.coverage->>'schemaVersion' IS DISTINCT FROM '2' OR EXISTS(SELECT 1 FROM biplan.preparation_batch_items WHERE batch_id=b.id AND status<>'accepted')
    THEN RAISE EXCEPTION 'projection batch has unresolved required records'; END IF;
  IF b.coverage->>'complete'='true' AND (b.coverage#>>'{freshness,validUntil}')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'full coverage expired before publication'; END IF;
  IF EXISTS(SELECT 1 FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id
    LEFT JOIN biplan.source_page_heads h ON h.provider=p.provider AND h.source_url=p.source_url
    WHERE bp.batch_id=b.id AND (h.page_id IS DISTINCT FROM p.id OR p.receipt->>'status'<>'accepted' OR p.status='quarantined')) THEN
    RAISE EXCEPTION 'page dependency changed or mandatory page integrity held'; END IF;
  IF b.coverage->>'complete'='true' AND EXISTS(SELECT 1 FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
    JOIN biplan.sessions s ON s.id=i.session_id WHERE i.provider=ANY(b.providers) AND r.acceptance_status='accepted'
      AND r.availability IN ('available','limited') AND s.status='scheduled' AND s.starts_at>=b.horizon_start AND s.starts_at<b.horizon_end
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.coverage#>'{discovery,urls}')u
        JOIN biplan.source_page_heads h ON h.provider=u->>'provider' AND h.source_url=u->>'url'
        JOIN biplan.source_page_observations p ON p.id=h.page_id JOIN biplan.preparation_batch_pages bp ON bp.page_id=p.id AND bp.batch_id=b.id
        WHERE u->>'provider'=i.provider AND u->>'url'=r.source_url AND p.receipt->>'status'='accepted' AND p.status IN ('verified','retired')
          AND p.payload->>'complete'='true' AND p.payload->>'origin'='current_run' AND p.payload->>'originRunId'=b.collection_run_id
          AND p.observed_at>=(b.header->>'startedAt')::timestamptz AND biplan.current_offer_page_evidence(i.id)->>'disposition'<>'family_hold'))
    THEN RAISE EXCEPTION 'full coverage omits an eligible provider offer or current-cycle page evidence'; END IF;
  SELECT COALESCE(array_agg(DISTINCT x.session_id ORDER BY x.session_id),'{}') INTO target_ids FROM (
    SELECT session_id FROM biplan.published_sessions WHERE publication_id=active_id
    UNION SELECT session_id FROM biplan.preparation_batch_sessions WHERE batch_id=b.id
    UNION SELECT session_id FROM biplan.preparation_batch_page_sessions WHERE batch_id=b.id)x JOIN biplan.sessions s ON s.id=x.session_id WHERE s.status='scheduled';
  PERFORM 1 FROM biplan.sessions WHERE id=ANY(target_ids) ORDER BY id FOR SHARE;
  PERFORM 1 FROM biplan.canonical_heads WHERE session_id=ANY(target_ids) ORDER BY session_id FOR SHARE;
  IF EXISTS(SELECT 1 FROM biplan.preparation_batch_sessions bs LEFT JOIN biplan.preparation_jobs p ON p.id=bs.job_id
    LEFT JOIN biplan.canonical_preparations cp ON cp.revision_id=bs.revision_id LEFT JOIN biplan.search_documents d ON d.id=cp.document_id
    LEFT JOIN biplan.canonical_heads h ON h.session_id=bs.session_id LEFT JOIN biplan.canonical_revisions r ON r.id=bs.revision_id
    JOIN biplan.sessions s ON s.id=bs.session_id WHERE bs.batch_id=b.id AND (p.state IS DISTINCT FROM 'succeeded' OR cp.revision_id IS NULL OR d.id IS NULL
      OR h.revision_id IS DISTINCT FROM bs.revision_id OR s.content_hash IS DISTINCT FROM r.semantic_hash
      OR d.dependency_hash IS DISTINCT FROM r.dependency_hash OR d.document_hash IS DISTINCT FROM cp.result->>'documentHash')) THEN
    RAISE EXCEPTION 'projection batch required canonical preparation or dependency incomplete'; END IF;
  IF EXISTS(SELECT 1 FROM biplan.sessions s LEFT JOIN biplan.preparation_batch_sessions bs ON bs.batch_id=b.id AND bs.session_id=s.id
    LEFT JOIN biplan.published_sessions ps ON ps.publication_id=active_id AND ps.session_id=s.id
    LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id LEFT JOIN biplan.canonical_revisions r ON r.id=h.revision_id
    WHERE s.id=ANY(target_ids) AND (NOT biplan.session_projection_integrity(s.id,COALESCE(r.facts,ps.eligibility_snapshot))
      OR (bs.session_id IS NULL AND (ps.session_id IS NULL OR h.revision_id IS DISTINCT FROM ps.eligibility_snapshot->>'canonicalRevisionId'
        OR s.production_id<>ps.production_id OR s.venue_id IS DISTINCT FROM ps.venue_id
        OR s.starts_at IS DISTINCT FROM (ps.eligibility_snapshot->>'startsAt')::timestamptz
        OR NULLIF(s.attendance_timing,'null'::jsonb) IS DISTINCT FROM NULLIF(ps.eligibility_snapshot->'attendanceTiming','null'::jsonb)))))
    THEN RAISE EXCEPTION 'canonical family integrity or prepared base dependency changed'; END IF;
  IF EXISTS(SELECT 1 FROM biplan.preparation_batch_page_sessions ps JOIN biplan.sessions s ON s.id=ps.session_id
    LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id WHERE ps.batch_id=b.id
      AND NOT EXISTS(SELECT 1 FROM biplan.preparation_batch_sessions bs WHERE bs.batch_id=b.id AND bs.session_id=s.id)
      AND (h.revision_id IS DISTINCT FROM ps.canonical_revision_id OR s.content_hash IS DISTINCT FROM ps.canonical_content_hash)) THEN
    RAISE EXCEPTION 'page-only canonical dependency changed'; END IF;
  SELECT count(*) INTO offer_count FROM biplan.offer_identities WHERE session_id=ANY(target_ids);
  SELECT count(*) INTO evaluation_count FROM biplan.publication_evaluations pe JOIN biplan.evaluations e ON e.id=pe.evaluation_id
    WHERE pe.publication_id=active_id AND e.status<>'complete';
  target_id:='batch-publication:'||md5(b.id);
  previous_coverage:=CASE WHEN base.manifest#>>'{collectorCoverage,complete}'='true' THEN base.manifest->'collectorCoverage' ELSE base.manifest->'previousFullCoverage' END;
  preparation_receipt:=jsonb_build_object('status','verified','publicationId',target_id,'batchId',b.id,'version','provider-page-offer-v1',
    'inputHash',b.input_hash,'acceptedRecords',(SELECT count(*) FROM biplan.preparation_batch_items WHERE batch_id=b.id),
    'pageAffectedSessions',(SELECT count(*) FROM biplan.preparation_batch_page_sessions WHERE batch_id=b.id),'checkedAt',checked_at,'optionalEmbeddingsRequired',false);
  manifest:=jsonb_build_object('schemaVersion',8,'kind','cohort-publication','offerProjectionVersion',1,'batchId',b.id,'basePublicationId',active_id,
    'collectionBasePublicationId',b.collection_base_publication_id,'collectorCoverage',b.coverage,'previousFullCoverage',previous_coverage,
    'preparationReceipt',preparation_receipt,'requiredOfferCount',offer_count,'requiredOfferEvidenceCount',offer_count,'requiredEvaluationCount',evaluation_count);
  INSERT INTO biplan.publications(id,state,manifest,manifest_hash,required_session_count,required_document_count,required_embedding_profile)
    VALUES(target_id,'candidate',manifest,md5(manifest::text),cardinality(target_ids),cardinality(target_ids),b.embedding_profile);
  INSERT INTO biplan.publication_offers SELECT target_id,i.session_id,i.current_revision_id FROM biplan.offer_identities i WHERE i.session_id=ANY(target_ids);
  INSERT INTO biplan.publication_offer_evidence(publication_id,session_id,offer_id,offer_revision_id,page_observation_id,canonical_dependency_hash,
    disposition,reason_code,policy_version,evidence_observed_at,dependency_hash)
    SELECT target_id,i.session_id,i.id,r.id,ph.page_id,COALESCE(cr.dependency_hash,s.content_hash),
      derived.value->>'disposition',derived.value->>'reasonCode','provider-page-offer-v1',(derived.value->>'observedAt')::timestamptz,
      biplan.offer_evidence_hash(r.id,ph.page_id,COALESCE(cr.dependency_hash,s.content_hash),derived.value->>'disposition',derived.value->>'reasonCode')
    FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id JOIN biplan.sessions s ON s.id=i.session_id
      LEFT JOIN biplan.source_page_heads ph ON ph.provider=i.provider AND ph.source_url=r.source_url
      LEFT JOIN biplan.canonical_heads ch ON ch.session_id=s.id LEFT JOIN biplan.canonical_revisions cr ON cr.id=ch.revision_id
      CROSS JOIN LATERAL(SELECT biplan.derive_offer_page_evidence(r.id,ph.page_id) value) derived WHERE s.id=ANY(target_ids);
  INSERT INTO biplan.published_sessions(publication_id,session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot)
    SELECT target_id,s.id,s.production_id,s.venue_id,COALESCE(cp.document_id,old.search_document_id),md5(projected.value::text),projected.value
    FROM biplan.sessions s LEFT JOIN biplan.preparation_batch_sessions bs ON bs.batch_id=b.id AND bs.session_id=s.id
      LEFT JOIN biplan.canonical_preparations cp ON cp.revision_id=bs.revision_id
      LEFT JOIN biplan.published_sessions old ON old.publication_id=active_id AND old.session_id=s.id
      LEFT JOIN biplan.canonical_heads h ON h.session_id=s.id LEFT JOIN biplan.canonical_revisions r ON r.id=h.revision_id
      CROSS JOIN LATERAL(SELECT CASE WHEN bs.session_id IS NOT NULL THEN biplan.batch_session_snapshot(bs.revision_id,cp.document_id,checked_at)
        ELSE old.eligibility_snapshot END||jsonb_build_object('canonicalDependencyHash',COALESCE(r.dependency_hash,s.content_hash)) value) facts
      CROSS JOIN LATERAL(SELECT biplan.projected_session_snapshot(target_id,s.id,facts.value,checked_at) value) projected WHERE s.id=ANY(target_ids);
  INSERT INTO biplan.publication_evaluations SELECT target_id,pe.evaluation_id FROM biplan.publication_evaluations pe
    JOIN biplan.evaluations e ON e.id=pe.evaluation_id WHERE pe.publication_id=active_id AND e.status<>'complete';
  PERFORM biplan.validate_publication_offers(target_id);
  UPDATE biplan.publications SET state='validated',validated_at=clock_timestamp(),validation_hash=md5(manifest::text||':verified') WHERE id=target_id;
  IF j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'projection publisher lease expired'; END IF;
  PERFORM biplan.activate_publication(target_id,active_id);
  receipt:=jsonb_build_object('status','completed','batchId',b.id,'jobId',j.id,'basePublicationId',active_id,'resultPublicationId',target_id,
    'publishedSessions',cardinality(target_ids),'publishedOffers',offer_count,'preparationReceipt',preparation_receipt,'storageAdmission',storage,'idempotent',false);
  UPDATE biplan.outbox SET state='delivered',delivered_at=clock_timestamp() WHERE topic='canonical.batch.offer.accepted' AND state='pending'
    AND id IN(SELECT 'offer-revision:'||(i.receipt->>'offerRevisionId') FROM biplan.preparation_batch_items i WHERE i.batch_id=b.id AND i.status='accepted');
  UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='succeeded',cost_units=0,details=receipt
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker_id AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing projection publication attempt'; END IF;
  UPDATE biplan.preparation_jobs SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,checkpoint=receipt,updated_at=clock_timestamp()
    WHERE id=j.id AND state='leased' AND lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'projection publication lease expired during completion'; END IF;
  UPDATE biplan.preparation_batches SET state='published',publication_id=target_id,receipt=receipt,completed_at=clock_timestamp() WHERE id=b.id;
  RETURN receipt;
END $$;


CREATE OR REPLACE FUNCTION biplan.current_publication_offer_status(p_publication_id text,p_session_id text,
  p_checked_at timestamptz DEFAULT clock_timestamp(),p_max_age interval DEFAULT interval '72 hours') RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE base jsonb; facts jsonb; rows jsonb; canonical_ok boolean; available boolean; verified boolean; head text;
BEGIN
  IF (SELECT manifest->>'offerProjectionVersion' FROM biplan.publications WHERE id=p_publication_id) IS DISTINCT FROM '1' THEN
    RETURN biplan.current_publication_offer_status_v7(p_publication_id,p_session_id,p_checked_at,p_max_age); END IF;
  base:=biplan.current_publication_offer_status_v4(p_publication_id,p_session_id,p_checked_at,p_max_age);
  SELECT eligibility_snapshot INTO facts FROM biplan.published_sessions WHERE publication_id=p_publication_id AND session_id=p_session_id;
  SELECT revision_id INTO head FROM biplan.canonical_heads WHERE session_id=p_session_id;
  canonical_ok:=COALESCE((base->>'canonicalSessionUsable')::boolean,false) AND head IS NOT DISTINCT FROM facts->>'canonicalRevisionId'
    AND biplan.session_projection_integrity(p_session_id,facts);
  SELECT COALESCE(jsonb_agg(o||jsonb_build_object('pinnedPageObservationId',e.page_observation_id,'currentPageObservationId',ph.page_id,
      'evidenceDependencyHash',e.dependency_hash,'status',CASE WHEN e.offer_id IS NULL OR NOT biplan.publication_offer_evidence_current(p_publication_id,o->>'offerId') THEN 'unusable'
        WHEN e.disposition='unsupported' THEN 'unsupported' WHEN o->>'status'='usable' AND e.evidence_observed_at<=p_checked_at
          AND e.evidence_observed_at>=p_checked_at-p_max_age THEN 'usable' ELSE 'unusable' END,
      'reasons',COALESCE(o->'reasons','[]'::jsonb)||CASE WHEN e.offer_id IS NULL THEN '["offer_evidence_pin_missing"]'::jsonb
        WHEN NOT biplan.publication_offer_evidence_current(p_publication_id,o->>'offerId') THEN '["offer_page_evidence_changed"]'::jsonb
        WHEN e.disposition='unsupported' THEN jsonb_build_array(e.reason_code) ELSE '[]'::jsonb END) ORDER BY o->>'offerId'),'[]'::jsonb) INTO rows
  FROM jsonb_array_elements(base->'offers') o LEFT JOIN biplan.publication_offer_evidence e ON e.publication_id=p_publication_id AND e.offer_id=o->>'offerId'
    LEFT JOIN biplan.offer_identities i ON i.id=o->>'offerId' LEFT JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
    LEFT JOIN biplan.source_page_heads ph ON ph.provider=i.provider AND ph.source_url=r.source_url;
  -- Unselected ordinary offer drift does not invalidate independently pinned offers.
  available:=canonical_ok AND EXISTS(SELECT 1 FROM jsonb_array_elements(rows)o WHERE o->>'status'='usable');
  SELECT available AND EXISTS(SELECT 1 FROM jsonb_array_elements(rows)o JOIN biplan.offer_revisions r ON r.id=o->>'pinnedRevisionId'
    WHERE o->>'status'='usable' AND r.currency='TRY' AND r.price_kind='exact' AND r.price_minor IS NOT NULL AND r.fee_minor IS NOT NULL
      AND (r.price IS NULL OR r.price*100=r.price_minor)) INTO verified;
  RETURN base||jsonb_build_object('offers',rows,'canonicalSessionUsable',canonical_ok,'availabilityUsable',available,'usable',available,
    'verifiedTotalEligible',verified,'status',CASE WHEN available THEN 'usable' ELSE 'unusable' END,
    'reasons',COALESCE(base->'reasons','[]'::jsonb)||CASE WHEN canonical_ok THEN '[]'::jsonb ELSE '["projection_or_canonical_dependency_changed"]'::jsonb END);
END $$;
INSERT INTO biplan.schema_migrations(version,migration_hash) VALUES('008-offer-evidence-projections','008-offer-evidence-projections-v1') ON CONFLICT(version) DO NOTHING;
COMMIT;
