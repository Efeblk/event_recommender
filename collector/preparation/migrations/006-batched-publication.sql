BEGIN;
DO $guard$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='005-canonical-preparation') THEN
    RAISE EXCEPTION 'batch publication requires canonical migration 005'; END IF;
  IF EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='006-batched-publication'
    AND migration_hash<>'006-batched-publication-v1') THEN RAISE EXCEPTION 'incompatible batch migration'; END IF;
END $guard$;

-- Administrator configures this after inspecting the actual instance/storage.
-- There is deliberately no implicit capacity promise and no automatic deletion.
CREATE TABLE IF NOT EXISTS biplan.preparation_storage_limits (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  max_database_bytes bigint NOT NULL CHECK(max_database_bytes>0),
  min_headroom_bytes bigint NOT NULL CHECK(min_headroom_bytes>0 AND min_headroom_bytes<max_database_bytes),
  max_batch_records integer NOT NULL CHECK(max_batch_records BETWEEN 1 AND 20000),
  max_record_bytes integer NOT NULL CHECK(max_record_bytes BETWEEN 1024 AND 1048576)
);
CREATE TABLE IF NOT EXISTS biplan.preparation_batches (
  id text PRIMARY KEY, input_hash text NOT NULL, collection_run_id text NOT NULL UNIQUE,
  header jsonb NOT NULL, scope text NOT NULL CHECK(scope IN ('full','incremental')),
  providers text[] NOT NULL, horizon_start timestamptz NOT NULL,horizon_end timestamptz NOT NULL,
  collection_base_publication_id text REFERENCES biplan.publications(id), embedding_profile text,
  state text NOT NULL CHECK(state IN ('collecting','sealed','blocked','published','canceled')),
  seal jsonb, coverage jsonb, publication_id text REFERENCES biplan.publications(id), receipt jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),sealed_at timestamptz,completed_at timestamptz,
  CHECK(horizon_end>horizon_start)
);
CREATE UNIQUE INDEX IF NOT EXISTS preparation_batches_one_unfinished ON biplan.preparation_batches((true))
  WHERE state IN ('collecting','sealed','blocked');
CREATE TABLE IF NOT EXISTS biplan.preparation_batch_items (
  batch_id text NOT NULL REFERENCES biplan.preparation_batches(id),request_id text NOT NULL,
  payload_hash text NOT NULL,provider text,status text NOT NULL CHECK(status IN ('accepted','held','quarantined')),
  session_id text REFERENCES biplan.sessions(id),revision_id text REFERENCES biplan.canonical_revisions(id),
  job_id text REFERENCES biplan.preparation_jobs(id),receipt jsonb NOT NULL,raw_quarantine jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(batch_id,request_id)
);
CREATE TABLE IF NOT EXISTS biplan.preparation_batch_sessions (
  batch_id text NOT NULL REFERENCES biplan.preparation_batches(id),session_id text NOT NULL REFERENCES biplan.sessions(id),
  revision_id text NOT NULL REFERENCES biplan.canonical_revisions(id),job_id text NOT NULL REFERENCES biplan.preparation_jobs(id),
  PRIMARY KEY(batch_id,session_id)
);
CREATE OR REPLACE TRIGGER preparation_batch_items_immutable BEFORE UPDATE OR DELETE ON biplan.preparation_batch_items
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();

CREATE OR REPLACE FUNCTION biplan.check_preparation_storage() RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE limits biplan.preparation_storage_limits%ROWTYPE; used bigint;
BEGIN
  SELECT * INTO limits FROM biplan.preparation_storage_limits WHERE singleton;
  IF NOT FOUND THEN RAISE EXCEPTION 'preparation storage limits require explicit administrator configuration'; END IF;
  used:=pg_database_size(current_database());
  IF used+limits.min_headroom_bytes>=limits.max_database_bytes THEN RAISE EXCEPTION 'preparation storage admission refused: database headroom exhausted'; END IF;
  RETURN jsonb_build_object('databaseBytes',used,'maxDatabaseBytes',limits.max_database_bytes,'reservedHeadroomBytes',limits.min_headroom_bytes);
END $$;

CREATE OR REPLACE FUNCTION biplan.begin_preparation_batch(p_header jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
#variable_conflict use_variable
DECLARE id text:=p_header->>'batchId'; b biplan.preparation_batches%ROWTYPE; providers text[]; base text; profile text; storage jsonb;
BEGIN
  IF jsonb_typeof(p_header) IS DISTINCT FROM 'object' OR COALESCE(id,'')='' OR length(id)>250
    OR COALESCE(p_header->>'collectionRunId','')='' OR COALESCE(p_header->>'inputHash','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(p_header->>'scope','') NOT IN ('full','incremental')
    OR jsonb_typeof(p_header->'providers') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'invalid batch header'; END IF;
  SELECT array_agg(DISTINCT value ORDER BY value) INTO providers FROM jsonb_array_elements_text(p_header->'providers');
  IF COALESCE(cardinality(providers),0)=0 OR NOT(providers<@ARRAY['biletix','bubilet','biletinial']::text[])
    OR cardinality(providers)<>jsonb_array_length(p_header->'providers')
    OR (p_header->>'horizonStart')::timestamptz IS NULL OR (p_header->>'horizonEnd')::timestamptz IS NULL
    OR NOT isfinite((p_header->>'horizonStart')::timestamptz) OR NOT isfinite((p_header->>'horizonEnd')::timestamptz)
    OR (p_header->>'horizonEnd')::timestamptz<=(p_header->>'horizonStart')::timestamptz THEN RAISE EXCEPTION 'invalid batch scope'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('biplan.preparation_batch',0));
  SELECT * INTO b FROM biplan.preparation_batches WHERE preparation_batches.id=id;
  IF FOUND THEN
    IF b.header<>p_header THEN RAISE EXCEPTION 'batch id reused with a different header'; END IF;
    RETURN jsonb_build_object('batchId',b.id,'status',b.state,'publicationId',b.publication_id,'idempotent',true);
  END IF;
  storage:=biplan.check_preparation_storage();
  IF EXISTS(SELECT 1 FROM biplan.preparation_batches WHERE state IN ('collecting','sealed','blocked')) THEN
    RAISE EXCEPTION 'another unfinished preparation batch exists'; END IF;
  SELECT a.publication_id,p.required_embedding_profile INTO base,profile FROM biplan.active_publication a
    JOIN biplan.publications p ON p.id=a.publication_id WHERE a.singleton;
  INSERT INTO biplan.preparation_batches(id,input_hash,collection_run_id,header,scope,providers,horizon_start,horizon_end,
    collection_base_publication_id,embedding_profile,state)
  VALUES(id,p_header->>'inputHash',p_header->>'collectionRunId',p_header,p_header->>'scope',providers,
    (p_header->>'horizonStart')::timestamptz,(p_header->>'horizonEnd')::timestamptz,base,profile,'collecting');
  RETURN jsonb_build_object('batchId',id,'status','collecting','basePublicationId',base,'storageAdmission',storage,'idempotent',false);
END $$;

CREATE OR REPLACE FUNCTION biplan.accept_batch_observation(p_batch_id text,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE b biplan.preparation_batches%ROWTYPE; item biplan.preparation_batch_items%ROWTYPE;
  result jsonb; job text; old_job text; payload_hash text:=md5((p_payload-'expectedCanonicalRevisionId'-'expectedOfferRevisionId')::text);
  limits biplan.preparation_storage_limits%ROWTYPE; rev text; sid text;
BEGIN
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch missing'; END IF;
  SELECT * INTO item FROM biplan.preparation_batch_items WHERE batch_id=b.id AND request_id=p_payload->>'requestId';
  IF FOUND THEN
    IF item.payload_hash<>payload_hash THEN RAISE EXCEPTION 'batch request reused with different payload'; END IF;
    RETURN item.receipt||jsonb_build_object('idempotent',true);
  END IF;
  IF b.state<>'collecting' THEN RAISE EXCEPTION 'batch is sealed'; END IF;
  SELECT * INTO limits FROM biplan.preparation_storage_limits WHERE singleton;
  PERFORM biplan.check_preparation_storage();
  IF octet_length(p_payload::text)>limits.max_record_bytes OR (SELECT count(*) FROM biplan.preparation_batch_items WHERE batch_id=b.id)>=limits.max_batch_records
    OR NOT(p_payload#>>'{record,source}'=ANY(b.providers)) THEN RAISE EXCEPTION 'batch record limit or source scope violation'; END IF;
  result:=biplan.accept_canonical_observation(p_payload);
  IF result->>'status'='accepted' THEN
    rev:=result->>'revisionId'; sid:=result->>'sessionId'; old_job:=result->>'jobId';
    IF NOT EXISTS(SELECT 1 FROM biplan.canonical_heads WHERE session_id=sid AND revision_id=rev) THEN
      RAISE EXCEPTION 'replayed observation no longer represents the current canonical head'; END IF;
    -- The production path never leaves a per-record publisher claimable. 005 stays
    -- unchanged for its isolated legacy fixtures and manually bounded workflows.
    UPDATE biplan.preparation_jobs SET state='canceled',last_error='{"code":"owned_by_batch"}'::jsonb
      WHERE id=old_job AND stage='canonical-base' AND state='pending';
    UPDATE biplan.outbox SET topic='canonical.batch.offer.accepted'
      WHERE id='offer-revision:'||(result->>'offerRevisionId') AND state='pending';
    job:='batch-prepare:'||md5(b.id||':'||rev);
    INSERT INTO biplan.preparation_jobs(id,stage,stage_version,subject_type,subject_id,input_hash,priority,checkpoint)
    VALUES(job,'canonical-batch','1','session',sid,md5(b.id||':'||rev),100,jsonb_build_object('batchId',b.id,'revisionId',rev)) ON CONFLICT DO NOTHING;
    INSERT INTO biplan.preparation_batch_sessions(batch_id,session_id,revision_id,job_id) VALUES(b.id,sid,rev,job)
      ON CONFLICT(batch_id,session_id) DO UPDATE SET revision_id=EXCLUDED.revision_id,job_id=EXCLUDED.job_id;
    result:=result||jsonb_build_object('jobId',job,'batchId',b.id);
  ELSE result:=result||jsonb_build_object('batchId',b.id); END IF;
  INSERT INTO biplan.preparation_batch_items(batch_id,request_id,payload_hash,provider,status,session_id,revision_id,job_id,receipt)
    VALUES(b.id,p_payload->>'requestId',payload_hash,p_payload#>>'{record,source}',result->>'status',result->>'sessionId',rev,job,result);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION biplan.record_batch_quarantine(p_batch_id text,p_request_id text,p_raw jsonb,p_reason text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE b biplan.preparation_batches%ROWTYPE; prior biplan.preparation_batch_items%ROWTYPE; result jsonb; h text;
  limits biplan.preparation_storage_limits%ROWTYPE;
BEGIN
  h:=md5(jsonb_build_array(p_raw,p_reason)::text);
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch missing'; END IF;
  SELECT * INTO prior FROM biplan.preparation_batch_items WHERE batch_id=b.id AND request_id=p_request_id;
  IF FOUND THEN
    IF prior.payload_hash<>h THEN RAISE EXCEPTION 'quarantine request reused'; END IF;
    RETURN prior.receipt||jsonb_build_object('idempotent',true);
  END IF;
  SELECT * INTO limits FROM biplan.preparation_storage_limits WHERE singleton;
  PERFORM biplan.check_preparation_storage();
  IF b.state<>'collecting' OR COALESCE(p_request_id,'')='' OR COALESCE(p_reason,'')='' OR p_raw IS NULL
    OR octet_length(p_raw::text)>limits.max_record_bytes OR (SELECT count(*) FROM biplan.preparation_batch_items WHERE batch_id=b.id)>=limits.max_batch_records
    THEN RAISE EXCEPTION 'invalid or sealed batch quarantine'; END IF;
  result:=jsonb_build_object('batchId',b.id,'requestId',p_request_id,'status','quarantined','reason',p_reason,'idempotent',false);
  INSERT INTO biplan.preparation_batch_items(batch_id,request_id,payload_hash,provider,status,receipt,raw_quarantine)
    VALUES(b.id,p_request_id,h,p_raw->>'source','quarantined',result,p_raw);
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION biplan.seal_preparation_batch(p_batch_id text,p_seal jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
#variable_conflict use_variable
DECLARE b biplan.preparation_batches%ROWTYPE; total integer; blocked integer; c jsonb:=p_seal->'collectorCoverage';
  entry jsonb; providers text[]; verified bigint:=0; failed bigint:=0; unvisited bigint:=0; quarantined bigint:=0;
  field text; coverage jsonb; finished timestamptz; pub_job text; receipt jsonb;
BEGIN
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch missing'; END IF;
  IF b.seal IS NOT NULL THEN
    IF b.seal<>p_seal THEN RAISE EXCEPTION 'sealed batch input changed'; END IF;
    RETURN b.receipt||jsonb_build_object('idempotent',true);
  END IF;
  IF b.state<>'collecting' THEN RAISE EXCEPTION 'batch cannot be sealed'; END IF;
  PERFORM biplan.check_preparation_storage();
  SELECT count(*),count(*) FILTER(WHERE status<>'accepted') INTO total,blocked FROM biplan.preparation_batch_items WHERE batch_id=b.id;
  IF p_seal->>'inputHash' IS DISTINCT FROM b.input_hash OR COALESCE(p_seal->>'recordCount','') !~ '^\d+$'
    OR (p_seal->>'recordCount')::bigint<>total OR jsonb_typeof(c) IS DISTINCT FROM 'object'
    OR jsonb_typeof(c->'complete') IS DISTINCT FROM 'boolean' OR jsonb_typeof(c->'inventory') IS DISTINCT FROM 'array'
    OR COALESCE(c->>'finishedAt','') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' THEN RAISE EXCEPTION 'invalid batch seal or collection receipt'; END IF;
  finished:=(c->>'finishedAt')::timestamptz;
  IF finished>clock_timestamp()+interval '5 minutes' OR NOT isfinite(finished) THEN RAISE EXCEPTION 'future or invalid collection receipt'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(c->'inventory') LOOP
    FOREACH field IN ARRAY ARRAY['discovered','verified','retired','quarantined','unvisited','failedPages'] LOOP
      IF COALESCE(entry->>field,'') !~ '^\d+$' THEN RAISE EXCEPTION 'invalid provider inventory count'; END IF;
    END LOOP;
    IF (entry->>'discovered')::bigint<>(entry->>'verified')::bigint+(entry->>'retired')::bigint+(entry->>'quarantined')::bigint+(entry->>'unvisited')::bigint
      OR NOT(entry->>'provider'=ANY(b.providers)) OR (entry->>'verified')::bigint<>
        (SELECT count(*) FROM biplan.preparation_batch_items WHERE batch_id=b.id AND provider=entry->>'provider')
      THEN RAISE EXCEPTION 'inconsistent provider inventory'; END IF;
    providers:=array_append(providers,entry->>'provider');
    verified:=verified+(entry->>'verified')::bigint; failed:=failed+(entry->>'failedPages')::bigint;
    unvisited:=unvisited+(entry->>'unvisited')::bigint; quarantined:=quarantined+(entry->>'quarantined')::bigint;
  END LOOP;
  SELECT array_agg(x ORDER BY x) INTO providers FROM unnest(providers)x;
  IF providers IS DISTINCT FROM b.providers OR verified<>total
    OR COALESCE(c->>'failedPages','') !~ '^\d+$' OR COALESCE(c->>'unvisited','') !~ '^\d+$'
    OR (c->>'failedPages')::bigint<>failed OR (c->>'unvisited')::bigint<>unvisited
    OR ((c->>'complete')::boolean AND (b.scope<>'full' OR failed<>0 OR unvisited<>0 OR quarantined<>0)) THEN
    RAISE EXCEPTION 'collection coverage does not match the sealed input scope'; END IF;
  coverage:=c||jsonb_build_object('scope',b.scope,'providers',to_jsonb(b.providers),
    'horizonStart',to_char(b.horizon_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'horizonEnd',to_char(b.horizon_end AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'collectionRunId',b.collection_run_id,'inputHash',b.input_hash);
  -- Only the latest accepted session revision in this sealed run needs preparation.
  UPDATE biplan.preparation_jobs j SET state='canceled',last_error='{"code":"superseded_within_batch"}'::jsonb
    WHERE j.stage='canonical-batch' AND j.checkpoint->>'batchId'=b.id AND j.state='pending'
      AND NOT EXISTS(SELECT 1 FROM biplan.preparation_batch_sessions s WHERE s.batch_id=b.id AND s.job_id=j.id);
  pub_job:='batch-publication:'||md5(b.id);
  INSERT INTO biplan.preparation_jobs(id,stage,stage_version,subject_type,subject_id,input_hash,priority,checkpoint)
    VALUES(pub_job,'canonical-batch-publication','1','batch',b.id,md5(p_seal::text),50,jsonb_build_object('batchId',b.id));
  receipt:=jsonb_build_object('batchId',b.id,'status',CASE WHEN blocked>0 THEN 'blocked' ELSE 'sealed' END,
    'records',total,'blockedRecords',blocked,'publicationJobId',pub_job,'idempotent',false);
  UPDATE biplan.preparation_batches SET state=receipt->>'status',seal=p_seal,coverage=coverage,sealed_at=clock_timestamp(),receipt=receipt WHERE id=b.id;
  RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION biplan.cancel_preparation_batch(p_batch_id text,p_reason text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE b biplan.preparation_batches%ROWTYPE;
BEGIN
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR b.state='published' OR COALESCE(p_reason,'')='' THEN RAISE EXCEPTION 'invalid batch cancellation'; END IF;
  IF EXISTS(SELECT 1 FROM biplan.preparation_jobs WHERE checkpoint->>'batchId'=b.id AND state='leased' AND lease_expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'cannot cancel a batch with active worker leases'; END IF;
  UPDATE biplan.preparation_jobs SET state='canceled',lease_owner=NULL,lease_expires_at=NULL,last_error=jsonb_build_object('code','batch_canceled','reason',p_reason)
    WHERE checkpoint->>'batchId'=b.id AND state IN ('pending','leased','failed');
  UPDATE biplan.preparation_batches SET state='canceled',completed_at=clock_timestamp(),receipt=jsonb_build_object('batchId',b.id,'status','canceled','reason',p_reason) WHERE id=b.id;
  RETURN jsonb_build_object('batchId',b.id,'status','canceled');
END $$;

CREATE OR REPLACE FUNCTION biplan.claim_batch_preparation_jobs(p_batch_id text,p_worker_id text,p_batch_limit integer,p_lease_for interval)
RETURNS SETOF biplan.preparation_jobs LANGUAGE plpgsql AS $$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id)='' OR p_batch_limit IS NULL OR p_batch_limit NOT BETWEEN 1 AND 100
    OR p_lease_for IS NULL OR p_lease_for<=interval '0 seconds' OR p_lease_for>interval '15 minutes' THEN RAISE EXCEPTION 'invalid bounded batch lease'; END IF;
  PERFORM 1 FROM biplan.preparation_batches WHERE id=p_batch_id AND state='sealed' FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  WITH exhausted AS (
    SELECT id,fencing_token FROM biplan.preparation_jobs WHERE stage='canonical-batch' AND stage_version='1'
      AND checkpoint->>'batchId'=p_batch_id AND state='leased' AND lease_expires_at<=clock_timestamp() AND attempt_count>=max_attempts
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT p_batch_limit
  ), attempts AS (
    UPDATE biplan.job_attempts a SET finished_at=clock_timestamp(),outcome='stale',details='{"reason":"attempts_exhausted"}'::jsonb
      FROM exhausted e WHERE a.job_id=e.id AND a.fencing_token=e.fencing_token AND a.finished_at IS NULL RETURNING a.job_id
  ) UPDATE biplan.preparation_jobs j SET state='failed',lease_owner=NULL,lease_expires_at=NULL,
      last_error='{"code":"attempts_exhausted","retryable":false}'::jsonb FROM exhausted e WHERE j.id=e.id;
  RETURN QUERY WITH candidates AS (
    SELECT id,fencing_token FROM biplan.preparation_jobs WHERE stage='canonical-batch' AND stage_version='1'
      AND checkpoint->>'batchId'=p_batch_id AND attempt_count<max_attempts AND available_at<=clock_timestamp()
      AND (state='pending' OR (state='leased' AND lease_expires_at<=clock_timestamp()))
      ORDER BY priority DESC,created_at,id FOR UPDATE SKIP LOCKED LIMIT p_batch_limit
  ), stale AS (
    UPDATE biplan.job_attempts a SET finished_at=clock_timestamp(),outcome='stale',details='{"reason":"lease_reclaimed"}'::jsonb
      FROM candidates c WHERE a.job_id=c.id AND a.fencing_token=c.fencing_token AND a.finished_at IS NULL RETURNING a.job_id
  ), updated AS (
    UPDATE biplan.preparation_jobs j SET state='leased',lease_owner=p_worker_id,lease_expires_at=clock_timestamp()+p_lease_for,
      fencing_token=j.fencing_token+1,attempt_count=j.attempt_count+1,updated_at=clock_timestamp() FROM candidates c WHERE j.id=c.id RETURNING j.*
  ), attempts AS (
    INSERT INTO biplan.job_attempts(job_id,fencing_token,attempt_number,worker_id)
      SELECT id,fencing_token,attempt_count,p_worker_id FROM updated RETURNING job_id,fencing_token
  ) SELECT u.* FROM updated u JOIN attempts a ON a.job_id=u.id AND a.fencing_token=u.fencing_token;
END $$;

CREATE OR REPLACE FUNCTION biplan.batch_preparation_input(p_job_id text,p_worker_id text,p_fence bigint) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE; r biplan.canonical_revisions%ROWTYPE;
BEGIN
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job_id;
  IF NOT FOUND OR j.stage<>'canonical-batch' OR j.stage_version<>'1' OR j.subject_type<>'session'
    OR j.state<>'leased' OR j.lease_owner IS DISTINCT FROM p_worker_id OR j.fencing_token IS DISTINCT FROM p_fence
    OR j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'unsupported stage or stale batch preparation lease'; END IF;
  SELECT * INTO r FROM biplan.canonical_revisions WHERE id=j.checkpoint->>'revisionId' AND session_id=j.subject_id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM biplan.canonical_heads WHERE session_id=r.session_id AND revision_id=r.id)
    OR NOT EXISTS(SELECT 1 FROM biplan.preparation_batches WHERE id=j.checkpoint->>'batchId' AND state='sealed') THEN
    RAISE EXCEPTION 'batch dependency head or state changed'; END IF;
  RETURN jsonb_build_object('batchId',j.checkpoint->'batchId','revisionId',r.id,'sessionId',r.session_id,'facts',r.facts,'dependencyHash',r.dependency_hash);
END $$;

CREATE OR REPLACE FUNCTION biplan.complete_batch_preparation_job(p_job_id text,p_worker_id text,p_fence bigint,p_result jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE; r biplan.canonical_revisions%ROWTYPE; b biplan.preparation_batches%ROWTYPE;
  cached biplan.search_documents%ROWTYPE; prior biplan.canonical_preparations%ROWTYPE;
  hash text; doc_id text; receipt jsonb; result_hash text:=md5(p_result::text);
BEGIN
  -- Same offers-before-canonical lock order as acceptance/publication; no pointer
  -- lock or full-catalog copy belongs to per-item deterministic preparation.
  LOCK TABLE biplan.offer_identities IN SHARE MODE;
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.stage<>'canonical-batch' OR j.stage_version<>'1' THEN RAISE EXCEPTION 'unsupported batch completion'; END IF;
  IF j.state='succeeded' AND j.fencing_token=p_fence AND EXISTS(SELECT 1 FROM biplan.job_attempts
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker_id AND outcome='succeeded') THEN
    IF j.checkpoint->>'resultHash' IS DISTINCT FROM result_hash THEN RAISE EXCEPTION 'batch completion replay result changed'; END IF;
    RETURN j.checkpoint||jsonb_build_object('idempotent',true);
  END IF;
  IF j.state<>'leased' OR j.lease_owner IS DISTINCT FROM p_worker_id OR j.fencing_token IS DISTINCT FROM p_fence
    OR j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale batch completion lease'; END IF;
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=j.checkpoint->>'batchId';
  IF NOT FOUND OR b.state<>'sealed' THEN RAISE EXCEPTION 'batch is not sealed'; END IF;
  PERFORM biplan.check_preparation_storage();
  SELECT * INTO r FROM biplan.canonical_revisions WHERE id=j.checkpoint->>'revisionId' AND session_id=j.subject_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch revision missing'; END IF;
  PERFORM 1 FROM biplan.canonical_heads WHERE session_id=r.session_id AND revision_id=r.id FOR SHARE;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM biplan.sessions WHERE id=r.session_id AND content_hash=r.semantic_hash) THEN RAISE EXCEPTION 'batch canonical dependency changed'; END IF;
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR p_result->>'documentProfile' IS DISTINCT FROM 'event-title-category-venue-description-v1'
    OR p_result->>'dependencyHash' IS DISTINCT FROM r.dependency_hash OR COALESCE(p_result->>'documentText','')=''
    OR length(p_result->>'documentText')>100000 OR jsonb_typeof(p_result->'lexicalTokens') IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'lexicalTokens')x WHERE jsonb_typeof(x)<>'string') THEN RAISE EXCEPTION 'invalid batch document'; END IF;
  hash:=encode(sha256(convert_to(p_result->>'documentText','UTF8')),'hex');
  IF p_result->>'documentHash' IS DISTINCT FROM hash THEN RAISE EXCEPTION 'batch document hash mismatch'; END IF;
  SELECT * INTO prior FROM biplan.canonical_preparations WHERE revision_id=r.id;
  IF FOUND THEN
    IF prior.result_hash<>result_hash OR prior.result<>p_result THEN RAISE EXCEPTION 'immutable prepared revision result changed'; END IF;
    doc_id:=prior.document_id;
  ELSE
    SELECT * INTO cached FROM biplan.search_documents d WHERE d.document_hash=hash AND d.document_text=p_result->>'documentText'
      AND d.document_profile=p_result->>'documentProfile' AND d.embedding IS NOT NULL AND d.embedding_profile=b.embedding_profile ORDER BY d.id LIMIT 1;
    doc_id:='canonical-document:'||md5(jsonb_build_array(r.session_id,hash,r.dependency_hash,p_result->>'documentProfile',cached.embedding_profile)::text);
    INSERT INTO biplan.search_documents(id,subject_type,subject_id,document_profile,embedding_profile,document_text,document_hash,dependency_hash,embedding)
      VALUES(doc_id,'session',r.session_id,p_result->>'documentProfile',cached.embedding_profile,p_result->>'documentText',hash,r.dependency_hash,cached.embedding) ON CONFLICT DO NOTHING;
    SELECT id INTO doc_id FROM biplan.search_documents d WHERE d.subject_type='session' AND d.subject_id=r.session_id
      AND d.document_profile=p_result->>'documentProfile' AND d.document_hash=hash AND d.dependency_hash=r.dependency_hash
      AND d.embedding_profile IS NOT DISTINCT FROM cached.embedding_profile;
    IF doc_id IS NULL THEN RAISE EXCEPTION 'batch document identity collision'; END IF;
    INSERT INTO biplan.canonical_preparations(revision_id,document_id,result,result_hash) VALUES(r.id,doc_id,p_result,result_hash);
  END IF;
  receipt:=jsonb_build_object('status','prepared','batchId',b.id,'revisionId',r.id,'documentId',doc_id,'resultHash',result_hash,'idempotent',false);
  UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='succeeded',cost_units=0,details=receipt
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker_id AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing batch preparation attempt'; END IF;
  UPDATE biplan.preparation_jobs SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,checkpoint=receipt,updated_at=clock_timestamp()
    WHERE id=j.id AND state='leased' AND lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'batch preparation lease expired during completion'; END IF;
  RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION biplan.fail_batch_preparation_job(p_job_id text,p_worker_id text,p_fence bigint,p_error jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE; next_state text;
BEGIN
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.stage NOT IN ('canonical-batch','canonical-batch-publication') OR j.stage_version<>'1' OR j.state<>'leased'
    OR j.lease_owner IS DISTINCT FROM p_worker_id OR j.fencing_token IS DISTINCT FROM p_fence OR j.lease_expires_at<=clock_timestamp()
    OR jsonb_typeof(p_error) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'stale or invalid batch failure'; END IF;
  next_state:=CASE WHEN p_error->>'retryable'='true' AND j.attempt_count<j.max_attempts THEN 'pending' ELSE 'failed' END;
  UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='failed',cost_units=0,details=p_error
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker_id AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing batch attempt'; END IF;
  UPDATE biplan.preparation_jobs SET state=next_state,lease_owner=NULL,lease_expires_at=NULL,last_error=p_error,updated_at=clock_timestamp() WHERE id=j.id;
  RETURN jsonb_build_object('status',next_state,'jobId',j.id);
END $$;

CREATE OR REPLACE FUNCTION biplan.claim_batch_publication(p_batch_id text,p_worker_id text,p_lease_for interval)
RETURNS SETOF biplan.preparation_jobs LANGUAGE plpgsql AS $$
DECLARE b biplan.preparation_batches%ROWTYPE; j biplan.preparation_jobs%ROWTYPE;
BEGIN
  IF COALESCE(p_worker_id,'')='' OR p_lease_for IS NULL OR p_lease_for<=interval '0 seconds' OR p_lease_for>interval '15 minutes' THEN RAISE EXCEPTION 'invalid batch publisher lease'; END IF;
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND OR b.state<>'sealed' OR EXISTS(SELECT 1 FROM biplan.preparation_batch_sessions s JOIN biplan.preparation_jobs p ON p.id=s.job_id
    WHERE s.batch_id=b.id AND p.state<>'succeeded') THEN RETURN; END IF;
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id='batch-publication:'||md5(b.id) FOR UPDATE;
  IF NOT FOUND OR j.stage<>'canonical-batch-publication' OR j.stage_version<>'1' OR j.state NOT IN ('pending','leased')
    OR (j.state='leased' AND j.lease_expires_at>clock_timestamp()) THEN RETURN; END IF;
  IF j.state='leased' THEN
    UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='stale',details='{"reason":"publisher_lease_expired"}'::jsonb
      WHERE job_id=j.id AND fencing_token=j.fencing_token AND finished_at IS NULL;
  END IF;
  IF j.attempt_count>=j.max_attempts THEN
    UPDATE biplan.preparation_jobs SET state='failed',lease_owner=NULL,lease_expires_at=NULL,last_error='{"code":"attempts_exhausted"}'::jsonb WHERE id=j.id;
    RETURN;
  END IF;
  UPDATE biplan.preparation_jobs SET state='leased',lease_owner=p_worker_id,lease_expires_at=clock_timestamp()+p_lease_for,
    fencing_token=fencing_token+1,attempt_count=attempt_count+1,updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
  INSERT INTO biplan.job_attempts(job_id,fencing_token,attempt_number,worker_id) VALUES(j.id,j.fencing_token,j.attempt_count,p_worker_id);
  RETURN NEXT j;
END $$;

CREATE OR REPLACE FUNCTION biplan.batch_session_snapshot(p_revision_id text,p_document_id text,p_checked_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE r biplan.canonical_revisions%ROWTYPE; s biplan.sessions%ROWTYPE; prepared biplan.canonical_preparations%ROWTYPE;
  doc biplan.search_documents%ROWTYPE; terms jsonb; raws jsonb; summary jsonb;
BEGIN
  SELECT * INTO r FROM biplan.canonical_revisions WHERE id=p_revision_id;
  SELECT * INTO s FROM biplan.sessions WHERE id=r.session_id;
  SELECT * INTO prepared FROM biplan.canonical_preparations WHERE revision_id=r.id AND document_id=p_document_id;
  SELECT * INTO doc FROM biplan.search_documents WHERE id=p_document_id;
  IF r.id IS NULL OR s.id IS NULL OR prepared.revision_id IS NULL OR doc.id IS NULL THEN RAISE EXCEPTION 'batch snapshot dependency missing'; END IF;
  SELECT jsonb_agg(biplan.offer_revision_term(v.id) ORDER BY i.id),jsonb_agg(v.source_payload ORDER BY i.id) INTO terms,raws
    FROM biplan.offer_identities i JOIN biplan.offer_revisions v ON v.id=i.current_revision_id WHERE i.session_id=s.id;
  IF terms IS NULL THEN RAISE EXCEPTION 'batch session has no offer evidence'; END IF;
  SELECT jsonb_build_object('availability',CASE WHEN bool_or(eligible) THEN 'available'
      WHEN bool_and(fresh AND availability IN ('sold_out','unavailable')) THEN 'unavailable' ELSE 'unknown' END,
    'displayPrice',min(price_minor) FILTER(WHERE eligible)/100.0,'displayPriceMinor',(min(price_minor) FILTER(WHERE eligible))::text,
    'currency',CASE WHEN bool_or(eligible) THEN 'TRY' END,'displayPriceIsHardBudgetTotal',false,
    'sourceUrl',(array_agg(source_url ORDER BY price_minor,id) FILTER(WHERE eligible))[1]) INTO summary
  FROM (SELECT v.*,v.observed_at<=p_checked_at AND v.observed_at>=p_checked_at-interval '3 days'
      AND (v.valid_from IS NULL OR v.valid_from<=p_checked_at) AND (v.valid_until IS NULL OR v.valid_until>=p_checked_at) fresh,
    v.currency='TRY' AND v.price_minor IS NOT NULL AND (v.price IS NULL OR v.price*100=v.price_minor)
      AND v.availability IN ('available','limited') AND v.price_kind<>'unknown'
      AND v.observed_at<=p_checked_at AND v.observed_at>=p_checked_at-interval '3 days'
      AND (v.valid_from IS NULL OR v.valid_from<=p_checked_at) AND (v.valid_until IS NULL OR v.valid_until>=p_checked_at) eligible
    FROM biplan.offer_identities i JOIN biplan.offer_revisions v ON v.id=i.current_revision_id WHERE i.session_id=s.id) q;
  RETURN r.facts||jsonb_build_object('id',s.id,'source',r.source_name,'sourceSessionIds',to_jsonb(s.source_session_ids),
    'checkedAt',r.observed_at,'canonicalRevisionId',r.id,'canonicalDependencyHash',r.dependency_hash,
    'offers',raws,'offerTerms',terms,'offerTermsVersion',1,'offerSummary',summary,
    'availability',summary->'availability','price',summary->'displayPrice','currency',summary->'currency','url',summary->'sourceUrl',
    'preparedSearch',jsonb_build_object('version',1,'documentText',doc.document_text,'documentHash',doc.document_hash,'lexicalTokens',prepared.result->'lexicalTokens'),
    'indexingStatus',CASE WHEN doc.embedding IS NULL THEN 'lexical_only' ELSE 'cached_vector' END,'qualityStatus','unknown');
END $$;

CREATE OR REPLACE FUNCTION biplan.publish_preparation_batch(p_batch_id text,p_job_id text,p_worker_id text,p_fence bigint,p_expected_base_publication_id text)
RETURNS jsonb LANGUAGE plpgsql AS $$
#variable_conflict use_variable
DECLARE b biplan.preparation_batches%ROWTYPE; j biplan.preparation_jobs%ROWTYPE; base biplan.publications%ROWTYPE;
  active_id text; target_id text; keep_ids text[]; affected_ids text[]; rows_count integer; offer_count integer; evaluation_count integer;
  checked_at timestamptz:=clock_timestamp(); manifest jsonb; receipt jsonb; preparation_receipt jsonb; storage jsonb;
  captured_heads_hash text; previous_coverage jsonb; oldest_observation timestamptz; newest_observation timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('biplan.active_publication',0));
  -- Batch before offers matches accept_batch_observation, including invalid/premature
  -- publish calls. No caller can create a batch-row/offer-table lock inversion.
  SELECT * INTO b FROM biplan.preparation_batches WHERE id=p_batch_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'batch missing'; END IF;
  LOCK TABLE biplan.offer_identities IN SHARE MODE;
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.stage<>'canonical-batch-publication' OR j.stage_version<>'1' OR j.subject_id<>b.id
    OR j.checkpoint->>'batchId' IS DISTINCT FROM b.id THEN RAISE EXCEPTION 'unsupported batch publication job'; END IF;
  IF b.state='published' AND j.state='succeeded' AND j.fencing_token=p_fence AND EXISTS(SELECT 1 FROM biplan.job_attempts
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker_id AND outcome='succeeded') THEN
    RETURN b.receipt||jsonb_build_object('idempotent',true);
  END IF;
  IF b.state<>'sealed' OR j.state<>'leased' OR j.lease_owner IS DISTINCT FROM p_worker_id
    OR j.fencing_token IS DISTINCT FROM p_fence OR j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale or unsealed batch publisher'; END IF;
  storage:=biplan.check_preparation_storage();
  SELECT publication_id INTO active_id FROM biplan.active_publication WHERE singleton FOR UPDATE;
  IF active_id IS DISTINCT FROM p_expected_base_publication_id THEN RAISE EXCEPTION 'active publication guard failed for batch'; END IF;
  SELECT * INTO base FROM biplan.publications WHERE id=active_id;
  IF base.required_embedding_profile IS DISTINCT FROM b.embedding_profile THEN RAISE EXCEPTION 'batch embedding profile changed during preparation'; END IF;
  IF EXISTS(SELECT 1 FROM biplan.preparation_batch_items WHERE batch_id=b.id AND status<>'accepted') THEN RAISE EXCEPTION 'batch has unresolved mandatory quarantine'; END IF;
  IF EXISTS(SELECT 1 FROM biplan.preparation_batch_sessions bs
    LEFT JOIN biplan.preparation_jobs p ON p.id=bs.job_id LEFT JOIN biplan.canonical_preparations cp ON cp.revision_id=bs.revision_id
    LEFT JOIN biplan.search_documents d ON d.id=cp.document_id LEFT JOIN biplan.canonical_revisions r ON r.id=bs.revision_id
    WHERE bs.batch_id=b.id AND (p.state IS DISTINCT FROM 'succeeded' OR cp.revision_id IS NULL OR d.id IS NULL
      OR d.subject_type<>'session' OR d.subject_id<>bs.session_id OR d.dependency_hash<>r.dependency_hash
      OR d.document_hash<>cp.result->>'documentHash')) THEN RAISE EXCEPTION 'batch required preparation incomplete'; END IF;
  SELECT COALESCE(array_agg(session_id ORDER BY session_id),'{}') INTO affected_ids FROM biplan.preparation_batch_sessions WHERE batch_id=b.id;
  PERFORM 1 FROM biplan.sessions WHERE id=ANY(affected_ids) ORDER BY id FOR SHARE;
  PERFORM 1 FROM biplan.canonical_heads WHERE session_id=ANY(affected_ids) ORDER BY session_id FOR SHARE;
  IF EXISTS(SELECT 1 FROM biplan.preparation_batch_sessions bs JOIN biplan.canonical_revisions r ON r.id=bs.revision_id
    LEFT JOIN biplan.canonical_heads h ON h.session_id=bs.session_id LEFT JOIN biplan.sessions s ON s.id=bs.session_id
    WHERE bs.batch_id=b.id AND (h.revision_id IS DISTINCT FROM r.id OR s.content_hash IS DISTINCT FROM r.semantic_hash
      OR (s.status='scheduled' AND (biplan.canonical_offer_support(s.id,r.facts)->>'usable') IS DISTINCT FROM 'true')))
    THEN RAISE EXCEPTION 'batch canonical head or mandatory offer occurrence evidence changed'; END IF;
  IF EXISTS(SELECT 1 FROM biplan.offer_identities i LEFT JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
    AND r.offer_id=i.id AND r.session_id=i.session_id AND r.acceptance_status='accepted'
    WHERE i.session_id=ANY(affected_ids) AND r.id IS NULL) THEN RAISE EXCEPTION 'batch current offer head missing'; END IF;
  SELECT md5(COALESCE(jsonb_object_agg(i.id,i.current_revision_id ORDER BY i.id),'{}'::jsonb)::text) INTO captured_heads_hash
    FROM biplan.offer_identities i WHERE i.session_id=ANY(affected_ids);
  SELECT COALESCE(array_agg(ps.session_id),'{}') INTO keep_ids FROM biplan.published_sessions ps JOIN biplan.sessions s ON s.id=ps.session_id
    WHERE ps.publication_id=active_id AND NOT(ps.session_id=ANY(affected_ids)) AND s.status<>'canceled';
  rows_count:=cardinality(keep_ids)+(SELECT count(*) FROM biplan.sessions WHERE id=ANY(affected_ids) AND status='scheduled');
  SELECT count(*) INTO offer_count FROM biplan.publication_offers WHERE publication_id=active_id AND session_id=ANY(keep_ids);
  offer_count:=offer_count+(SELECT count(*) FROM biplan.offer_identities i JOIN biplan.sessions s ON s.id=i.session_id WHERE s.id=ANY(affected_ids) AND s.status='scheduled');
  SELECT count(*) INTO evaluation_count FROM biplan.publication_evaluations pe JOIN biplan.evaluations e ON e.id=pe.evaluation_id
    WHERE pe.publication_id=active_id AND e.status<>'complete' AND NOT(e.subject_type='session' AND e.subject_id=ANY(affected_ids));
  SELECT min(r.observed_at),max(r.observed_at) INTO oldest_observation,newest_observation FROM biplan.preparation_batch_sessions bs
    JOIN biplan.canonical_revisions r ON r.id=bs.revision_id WHERE bs.batch_id=b.id;
  target_id:='batch-publication:'||md5(b.id);
  preparation_receipt:=jsonb_build_object('status','verified','publicationId',target_id,'batchId',b.id,'version','canonical-batch-v1',
    'inputHash',b.input_hash,'acceptedRecords',(SELECT count(*) FROM biplan.preparation_batch_items WHERE batch_id=b.id),
    'preparedSessions',cardinality(affected_ids),'copiedUnchangedSessions',cardinality(keep_ids),'mandatoryQuarantines',0,
    'capturedOfferHeadsHash',captured_heads_hash,'oldestAffectedObservation',oldest_observation,'newestAffectedObservation',newest_observation,
    'checkedAt',checked_at,'optionalEmbeddingsRequired',false);
  previous_coverage:=CASE WHEN base.manifest#>>'{collectorCoverage,complete}'='true' THEN base.manifest->'collectorCoverage'
    ELSE base.manifest->'previousFullCoverage' END;
  manifest:=jsonb_build_object('schemaVersion',6,'kind','cohort-publication','batchId',b.id,'basePublicationId',active_id,
    'collectionBasePublicationId',b.collection_base_publication_id,'collectorCoverage',b.coverage,
    'previousFullCoverage',previous_coverage,'preparationReceipt',preparation_receipt,'requiredOfferCount',offer_count,
    'requiredEvaluationCount',evaluation_count,'evaluationInvalidationReason','canonical_dependencies_changed_completed_evaluations_not_reused');
  INSERT INTO biplan.publications(id,state,manifest,manifest_hash,required_session_count,required_document_count,required_embedding_profile)
    VALUES(target_id,'candidate',manifest,md5(manifest::text),rows_count,rows_count,b.embedding_profile);
  INSERT INTO biplan.published_sessions SELECT target_id,session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot
    FROM biplan.published_sessions WHERE publication_id=active_id AND session_id=ANY(keep_ids);
  INSERT INTO biplan.published_sessions(publication_id,session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot)
    SELECT target_id,s.id,s.production_id,s.venue_id,cp.document_id,md5(snapshot.value::text),snapshot.value
    FROM biplan.preparation_batch_sessions bs JOIN biplan.sessions s ON s.id=bs.session_id
      JOIN biplan.canonical_preparations cp ON cp.revision_id=bs.revision_id
      CROSS JOIN LATERAL(SELECT biplan.batch_session_snapshot(bs.revision_id,cp.document_id,checked_at) AS value) snapshot
    WHERE bs.batch_id=b.id AND s.status='scheduled';
  INSERT INTO biplan.publication_offers SELECT target_id,session_id,offer_revision_id FROM biplan.publication_offers
    WHERE publication_id=active_id AND session_id=ANY(keep_ids);
  INSERT INTO biplan.publication_offers SELECT target_id,i.session_id,i.current_revision_id FROM biplan.offer_identities i
    JOIN biplan.sessions s ON s.id=i.session_id WHERE s.id=ANY(affected_ids) AND s.status='scheduled';
  INSERT INTO biplan.publication_evaluations SELECT target_id,pe.evaluation_id FROM biplan.publication_evaluations pe
    JOIN biplan.evaluations e ON e.id=pe.evaluation_id WHERE pe.publication_id=active_id AND e.status<>'complete'
      AND NOT(e.subject_type='session' AND e.subject_id=ANY(affected_ids));
  PERFORM biplan.validate_publication_offers(target_id);
  UPDATE biplan.publications SET state='validated',validated_at=clock_timestamp(),validation_hash=md5(manifest::text||':verified') WHERE id=target_id;
  IF j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'batch publisher lease expired before activation'; END IF;
  PERFORM biplan.activate_publication(target_id,active_id);
  receipt:=jsonb_build_object('status','completed','batchId',b.id,'jobId',j.id,'basePublicationId',active_id,'resultPublicationId',target_id,
    'preparedSessions',cardinality(affected_ids),'publishedSessions',rows_count,'publishedOffers',offer_count,
    'storageAdmission',storage,'preparationReceipt',preparation_receipt,'idempotent',false);
  UPDATE biplan.outbox SET state='delivered',delivered_at=clock_timestamp()
    WHERE topic='canonical.batch.offer.accepted' AND state='pending' AND id IN (
      SELECT 'offer-revision:'||(bi.receipt->>'offerRevisionId') FROM biplan.preparation_batch_items bi WHERE bi.batch_id=b.id AND bi.status='accepted');
  UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='succeeded',cost_units=0,details=receipt
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker_id AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing batch publication attempt'; END IF;
  UPDATE biplan.preparation_jobs SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,checkpoint=receipt,updated_at=clock_timestamp()
    WHERE id=j.id AND state='leased' AND lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'batch publisher lease expired during completion'; END IF;
  UPDATE biplan.preparation_batches SET state='published',publication_id=target_id,receipt=receipt,completed_at=clock_timestamp() WHERE id=b.id;
  RETURN receipt;
END $$;
INSERT INTO biplan.schema_migrations(version,migration_hash)
VALUES('006-batched-publication','006-batched-publication-v1') ON CONFLICT(version) DO NOTHING;
COMMIT;
