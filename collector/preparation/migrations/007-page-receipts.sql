BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='006-batched-publication') THEN
    RAISE EXCEPTION 'page receipts require migration 006'; END IF;
END $$;
ALTER TABLE biplan.preparation_batches ALTER COLUMN horizon_start DROP NOT NULL;
ALTER TABLE biplan.preparation_batches ALTER COLUMN horizon_end DROP NOT NULL;
ALTER TABLE biplan.preparation_batches DROP CONSTRAINT IF EXISTS preparation_batches_scope_check;
ALTER TABLE biplan.preparation_batches ADD CONSTRAINT preparation_batches_scope_check CHECK(scope IN ('full','incremental','legacy_incremental'));
CREATE TABLE IF NOT EXISTS biplan.source_page_observations (
  id text PRIMARY KEY,page_hash text NOT NULL,payload jsonb NOT NULL,receipt jsonb NOT NULL,
  provider text NOT NULL,source_url text NOT NULL,observed_at timestamptz NOT NULL,source_updated_at timestamptz,
  status text NOT NULL CHECK(status IN ('verified','retired','quarantined','failed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS source_page_observations_source_idx ON biplan.source_page_observations(provider,source_url,observed_at);
CREATE TABLE IF NOT EXISTS biplan.source_page_heads (
  provider text NOT NULL,source_url text NOT NULL,page_id text NOT NULL REFERENCES biplan.source_page_observations(id),
  max_source_updated_at timestamptz,PRIMARY KEY(provider,source_url)
);
CREATE TABLE IF NOT EXISTS biplan.preparation_batch_pages (
  batch_id text NOT NULL REFERENCES biplan.preparation_batches(id),page_id text NOT NULL REFERENCES biplan.source_page_observations(id),
  PRIMARY KEY(batch_id,page_id)
);
CREATE OR REPLACE TRIGGER source_page_observations_immutable BEFORE UPDATE OR DELETE ON biplan.source_page_observations
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();
CREATE OR REPLACE TRIGGER preparation_batch_pages_immutable BEFORE UPDATE OR DELETE ON biplan.preparation_batch_pages
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();

CREATE OR REPLACE FUNCTION biplan.begin_preparation_batch_v2(p_header jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE b biplan.preparation_batches%ROWTYPE; ps text[]; base text; profile text; storage jsonb; legacy boolean;
BEGIN
  legacy:=p_header->>'scope'='legacy_incremental';
  IF jsonb_typeof(p_header) IS DISTINCT FROM 'object' OR p_header->>'schemaVersion' IS DISTINCT FROM '2'
    OR COALESCE(p_header->>'batchId','')='' OR length(p_header->>'batchId')>250
    OR COALESCE(p_header->>'collectionRunId','')='' OR COALESCE(p_header->>'inputHash','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(p_header->>'scope','') NOT IN ('full','incremental','legacy_incremental')
    OR jsonb_typeof(p_header->'providers') IS DISTINCT FROM 'array'
    OR p_header#>>'{scopeEvidence,geography}' IS DISTINCT FROM 'Istanbul'
    OR COALESCE(p_header#>>'{scopeEvidence,listingConfigHash}','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(p_header->>'startedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    THEN RAISE EXCEPTION 'invalid v2 batch header'; END IF;
  IF NOT isfinite((p_header->>'startedAt')::timestamptz) OR (p_header->>'startedAt')::timestamptz>clock_timestamp()+interval '5 minutes'
    THEN RAISE EXCEPTION 'invalid v2 cycle start'; END IF;
  SELECT array_agg(DISTINCT value ORDER BY value) INTO ps FROM jsonb_array_elements_text(p_header->'providers');
  IF COALESCE(cardinality(ps),0)=0 OR array_position(ps,NULL) IS NOT NULL OR NOT(ps<@ARRAY['biletix','bubilet','biletinial']::text[])
    OR to_jsonb(ps)<>p_header->'providers' THEN RAISE EXCEPTION 'invalid v2 providers'; END IF;
  IF legacy THEN
    IF p_header->>'horizonStart' IS NOT NULL OR p_header->>'horizonEnd' IS NOT NULL THEN RAISE EXCEPTION 'legacy original horizon must remain unknown'; END IF;
  ELSE
    IF COALESCE(p_header->>'horizonStart','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      OR COALESCE(p_header->>'horizonEnd','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
      OR NOT isfinite((p_header->>'horizonStart')::timestamptz) OR NOT isfinite((p_header->>'horizonEnd')::timestamptz)
      OR (p_header->>'horizonEnd')::timestamptz<=(p_header->>'horizonStart')::timestamptz THEN RAISE EXCEPTION 'invalid declared v2 horizon'; END IF;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('biplan.preparation_batch',0));
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=p_header->>'batchId';
  IF FOUND THEN
    IF b.header<>p_header THEN RAISE EXCEPTION 'batch id reused with different header'; END IF;
    RETURN jsonb_build_object('batchId',b.id,'status',b.state,'publicationId',b.publication_id,'idempotent',true);
  END IF;
  storage:=biplan.check_preparation_storage();
  IF EXISTS(SELECT 1 FROM biplan.preparation_batches WHERE state IN ('collecting','sealed','blocked')) THEN RAISE EXCEPTION 'another unfinished preparation batch exists'; END IF;
  SELECT a.publication_id,p.required_embedding_profile INTO base,profile FROM biplan.active_publication a JOIN biplan.publications p ON p.id=a.publication_id WHERE a.singleton;
  INSERT INTO biplan.preparation_batches(id,input_hash,collection_run_id,header,scope,providers,horizon_start,horizon_end,collection_base_publication_id,embedding_profile,state)
    VALUES(p_header->>'batchId',p_header->>'inputHash',p_header->>'collectionRunId',p_header,p_header->>'scope',ps,
      (p_header->>'horizonStart')::timestamptz,(p_header->>'horizonEnd')::timestamptz,base,profile,'collecting');
  RETURN jsonb_build_object('batchId',p_header->>'batchId','status','collecting','basePublicationId',base,'storageAdmission',storage,'idempotent',false);
END $$;

CREATE OR REPLACE FUNCTION biplan.record_batch_page(p_batch_id text,p_page jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE b biplan.preparation_batches%ROWTYPE; prior biplan.source_page_observations%ROWTYPE; head biplan.source_page_heads%ROWTYPE;
  old biplan.source_page_observations%ROWTYPE; receipt jsonb; decision text:='accepted'; reason text; h text:=md5(p_page::text);
  observed timestamptz; source_clock timestamptz; limits biplan.preparation_storage_limits%ROWTYPE;
BEGIN
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR b.header->>'schemaVersion' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'v2 batch required'; END IF;
  SELECT * INTO prior FROM biplan.source_page_observations WHERE id=p_page->>'pageId';
  IF FOUND THEN
    IF prior.page_hash<>h THEN RAISE EXCEPTION 'page id reused with changed observation'; END IF;
    IF EXISTS(SELECT 1 FROM biplan.preparation_batch_pages WHERE batch_id=b.id AND page_id=prior.id) THEN RETURN prior.receipt||'{"idempotent":true}'::jsonb; END IF;
  END IF;
  IF b.state<>'collecting' THEN RAISE EXCEPTION 'batch is sealed'; END IF;
  PERFORM biplan.check_preparation_storage(); SELECT * INTO limits FROM biplan.preparation_storage_limits WHERE singleton;
  IF octet_length(p_page::text)>limits.max_record_bytes OR (SELECT count(*) FROM biplan.preparation_batch_pages WHERE batch_id=b.id)>=limits.max_batch_records
    OR COALESCE(p_page->>'pageId','')='' OR length(p_page->>'pageId')>250
    OR COALESCE(p_page->>'provider','')<>ALL(b.providers)
    OR COALESCE(p_page->>'url','') !~ (CASE p_page->>'provider' WHEN 'bubilet' THEN '^https://(www\.)?bubilet\.com\.tr/' WHEN 'biletix' THEN '^https://(www\.)?biletix\.com/' WHEN 'biletinial' THEN '^https://(www\.)?biletinial\.com/' ELSE '^$' END)
    OR COALESCE(p_page->>'status','') NOT IN ('verified','retired','quarantined','failed')
    OR COALESCE(p_page->>'origin','') NOT IN ('current_run','recovered')
    OR (p_page->>'origin'='current_run' AND p_page->>'originRunId' IS DISTINCT FROM b.collection_run_id)
    OR (p_page->>'origin'='recovered' AND p_page->>'originRunId' IS NOT NULL)
    OR COALESCE(p_page->>'evidenceHash','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(p_page->>'evidenceKind','') NOT IN ('raw_response','normalized_page')
    OR COALESCE(p_page->>'parserVersion','')='' OR jsonb_typeof(p_page->'complete') IS DISTINCT FROM 'boolean'
    OR jsonb_typeof(p_page->'records') IS DISTINCT FROM 'array'
    OR COALESCE(p_page->>'observedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    THEN RAISE EXCEPTION 'invalid v2 page observation'; END IF;
  observed:=(p_page->>'observedAt')::timestamptz; source_clock:=(p_page->>'sourceUpdatedAt')::timestamptz;
  IF NOT isfinite(observed) OR observed>clock_timestamp()+interval '5 minutes' OR (source_clock IS NOT NULL AND (NOT isfinite(source_clock) OR source_clock>observed+interval '5 minutes'))
    OR (p_page->>'origin'='current_run' AND observed<(b.header->>'startedAt')::timestamptz)
    OR (p_page->>'status'<>'verified' AND jsonb_array_length(p_page->'records')<>0)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_page->'records') r WHERE COALESCE(r->>'requestId','')='' OR COALESCE(r->>'sourceRecordId','')='')
    OR (SELECT count(DISTINCT r->>'requestId') FROM jsonb_array_elements(p_page->'records')r)<>jsonb_array_length(p_page->'records')
    THEN RAISE EXCEPTION 'invalid page clock or record references'; END IF;
  LOCK TABLE biplan.offer_identities IN SHARE ROW EXCLUSIVE MODE;
  SELECT * INTO head FROM biplan.source_page_heads WHERE provider=p_page->>'provider' AND source_url=p_page->>'url' FOR UPDATE;
  SELECT * INTO old FROM biplan.source_page_observations WHERE id=head.page_id;
  IF prior.id IS NULL THEN
    IF old.id IS NOT NULL THEN
      IF observed<old.observed_at OR (head.max_source_updated_at IS NOT NULL AND source_clock<head.max_source_updated_at) THEN decision:='stale'; reason:='older_source_evidence';
      ELSIF (head.max_source_updated_at IS NOT NULL AND source_clock IS NULL)
        OR (observed=old.observed_at AND p_page->>'evidenceHash' IS DISTINCT FROM old.payload->>'evidenceHash')
        OR (source_clock IS NOT NULL AND source_clock=head.max_source_updated_at AND p_page->>'evidenceHash' IS DISTINCT FROM old.payload->>'evidenceHash')
        OR (old.receipt->>'status'='held' AND source_clock IS NOT DISTINCT FROM head.max_source_updated_at)
        THEN decision:='held'; reason:='unresolved_page_clock_conflict'; END IF;
    END IF;
    receipt:=jsonb_build_object('pageId',p_page->>'pageId','status',decision,'reason',reason,'idempotent',false);
    INSERT INTO biplan.source_page_observations(id,page_hash,payload,receipt,provider,source_url,observed_at,source_updated_at,status)
      VALUES(p_page->>'pageId',h,p_page,receipt,p_page->>'provider',p_page->>'url',observed,source_clock,p_page->>'status');
    IF decision<>'stale' THEN
      INSERT INTO biplan.source_page_heads(provider,source_url,page_id,max_source_updated_at)
        VALUES(p_page->>'provider',p_page->>'url',p_page->>'pageId',greatest(head.max_source_updated_at,source_clock))
        ON CONFLICT(provider,source_url) DO UPDATE SET page_id=EXCLUDED.page_id,max_source_updated_at=EXCLUDED.max_source_updated_at;
    END IF;
  ELSE receipt:=prior.receipt||'{"idempotent":true}'::jsonb; END IF;
  INSERT INTO biplan.preparation_batch_pages VALUES(b.id,p_page->>'pageId');
  RETURN receipt;
END $$;

-- A page proves only its own provider's offer. Until a complete page and its exact
-- accepted record agree, retain the offer row but withhold its linked family.
CREATE OR REPLACE FUNCTION biplan.offer_page_support(p_offer_id text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN p.id IS NULL THEN jsonb_build_object('usable',true,'status','legacy_no_page')
    WHEN p.receipt->>'status'<>'accepted' OR p.status<>'verified' OR p.payload->>'complete'<>'true'
      THEN jsonb_build_object('usable',false,'status','page_'||p.status,'pageId',p.id)
    WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(p.payload->'records') ref
      JOIN biplan.canonical_requests cr ON cr.id=ref->>'requestId'
      WHERE cr.receipt->>'status'='accepted' AND cr.receipt->>'offerRevisionId'=i.current_revision_id
        AND cr.payload#>>'{record,id}'=ref->>'sourceRecordId' AND cr.payload#>>'{record,source}'=p.provider
        AND cr.payload#>>'{record,url}'=p.source_url
        AND abs(extract(epoch FROM (cr.payload#>>'{record,checkedAt}')::timestamptz-p.observed_at))<=60)
      THEN jsonb_build_object('usable',true,'status','supported','pageId',p.id)
    ELSE jsonb_build_object('usable',false,'status','page_record_missing_or_unreconciled','pageId',p.id) END
  FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
    LEFT JOIN biplan.source_page_heads h ON h.provider=i.provider AND h.source_url=r.source_url
    LEFT JOIN biplan.source_page_observations p ON p.id=h.page_id WHERE i.id=p_offer_id
$$;

DO $$ DECLARE definition text; BEGIN
  IF to_regprocedure('biplan.canonical_offer_support_v5(text,jsonb)') IS NULL THEN
    SELECT pg_get_functiondef('biplan.canonical_offer_support(text,jsonb)'::regprocedure) INTO definition;
    EXECUTE replace(definition,'FUNCTION biplan.canonical_offer_support(','FUNCTION biplan.canonical_offer_support_v5('); END IF;
  IF to_regprocedure('biplan.publish_preparation_batch_v6(text,text,text,bigint,text)') IS NULL THEN
    SELECT pg_get_functiondef('biplan.publish_preparation_batch(text,text,text,bigint,text)'::regprocedure) INTO definition;
    EXECUTE replace(definition,'FUNCTION biplan.publish_preparation_batch(','FUNCTION biplan.publish_preparation_batch_v6('); END IF;
END $$;
CREATE OR REPLACE FUNCTION biplan.canonical_offer_support(p_session_id text,p_facts jsonb) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT biplan.canonical_offer_support_v5(p_session_id,p_facts)||jsonb_build_object('pageSupport',COALESCE(x.support,'[]'::jsonb))
    ||CASE WHEN x.blocked THEN '{"usable":false}'::jsonb ELSE '{}'::jsonb END
  FROM (SELECT jsonb_agg(jsonb_build_object('offerId',i.id)||biplan.offer_page_support(i.id) ORDER BY i.id) support,
    bool_or((biplan.offer_page_support(i.id)->>'usable') IS DISTINCT FROM 'true') blocked
    FROM biplan.offer_identities i WHERE i.session_id=p_session_id)x
$$;

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
            AND p.status='verified' AND p.payload->>'complete'='true' AND p.payload->>'origin'='current_run'
            AND p.payload->>'originRunId'=b.collection_run_id AND p.observed_at>=(b.header->>'startedAt')::timestamptz
            AND biplan.offer_page_support(i.id)->>'status'='supported'))
      THEN RAISE EXCEPTION 'full coverage omits an eligible provider offer or its current-cycle page evidence'; END IF;
  END IF;
  -- Negative/held page evidence remains durable and immediately affects reads.
  -- Automatic source-page reconciliation is deliberately conservative here.
  IF EXISTS(SELECT 1 FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id
    LEFT JOIN biplan.source_page_heads h ON h.provider=p.provider AND h.source_url=p.source_url WHERE bp.batch_id=b.id
      AND (p.receipt->>'status'<>'accepted' OR h.page_id IS DISTINCT FROM p.id OR p.status='quarantined'
        OR (p.status='verified' AND p.payload->>'complete'<>'true')
        OR EXISTS(SELECT 1 FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
          WHERE i.provider=p.provider AND r.source_url=p.source_url AND (biplan.offer_page_support(i.id)->>'usable') IS DISTINCT FROM 'true')))
    THEN blocked:=blocked+1; END IF;
  IF (c#>>'{records,sourceQuarantined}')::bigint>0 THEN blocked:=blocked+1; END IF;
  IF EXISTS(SELECT 1 FROM biplan.offer_identities i WHERE (biplan.offer_page_support(i.id)->>'usable') IS DISTINCT FROM 'true') THEN blocked:=blocked+1; END IF;
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
DECLARE b biplan.preparation_batches%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('biplan.active_publication',0));
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=p_batch_id FOR UPDATE;
  LOCK TABLE biplan.offer_identities IN SHARE MODE;
  IF b.header->>'schemaVersion'='2' AND b.state<>'published' THEN
    IF b.coverage->>'schemaVersion' IS DISTINCT FROM '2' THEN RAISE EXCEPTION 'v2 batch requires v2 seal'; END IF;
    IF EXISTS(SELECT 1 FROM biplan.offer_identities i WHERE (biplan.offer_page_support(i.id)->>'usable') IS DISTINCT FROM 'true') THEN
      RAISE EXCEPTION 'mandatory provider page reconciliation unresolved; publication cannot copy unsafe prices'; END IF;
    IF b.coverage->>'complete'='true' AND (b.coverage#>>'{freshness,validUntil}')::timestamptz<=clock_timestamp() THEN RAISE EXCEPTION 'full coverage expired before publication'; END IF;
    IF b.coverage->>'complete'='true' AND EXISTS(SELECT 1 FROM biplan.offer_identities i
      JOIN biplan.offer_revisions r ON r.id=i.current_revision_id JOIN biplan.sessions s ON s.id=i.session_id
      WHERE i.provider=ANY(b.providers) AND r.acceptance_status='accepted' AND r.availability IN ('available','limited')
        AND s.status='scheduled' AND s.starts_at>=b.horizon_start AND s.starts_at<b.horizon_end
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.coverage#>'{discovery,urls}') u
          JOIN biplan.source_page_heads h ON h.provider=u->>'provider' AND h.source_url=u->>'url'
          JOIN biplan.source_page_observations p ON p.id=h.page_id
          JOIN biplan.preparation_batch_pages bp ON bp.page_id=p.id AND bp.batch_id=b.id
          WHERE u->>'provider'=i.provider AND u->>'url'=r.source_url AND p.receipt->>'status'='accepted'
            AND p.status='verified' AND p.payload->>'complete'='true' AND p.payload->>'origin'='current_run'
            AND p.payload->>'originRunId'=b.collection_run_id AND p.observed_at>=(b.header->>'startedAt')::timestamptz
            AND biplan.offer_page_support(i.id)->>'status'='supported')) THEN
      RAISE EXCEPTION 'full coverage omits an eligible provider offer or its current-cycle page evidence'; END IF;
    IF EXISTS(SELECT 1 FROM biplan.preparation_batch_pages bp JOIN biplan.source_page_observations p ON p.id=bp.page_id
      LEFT JOIN biplan.source_page_heads h ON h.provider=p.provider AND h.source_url=p.source_url WHERE bp.batch_id=b.id
        AND (h.page_id IS DISTINCT FROM p.id OR p.receipt->>'status'<>'accepted'
          OR EXISTS(SELECT 1 FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
            WHERE i.provider=p.provider AND r.source_url=p.source_url AND (biplan.offer_page_support(i.id)->>'usable') IS DISTINCT FROM 'true')))
      THEN RAISE EXCEPTION 'page dependency changed or mandatory page reconciliation unresolved'; END IF;
  END IF;
  RETURN biplan.publish_preparation_batch_v6(p_batch_id,p_job_id,p_worker_id,p_fence,p_expected_base_publication_id);
END $$;
INSERT INTO biplan.schema_migrations(version,migration_hash) VALUES('007-page-receipts','007-page-receipts-v1') ON CONFLICT(version) DO NOTHING;
COMMIT;
