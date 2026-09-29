BEGIN;

DO $guard$
DECLARE installed_hash text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM biplan.schema_migrations WHERE version = '002-offer-revisions') THEN
    RAISE EXCEPTION 'worker migration requires 002-offer-revisions';
  END IF;
  SELECT migration_hash INTO installed_hash FROM biplan.schema_migrations
  WHERE version = '003-workers';
  IF installed_hash IS NOT NULL AND installed_hash <> '003-workers-v1' THEN
    RAISE EXCEPTION 'incompatible installed migration 003-workers: %', installed_hash;
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS biplan.offer_derivations (
  offer_id text NOT NULL REFERENCES biplan.offer_identities(id),
  input_hash text NOT NULL CHECK (btrim(input_hash) <> ''),
  stage_version text NOT NULL CHECK (btrim(stage_version) <> ''),
  currency text,
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  fee_minor bigint CHECK (fee_minor IS NULL OR fee_minor >= 0),
  fee_status text NOT NULL CHECK (fee_status IN ('known','unknown')),
  price_kind text NOT NULL CHECK (price_kind IN ('unknown','exact','starting_at','range')),
  availability text NOT NULL CHECK (availability IN ('unknown','available','limited','sold_out','unavailable')),
  valid_from timestamptz,
  valid_until timestamptz,
  normalized_facts jsonb NOT NULL CHECK (jsonb_typeof(normalized_facts) = 'object'),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  result_hash text NOT NULL CHECK (result_hash ~ '^[0-9a-f]{32}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (offer_id, input_hash, stage_version),
  CHECK ((fee_status = 'known') = (fee_minor IS NOT NULL)),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);

ALTER TABLE biplan.job_attempts ADD COLUMN IF NOT EXISTS worker_id text;

CREATE OR REPLACE TRIGGER offer_derivations_immutable
BEFORE UPDATE OR DELETE ON biplan.offer_derivations
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_offer_revision();

CREATE TABLE IF NOT EXISTS biplan.publication_refresh_requests (
  id text PRIMARY KEY,
  offer_id text NOT NULL REFERENCES biplan.offer_identities(id),
  offer_revision_id text NOT NULL REFERENCES biplan.offer_revisions(id),
  outbox_event_id text NOT NULL REFERENCES biplan.outbox(id),
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','completed','failed','canceled')),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS publication_refresh_requests_event_idx
  ON biplan.publication_refresh_requests(outbox_event_id);

CREATE OR REPLACE FUNCTION biplan.protect_publication_refresh_request_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'publication refresh request identity and links are immutable';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
     OR NEW.offer_revision_id IS DISTINCT FROM OLD.offer_revision_id
     OR NEW.outbox_event_id IS DISTINCT FROM OLD.outbox_event_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'publication refresh request identity and links are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER publication_refresh_requests_protect_identity
BEFORE UPDATE OR DELETE ON biplan.publication_refresh_requests
FOR EACH ROW EXECUTE FUNCTION biplan.protect_publication_refresh_request_identity();

ALTER TABLE biplan.outbox ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;
ALTER TABLE biplan.outbox ADD COLUMN IF NOT EXISTS last_error jsonb;
DO $constraint$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='biplan.outbox'::regclass
    AND conname='outbox_max_attempts_positive') THEN
    ALTER TABLE biplan.outbox ADD CONSTRAINT outbox_max_attempts_positive CHECK (max_attempts > 0);
  END IF;
END $constraint$;

CREATE TABLE IF NOT EXISTS biplan.outbox_attempts (
  event_id text NOT NULL REFERENCES biplan.outbox(id),
  fencing_token bigint NOT NULL CHECK (fencing_token > 0),
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  worker_id text,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text CHECK (outcome IS NULL OR outcome IN ('delivered','failed','stale')),
  cost_units numeric CHECK (cost_units IS NULL OR cost_units >= 0),
  checkpoint jsonb,
  error jsonb,
  PRIMARY KEY (event_id, fencing_token)
);
ALTER TABLE biplan.outbox_attempts ADD COLUMN IF NOT EXISTS worker_id text;
ALTER TABLE biplan.outbox_attempts ADD COLUMN IF NOT EXISTS cost_units numeric;

CREATE OR REPLACE FUNCTION biplan.claim_offer_preparation_jobs(
  worker_id text, batch_limit integer, lease_for interval DEFAULT interval '5 minutes'
) RETURNS SETOF biplan.preparation_jobs LANGUAGE plpgsql AS $$
BEGIN
  IF worker_id IS NULL OR btrim(worker_id) = '' OR batch_limit IS NULL OR batch_limit < 1
     OR batch_limit > 100 OR lease_for IS NULL OR lease_for <= interval '0 seconds'
     OR lease_for > interval '15 minutes' THEN
    RAISE EXCEPTION 'invalid bounded offer preparation lease request';
  END IF;

  WITH exhausted AS (
    SELECT id, fencing_token FROM biplan.preparation_jobs
    WHERE stage='offer_revision_accepted' AND stage_version='1' AND subject_type='offer' AND state='leased'
      AND lease_expires_at <= clock_timestamp() AND attempt_count >= max_attempts
    ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT batch_limit
  ), closed_attempts AS (
    UPDATE biplan.job_attempts a SET finished_at=clock_timestamp(), outcome='stale',
      details=COALESCE(a.details,'{}'::jsonb)||jsonb_build_object('reason','lease_expired_attempts_exhausted')
    FROM exhausted e WHERE a.job_id=e.id AND a.fencing_token=e.fencing_token
      AND a.finished_at IS NULL RETURNING a.job_id
  )
  UPDATE biplan.preparation_jobs j SET state='failed', lease_owner=NULL, lease_expires_at=NULL,
    last_error=jsonb_build_object('code','attempts_exhausted','retryable',false), updated_at=clock_timestamp()
  FROM exhausted e WHERE j.id=e.id;

  RETURN QUERY
  WITH candidates AS (
    SELECT id, fencing_token FROM biplan.preparation_jobs
    WHERE stage='offer_revision_accepted' AND stage_version='1' AND subject_type='offer' AND attempt_count < max_attempts
      AND available_at <= clock_timestamp()
      AND (state='pending' OR (state='leased' AND lease_expires_at <= clock_timestamp()))
    ORDER BY priority DESC, created_at, id FOR UPDATE SKIP LOCKED LIMIT batch_limit
  ), stale_attempts AS (
    UPDATE biplan.job_attempts a SET finished_at=clock_timestamp(), outcome='stale',
      details=COALESCE(a.details,'{}'::jsonb)||jsonb_build_object('reason','lease_expired_reclaimed')
    FROM candidates c WHERE a.job_id=c.id AND a.fencing_token=c.fencing_token
      AND a.finished_at IS NULL RETURNING a.job_id
  ), updated AS (
    UPDATE biplan.preparation_jobs j SET state='leased', lease_owner=worker_id,
      lease_expires_at=clock_timestamp()+lease_for, fencing_token=j.fencing_token+1,
      attempt_count=j.attempt_count+1, updated_at=clock_timestamp()
    FROM candidates c WHERE j.id=c.id RETURNING j.*
  ), attempts AS (
    INSERT INTO biplan.job_attempts(job_id,fencing_token,attempt_number,worker_id)
    SELECT id,fencing_token,attempt_count,worker_id FROM updated RETURNING job_id,fencing_token
  ) SELECT u.* FROM updated u JOIN attempts a ON a.job_id=u.id AND a.fencing_token=u.fencing_token;
END $$;

CREATE OR REPLACE FUNCTION biplan.enqueue_missing_offer_preparation_jobs(batch_limit integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE inserted_count integer;
BEGIN
  IF batch_limit IS NULL OR batch_limit < 1 OR batch_limit > 100 THEN
    RAISE EXCEPTION 'invalid bounded offer preparation enqueue request';
  END IF;
  WITH candidates AS (
    SELECT identity.id AS offer_id, identity.current_revision_id AS revision_id,
      revision.semantic_content_hash AS input_hash
    FROM biplan.offer_identities identity
    JOIN biplan.offer_revisions revision ON revision.id=identity.current_revision_id
      AND revision.offer_id=identity.id AND revision.acceptance_status='accepted'
    WHERE NOT EXISTS (
      SELECT 1 FROM biplan.preparation_jobs job
      WHERE job.stage='offer_revision_accepted' AND job.stage_version='1'
        AND job.subject_type='offer' AND job.subject_id=identity.id
        AND job.input_hash=revision.semantic_content_hash
    ) AND NOT EXISTS (
      SELECT 1 FROM biplan.offer_derivations derivation
      WHERE derivation.offer_id=identity.id AND derivation.input_hash=revision.semantic_content_hash
        AND derivation.stage_version='1'
    )
    ORDER BY identity.id
    FOR UPDATE OF identity SKIP LOCKED
    LIMIT batch_limit
  )
  INSERT INTO biplan.preparation_jobs(id,stage,stage_version,subject_type,subject_id,input_hash)
  SELECT 'offer-revision:'||revision_id,'offer_revision_accepted','1','offer',offer_id,input_hash
  FROM candidates
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;
  RETURN inserted_count;
END $$;

CREATE OR REPLACE FUNCTION biplan.checkpoint_offer_preparation_job(
  p_job_id text, p_worker_id text, p_fence bigint, p_checkpoint jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE saved jsonb;
BEGIN
  IF p_job_id IS NULL OR p_worker_id IS NULL OR btrim(p_worker_id)='' OR p_fence IS NULL
     OR p_checkpoint IS NULL OR jsonb_typeof(p_checkpoint)<>'object' THEN
    RAISE EXCEPTION 'invalid offer preparation checkpoint';
  END IF;
  UPDATE biplan.preparation_jobs SET checkpoint=p_checkpoint, updated_at=clock_timestamp()
  WHERE id=p_job_id AND stage='offer_revision_accepted' AND stage_version='1' AND subject_type='offer' AND state='leased'
    AND lease_owner=p_worker_id AND fencing_token=p_fence AND lease_expires_at>clock_timestamp()
  RETURNING checkpoint INTO saved;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale or invalid checkpoint for offer preparation job %',p_job_id; END IF;
  UPDATE biplan.job_attempts SET details=COALESCE(details,'{}'::jsonb)||jsonb_build_object('checkpoint',p_checkpoint)
  WHERE job_id=p_job_id AND fencing_token=p_fence AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing active attempt for offer preparation job %',p_job_id; END IF;
  RETURN saved;
END $$;

CREATE OR REPLACE FUNCTION biplan.finish_offer_preparation_job(
  p_job_id text, p_worker_id text, p_fence bigint, p_result jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE; r biplan.offer_revisions%ROWTYPE;
  facts jsonb; stored_result jsonb; computed_hash text; existing biplan.offer_derivations%ROWTYPE;
BEGIN
  IF p_job_id IS NULL OR p_worker_id IS NULL OR btrim(p_worker_id)='' OR p_fence IS NULL
     OR p_result IS NULL OR jsonb_typeof(p_result)<>'object' THEN RAISE EXCEPTION 'invalid offer preparation result'; END IF;
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.stage<>'offer_revision_accepted' OR j.stage_version<>'1' OR j.subject_type<>'offer' OR j.state<>'leased' OR j.lease_owner<>p_worker_id
     OR j.fencing_token<>p_fence OR j.lease_expires_at<=clock_timestamp() THEN
    -- Lost replies may repeat only the exact result at the successful fence.
    SELECT d.* INTO existing FROM biplan.offer_derivations d
    JOIN biplan.preparation_jobs pj ON pj.subject_id=d.offer_id AND pj.input_hash=d.input_hash
      AND pj.stage_version=d.stage_version WHERE pj.id=p_job_id;
    IF j.state='succeeded' AND j.fencing_token=p_fence AND existing.result_hash=md5(p_result::text)
       AND EXISTS (SELECT 1 FROM biplan.job_attempts WHERE job_id=p_job_id AND fencing_token=p_fence
         AND worker_id=p_worker_id AND outcome='succeeded') THEN
      RETURN jsonb_build_object('status','succeeded','idempotent',true,'resultHash',existing.result_hash);
    END IF;
    RAISE EXCEPTION 'stale or invalid completion for offer preparation job % at fence %',p_job_id,p_fence;
  END IF;
  IF p_result->>'dependencyHash' IS DISTINCT FROM j.input_hash OR p_result->>'profile' IS DISTINCT FROM 'offer-facts-v'||j.stage_version
     OR p_result->>'offerId' IS DISTINCT FROM j.subject_id OR (p_result->>'schemaVersion')::integer IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'offer preparation result does not match claimed input or stage';
  END IF;
  SELECT rev.* INTO r FROM biplan.offer_revisions rev WHERE rev.id=p_result->>'sourceRevisionId'
    AND rev.offer_id=j.subject_id AND rev.semantic_content_hash=j.input_hash AND rev.acceptance_status='accepted';
  IF NOT FOUND THEN RAISE EXCEPTION 'offer preparation input no longer matches immutable accepted revision'; END IF;
  facts:=jsonb_build_object('currency',CASE WHEN upper(btrim(r.currency)) ~ '^[A-Z]{3}$' THEN upper(btrim(r.currency)) ELSE NULL END,
    'basePriceMinor',CASE WHEN r.price_minor IS NULL THEN NULL ELSE to_jsonb(r.price_minor::text) END,
    'feeMinor',CASE WHEN r.fee_minor IS NULL THEN NULL ELSE to_jsonb(r.fee_minor::text) END,
    'priceKind',r.price_kind,'availability',r.availability,
    'exactCheckoutPriceMinor',CASE WHEN r.price_kind='exact' AND upper(btrim(r.currency)) ~ '^[A-Z]{3}$'
      AND r.price_minor IS NOT NULL AND r.fee_minor IS NOT NULL THEN to_jsonb((r.price_minor::numeric+r.fee_minor)::text) ELSE NULL END,
    'priceStatus',CASE WHEN r.price_minor IS NULL OR (upper(btrim(r.currency)) ~ '^[A-Z]{3}$') IS NOT TRUE
      THEN 'unknown' ELSE r.price_kind END,'groupStock','unknown','promotionStatus','unknown');
  IF p_result->'facts' IS DISTINCT FROM facts THEN
    RAISE EXCEPTION 'offer preparation facts do not match immutable source revision';
  END IF;
  stored_result:=p_result;
  computed_hash:=md5(stored_result::text);
  INSERT INTO biplan.offer_derivations(offer_id,input_hash,stage_version,currency,price_minor,fee_minor,
    fee_status,price_kind,availability,valid_from,valid_until,normalized_facts,result,result_hash)
  VALUES(j.subject_id,j.input_hash,j.stage_version,
    CASE WHEN upper(btrim(r.currency)) ~ '^[A-Z]{3}$' THEN upper(btrim(r.currency)) ELSE NULL END,r.price_minor,r.fee_minor,
    CASE WHEN r.fee_minor IS NULL THEN 'unknown' ELSE 'known' END,r.price_kind,r.availability,
    r.valid_from,r.valid_until,facts,stored_result,computed_hash)
  ON CONFLICT (offer_id,input_hash,stage_version) DO NOTHING;
  SELECT * INTO existing FROM biplan.offer_derivations WHERE offer_id=j.subject_id
    AND input_hash=j.input_hash AND stage_version=j.stage_version;
  IF existing.result_hash<>computed_hash OR existing.result<>stored_result OR existing.normalized_facts<>facts THEN
    RAISE EXCEPTION 'content-addressed offer derivation conflicts with cached result';
  END IF;
  UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='succeeded',cost_units=0,
    details=COALESCE(details,'{}'::jsonb)||jsonb_build_object('resultHash',computed_hash)
  WHERE job_id=p_job_id AND fencing_token=p_fence AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing active offer preparation attempt'; END IF;
  UPDATE biplan.preparation_jobs SET state='succeeded',checkpoint=jsonb_build_object('resultHash',computed_hash),
    lease_owner=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
  WHERE id=p_job_id AND fencing_token=p_fence;
  RETURN jsonb_build_object('status','succeeded','idempotent',false,'resultHash',computed_hash);
END $$;

CREATE OR REPLACE FUNCTION biplan.fail_offer_preparation_job(
  p_job_id text,p_worker_id text,p_fence bigint,p_error jsonb,p_retry_after interval DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE; retryable boolean; next_state text;
BEGIN
  IF p_job_id IS NULL OR p_worker_id IS NULL OR btrim(p_worker_id)='' OR p_fence IS NULL OR p_error IS NULL
    OR jsonb_typeof(p_error)<>'object' OR p_error->>'code' IS NULL
    OR COALESCE(jsonb_typeof(p_error->'retryable'),'null')<>'boolean'
    OR (p_retry_after IS NOT NULL AND p_retry_after<interval '0 seconds') THEN RAISE EXCEPTION 'invalid offer preparation failure'; END IF;
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.stage<>'offer_revision_accepted' OR j.stage_version<>'1' OR j.subject_type<>'offer' OR j.state<>'leased' OR j.lease_owner<>p_worker_id
    OR j.fencing_token<>p_fence OR j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale or invalid failure for offer preparation job %',p_job_id; END IF;
  retryable:=(p_error->>'retryable')::boolean;
  next_state:=CASE WHEN retryable AND j.attempt_count<j.max_attempts THEN 'pending' ELSE 'failed' END;
  UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='failed',cost_units=0,
    details=COALESCE(details,'{}'::jsonb)||jsonb_build_object('error',p_error)
  WHERE job_id=p_job_id AND fencing_token=p_fence AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing active offer preparation attempt'; END IF;
  UPDATE biplan.preparation_jobs SET state=next_state,available_at=CASE WHEN next_state='pending' THEN clock_timestamp()+COALESCE(p_retry_after,interval '0 seconds') ELSE available_at END,
    lease_owner=NULL,lease_expires_at=NULL,last_error=p_error,updated_at=clock_timestamp() WHERE id=p_job_id;
  RETURN jsonb_build_object('status',next_state,'retryable',next_state='pending');
END $$;

CREATE OR REPLACE FUNCTION biplan.claim_offer_outbox(
  worker_id text,batch_limit integer,lease_for interval DEFAULT interval '5 minutes'
) RETURNS SETOF biplan.outbox LANGUAGE plpgsql AS $$
BEGIN
  IF worker_id IS NULL OR btrim(worker_id)='' OR batch_limit IS NULL OR batch_limit<1 OR batch_limit>100
    OR lease_for IS NULL OR lease_for<=interval '0 seconds' OR lease_for>interval '15 minutes' THEN RAISE EXCEPTION 'invalid bounded offer outbox lease request'; END IF;
  WITH exhausted AS (
    SELECT id,fencing_token FROM biplan.outbox WHERE topic='offer.revision.accepted' AND state='leased'
      AND lease_expires_at<=clock_timestamp() AND attempt_count>=max_attempts
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT batch_limit
  ), closed AS (
    UPDATE biplan.outbox_attempts a SET finished_at=clock_timestamp(),outcome='stale',error=jsonb_build_object('code','attempts_exhausted')
    FROM exhausted e WHERE a.event_id=e.id AND a.fencing_token=e.fencing_token AND a.finished_at IS NULL RETURNING a.event_id
  ) UPDATE biplan.outbox o SET state='failed',lease_owner=NULL,lease_expires_at=NULL,
    last_error=jsonb_build_object('code','attempts_exhausted','retryable',false) FROM exhausted e WHERE o.id=e.id;
  RETURN QUERY WITH candidates AS (
    SELECT id,fencing_token FROM biplan.outbox WHERE topic='offer.revision.accepted' AND attempt_count<max_attempts
      AND available_at<=clock_timestamp() AND (state='pending' OR (state='leased' AND lease_expires_at<=clock_timestamp()))
    ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT batch_limit
  ), stale AS (
    UPDATE biplan.outbox_attempts a SET finished_at=clock_timestamp(),outcome='stale',error=jsonb_build_object('code','lease_expired_reclaimed')
    FROM candidates c WHERE a.event_id=c.id AND a.fencing_token=c.fencing_token AND a.finished_at IS NULL RETURNING a.event_id
  ), updated AS (
    UPDATE biplan.outbox o SET state='leased',lease_owner=worker_id,lease_expires_at=clock_timestamp()+lease_for,
      fencing_token=o.fencing_token+1,attempt_count=o.attempt_count+1 FROM candidates c WHERE o.id=c.id RETURNING o.*
  ), attempts AS (
    INSERT INTO biplan.outbox_attempts(event_id,fencing_token,attempt_number,worker_id)
    SELECT id,fencing_token,attempt_count,worker_id FROM updated RETURNING event_id,fencing_token
  ) SELECT u.* FROM updated u JOIN attempts a ON a.event_id=u.id AND a.fencing_token=u.fencing_token;
END $$;

CREATE OR REPLACE FUNCTION biplan.deliver_offer_outbox(p_event_id text,p_worker_id text,p_fence bigint)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e biplan.outbox%ROWTYPE; rev biplan.offer_revisions%ROWTYPE; req biplan.publication_refresh_requests%ROWTYPE;
BEGIN
  IF p_event_id IS NULL OR p_worker_id IS NULL OR btrim(p_worker_id)='' OR p_fence IS NULL THEN RAISE EXCEPTION 'invalid offer outbox delivery'; END IF;
  SELECT * INTO e FROM biplan.outbox WHERE id=p_event_id FOR UPDATE;
  IF e.state='delivered' AND e.fencing_token=p_fence THEN
    SELECT * INTO req FROM biplan.publication_refresh_requests WHERE outbox_event_id=e.id;
    IF FOUND AND EXISTS (SELECT 1 FROM biplan.outbox_attempts WHERE event_id=e.id AND fencing_token=p_fence
      AND worker_id=p_worker_id AND outcome='delivered') THEN
      RETURN jsonb_build_object('status','delivered','idempotent',true,'requestId',req.id);
    END IF;
  END IF;
  IF NOT FOUND OR e.topic<>'offer.revision.accepted' OR e.state<>'leased' OR e.lease_owner<>p_worker_id
    OR e.fencing_token<>p_fence OR e.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale or invalid offer outbox delivery %',p_event_id; END IF;
  SELECT * INTO rev FROM biplan.offer_revisions WHERE id=e.payload->>'revisionId' AND offer_id=e.payload->>'offerId'
    AND offer_id=e.aggregate_id AND acceptance_status='accepted';
  IF NOT FOUND OR e.aggregate_type<>'offer' OR e.idempotency_key IS DISTINCT FROM 'offer.revision.accepted:'||(e.payload->>'revisionId') THEN
    RAISE EXCEPTION 'offer outbox event does not match immutable accepted revision identity';
  END IF;
  INSERT INTO biplan.publication_refresh_requests(id,offer_id,offer_revision_id,outbox_event_id,idempotency_key)
  VALUES('refresh:'||e.id,rev.offer_id,rev.id,e.id,e.idempotency_key) ON CONFLICT (idempotency_key) DO NOTHING;
  SELECT * INTO req FROM biplan.publication_refresh_requests WHERE idempotency_key=e.idempotency_key;
  IF req.offer_id<>rev.offer_id OR req.offer_revision_id<>rev.id OR req.outbox_event_id<>e.id THEN RAISE EXCEPTION 'publication refresh idempotency key conflict'; END IF;
  UPDATE biplan.outbox_attempts SET finished_at=clock_timestamp(),outcome='delivered',cost_units=0,checkpoint=jsonb_build_object('requestId',req.id)
  WHERE event_id=e.id AND fencing_token=p_fence AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing active offer outbox attempt'; END IF;
  UPDATE biplan.outbox SET state='delivered',delivered_at=clock_timestamp(),lease_owner=NULL,lease_expires_at=NULL WHERE id=e.id AND fencing_token=p_fence;
  RETURN jsonb_build_object('status','delivered','idempotent',false,'requestId',req.id);
END $$;

CREATE OR REPLACE FUNCTION biplan.fail_offer_outbox(p_event_id text,p_worker_id text,p_fence bigint,p_error jsonb,p_retry_after interval DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE e biplan.outbox%ROWTYPE; retryable boolean; next_state text;
BEGIN
  IF p_event_id IS NULL OR p_worker_id IS NULL OR btrim(p_worker_id)='' OR p_fence IS NULL OR p_error IS NULL
    OR jsonb_typeof(p_error)<>'object' OR p_error->>'code' IS NULL OR COALESCE(jsonb_typeof(p_error->'retryable'),'null')<>'boolean'
    OR (p_retry_after IS NOT NULL AND p_retry_after<interval '0 seconds') THEN RAISE EXCEPTION 'invalid offer outbox failure'; END IF;
  SELECT * INTO e FROM biplan.outbox WHERE id=p_event_id FOR UPDATE;
  IF NOT FOUND OR e.topic<>'offer.revision.accepted' OR e.state<>'leased' OR e.lease_owner<>p_worker_id
    OR e.fencing_token<>p_fence OR e.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale or invalid offer outbox failure %',p_event_id; END IF;
  retryable:=(p_error->>'retryable')::boolean;
  next_state:=CASE WHEN retryable AND e.attempt_count<e.max_attempts THEN 'pending' ELSE 'failed' END;
  UPDATE biplan.outbox_attempts SET finished_at=clock_timestamp(),outcome='failed',cost_units=0,error=p_error
  WHERE event_id=e.id AND fencing_token=p_fence AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing active offer outbox attempt'; END IF;
  UPDATE biplan.outbox SET state=next_state,available_at=CASE WHEN next_state='pending' THEN clock_timestamp()+COALESCE(p_retry_after,interval '0 seconds') ELSE available_at END,
    lease_owner=NULL,lease_expires_at=NULL,last_error=p_error WHERE id=e.id;
  RETURN jsonb_build_object('status',next_state,'retryable',next_state='pending');
END $$;

INSERT INTO biplan.schema_migrations(version,migration_hash) VALUES('003-workers','003-workers-v1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
