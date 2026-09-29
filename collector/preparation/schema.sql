BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS biplan;

CREATE TABLE IF NOT EXISTS biplan.schema_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  installed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $migration$
DECLARE current_version integer;
BEGIN
  SELECT schema_version INTO current_version
  FROM biplan.schema_metadata WHERE singleton;
  IF current_version IS NULL THEN
    INSERT INTO biplan.schema_metadata(singleton, schema_version) VALUES (true, 1);
  ELSIF current_version <> 1 THEN
    RAISE EXCEPTION 'incompatible biplan schema version: expected 1, found %', current_version;
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS biplan.works (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (btrim(title) <> ''),
  original_title text,
  work_type text,
  synopsis text,
  language_code text,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS biplan.productions (
  id text PRIMARY KEY,
  work_id text REFERENCES biplan.works(id),
  title text NOT NULL CHECK (btrim(title) <> ''),
  production_type text,
  synopsis text,
  language_code text,
  canonical_production_key text,
  identity_basis text,
  status text NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown','announced','active','paused','ended','canceled')),
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE biplan.productions ADD COLUMN IF NOT EXISTS canonical_production_key text;
ALTER TABLE biplan.productions ADD COLUMN IF NOT EXISTS identity_basis text;

CREATE TABLE IF NOT EXISTS biplan.venues (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (btrim(name) <> ''),
  address_text text,
  district text,
  neighborhood text,
  country_code text,
  location geography(Point, 4326),
  location_precision text NOT NULL DEFAULT 'unknown'
    CHECK (location_precision IN ('unknown','country','city','district','neighborhood','address','entrance')),
  location_evidence_claim_id text,
  identity_basis text,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE biplan.venues ADD COLUMN IF NOT EXISTS identity_basis text;
CREATE INDEX IF NOT EXISTS venues_location_gix ON biplan.venues USING gist(location);
CREATE INDEX IF NOT EXISTS venues_name_trgm_idx ON biplan.venues USING gin(name gin_trgm_ops);

CREATE TABLE IF NOT EXISTS biplan.sessions (
  id text PRIMARY KEY,
  production_id text NOT NULL REFERENCES biplan.productions(id),
  venue_id text REFERENCES biplan.venues(id),
  starts_at timestamptz,
  ends_at timestamptz,
  admission_starts_at timestamptz,
  admission_ends_at timestamptz,
  timezone text NOT NULL DEFAULT 'Europe/Istanbul',
  status text NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown','scheduled','postponed','canceled','completed')),
  attendance_policy text,
  attendance_timing jsonb,
  source_session_ids text[] NOT NULL DEFAULT '{}',
  availability text NOT NULL DEFAULT 'unknown',
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at),
  CHECK (admission_ends_at IS NULL OR admission_starts_at IS NULL OR admission_ends_at >= admission_starts_at)
);
ALTER TABLE biplan.sessions ADD COLUMN IF NOT EXISTS attendance_timing jsonb;
ALTER TABLE biplan.sessions ADD COLUMN IF NOT EXISTS source_session_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE biplan.sessions ADD COLUMN IF NOT EXISTS availability text NOT NULL DEFAULT 'unknown';
CREATE INDEX IF NOT EXISTS sessions_eligibility_idx ON biplan.sessions(status, starts_at, admission_ends_at);

CREATE TABLE IF NOT EXISTS biplan.people (
  id text PRIMARY KEY,
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS biplan.organizations (
  id text PRIMARY KEY,
  display_name text NOT NULL CHECK (btrim(display_name) <> ''),
  organization_type text,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS biplan.production_people (
  production_id text NOT NULL REFERENCES biplan.productions(id),
  person_id text NOT NULL REFERENCES biplan.people(id),
  role_type text NOT NULL CHECK (btrim(role_type) <> ''),
  role_detail text,
  evidence_claim_id text,
  PRIMARY KEY (production_id, person_id, role_type)
);
CREATE TABLE IF NOT EXISTS biplan.production_organizations (
  production_id text NOT NULL REFERENCES biplan.productions(id),
  organization_id text NOT NULL REFERENCES biplan.organizations(id),
  role_type text NOT NULL CHECK (btrim(role_type) <> ''),
  evidence_claim_id text,
  PRIMARY KEY (production_id, organization_id, role_type)
);

CREATE TABLE IF NOT EXISTS biplan.provider_offers (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES biplan.sessions(id),
  provider text NOT NULL CHECK (btrim(provider) <> ''),
  provider_record_id text NOT NULL CHECK (btrim(provider_record_id) <> ''),
  source_session_ids text[] NOT NULL DEFAULT '{}',
  provider_session_id text,
  source_url text,
  ticket_tier_id text,
  ticket_tier_name text,
  currency text,
  price numeric CHECK (price IS NULL OR price >= 0),
  price_minor bigint CHECK (price_minor IS NULL OR price_minor >= 0),
  fee_minor bigint CHECK (fee_minor IS NULL OR fee_minor >= 0),
  price_kind text NOT NULL DEFAULT 'unknown'
    CHECK (price_kind IN ('unknown','exact','starting_at','range')),
  availability text NOT NULL DEFAULT 'unknown'
    CHECK (availability IN ('unknown','available','limited','sold_out','unavailable')),
  observed_at timestamptz NOT NULL,
  source_updated_at timestamptz,
  valid_from timestamptz,
  valid_until timestamptz,
  content_hash text NOT NULL,
  source_payload jsonb NOT NULL CHECK (jsonb_typeof(source_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);
ALTER TABLE biplan.provider_offers ADD COLUMN IF NOT EXISTS source_session_ids text[] NOT NULL DEFAULT '{}';
ALTER TABLE biplan.provider_offers ADD COLUMN IF NOT EXISTS price numeric;
CREATE UNIQUE INDEX IF NOT EXISTS provider_offers_source_identity_idx
  ON biplan.provider_offers(provider, provider_record_id, COALESCE(ticket_tier_id, ''));
CREATE INDEX IF NOT EXISTS provider_offers_session_idx ON biplan.provider_offers(session_id);

CREATE TABLE IF NOT EXISTS biplan.source_observations (
  id text PRIMARY KEY,
  source_name text NOT NULL,
  source_record_id text NOT NULL,
  source_url text,
  subject_type text,
  subject_id text,
  content_hash text NOT NULL,
  observed_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  source_updated_at timestamptz,
  effective_from timestamptz,
  effective_until timestamptz,
  refresh_status text NOT NULL DEFAULT 'current'
    CHECK (refresh_status IN ('current','stale','failed','retired','quarantined','unknown')),
  raw_object_uri text,
  raw_payload jsonb CHECK (raw_payload IS NULL OR jsonb_typeof(raw_payload) IN ('object','array')),
  UNIQUE(source_name, source_record_id, content_hash),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until >= effective_from)
);

CREATE TABLE IF NOT EXISTS biplan.source_claims (
  id text PRIMARY KEY,
  observation_id text REFERENCES biplan.source_observations(id),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  field_name text NOT NULL,
  value_json jsonb,
  claim_status text NOT NULL DEFAULT 'supported'
    CHECK (claim_status IN ('supported','conflicting','disputed','withdrawn','unknown','stale')),
  evidence_class text NOT NULL DEFAULT 'unknown',
  effective_from timestamptz,
  effective_until timestamptz,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(subject_type, subject_id, field_name, content_hash),
  CHECK (effective_until IS NULL OR effective_from IS NULL OR effective_until >= effective_from)
);
CREATE TABLE IF NOT EXISTS biplan.claim_evidence (
  claim_id text NOT NULL REFERENCES biplan.source_claims(id),
  observation_id text NOT NULL REFERENCES biplan.source_observations(id),
  PRIMARY KEY (claim_id, observation_id)
);

CREATE TABLE IF NOT EXISTS biplan.evaluations (
  id text PRIMARY KEY,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  evaluation_type text NOT NULL,
  status text NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown','pending','complete','failed','stale','disputed')),
  components jsonb CHECK (components IS NULL OR jsonb_typeof(components) = 'object'),
  evidence_sufficiency jsonb CHECK (evidence_sufficiency IS NULL OR jsonb_typeof(evidence_sufficiency) = 'object'),
  model_confidence double precision CHECK (model_confidence IS NULL OR model_confidence BETWEEN 0 AND 1),
  evidence_claim_ids text[] NOT NULL DEFAULT '{}',
  rubric_version text,
  model_version text,
  input_hash text,
  cohort_hash text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE NULLS NOT DISTINCT (subject_type, subject_id, evaluation_type, rubric_version, input_hash)
);

CREATE TABLE IF NOT EXISTS biplan.promotions (
  id text PRIMARY KEY,
  sponsor_organization_id text REFERENCES biplan.organizations(id),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('unknown','active','expired','withdrawn','unsupported')),
  eligibility_rule jsonb NOT NULL CHECK (jsonb_typeof(eligibility_rule) = 'object' AND eligibility_rule ? 'type'),
  applicability_rule jsonb NOT NULL CHECK (jsonb_typeof(applicability_rule) = 'object' AND applicability_rule ? 'type'),
  benefit_rule jsonb NOT NULL CHECK (jsonb_typeof(benefit_rule) = 'object' AND benefit_rule ? 'type'),
  stacking_rule jsonb NOT NULL CHECK (jsonb_typeof(stacking_rule) = 'object' AND stacking_rule ? 'type'),
  rule_version text NOT NULL,
  purchase_channel text,
  redemption_instructions text,
  valid_from timestamptz,
  valid_until timestamptz,
  observed_at timestamptz NOT NULL,
  source_observation_id text NOT NULL REFERENCES biplan.source_observations(id),
  content_hash text NOT NULL,
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from)
);
CREATE TABLE IF NOT EXISTS biplan.promotion_targets (
  promotion_id text NOT NULL REFERENCES biplan.promotions(id),
  target_type text NOT NULL CHECK (target_type IN ('provider','offer','session','production','venue')),
  target_id text NOT NULL,
  PRIMARY KEY (promotion_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS biplan.search_documents (
  id text PRIMARY KEY,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  document_profile text NOT NULL,
  embedding_profile text,
  document_text text NOT NULL,
  document_hash text NOT NULL,
  dependency_hash text NOT NULL,
  embedding vector(1024),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(subject_type, subject_id, document_profile, document_hash),
  CHECK ((embedding IS NULL) = (embedding_profile IS NULL))
);
CREATE INDEX IF NOT EXISTS search_documents_text_idx ON biplan.search_documents
  USING gin(to_tsvector('simple', document_text));
CREATE INDEX IF NOT EXISTS search_documents_subject_idx ON biplan.search_documents(subject_type, subject_id);

CREATE TABLE IF NOT EXISTS biplan.publications (
  id text PRIMARY KEY,
  state text NOT NULL DEFAULT 'candidate'
    CHECK (state IN ('candidate','validated','active','superseded','invalid')),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  manifest_hash text NOT NULL UNIQUE,
  required_session_count integer NOT NULL CHECK (required_session_count >= 0),
  required_document_count integer NOT NULL CHECK (required_document_count >= 0),
  required_embedding_profile text,
  validated_at timestamptz,
  validation_hash text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  activated_at timestamptz
);
CREATE TABLE IF NOT EXISTS biplan.published_sessions (
  publication_id text NOT NULL REFERENCES biplan.publications(id),
  session_id text NOT NULL REFERENCES biplan.sessions(id),
  production_id text NOT NULL REFERENCES biplan.productions(id),
  venue_id text REFERENCES biplan.venues(id),
  search_document_id text REFERENCES biplan.search_documents(id),
  snapshot_hash text NOT NULL,
  eligibility_snapshot jsonb NOT NULL CHECK (jsonb_typeof(eligibility_snapshot) = 'object'),
  PRIMARY KEY (publication_id, session_id)
);
CREATE TABLE IF NOT EXISTS biplan.publication_evaluations (
  publication_id text NOT NULL REFERENCES biplan.publications(id),
  evaluation_id text NOT NULL REFERENCES biplan.evaluations(id),
  PRIMARY KEY (publication_id, evaluation_id)
);
CREATE TABLE IF NOT EXISTS biplan.active_publication (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  publication_id text NOT NULL REFERENCES biplan.publications(id),
  previous_publication_id text REFERENCES biplan.publications(id),
  switched_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION biplan.reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME; END $$;
CREATE OR REPLACE FUNCTION biplan.protect_publication_manifest() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.manifest IS DISTINCT FROM OLD.manifest
     OR NEW.manifest_hash IS DISTINCT FROM OLD.manifest_hash
     OR NEW.required_session_count IS DISTINCT FROM OLD.required_session_count
     OR NEW.required_document_count IS DISTINCT FROM OLD.required_document_count
     OR NEW.required_embedding_profile IS DISTINCT FROM OLD.required_embedding_profile
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'publication manifest fields are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER publications_immutable_delete BEFORE DELETE ON biplan.publications
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();
CREATE OR REPLACE TRIGGER publications_manifest_immutable BEFORE UPDATE ON biplan.publications
FOR EACH ROW EXECUTE FUNCTION biplan.protect_publication_manifest();
CREATE OR REPLACE TRIGGER published_sessions_immutable BEFORE UPDATE OR DELETE ON biplan.published_sessions
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();
CREATE OR REPLACE FUNCTION biplan.protect_validated_publication_rows() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM biplan.publications WHERE id = NEW.publication_id AND state <> 'candidate') THEN
    RAISE EXCEPTION 'cannot append rows to non-candidate publication %', NEW.publication_id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER published_sessions_candidate_only BEFORE INSERT ON biplan.published_sessions
FOR EACH ROW EXECUTE FUNCTION biplan.protect_validated_publication_rows();
CREATE OR REPLACE TRIGGER publication_evaluations_immutable BEFORE UPDATE OR DELETE ON biplan.publication_evaluations
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();
CREATE OR REPLACE TRIGGER publication_evaluations_candidate_only BEFORE INSERT ON biplan.publication_evaluations
FOR EACH ROW EXECUTE FUNCTION biplan.protect_validated_publication_rows();
CREATE OR REPLACE TRIGGER search_documents_immutable BEFORE UPDATE OR DELETE ON biplan.search_documents
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();

CREATE TABLE IF NOT EXISTS biplan.preparation_jobs (
  id text PRIMARY KEY,
  stage text NOT NULL,
  stage_version text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  input_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','leased','succeeded','failed','uncertain','canceled')),
  priority integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  checkpoint jsonb,
  last_error jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(stage, stage_version, subject_type, subject_id, input_hash),
  CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS preparation_jobs_claim_idx
  ON biplan.preparation_jobs(state, available_at, priority DESC, created_at);
CREATE TABLE IF NOT EXISTS biplan.job_attempts (
  job_id text NOT NULL REFERENCES biplan.preparation_jobs(id),
  fencing_token bigint NOT NULL,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  outcome text CHECK (outcome IS NULL OR outcome IN ('succeeded','failed','uncertain','stale')),
  cost_units numeric CHECK (cost_units IS NULL OR cost_units >= 0),
  external_request_id text,
  details jsonb,
  PRIMARY KEY (job_id, fencing_token)
);
CREATE TABLE IF NOT EXISTS biplan.outbox (
  id text PRIMARY KEY,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','delivered','failed')),
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  delivered_at timestamptz,
  CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE OR REPLACE FUNCTION biplan.activate_publication(
  candidate_id text, expected_previous_id text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE candidate biplan.publications%ROWTYPE; current_id text; session_count integer; document_count integer;
  required_evaluation_count integer; evaluation_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('biplan.active_publication', 0));
  SELECT publication_id INTO current_id FROM biplan.active_publication WHERE singleton FOR UPDATE;
  IF current_id IS DISTINCT FROM expected_previous_id THEN
    RAISE EXCEPTION 'active publication guard failed: expected %, found %', expected_previous_id, current_id;
  END IF;
  SELECT * INTO candidate FROM biplan.publications WHERE id = candidate_id FOR UPDATE;
  IF NOT FOUND OR candidate.state <> 'validated' OR candidate.validated_at IS NULL OR candidate.validation_hash IS NULL THEN
    RAISE EXCEPTION 'publication % is not validated', candidate_id;
  END IF;
  SELECT count(*), count(search_document_id) INTO session_count, document_count
  FROM biplan.published_sessions WHERE publication_id = candidate_id;
  IF session_count <> candidate.required_session_count OR document_count <> candidate.required_document_count THEN
    RAISE EXCEPTION 'publication % integrity failed: sessions %/%, documents %/%', candidate_id,
      session_count, candidate.required_session_count, document_count, candidate.required_document_count;
  END IF;
  IF candidate.required_embedding_profile IS NOT NULL AND EXISTS (
    SELECT 1 FROM biplan.published_sessions ps
    JOIN biplan.search_documents sd ON sd.id = ps.search_document_id
    WHERE ps.publication_id = candidate_id AND sd.embedding IS NOT NULL
      AND sd.embedding_profile IS DISTINCT FROM candidate.required_embedding_profile
  ) THEN RAISE EXCEPTION 'publication % mixes an incompatible embedding profile', candidate_id; END IF;
  IF candidate.manifest ? 'requiredEvaluationCount' THEN
    required_evaluation_count := (candidate.manifest->>'requiredEvaluationCount')::integer;
    IF required_evaluation_count < 0 THEN
      RAISE EXCEPTION 'publication % has a negative required evaluation count', candidate_id;
    END IF;
    SELECT count(*) INTO evaluation_count
    FROM biplan.publication_evaluations WHERE publication_id = candidate_id;
    IF evaluation_count <> required_evaluation_count THEN
      RAISE EXCEPTION 'publication % integrity failed: evaluations %/%', candidate_id,
        evaluation_count, required_evaluation_count;
    END IF;
  END IF;
  IF EXISTS (
    SELECT 1 FROM biplan.published_sessions ps
    LEFT JOIN biplan.sessions s ON s.id = ps.session_id
    LEFT JOIN biplan.productions p ON p.id = ps.production_id
    WHERE ps.publication_id = candidate_id AND (s.id IS NULL OR p.id IS NULL OR s.status = 'canceled')
  ) THEN RAISE EXCEPTION 'publication % contains missing or canceled mandatory records', candidate_id; END IF;
  IF current_id IS NOT NULL THEN UPDATE biplan.publications SET state = 'superseded' WHERE id = current_id; END IF;
  UPDATE biplan.publications SET state = 'active', activated_at = clock_timestamp() WHERE id = candidate_id;
  INSERT INTO biplan.active_publication(singleton, publication_id, previous_publication_id, switched_at)
  VALUES (true, candidate_id, current_id, clock_timestamp())
  ON CONFLICT (singleton) DO UPDATE SET publication_id = EXCLUDED.publication_id,
    previous_publication_id = EXCLUDED.previous_publication_id, switched_at = EXCLUDED.switched_at;
END $$;

CREATE OR REPLACE FUNCTION biplan.claim_preparation_jobs(
  worker_id text, batch_limit integer, lease_for interval DEFAULT interval '5 minutes'
) RETURNS SETOF biplan.preparation_jobs LANGUAGE plpgsql AS $$
BEGIN
  IF btrim(worker_id) = '' OR batch_limit < 1 OR batch_limit > 100 OR lease_for <= interval '0 seconds' THEN
    RAISE EXCEPTION 'invalid bounded lease request';
  END IF;
  RETURN QUERY
  WITH candidates AS (
    SELECT id FROM biplan.preparation_jobs
    WHERE attempt_count < max_attempts AND available_at <= clock_timestamp()
      AND (state = 'pending' OR (state = 'leased' AND lease_expires_at <= clock_timestamp()))
    ORDER BY priority DESC, created_at, id FOR UPDATE SKIP LOCKED LIMIT batch_limit
  ), updated AS (
  UPDATE biplan.preparation_jobs j SET state = 'leased', lease_owner = worker_id,
    lease_expires_at = clock_timestamp() + lease_for, fencing_token = j.fencing_token + 1,
    attempt_count = j.attempt_count + 1, updated_at = clock_timestamp()
  FROM candidates c WHERE j.id = c.id RETURNING j.*
  ), attempts AS (
    INSERT INTO biplan.job_attempts(job_id, fencing_token, attempt_number)
    SELECT id, fencing_token, attempt_count FROM updated
    RETURNING job_id
  )
  SELECT u.* FROM updated u JOIN attempts a ON a.job_id = u.id;
END $$;

CREATE OR REPLACE FUNCTION biplan.complete_preparation_job(
  p_job_id text, p_worker_id text, p_expected_fencing_token bigint, p_checkpoint jsonb DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE completed_count integer;
BEGIN
  UPDATE biplan.preparation_jobs
  SET state = 'succeeded', checkpoint = p_checkpoint, lease_owner = NULL,
      lease_expires_at = NULL, updated_at = clock_timestamp()
  WHERE id = p_job_id AND state = 'leased' AND lease_owner = p_worker_id
    AND fencing_token = p_expected_fencing_token AND lease_expires_at > clock_timestamp();
  GET DIAGNOSTICS completed_count = ROW_COUNT;
  IF completed_count <> 1 THEN
    RAISE EXCEPTION 'stale or invalid completion for preparation job % at fencing token %',
      p_job_id, p_expected_fencing_token;
  END IF;
  UPDATE biplan.job_attempts
  SET finished_at = clock_timestamp(), outcome = 'succeeded', details = p_checkpoint
  WHERE job_id = p_job_id AND fencing_token = p_expected_fencing_token;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'missing attempt record for preparation job % at fencing token %',
      p_job_id, p_expected_fencing_token;
  END IF;
END $$;

-- Thin import boundary. Callers own normalization and hashes; this only persists the
-- documented prepared bundle and remains safe to replay through primary/unique keys.
CREATE OR REPLACE FUNCTION biplan.ingest_prepared_payload(payload jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE item jsonb; inserted jsonb := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(payload) <> 'object' THEN RAISE EXCEPTION 'payload must be an object'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'works','[]'::jsonb)) LOOP
    INSERT INTO biplan.works(id,title,original_title,work_type,synopsis,language_code,content_hash)
    VALUES(item->>'id',item->>'title',item->>'originalTitle',item->>'workType',item->>'synopsis',item->>'languageCode',item->>'contentHash')
    ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, original_title=EXCLUDED.original_title,
      work_type=EXCLUDED.work_type, synopsis=EXCLUDED.synopsis, language_code=EXCLUDED.language_code,
      content_hash=EXCLUDED.content_hash, updated_at=clock_timestamp();
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'productions','[]'::jsonb)) LOOP
    INSERT INTO biplan.productions(id,work_id,title,production_type,synopsis,language_code,canonical_production_key,identity_basis,status,content_hash)
    VALUES(item->>'id',item->>'workId',COALESCE(item->>'title',item->>'canonicalProductionKey',item->>'id'),item->>'productionType',item->>'synopsis',item->>'languageCode',
      item->>'canonicalProductionKey',item->>'identityBasis',COALESCE(item->>'status','unknown'),COALESCE(item->>'contentHash',payload#>>'{inputProvenance,inputHash}',item->>'id'))
    ON CONFLICT (id) DO UPDATE SET work_id=EXCLUDED.work_id,title=EXCLUDED.title,production_type=EXCLUDED.production_type,
      synopsis=EXCLUDED.synopsis,language_code=EXCLUDED.language_code,canonical_production_key=EXCLUDED.canonical_production_key,
      identity_basis=EXCLUDED.identity_basis,status=EXCLUDED.status,content_hash=EXCLUDED.content_hash,updated_at=clock_timestamp();
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'venues','[]'::jsonb)) LOOP
    INSERT INTO biplan.venues(id,name,address_text,district,neighborhood,country_code,location,location_precision,identity_basis,content_hash)
    VALUES(item->>'id',item->>'name',COALESCE(item->>'addressText',item->>'address'),item->>'district',item->>'neighborhood',item->>'countryCode',
      CASE WHEN item ? 'longitude' AND item ? 'latitude' THEN ST_SetSRID(ST_MakePoint((item->>'longitude')::float8,(item->>'latitude')::float8),4326)::geography END,
      COALESCE(item->>'locationPrecision','unknown'),item->>'identityBasis',COALESCE(item->>'contentHash',payload#>>'{inputProvenance,inputHash}',item->>'id'))
    ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name,address_text=EXCLUDED.address_text,district=EXCLUDED.district,
      neighborhood=EXCLUDED.neighborhood,country_code=EXCLUDED.country_code,location=EXCLUDED.location,
      location_precision=EXCLUDED.location_precision,identity_basis=EXCLUDED.identity_basis,content_hash=EXCLUDED.content_hash,updated_at=clock_timestamp();
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'sessions','[]'::jsonb)) LOOP
    INSERT INTO biplan.sessions(id,production_id,venue_id,starts_at,ends_at,admission_starts_at,admission_ends_at,timezone,status,attendance_policy,attendance_timing,source_session_ids,availability,content_hash)
    VALUES(item->>'id',item->>'productionId',item->>'venueId',(item->>'startsAt')::timestamptz,(item->>'endsAt')::timestamptz,
      (item->>'admissionStartsAt')::timestamptz,(item->>'admissionEndsAt')::timestamptz,COALESCE(item->>'timezone','Europe/Istanbul'),
      CASE WHEN item->>'status' IN ('unknown','scheduled','postponed','canceled','completed') THEN item->>'status' ELSE 'scheduled' END,
      item->>'attendancePolicy',item->'attendanceTiming',ARRAY(SELECT jsonb_array_elements_text(COALESCE(item->'sourceSessionIds','[]'::jsonb))),
      COALESCE(item->>'availability','unknown'),COALESCE(item->>'contentHash',payload#>>'{inputProvenance,inputHash}',item->>'id'))
    ON CONFLICT (id) DO UPDATE SET production_id=EXCLUDED.production_id,venue_id=EXCLUDED.venue_id,starts_at=EXCLUDED.starts_at,
      ends_at=EXCLUDED.ends_at,admission_starts_at=EXCLUDED.admission_starts_at,admission_ends_at=EXCLUDED.admission_ends_at,
      timezone=EXCLUDED.timezone,status=EXCLUDED.status,attendance_policy=EXCLUDED.attendance_policy,attendance_timing=EXCLUDED.attendance_timing,
      source_session_ids=EXCLUDED.source_session_ids,availability=EXCLUDED.availability,content_hash=EXCLUDED.content_hash,updated_at=clock_timestamp();
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'providerOffers','[]'::jsonb)) LOOP
    IF EXISTS (
      SELECT 1 FROM biplan.provider_offers
      WHERE id = item->>'id'
        AND content_hash IS DISTINCT FROM COALESCE(item->>'contentHash',payload#>>'{inputProvenance,inputHash}',item->>'id')
    ) THEN RAISE EXCEPTION 'provider offer id % was reused with different content', item->>'id'; END IF;
    INSERT INTO biplan.provider_offers(id,session_id,provider,provider_record_id,source_session_ids,provider_session_id,source_url,ticket_tier_id,ticket_tier_name,currency,price,price_minor,fee_minor,price_kind,availability,observed_at,source_updated_at,valid_from,valid_until,content_hash,source_payload)
    VALUES(item->>'id',item->>'sessionId',COALESCE(item->>'provider',item->>'source','unknown'),
      COALESCE(item->>'providerRecordId',item->'sourceSessionIds'->>0,item->>'id'),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(item->'sourceSessionIds','[]'::jsonb))),item->>'providerSessionId',COALESCE(item->>'sourceUrl',item->>'url'),item->>'ticketTierId',item->>'ticketTierName',item->>'currency',
      (item->>'price')::numeric,(item->>'priceMinor')::bigint,(item->>'feeMinor')::bigint,COALESCE(item->>'priceKind',CASE WHEN item->'price' IS NULL THEN 'unknown' ELSE 'exact' END),COALESCE(item->>'availability','unknown'),
      COALESCE((item->>'observedAt')::timestamptz,(item->>'checkedAt')::timestamptz),(item->>'sourceUpdatedAt')::timestamptz,(item->>'validFrom')::timestamptz,(item->>'validUntil')::timestamptz,
      COALESCE(item->>'contentHash',payload#>>'{inputProvenance,inputHash}',item->>'id'),COALESCE(item->'sourcePayload',item->'raw','{}'::jsonb))
    ON CONFLICT (id) DO NOTHING;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'sourceObservations','[]'::jsonb)) LOOP
    IF EXISTS (
      SELECT 1 FROM biplan.source_observations
      WHERE id = item->>'id' AND content_hash IS DISTINCT FROM item->>'contentHash'
    ) THEN RAISE EXCEPTION 'source observation id % was reused with different content', item->>'id'; END IF;
    INSERT INTO biplan.source_observations(id,source_name,source_record_id,subject_type,subject_id,content_hash,observed_at,source_updated_at,refresh_status,raw_payload)
    VALUES(item->>'id',COALESCE(item->>'source','unknown'),item->>'sourceRecordId',item#>>'{subject,type}',item#>>'{subject,id}',item->>'contentHash',
      (item->>'observedAt')::timestamptz,(item->>'sourceUpdatedAt')::timestamptz,'current',item->'raw')
    ON CONFLICT (id) DO NOTHING;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'sourceClaims','[]'::jsonb)) LOOP
    INSERT INTO biplan.source_claims(id,observation_id,subject_type,subject_id,field_name,value_json,claim_status,effective_from,effective_until,content_hash)
    VALUES(item->>'id',item->'sourceObservationIds'->>0,item#>>'{subject,type}',item#>>'{subject,id}',item->>'field',item->'value',
      COALESCE(item->>'status','supported'),(item->>'validFrom')::timestamptz,(item->>'validThrough')::timestamptz,item->>'id')
    ON CONFLICT (id) DO NOTHING;
    INSERT INTO biplan.claim_evidence(claim_id,observation_id)
    SELECT item->>'id', value FROM jsonb_array_elements_text(COALESCE(item->'sourceObservationIds','[]'::jsonb))
    ON CONFLICT DO NOTHING;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'evaluations','[]'::jsonb)) LOOP
    INSERT INTO biplan.evaluations(id,subject_type,subject_id,evaluation_type,status,components,evidence_claim_ids,rubric_version,model_version,input_hash)
    VALUES(item->>'id',item#>>'{subject,type}',item#>>'{subject,id}',item->>'dimension',COALESCE(item->>'status','unknown'),
      jsonb_build_object('score',item->'score','components',COALESCE(item->'components','[]'::jsonb)),
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(item->'evidenceClaimIds','[]'::jsonb))),item->>'rubricVersion',item->>'modelVersion',item->>'inputHash')
    ON CONFLICT (id) DO NOTHING;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(payload->'documents','[]'::jsonb)) LOOP
    IF EXISTS (
      SELECT 1 FROM biplan.search_documents
      WHERE id = item->>'id'
        AND (document_hash IS DISTINCT FROM item->>'documentHash'
          OR dependency_hash IS DISTINCT FROM item->>'dependencyHash')
    ) THEN RAISE EXCEPTION 'search document id % was reused with different content', item->>'id'; END IF;
    INSERT INTO biplan.search_documents(id,subject_type,subject_id,document_profile,embedding_profile,document_text,document_hash,dependency_hash,embedding)
    VALUES(item->>'id',item->>'subjectType',item->>'subjectId',item->>'documentProfile',item->>'embeddingProfile',item->>'documentText',item->>'documentHash',item->>'dependencyHash',
      CASE WHEN item ? 'embedding' THEN (item->>'embedding')::vector(1024) END)
    ON CONFLICT (id) DO NOTHING;
  END LOOP;
  RETURN jsonb_build_object('accepted', true, 'summary', COALESCE(payload->'summary','{}'::jsonb));
END $$;

COMMIT;
