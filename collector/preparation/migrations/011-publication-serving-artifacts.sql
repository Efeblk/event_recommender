BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='010-offer-identity-session-index') THEN
    RAISE EXCEPTION 'serving artifacts require migration 010'; END IF;
  IF EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='011-publication-serving-artifacts'
    AND migration_hash<>'011-publication-serving-artifacts-v1') THEN RAISE EXCEPTION 'incompatible serving artifact migration'; END IF;
END $guard$;

-- Optional transport for an already sealed publication. No second active pointer.
CREATE TABLE IF NOT EXISTS biplan.publication_serving_artifacts (
  publication_id text PRIMARY KEY REFERENCES biplan.publications(id),
  schema_version integer NOT NULL CHECK(schema_version=1),
  state text NOT NULL CHECK(state IN('pending','ready')),
  job_id text NOT NULL UNIQUE REFERENCES biplan.preparation_jobs(id),
  header jsonb NOT NULL, header_text text NOT NULL,
  content_root text NOT NULL CHECK(content_root ~ '^[a-f0-9]{64}$'),
  uncompressed_bytes bigint NOT NULL CHECK(uncompressed_bytes BETWEEN 1 AND 134217728),
  bucket text NOT NULL CHECK(bucket ~ '^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$'),
  object_receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ready_at timestamptz,
  CHECK((state='ready')=(object_receipt IS NOT NULL AND ready_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION biplan.protect_publication_serving_artifact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.state='ready' THEN RAISE EXCEPTION 'serving artifact binding is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','object_receipt','ready_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['state','object_receipt','ready_at']) OR NEW.state<>'ready' THEN
    RAISE EXCEPTION 'only pending to ready serving transition is allowed'; END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER publication_serving_artifact_immutable BEFORE UPDATE OR DELETE ON biplan.publication_serving_artifacts
FOR EACH ROW EXECUTE FUNCTION biplan.protect_publication_serving_artifact();

-- Canonical byte contract: jsonb::text in UTC, UTF8, one row per LF-terminated line.
-- This helper deliberately stays private; preparation reads through a fenced API.
CREATE OR REPLACE FUNCTION biplan.publication_serving_rows(p_publication text,p_after text,p_limit integer)
RETURNS TABLE(session_id text,raw_row_text text) LANGUAGE sql STABLE SET timezone='UTC' AS $$
  WITH publication AS MATERIALIZED (
    SELECT p.* FROM biplan.publications p WHERE p.id=p_publication AND p.state IN('validated','active','superseded')
      AND (NOT(p.manifest?'offerProjectionVersion') OR p.manifest->>'offerProjectionVersion'='1')
  ), page AS MATERIALIZED (
    SELECT s.* FROM biplan.published_sessions s JOIN publication p ON p.id=s.publication_id
    WHERE s.session_id COLLATE "C">p_after COLLATE "C" ORDER BY s.session_id COLLATE "C" LIMIT p_limit
  ), legacy_terms AS MATERIALIZED (
    SELECT o.session_id,jsonb_agg(jsonb_build_object(
      'offerId',r.offer_id,'revisionId',r.id,'provider',r.provider,'providerRecordId',r.provider_record_id,
      'sourceUrl',r.source_url,'ticketTierId',r.ticket_tier_id,'ticketTierName',r.ticket_tier_name,'currency',r.currency,
      'price',r.price::text,'priceMinor',r.price_minor::text,'feeMinor',r.fee_minor::text,'priceKind',r.price_kind,
      'availability',r.availability,'observedAt',r.observed_at,'sourceUpdatedAt',r.source_updated_at,
      'validFrom',r.valid_from,'validUntil',r.valid_until) ORDER BY r.offer_id) records
    FROM page s JOIN publication p ON true JOIN biplan.publication_offers o ON o.publication_id=p.id AND o.session_id=s.session_id
      JOIN biplan.offer_revisions r ON r.id=o.offer_revision_id
    WHERE p.manifest->>'offerProjectionVersion' IS DISTINCT FROM '1' GROUP BY o.session_id
  ) SELECT s.session_id,jsonb_build_object(
    'sessionId',s.session_id,'productionId',s.production_id,'venueId',s.venue_id,
    'snapshot',(s.eligibility_snapshot-'offers') #- '{preparedSearch,documentText}',
    'document',CASE WHEN d.id IS NULL THEN NULL ELSE jsonb_build_object('id',d.id,'text',d.document_text,
      'hash',d.document_hash,'embeddingProfile',d.embedding_profile,'vector',NULL) END,
    'pinnedOfferTerms',CASE WHEN p.manifest->>'offerProjectionVersion'='1' THEN COALESCE(s.eligibility_snapshot->'offerTerms','[]'::jsonb)
      ELSE COALESCE(t.records,'[]'::jsonb) END)::text
    FROM page s JOIN publication p ON true LEFT JOIN biplan.search_documents d ON d.id=s.search_document_id
    LEFT JOIN legacy_terms t ON t.session_id=s.session_id ORDER BY s.session_id COLLATE "C"
$$;

CREATE OR REPLACE FUNCTION biplan.publication_serving_binding(p_publication text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('jobId',a.job_id,'state',a.state,'header',a.header,'headerText',a.header_text,
    'contentRoot',a.content_root,'uncompressedBytes',a.uncompressed_bytes,'bucket',a.bucket)
    ||COALESCE(a.object_receipt,'{}'::jsonb) FROM biplan.publication_serving_artifacts a WHERE a.publication_id=p_publication
$$;

CREATE OR REPLACE FUNCTION biplan.begin_publication_serving_export(p_publication text,p_bucket text) RETURNS jsonb
LANGUAGE plpgsql SET timezone='UTC' AS $$
DECLARE p biplan.publications%ROWTYPE; existing biplan.publication_serving_artifacts%ROWTYPE;
  row record; row_count integer:=0; offer_count bigint:=0; expected_offers bigint; raw_bytes bigint:=0;
  root_input text:=E'biplan-serving-rows-v1\n'; root text; header jsonb; header_text text; job text;
  deadline timestamptz:=clock_timestamp()+interval '30 seconds';
BEGIN
  IF p_bucket IS NULL OR p_bucket!~'^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$' THEN RAISE EXCEPTION 'invalid serving bucket'; END IF;
  SELECT * INTO p FROM biplan.publications WHERE id=p_publication FOR UPDATE;
  IF NOT FOUND OR p.state NOT IN('validated','active','superseded') OR p.validation_hash IS NULL
    OR (p.manifest?'offerProjectionVersion' AND p.manifest->>'offerProjectionVersion' IS DISTINCT FROM '1')
    OR p.required_session_count>20000 THEN RAISE EXCEPTION 'publication is not exportable'; END IF;
  SELECT * INTO existing FROM biplan.publication_serving_artifacts WHERE publication_id=p.id;
  IF FOUND THEN
    IF existing.bucket<>p_bucket THEN RAISE EXCEPTION 'serving export bucket changed'; END IF;
    RETURN biplan.publication_serving_binding(p.id);
  END IF;
  SELECT count(*) INTO expected_offers FROM biplan.publication_offers WHERE publication_id=p.id;
  FOR row IN SELECT * FROM biplan.publication_serving_rows(p.id,'',20001) LOOP
    row_count:=row_count+1;
    IF row_count>20000 OR octet_length(row.raw_row_text)+1>1048576 OR clock_timestamp()>deadline THEN
      RAISE EXCEPTION 'serving export row count, line size or time bound exceeded'; END IF;
    raw_bytes:=raw_bytes+octet_length(row.raw_row_text)+1;
    IF raw_bytes>134217728 THEN RAISE EXCEPTION 'serving export byte bound exceeded'; END IF;
    offer_count:=offer_count+jsonb_array_length(row.raw_row_text::jsonb->'pinnedOfferTerms');
    root_input:=root_input||encode(sha256(convert_to(row.raw_row_text,'UTF8')),'hex')||E'\n';
  END LOOP;
  IF row_count<>p.required_session_count OR offer_count<>expected_offers OR
    (p.manifest->>'offerProjectionVersion'='1' AND (COALESCE(p.manifest->>'requiredOfferCount','')!~'^[0-9]+$'
      OR (p.manifest->>'requiredOfferCount')::bigint<>offer_count)) THEN RAISE EXCEPTION 'serving export manifest counts differ'; END IF;
  root:=encode(sha256(convert_to(root_input,'UTF8')),'hex');
  header:=jsonb_build_object('schemaVersion',1,'kind','biplan-publication-serving','publicationId',p.id,
    'manifestHash',p.manifest_hash,'validationHash',p.validation_hash,
    'offerProjectionVersion',CASE WHEN p.manifest->>'offerProjectionVersion'='1' THEN 1 ELSE NULL END,
    'embeddingProfile',p.required_embedding_profile,'sessionCount',row_count,'offerCount',offer_count,'contentRoot',root);
  header_text:=header::text; raw_bytes:=raw_bytes+octet_length(header_text)+1;
  IF octet_length(header_text)+1>1048576 OR raw_bytes>134217728 THEN RAISE EXCEPTION 'serving export header or byte bound exceeded'; END IF;
  job:='serving-export:'||encode(sha256(convert_to(p.id,'UTF8')),'hex');
  INSERT INTO biplan.preparation_jobs(id,stage,stage_version,subject_type,subject_id,input_hash,max_attempts,checkpoint)
    VALUES(job,'publication-serving-export','1','publication',p.id,root,3,jsonb_build_object('publicationId',p.id));
  INSERT INTO biplan.publication_serving_artifacts(publication_id,schema_version,state,job_id,header,header_text,content_root,uncompressed_bytes,bucket)
    VALUES(p.id,1,'pending',job,header,header_text,root,raw_bytes,p_bucket);
  RETURN biplan.publication_serving_binding(p.id);
END $$;

CREATE OR REPLACE FUNCTION biplan.claim_publication_serving_export(p_publication text,p_worker text,p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE;
BEGIN
  IF COALESCE(btrim(p_worker),'')='' OR length(p_worker)>200 OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 1 AND 900 THEN
    RAISE EXCEPTION 'invalid serving lease'; END IF;
  SELECT q.* INTO j FROM biplan.preparation_jobs q JOIN biplan.publication_serving_artifacts a ON a.job_id=q.id
    JOIN biplan.publications p ON p.id=a.publication_id
    WHERE a.publication_id=p_publication AND a.state='pending' AND p.state IN('validated','active','superseded') FOR UPDATE OF q;
  IF NOT FOUND OR j.stage<>'publication-serving-export' OR j.stage_version<>'1' OR j.state NOT IN('pending','leased','failed')
    OR (j.state='leased' AND j.lease_expires_at>clock_timestamp()) THEN RETURN NULL; END IF;
  IF j.state='leased' THEN
    UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='stale',details='{"code":"lease_expired"}'::jsonb
      WHERE job_id=j.id AND fencing_token=j.fencing_token AND finished_at IS NULL;
  END IF;
  IF j.attempt_count>=j.max_attempts THEN
    UPDATE biplan.preparation_jobs SET state='failed',lease_owner=NULL,lease_expires_at=NULL,last_error='{"code":"attempts_exhausted"}'::jsonb,
      updated_at=clock_timestamp() WHERE id=j.id; RETURN NULL;
  END IF;
  UPDATE biplan.preparation_jobs SET state='leased',lease_owner=p_worker,lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    attempt_count=attempt_count+1,fencing_token=fencing_token+1,updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
  INSERT INTO biplan.job_attempts(job_id,fencing_token,attempt_number,worker_id) VALUES(j.id,j.fencing_token,j.attempt_count,p_worker);
  RETURN jsonb_build_object('id',j.id,'publicationId',p_publication,'workerId',p_worker,'fencing_token',j.fencing_token::text,
    'leaseExpiresAt',j.lease_expires_at,'checkpoint',j.checkpoint);
END $$;

CREATE OR REPLACE FUNCTION biplan.publication_serving_lease(p_job text,p_worker text,p_fence bigint)
RETURNS biplan.preparation_jobs LANGUAGE plpgsql AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE;
BEGIN
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job FOR UPDATE;
  IF NOT FOUND OR j.stage<>'publication-serving-export' OR j.stage_version<>'1' OR j.subject_type<>'publication'
    OR j.state<>'leased' OR j.lease_owner IS DISTINCT FROM p_worker OR j.fencing_token IS DISTINCT FROM p_fence
    OR j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale or invalid serving export lease'; END IF;
  IF NOT EXISTS(SELECT 1 FROM biplan.publication_serving_artifacts a JOIN biplan.publications p ON p.id=a.publication_id
    WHERE a.job_id=j.id AND a.state='pending' AND a.content_root=j.input_hash AND p.state IN('validated','active','superseded')
      AND p.manifest_hash=a.header->>'manifestHash' AND p.validation_hash=a.header->>'validationHash') THEN
    RAISE EXCEPTION 'serving export publication is no longer readable'; END IF;
  RETURN j;
END $$;

CREATE OR REPLACE FUNCTION biplan.read_publication_serving_export_page(p_job text,p_worker text,p_fence bigint,p_after text,p_limit integer DEFAULT 1000)
RETURNS jsonb LANGUAGE plpgsql SET timezone='UTC' AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE; rows jsonb; last_id text; count_rows integer;
BEGIN
  j:=biplan.publication_serving_lease(p_job,p_worker,p_fence);
  IF p_after IS NULL OR length(p_after)>1000 OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'invalid serving export page'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('sessionId',x.session_id,'rawRowText',x.raw_row_text) ORDER BY x.session_id COLLATE "C"),'[]'::jsonb),
    max(x.session_id COLLATE "C"),count(*) INTO rows,last_id,count_rows FROM biplan.publication_serving_rows(j.subject_id,p_after,p_limit)x;
  IF j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'serving export lease expired during page'; END IF;
  RETURN jsonb_build_object('rows',rows,'nextAfter',COALESCE(last_id,p_after),'done',count_rows<p_limit);
END $$;

CREATE OR REPLACE FUNCTION biplan.checkpoint_publication_serving_export(p_job text,p_worker text,p_fence bigint,p_checkpoint jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE;
BEGIN
  j:=biplan.publication_serving_lease(p_job,p_worker,p_fence);
  IF jsonb_typeof(p_checkpoint) IS DISTINCT FROM 'object' OR octet_length(p_checkpoint::text)>16384 THEN RAISE EXCEPTION 'invalid serving checkpoint'; END IF;
  UPDATE biplan.preparation_jobs SET checkpoint=p_checkpoint,updated_at=clock_timestamp() WHERE id=j.id;
  UPDATE biplan.job_attempts SET details=COALESCE(details,'{}'::jsonb)||jsonb_build_object('checkpoint',p_checkpoint)
    WHERE job_id=j.id AND fencing_token=p_fence AND finished_at IS NULL;
  RETURN jsonb_build_object('status','checkpointed','jobId',j.id);
END $$;

CREATE OR REPLACE FUNCTION biplan.complete_publication_serving_export(p_job text,p_worker text,p_fence bigint,p_object jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE; a biplan.publication_serving_artifacts%ROWTYPE; expected_name text;
BEGIN
  -- An exact completed-attempt replay is safe, but cannot replace any receipt.
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job FOR UPDATE;
  SELECT * INTO a FROM biplan.publication_serving_artifacts WHERE job_id=p_job;
  IF j.state='succeeded' AND a.state='ready' AND a.object_receipt=p_object AND j.fencing_token=p_fence
    AND EXISTS(SELECT 1 FROM biplan.job_attempts WHERE job_id=p_job AND fencing_token=p_fence AND worker_id=p_worker AND outcome='succeeded') THEN
    RETURN biplan.publication_serving_binding(a.publication_id); END IF;
  j:=biplan.publication_serving_lease(p_job,p_worker,p_fence);
  IF jsonb_typeof(p_object) IS DISTINCT FROM 'object' OR octet_length(p_object::text)>4096
    OR COALESCE(p_object->>'encoding','')<>'gzip' OR p_object->>'bucket' IS DISTINCT FROM a.bucket
    OR COALESCE(p_object->>'generation','')!~'^[1-9][0-9]{0,30}$'
    OR jsonb_typeof(p_object->'generation') IS DISTINCT FROM 'string'
    OR COALESCE(p_object->>'compressedSha256','')!~'^[a-f0-9]{64}$'
    OR COALESCE(p_object->>'uncompressedSha256','')!~'^[a-f0-9]{64}$'
    OR COALESCE(p_object->>'compressedBytes','')!~'^[0-9]{1,9}$'
    OR COALESCE(p_object->>'uncompressedBytes','')!~'^[0-9]{1,9}$'
    OR jsonb_typeof(p_object->'compressedBytes') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_object->'uncompressedBytes') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'invalid serving object receipt'; END IF;
  IF (p_object->>'compressedBytes')::bigint NOT BETWEEN 1 AND 33554432
    OR (p_object->>'uncompressedBytes')::bigint<>a.uncompressed_bytes
    OR (SELECT count(*) FROM jsonb_object_keys(p_object))<>8 THEN RAISE EXCEPTION 'serving object size or fields differ'; END IF;
  expected_name:='staging/preparation/serving/v1/'||encode(sha256(convert_to(a.publication_id,'UTF8')),'hex')||'/'||(p_object->>'compressedSha256');
  expected_name:=expected_name||'.ndjson.gz';
  IF p_object->>'objectName' IS DISTINCT FROM expected_name THEN RAISE EXCEPTION 'serving object name is outside its exact content address'; END IF;
  UPDATE biplan.publication_serving_artifacts SET state='ready',object_receipt=p_object,ready_at=clock_timestamp() WHERE publication_id=a.publication_id;
  UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='succeeded',cost_units=0,details=p_object
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker AND finished_at IS NULL;
  IF NOT FOUND OR j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'serving completion attempt or lease expired'; END IF;
  UPDATE biplan.preparation_jobs SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,checkpoint=p_object,updated_at=clock_timestamp() WHERE id=j.id;
  RETURN biplan.publication_serving_binding(a.publication_id);
END $$;

CREATE OR REPLACE FUNCTION biplan.fail_publication_serving_export(p_job text,p_worker text,p_fence bigint,p_error jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE;
BEGIN
  j:=biplan.publication_serving_lease(p_job,p_worker,p_fence);
  IF jsonb_typeof(p_error) IS DISTINCT FROM 'object' OR octet_length(p_error::text)>4096 THEN RAISE EXCEPTION 'invalid serving export error'; END IF;
  UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='failed',cost_units=0,details=p_error
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing serving attempt'; END IF;
  UPDATE biplan.preparation_jobs SET state='failed',lease_owner=NULL,lease_expires_at=NULL,last_error=p_error,updated_at=clock_timestamp() WHERE id=j.id;
  RETURN jsonb_build_object('status','failed','jobId',j.id);
END $$;

CREATE OR REPLACE FUNCTION biplan.read_publication_serving_artifact(p_publication text) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT biplan.publication_serving_binding(a.publication_id) FROM biplan.publication_serving_artifacts a
    JOIN biplan.publications p ON p.id=a.publication_id WHERE a.publication_id=p_publication AND a.state='ready'
      AND p.state IN('validated','active','superseded') AND p.manifest_hash=a.header->>'manifestHash'
      AND p.validation_hash=a.header->>'validationHash'
$$;

-- New functions are closed even before the explicit roles.sql installation.
REVOKE ALL ON TABLE biplan.publication_serving_artifacts FROM PUBLIC;
DO $permissions$ DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace='biplan'::regnamespace AND p.proname=ANY(ARRAY[
    'protect_publication_serving_artifact','publication_serving_rows','publication_serving_binding','begin_publication_serving_export',
    'claim_publication_serving_export','publication_serving_lease','read_publication_serving_export_page','checkpoint_publication_serving_export',
    'complete_publication_serving_export','fail_publication_serving_export','read_publication_serving_artifact']) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',f);
  END LOOP;
END $permissions$;
INSERT INTO biplan.schema_migrations(version,migration_hash) VALUES('011-publication-serving-artifacts','011-publication-serving-artifacts-v1')
ON CONFLICT(version) DO NOTHING;
COMMIT;
