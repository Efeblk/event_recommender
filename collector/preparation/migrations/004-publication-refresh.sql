BEGIN;

DO $guard$
DECLARE installed_hash text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM biplan.schema_migrations WHERE version='003-workers') THEN
    RAISE EXCEPTION 'publication refresh migration requires 003-workers';
  END IF;
  SELECT migration_hash INTO installed_hash FROM biplan.schema_migrations
  WHERE version='004-publication-refresh';
  IF installed_hash IS NOT NULL AND installed_hash <> '004-publication-refresh-v1' THEN
    RAISE EXCEPTION 'incompatible installed migration 004-publication-refresh: %',installed_hash;
  END IF;
END $guard$;

ALTER TABLE biplan.publication_refresh_requests DROP CONSTRAINT IF EXISTS publication_refresh_requests_state_check;
ALTER TABLE biplan.publication_refresh_requests
  ADD CONSTRAINT publication_refresh_requests_state_check
  CHECK (state IN ('pending','processing','completed','failed','blocked','canceled'));
ALTER TABLE biplan.publication_refresh_requests ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE biplan.publication_refresh_requests ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE biplan.publication_refresh_requests ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;
ALTER TABLE biplan.publication_refresh_requests ADD COLUMN IF NOT EXISTS fencing_token bigint NOT NULL DEFAULT 0;
ALTER TABLE biplan.publication_refresh_requests ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0;
ALTER TABLE biplan.publication_refresh_requests ADD COLUMN IF NOT EXISTS max_attempts integer NOT NULL DEFAULT 5;
ALTER TABLE biplan.publication_refresh_requests ADD COLUMN IF NOT EXISTS checkpoint jsonb;
ALTER TABLE biplan.publication_refresh_requests ADD COLUMN IF NOT EXISTS last_error jsonb;
ALTER TABLE biplan.publication_refresh_requests ADD COLUMN IF NOT EXISTS base_publication_id text REFERENCES biplan.publications(id);
ALTER TABLE biplan.publication_refresh_requests ADD COLUMN IF NOT EXISTS result_publication_id text REFERENCES biplan.publications(id);
ALTER TABLE biplan.publication_refresh_requests ADD COLUMN IF NOT EXISTS completed_at timestamptz;
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='biplan.publication_refresh_requests'::regclass AND conname='publication_refresh_requests_fence_nonnegative') THEN
    ALTER TABLE biplan.publication_refresh_requests ADD CONSTRAINT publication_refresh_requests_fence_nonnegative CHECK (fencing_token>=0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='biplan.publication_refresh_requests'::regclass AND conname='publication_refresh_requests_attempts_bounded') THEN
    ALTER TABLE biplan.publication_refresh_requests ADD CONSTRAINT publication_refresh_requests_attempts_bounded CHECK (attempt_count>=0 AND max_attempts>0 AND attempt_count<=max_attempts);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='biplan.publication_refresh_requests'::regclass AND conname='publication_refresh_requests_lease_consistent') THEN
    ALTER TABLE biplan.publication_refresh_requests ADD CONSTRAINT publication_refresh_requests_lease_consistent
      CHECK ((state='processing')=(lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='biplan.publication_refresh_requests'::regclass AND conname='publication_refresh_requests_completion_consistent') THEN
    ALTER TABLE biplan.publication_refresh_requests ADD CONSTRAINT publication_refresh_requests_completion_consistent
      CHECK ((state='completed')=(result_publication_id IS NOT NULL AND completed_at IS NOT NULL));
  END IF;
END $constraints$;
CREATE INDEX IF NOT EXISTS publication_refresh_requests_claim_idx
  ON biplan.publication_refresh_requests(state,available_at,requested_at,id);

CREATE TABLE IF NOT EXISTS biplan.publication_refresh_attempts (
  request_id text NOT NULL REFERENCES biplan.publication_refresh_requests(id),
  fencing_token bigint NOT NULL CHECK (fencing_token>0),
  attempt_number integer NOT NULL CHECK (attempt_number>0),
  worker_id text NOT NULL CHECK (btrim(worker_id)<>''),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text CHECK (outcome IS NULL OR outcome IN ('completed','failed','blocked','stale')),
  checkpoint jsonb,
  error jsonb,
  result_publication_id text REFERENCES biplan.publications(id),
  PRIMARY KEY(request_id,fencing_token)
);

CREATE OR REPLACE FUNCTION biplan.offer_revision_term(p_revision_id text) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
  SELECT jsonb_build_object('offerId',i.id,'revisionId',r.id,'provider',r.provider,
    'providerRecordId',r.provider_record_id,'sourceUrl',r.source_url,'ticketTierId',r.ticket_tier_id,
    'ticketTierName',r.ticket_tier_name,'currency',r.currency,
    'price',CASE WHEN r.price IS NULL THEN NULL ELSE to_jsonb(r.price::text) END,
    'priceMinor',CASE WHEN r.price_minor IS NULL THEN NULL ELSE to_jsonb(r.price_minor::text) END,
    'feeMinor',CASE WHEN r.fee_minor IS NULL THEN NULL ELSE to_jsonb(r.fee_minor::text) END,
    'priceKind',r.price_kind,'availability',r.availability,'observedAt',r.observed_at,
    'sourceUpdatedAt',r.source_updated_at,'validFrom',r.valid_from,'validUntil',r.valid_until)
  FROM biplan.offer_revisions r JOIN biplan.offer_identities i ON i.id=r.offer_id WHERE r.id=p_revision_id
$$;

CREATE OR REPLACE FUNCTION biplan.protect_publication_refresh_request_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'publication refresh request identity and links are immutable'; END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.offer_id IS DISTINCT FROM OLD.offer_id
    OR NEW.offer_revision_id IS DISTINCT FROM OLD.offer_revision_id OR NEW.outbox_event_id IS DISTINCT FROM OLD.outbox_event_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
    OR (OLD.base_publication_id IS NOT NULL AND NEW.base_publication_id IS DISTINCT FROM OLD.base_publication_id)
    OR (OLD.result_publication_id IS NOT NULL AND NEW.result_publication_id IS DISTINCT FROM OLD.result_publication_id)
    OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'publication refresh request identity and links are immutable';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION biplan.claim_publication_refresh_requests(
  p_worker_id text,p_batch_limit integer,p_lease_for interval DEFAULT interval '5 minutes'
) RETURNS SETOF biplan.publication_refresh_requests LANGUAGE plpgsql AS $$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id)='' OR p_batch_limit IS NULL OR p_batch_limit<1 OR p_batch_limit>100
    OR p_lease_for IS NULL OR p_lease_for<=interval '0 seconds' OR p_lease_for>interval '15 minutes' THEN
    RAISE EXCEPTION 'invalid bounded publication refresh lease request';
  END IF;
  WITH exhausted AS (
    SELECT id,fencing_token FROM biplan.publication_refresh_requests
    WHERE state='processing' AND lease_expires_at<=clock_timestamp() AND attempt_count>=max_attempts
    ORDER BY requested_at,id FOR UPDATE SKIP LOCKED LIMIT p_batch_limit
  ), closed AS (
    UPDATE biplan.publication_refresh_attempts a SET finished_at=clock_timestamp(),outcome='stale',
      error=jsonb_build_object('code','attempts_exhausted','retryable',false)
    FROM exhausted e WHERE a.request_id=e.id AND a.fencing_token=e.fencing_token AND a.finished_at IS NULL RETURNING a.request_id
  ) UPDATE biplan.publication_refresh_requests r SET state='failed',lease_owner=NULL,lease_expires_at=NULL,
    last_error=jsonb_build_object('code','attempts_exhausted','retryable',false)
    FROM exhausted e WHERE r.id=e.id;

  RETURN QUERY WITH candidates AS (
    SELECT id,fencing_token FROM biplan.publication_refresh_requests
    WHERE attempt_count<max_attempts AND available_at<=clock_timestamp()
      AND (state='pending' OR (state='processing' AND lease_expires_at<=clock_timestamp()))
    ORDER BY requested_at,id FOR UPDATE SKIP LOCKED LIMIT p_batch_limit
  ), stale AS (
    UPDATE biplan.publication_refresh_attempts a SET finished_at=clock_timestamp(),outcome='stale',
      error=jsonb_build_object('code','lease_expired_reclaimed','retryable',true)
    FROM candidates c WHERE a.request_id=c.id AND a.fencing_token=c.fencing_token AND a.finished_at IS NULL RETURNING a.request_id
  ), updated AS (
    UPDATE biplan.publication_refresh_requests r SET state='processing',lease_owner=p_worker_id,
      lease_expires_at=clock_timestamp()+p_lease_for,fencing_token=r.fencing_token+1,attempt_count=r.attempt_count+1
    FROM candidates c WHERE r.id=c.id RETURNING r.*
  ), attempts AS (
    INSERT INTO biplan.publication_refresh_attempts(request_id,fencing_token,attempt_number,worker_id)
    SELECT id,fencing_token,attempt_count,p_worker_id FROM updated RETURNING request_id,fencing_token
  ) SELECT u.* FROM updated u JOIN attempts a ON a.request_id=u.id AND a.fencing_token=u.fencing_token;
END $$;

CREATE OR REPLACE FUNCTION biplan.checkpoint_publication_refresh_request(
  p_request_id text,p_worker_id text,p_fence bigint,p_checkpoint jsonb
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE saved jsonb;
BEGIN
  IF p_request_id IS NULL OR p_worker_id IS NULL OR btrim(p_worker_id)='' OR p_fence IS NULL
    OR p_checkpoint IS NULL OR jsonb_typeof(p_checkpoint)<>'object' THEN RAISE EXCEPTION 'invalid publication refresh checkpoint'; END IF;
  UPDATE biplan.publication_refresh_requests SET checkpoint=p_checkpoint
  WHERE id=p_request_id AND state='processing' AND lease_owner=p_worker_id AND fencing_token=p_fence
    AND lease_expires_at>clock_timestamp() RETURNING checkpoint INTO saved;
  IF NOT FOUND THEN RAISE EXCEPTION 'stale or invalid publication refresh checkpoint for %',p_request_id; END IF;
  UPDATE biplan.publication_refresh_attempts SET checkpoint=p_checkpoint
  WHERE request_id=p_request_id AND fencing_token=p_fence AND worker_id=p_worker_id AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing active publication refresh attempt for %',p_request_id; END IF;
  RETURN saved;
END $$;

CREATE OR REPLACE FUNCTION biplan.fail_publication_refresh_request(
  p_request_id text,p_worker_id text,p_fence bigint,p_error jsonb,p_retry_after interval DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE r biplan.publication_refresh_requests%ROWTYPE; retryable boolean; next_state text;
BEGIN
  IF p_error IS NULL OR jsonb_typeof(p_error)<>'object' OR p_error->>'code' IS NULL
    OR COALESCE(jsonb_typeof(p_error->'retryable'),'null')<>'boolean'
    OR p_retry_after<interval '0 seconds' THEN RAISE EXCEPTION 'invalid publication refresh failure'; END IF;
  SELECT * INTO r FROM biplan.publication_refresh_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND OR r.state<>'processing' OR r.lease_owner<>p_worker_id OR r.fencing_token<>p_fence
    OR r.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale or invalid publication refresh failure for %',p_request_id; END IF;
  retryable:=(p_error->>'retryable')::boolean;
  next_state:=CASE WHEN retryable AND r.attempt_count<r.max_attempts THEN 'pending' ELSE 'failed' END;
  UPDATE biplan.publication_refresh_attempts SET finished_at=clock_timestamp(),outcome='failed',error=p_error
  WHERE request_id=p_request_id AND fencing_token=p_fence AND worker_id=p_worker_id AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing active publication refresh attempt'; END IF;
  UPDATE biplan.publication_refresh_requests SET state=next_state,lease_owner=NULL,lease_expires_at=NULL,last_error=p_error,
    available_at=CASE WHEN next_state='pending' THEN clock_timestamp()+COALESCE(p_retry_after,interval '0 seconds') ELSE available_at END
  WHERE id=p_request_id;
  RETURN jsonb_build_object('status',next_state,'retryable',next_state='pending');
END $$;

CREATE OR REPLACE FUNCTION biplan.current_publication_offer_status(
  p_publication_id text,p_session_id text,p_checked_at timestamptz DEFAULT clock_timestamp(),p_max_age interval DEFAULT interval '72 hours'
) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE v_rows jsonb; v_reasons jsonb; v_usable boolean; v_canonical_ok boolean;
  v_availability_usable boolean; v_verified_total_eligible boolean;
BEGIN
  IF p_checked_at IS NULL OR p_max_age IS NULL OR p_max_age<=interval '0 seconds' OR p_max_age>interval '30 days' THEN
    RAISE EXCEPTION 'invalid publication offer status window';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM biplan.published_sessions WHERE publication_id=p_publication_id AND session_id=p_session_id) THEN
    RAISE EXCEPTION 'published session %/% does not exist',p_publication_id,p_session_id;
  END IF;
  SELECT (s.status='scheduled' AND ps.production_id=s.production_id AND ps.venue_id IS NOT DISTINCT FROM s.venue_id
    AND (ps.eligibility_snapshot->>'startsAt')::timestamptz IS NOT DISTINCT FROM s.starts_at
    AND NULLIF(ps.eligibility_snapshot->'attendanceTiming','null'::jsonb) IS NOT DISTINCT FROM NULLIF(s.attendance_timing,'null'::jsonb))
    INTO v_canonical_ok FROM biplan.published_sessions ps JOIN biplan.sessions s ON s.id=ps.session_id
    WHERE ps.publication_id=p_publication_id AND ps.session_id=p_session_id;
  WITH statuses AS (
    SELECT i.id offer_id,p.offer_revision_id pinned_id,i.current_revision_id current_id,
      CASE WHEN i.current_revision_id IS DISTINCT FROM p.offer_revision_id THEN 'superseded'
        WHEN r.availability='sold_out' THEN 'sold_out' WHEN r.availability='unavailable' THEN 'unavailable'
        WHEN r.valid_from IS NOT NULL AND r.valid_from>p_checked_at THEN 'not_yet_valid'
        WHEN r.valid_until IS NOT NULL AND r.valid_until<p_checked_at THEN 'expired'
        WHEN r.observed_at>p_checked_at THEN 'future_observation'
        WHEN r.observed_at<p_checked_at-p_max_age THEN 'stale'
        WHEN r.availability='unknown' THEN 'unknown_availability' ELSE 'usable' END status,
      to_jsonb(array_remove(ARRAY[
        CASE WHEN i.current_revision_id IS DISTINCT FROM p.offer_revision_id THEN 'current_head_changed' END,
        CASE WHEN r.availability='sold_out' THEN 'sold_out' END,
        CASE WHEN r.availability='unavailable' THEN 'unavailable' END,
        CASE WHEN r.valid_from IS NOT NULL AND r.valid_from>p_checked_at THEN 'not_yet_valid' END,
        CASE WHEN r.valid_until IS NOT NULL AND r.valid_until<p_checked_at THEN 'expired' END,
        CASE WHEN r.observed_at>p_checked_at THEN 'future_observation' END,
        CASE WHEN r.observed_at<p_checked_at-p_max_age THEN 'stale_observation' END,
        CASE WHEN r.availability='unknown' THEN 'unknown_availability' END],NULL)) reasons
    FROM biplan.publication_offers p JOIN biplan.offer_revisions r ON r.id=p.offer_revision_id
    JOIN biplan.offer_identities i ON i.id=r.offer_id
    WHERE p.publication_id=p_publication_id AND p.session_id=p_session_id
  ), absent_heads AS (
    SELECT i.id offer_id,NULL::text pinned_id,i.current_revision_id current_id,'missing_pin' status,
      '["current_offer_missing_from_publication"]'::jsonb reasons
    FROM biplan.offer_identities i WHERE i.session_id=p_session_id AND NOT EXISTS (
      SELECT 1 FROM biplan.publication_offers p JOIN biplan.offer_revisions r ON r.id=p.offer_revision_id
      WHERE p.publication_id=p_publication_id AND p.session_id=p_session_id AND r.offer_id=i.id)
  ), all_statuses AS (SELECT * FROM statuses UNION ALL SELECT * FROM absent_heads)
  SELECT COALESCE(jsonb_agg(jsonb_build_object('offerId',z.offer_id,'pinnedRevisionId',z.pinned_id,
      'currentRevisionId',z.current_id,'status',z.status,'reasons',z.reasons) ORDER BY z.offer_id),'[]'::jsonb),
    COALESCE((SELECT jsonb_agg(DISTINCT reason) FROM all_statuses a CROSS JOIN LATERAL jsonb_array_elements_text(a.reasons) reason),'[]'::jsonb),
    bool_or(z.status='usable') AND bool_and(z.current_id IS NOT DISTINCT FROM z.pinned_id)
      INTO v_rows,v_reasons,v_usable FROM all_statuses z;
  v_availability_usable:=COALESCE(v_usable,false) AND v_canonical_ok;
  IF v_canonical_ok IS NOT TRUE THEN v_reasons:=v_reasons||'["canonical_session_changed"]'::jsonb; END IF;
  SELECT v_availability_usable AND EXISTS (
    SELECT 1 FROM biplan.publication_offers p
    JOIN biplan.offer_revisions r ON r.id=p.offer_revision_id
    JOIN biplan.offer_identities i ON i.id=r.offer_id AND i.current_revision_id=r.id
    WHERE p.publication_id=p_publication_id AND p.session_id=p_session_id
      AND r.acceptance_status='accepted' AND r.availability IN ('available','limited')
      AND r.observed_at<=p_checked_at AND r.observed_at>=p_checked_at-p_max_age
      AND (r.valid_from IS NULL OR r.valid_from<=p_checked_at)
      AND (r.valid_until IS NULL OR r.valid_until>=p_checked_at)
      AND r.currency='TRY' AND r.price_minor IS NOT NULL AND r.fee_minor IS NOT NULL
      AND r.price_kind='exact' AND (r.price IS NULL OR r.price*100=r.price_minor)
  ) INTO v_verified_total_eligible;
  RETURN jsonb_build_object('publicationId',p_publication_id,'sessionId',p_session_id,'checkedAt',p_checked_at,
    'maxAgeSeconds',extract(epoch from p_max_age),'usable',v_availability_usable,
    'availabilityUsable',v_availability_usable,'verifiedTotalEligible',COALESCE(v_verified_total_eligible,false),
    'canonicalSessionUsable',v_canonical_ok,
    'status',CASE WHEN v_availability_usable THEN 'usable' ELSE 'unusable' END,
    'reasons',v_reasons,'offers',v_rows);
END $$;

-- Version 1 refresh snapshots bind each typed term to one exact immutable pin.
-- Older publications retain the legacy raw-equality validation installed by 002.
CREATE OR REPLACE FUNCTION biplan.validate_publication_offers(p_publication_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE publication biplan.publications%ROWTYPE; required_count integer; actual_count integer;
BEGIN
  SELECT * INTO publication FROM biplan.publications WHERE id=p_publication_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'publication % does not exist',p_publication_id; END IF;
  IF EXISTS (SELECT 1 FROM biplan.publication_offers p JOIN biplan.offer_revisions r ON r.id=p.offer_revision_id
    LEFT JOIN biplan.published_sessions s ON s.publication_id=p.publication_id AND s.session_id=p.session_id
    WHERE p.publication_id=p_publication_id AND (p.session_id IS DISTINCT FROM r.session_id OR r.acceptance_status<>'accepted' OR s.session_id IS NULL))
  THEN RAISE EXCEPTION 'publication % has an invalid offer revision link',p_publication_id; END IF;
  IF EXISTS (SELECT 1 FROM biplan.published_sessions s WHERE s.publication_id=p_publication_id
    AND s.eligibility_snapshot?'offerTermsVersion' AND s.eligibility_snapshot->>'offerTermsVersion'<>'1') THEN
    RAISE EXCEPTION 'publication % has an unsupported offer terms version',p_publication_id;
  END IF;
  IF EXISTS (SELECT 1 FROM biplan.published_sessions s WHERE s.publication_id=p_publication_id
    AND s.eligibility_snapshot->>'offerTermsVersion'='1' AND (
      jsonb_typeof(s.eligibility_snapshot->'offers') IS DISTINCT FROM 'array'
      OR jsonb_typeof(s.eligibility_snapshot->'offerTerms') IS DISTINCT FROM 'array'
      OR jsonb_array_length(s.eligibility_snapshot->'offers')<>jsonb_array_length(s.eligibility_snapshot->'offerTerms')
      OR jsonb_array_length(s.eligibility_snapshot->'offerTerms')<>(SELECT count(*) FROM biplan.publication_offers p WHERE p.publication_id=s.publication_id AND p.session_id=s.session_id)
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(s.eligibility_snapshot->'offerTerms') t
        WHERE 1<>(SELECT count(*) FROM biplan.publication_offers p JOIN biplan.offer_revisions r ON r.id=p.offer_revision_id
          WHERE p.publication_id=s.publication_id AND p.session_id=s.session_id
            AND r.offer_id=t->>'offerId' AND r.id=t->>'revisionId' AND t=biplan.offer_revision_term(r.id)
            AND r.source_payload=(s.eligibility_snapshot->'offers')->(
              SELECT ordinality::integer-1 FROM jsonb_array_elements(s.eligibility_snapshot->'offerTerms') WITH ORDINALITY q(value,ordinality)
              WHERE q.value=t LIMIT 1)))
      OR EXISTS (SELECT 1 FROM biplan.publication_offers p JOIN biplan.offer_revisions r ON r.id=p.offer_revision_id
        WHERE p.publication_id=s.publication_id AND p.session_id=s.session_id AND 1<>(SELECT count(*)
          FROM jsonb_array_elements(s.eligibility_snapshot->'offerTerms') t
          WHERE t->>'offerId'=r.offer_id AND t->>'revisionId'=r.id))
    )) THEN RAISE EXCEPTION 'publication % typed offer projection does not exactly cover its pins',p_publication_id; END IF;
  IF EXISTS (SELECT 1 FROM biplan.published_sessions s WHERE s.publication_id=p_publication_id
    AND NOT (s.eligibility_snapshot ? 'offerTermsVersion') AND (
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.eligibility_snapshot->'offers')='array' THEN s.eligibility_snapshot->'offers' ELSE '[]'::jsonb END) o
        WHERE 1<>(SELECT count(*) FROM biplan.publication_offers p JOIN biplan.offer_revisions r ON r.id=p.offer_revision_id
          WHERE p.publication_id=s.publication_id AND p.session_id=s.session_id AND r.source_payload=o.value))
      OR EXISTS (SELECT 1 FROM biplan.publication_offers p JOIN biplan.offer_revisions r ON r.id=p.offer_revision_id
        WHERE p.publication_id=s.publication_id AND p.session_id=s.session_id AND NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.eligibility_snapshot->'offers')='array' THEN s.eligibility_snapshot->'offers' ELSE '[]'::jsonb END) o
          WHERE o.value=r.source_payload))
    )) THEN RAISE EXCEPTION 'publication % offer pins do not exactly cover its snapshots',p_publication_id; END IF;
  IF publication.manifest?'requiredOfferCount' THEN
    required_count:=(publication.manifest->>'requiredOfferCount')::integer;
    SELECT count(*) INTO actual_count FROM biplan.publication_offers WHERE publication_id=p_publication_id;
    IF required_count<0 OR actual_count<>required_count THEN RAISE EXCEPTION 'publication % integrity failed: offers %/%',p_publication_id,actual_count,required_count; END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION biplan.refresh_publication_request(
  p_request_id text,p_worker_id text,p_fence bigint,p_expected_base_publication_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE req biplan.publication_refresh_requests%ROWTYPE; active_id text; v_session_id text; target_id text;
  old_snapshot biplan.published_sessions%ROWTYPE; new_snapshot jsonb; terms jsonb; raw_offers jsonb;
  captured_heads jsonb; v_manifest jsonb; v_manifest_hash text; required_eval_count integer; receipt jsonb; offer_summary jsonb;
  invalidated_evaluations jsonb;
BEGIN
  IF p_request_id IS NULL OR p_worker_id IS NULL OR btrim(p_worker_id)='' OR p_fence IS NULL OR p_expected_base_publication_id IS NULL THEN
    RAISE EXCEPTION 'invalid publication refresh completion';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('biplan.active_publication',0));
  SELECT * INTO req FROM biplan.publication_refresh_requests WHERE id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'publication refresh request % does not exist',p_request_id; END IF;
  IF req.state='completed' AND req.fencing_token=p_fence AND EXISTS (
    SELECT 1 FROM biplan.publication_refresh_attempts WHERE request_id=p_request_id AND fencing_token=p_fence
      AND worker_id=p_worker_id AND outcome='completed') THEN
    RETURN req.checkpoint||jsonb_build_object('idempotent',true);
  END IF;
  IF req.state<>'processing' OR req.lease_owner<>p_worker_id OR req.fencing_token<>p_fence OR req.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'stale or invalid publication refresh completion for % at fence %',p_request_id,p_fence;
  END IF;
  SELECT publication_id INTO active_id FROM biplan.active_publication WHERE singleton FOR UPDATE;
  IF active_id IS DISTINCT FROM p_expected_base_publication_id THEN RAISE EXCEPTION 'active publication guard failed: expected %, found %',p_expected_base_publication_id,active_id; END IF;
  -- Acceptance locks an identity row before updating it. A table SHARE lock here avoids
  -- the inverse row-lock ordering while preventing inserts or head changes through activation.
  LOCK TABLE biplan.offer_identities IN SHARE MODE;
  SELECT r.session_id INTO v_session_id FROM biplan.offer_revisions r WHERE r.id=req.offer_revision_id AND r.offer_id=req.offer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'refresh request has a missing offer revision'; END IF;
  PERFORM 1 FROM biplan.sessions s WHERE s.id=v_session_id AND s.status<>'canceled' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'affected canonical session is missing or canceled'; END IF;
  SELECT * INTO old_snapshot FROM biplan.published_sessions WHERE publication_id=active_id AND session_id=v_session_id;
  IF NOT FOUND THEN
    UPDATE biplan.publication_refresh_attempts SET finished_at=clock_timestamp(),outcome='blocked',error=jsonb_build_object('code','missing_published_session','retryable',false)
      WHERE request_id=req.id AND fencing_token=p_fence AND worker_id=p_worker_id AND finished_at IS NULL;
    UPDATE biplan.publication_refresh_requests SET state='blocked',lease_owner=NULL,lease_expires_at=NULL,
      last_error=jsonb_build_object('code','missing_published_session','retryable',false),base_publication_id=active_id WHERE id=req.id;
    RETURN jsonb_build_object('status','blocked','code','missing_published_session','requestId',req.id);
  END IF;
  IF EXISTS (SELECT 1 FROM biplan.offer_identities i LEFT JOIN biplan.offer_revisions r
    ON r.id=i.current_revision_id AND r.offer_id=i.id AND r.session_id=i.session_id AND r.acceptance_status='accepted'
    WHERE i.session_id=v_session_id AND r.id IS NULL) THEN RAISE EXCEPTION 'affected session has a missing or invalid current offer head'; END IF;
  IF EXISTS (SELECT 1 FROM biplan.sessions s WHERE s.id=v_session_id AND
    (s.production_id<>old_snapshot.production_id OR s.venue_id IS DISTINCT FROM old_snapshot.venue_id
      OR s.status<>'scheduled'
      OR (old_snapshot.eligibility_snapshot->>'startsAt')::timestamptz IS DISTINCT FROM s.starts_at
      OR NULLIF(old_snapshot.eligibility_snapshot->'attendanceTiming','null'::jsonb) IS DISTINCT FROM NULLIF(s.attendance_timing,'null'::jsonb))) THEN
    RAISE EXCEPTION 'affected canonical session identity changed outside offer refresh';
  END IF;
  SELECT jsonb_agg(r.source_payload ORDER BY i.id),jsonb_agg(biplan.offer_revision_term(r.id) ORDER BY i.id),
    jsonb_object_agg(i.id,r.id ORDER BY i.id)
  INTO raw_offers,terms,captured_heads FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
  WHERE i.session_id=v_session_id;
  new_snapshot:=jsonb_set(jsonb_set(old_snapshot.eligibility_snapshot,'{offers}',COALESCE(raw_offers,'[]'::jsonb),true),
    '{offerTerms}',COALESCE(terms,'[]'::jsonb),true);
  new_snapshot:=jsonb_set(new_snapshot,'{offerTermsVersion}','1'::jsonb,true);
  SELECT jsonb_build_object(
    'availability',CASE WHEN bool_or(eligible AND r.availability IN ('available','limited')) THEN 'available'
      WHEN bool_and(fresh_valid AND r.availability IN ('sold_out','unavailable')) THEN 'unavailable' ELSE 'unknown' END,
    'currency',CASE WHEN count(*) FILTER (WHERE eligible)>0 THEN 'TRY' ELSE NULL END,
    'displayPrice',min(r.price_minor) FILTER (WHERE eligible)/100.0,
    'displayPriceMinor',(min(r.price_minor) FILTER (WHERE eligible))::text,
    'verifiedTotalMinor',(min(r.price_minor::numeric+r.fee_minor::numeric) FILTER (WHERE eligible AND r.fee_minor IS NOT NULL AND r.price_kind='exact'))::text,
    'verifiedTotalEligible',count(*) FILTER (WHERE eligible AND r.fee_minor IS NOT NULL AND r.price_kind='exact')>0,
    'displayPriceIsHardBudgetTotal',false,
    'sourceUrl',(array_agg(r.source_url ORDER BY r.price_minor,r.id) FILTER (WHERE eligible))[1])
  INTO offer_summary FROM (
    SELECT r.*,r.currency='TRY' AND r.price_minor IS NOT NULL
      AND (r.price IS NULL OR r.price*100=r.price_minor) AND r.price_kind<>'unknown'
      AND r.availability IN ('available','limited') AND r.observed_at<=clock_timestamp()
      AND r.observed_at>=clock_timestamp()-interval '3 days'
      AND (r.valid_from IS NULL OR r.valid_from<=clock_timestamp()) AND (r.valid_until IS NULL OR r.valid_until>=clock_timestamp()) eligible,
      r.observed_at<=clock_timestamp() AND r.observed_at>=clock_timestamp()-interval '3 days'
      AND (r.valid_from IS NULL OR r.valid_from<=clock_timestamp()) AND (r.valid_until IS NULL OR r.valid_until>=clock_timestamp()) fresh_valid
    FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id WHERE i.session_id=v_session_id
  ) r;
  new_snapshot:=jsonb_set(new_snapshot,'{offerSummary}',offer_summary,true);
  -- Legacy convenience fields are refreshed conservatively from the same eligible
  -- typed facts; they never retain a cheaper stale or sold-out offer.
  new_snapshot:=jsonb_set(new_snapshot,'{price}',COALESCE(offer_summary->'displayPrice','null'::jsonb),true);
  new_snapshot:=jsonb_set(new_snapshot,'{currency}',COALESCE(offer_summary->'currency','null'::jsonb),true);
  new_snapshot:=jsonb_set(new_snapshot,'{availability}',offer_summary->'availability',true);
  new_snapshot:=jsonb_set(new_snapshot,'{url}',COALESCE(offer_summary->'sourceUrl','null'::jsonb),true);

  -- If a prior request already published every captured head, complete this request without creating another generation.
  IF NOT EXISTS (SELECT 1 FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
    LEFT JOIN biplan.publication_offers p ON p.publication_id=active_id AND p.session_id=v_session_id AND p.offer_revision_id=r.id
    WHERE i.session_id=v_session_id AND p.offer_revision_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM biplan.publication_offers p JOIN biplan.offer_revisions r ON r.id=p.offer_revision_id
      LEFT JOIN biplan.offer_identities i ON i.id=r.offer_id AND i.session_id=v_session_id AND i.current_revision_id=r.id
      WHERE p.publication_id=active_id AND p.session_id=v_session_id AND i.id IS NULL)
    AND old_snapshot.eligibility_snapshot IS NOT DISTINCT FROM new_snapshot THEN target_id:=active_id;
  ELSE
    target_id:='publication-refresh:'||req.id;
    SELECT COALESCE(jsonb_agg(e.id ORDER BY e.id),'[]'::jsonb) INTO invalidated_evaluations
    FROM biplan.publication_evaluations pe JOIN biplan.evaluations e ON e.id=pe.evaluation_id
    WHERE pe.publication_id=active_id AND e.status='complete'
      AND (e.evaluation_type ILIKE '%price%' OR e.evaluation_type ILIKE '%value%' OR e.evaluation_type ILIKE '%compar%');
    SELECT count(*) INTO required_eval_count FROM biplan.publication_evaluations pe JOIN biplan.evaluations e ON e.id=pe.evaluation_id
    WHERE pe.publication_id=active_id AND NOT (e.status='complete'
      AND (e.evaluation_type ILIKE '%price%' OR e.evaluation_type ILIKE '%value%' OR e.evaluation_type ILIKE '%compar%'));
    v_manifest:=jsonb_build_object('schemaVersion',4,'kind','incremental-publication-refresh','basePublicationId',active_id,
      'requestId',req.id,'affectedSessionId',v_session_id,'capturedOfferHeads',captured_heads,
      'requiredOfferCount',(SELECT count(*) FROM biplan.publication_offers WHERE publication_id=active_id)
        -(SELECT count(*) FROM biplan.publication_offers WHERE publication_id=active_id AND session_id=v_session_id)
        +(SELECT count(*) FROM biplan.offer_identities WHERE session_id=v_session_id),
      'requiredEvaluationCount',required_eval_count,'invalidatedEvaluationIds',invalidated_evaluations,
      'evaluationInvalidationReason','offer_terms_changed_dependency_unknown');
    v_manifest_hash:=md5(v_manifest::text);
    INSERT INTO biplan.publications(id,state,manifest,manifest_hash,required_session_count,required_document_count,required_embedding_profile)
    SELECT target_id,'candidate',v_manifest,v_manifest_hash,base.required_session_count,base.required_document_count,base.required_embedding_profile
    FROM biplan.publications base WHERE base.id=active_id;
    INSERT INTO biplan.published_sessions
    SELECT target_id,session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot
    FROM biplan.published_sessions WHERE publication_id=active_id AND session_id<>v_session_id;
    INSERT INTO biplan.published_sessions(publication_id,session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot)
    VALUES(target_id,v_session_id,old_snapshot.production_id,old_snapshot.venue_id,old_snapshot.search_document_id,md5(new_snapshot::text),new_snapshot);
    INSERT INTO biplan.publication_offers SELECT target_id,session_id,offer_revision_id FROM biplan.publication_offers
      WHERE publication_id=active_id AND session_id<>v_session_id;
    INSERT INTO biplan.publication_offers(publication_id,session_id,offer_revision_id)
      SELECT target_id,v_session_id,current_revision_id FROM biplan.offer_identities WHERE session_id=v_session_id ORDER BY id;
    -- Pending/general evaluations remain pinned; completed price/value comparisons
    -- with unknown cohort dependencies are invalidated without delaying critical facts.
    INSERT INTO biplan.publication_evaluations
      SELECT target_id,pe.evaluation_id FROM biplan.publication_evaluations pe JOIN biplan.evaluations e ON e.id=pe.evaluation_id
      WHERE pe.publication_id=active_id AND NOT (e.status='complete'
        AND (e.evaluation_type ILIKE '%price%' OR e.evaluation_type ILIKE '%value%' OR e.evaluation_type ILIKE '%compar%'));
    PERFORM biplan.validate_publication_offers(target_id);
    UPDATE biplan.publications SET state='validated',validated_at=clock_timestamp(),validation_hash=md5((v_manifest||jsonb_build_object('validated',true))::text)
      WHERE id=target_id;
    -- Recheck every captured affected-session head immediately before the guarded switch.
    IF EXISTS (SELECT 1 FROM jsonb_each_text(captured_heads) h JOIN biplan.offer_identities i ON i.id=h.key
      WHERE i.current_revision_id IS DISTINCT FROM h.value) THEN RAISE EXCEPTION 'affected session current offer heads changed during refresh'; END IF;
    IF NOT EXISTS (SELECT 1 FROM biplan.publication_refresh_requests
      WHERE id=req.id AND state='processing' AND lease_owner=p_worker_id AND fencing_token=p_fence
        AND lease_expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'publication refresh lease expired before activation'; END IF;
    PERFORM biplan.activate_publication(target_id,active_id);
  END IF;
  receipt:=jsonb_build_object('status','completed','requestId',req.id,'basePublicationId',active_id,
    'resultPublicationId',target_id,'affectedSessionId',v_session_id,'capturedOfferHeads',captured_heads,'idempotent',false,
    'workerId',p_worker_id,'fencingToken',p_fence);
  UPDATE biplan.publication_refresh_attempts SET finished_at=clock_timestamp(),outcome='completed',checkpoint=receipt,result_publication_id=target_id
    WHERE request_id=req.id AND fencing_token=p_fence AND worker_id=p_worker_id AND finished_at IS NULL
      AND EXISTS (SELECT 1 FROM biplan.publication_refresh_requests r WHERE r.id=req.id AND r.state='processing'
        AND r.lease_owner=p_worker_id AND r.fencing_token=p_fence AND r.lease_expires_at>clock_timestamp());
  IF NOT FOUND THEN RAISE EXCEPTION 'missing active publication refresh attempt'; END IF;
  UPDATE biplan.publication_refresh_requests SET state='completed',lease_owner=NULL,lease_expires_at=NULL,checkpoint=receipt,
    base_publication_id=active_id,result_publication_id=target_id,completed_at=clock_timestamp(),last_error=NULL WHERE id=req.id;
  RETURN receipt;
END $$;

INSERT INTO biplan.schema_migrations(version,migration_hash)
VALUES('004-publication-refresh','004-publication-refresh-v1') ON CONFLICT(version) DO NOTHING;

COMMIT;
