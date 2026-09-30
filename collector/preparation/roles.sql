-- EXPLICIT ADMINISTRATIVE STEP for a dedicated Bi' Plan database.
-- Not a migration: run only after reviewed schema migrations, using an administrator
-- able to transfer the existing objects to biplan_owner. Never run as an app login.
-- This script does not set or print passwords. Supply authentication separately via
-- the protected deployment secret/IAM workflow. Reapply after a reviewed migration;
-- newly added functions are deliberately inaccessible until explicitly allowlisted.
BEGIN;

DO $roles$
DECLARE name text; member_name text; parent_name text;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='006-batched-publication') THEN
    RAISE EXCEPTION 'roles require reviewed batch migration 006'; END IF;
  IF current_user IN ('biplan_owner','biplan_reader','biplan_prepare','biplan_web','biplan_preparer') THEN
    RAISE EXCEPTION 'role installation requires a separate administrator'; END IF;
  FOREACH name IN ARRAY ARRAY['biplan_owner','biplan_reader','biplan_prepare','biplan_web','biplan_preparer'] LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=name) THEN
      EXECUTE format('CREATE ROLE %I %s NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
        name,CASE WHEN name IN ('biplan_web','biplan_preparer') THEN 'LOGIN' ELSE 'NOLOGIN' END);
    END IF;
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=name AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
      OR rolcanlogin IS DISTINCT FROM (name IN ('biplan_web','biplan_preparer')))) THEN
      RAISE EXCEPTION 'existing role % has incompatible elevated attributes or login policy',name; END IF;
  END LOOP;
  FOR member_name,parent_name IN SELECT m.rolname,p.rolname FROM pg_auth_members a
    JOIN pg_roles m ON m.oid=a.member JOIN pg_roles p ON p.oid=a.roleid
    WHERE m.rolname IN ('biplan_owner','biplan_reader','biplan_prepare','biplan_web','biplan_preparer') LOOP
    IF NOT((member_name='biplan_web' AND parent_name='biplan_reader') OR
      (member_name='biplan_preparer' AND parent_name='biplan_prepare')) THEN
      RAISE EXCEPTION 'unexpected inherited role membership: % -> %',member_name,parent_name; END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_namespace n JOIN pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname<>'biplan' AND r.rolname IN ('biplan_owner','biplan_reader','biplan_prepare','biplan_web','biplan_preparer')) THEN
    RAISE EXCEPTION 'application role unexpectedly owns another schema'; END IF;
END $roles$;

GRANT biplan_reader TO biplan_web WITH ADMIN FALSE;
GRANT biplan_prepare TO biplan_preparer WITH ADMIN FALSE;
ALTER ROLE biplan_web SET search_path=pg_catalog,biplan,public;
ALTER ROLE biplan_preparer SET search_path=pg_catalog,biplan,public;
ALTER ROLE biplan_web SET default_transaction_read_only=on;
ALTER ROLE biplan_web SET statement_timeout='15s';
ALTER ROLE biplan_preparer SET statement_timeout='60s';

DO $database$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
    WHERE d.datname=current_database() AND r.rolname IN ('biplan_owner','biplan_reader','biplan_prepare','biplan_web','biplan_preparer')) THEN
    RAISE EXCEPTION 'database must remain owned by the separate administrator'; END IF;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC,biplan_reader,biplan_prepare,biplan_web,biplan_preparer',current_database());
  -- NOLOGIN owner needs CONNECT privilege for pg_database_size admission checks.
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO biplan_owner,biplan_web,biplan_preparer',current_database());
END $database$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC,biplan_reader,biplan_prepare,biplan_web,biplan_preparer;
GRANT USAGE ON SCHEMA public TO biplan_owner,biplan_reader,biplan_prepare;
ALTER SCHEMA biplan OWNER TO biplan_owner;
REVOKE ALL ON SCHEMA biplan FROM PUBLIC,biplan_reader,biplan_prepare,biplan_web,biplan_preparer;
GRANT USAGE ON SCHEMA biplan TO biplan_reader,biplan_prepare;
DO $trusted_paths$
BEGIN
  -- public is needed for extension types/operators. It is safe in a definer path
  -- only when no unrelated grantee can create overloads there (or in biplan).
  IF EXISTS(SELECT 1 FROM pg_namespace n
    CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
    WHERE n.nspname IN ('biplan','public') AND a.privilege_type='CREATE'
      AND a.grantee NOT IN (n.nspowner,(SELECT oid FROM pg_roles WHERE rolname=current_user))) THEN
    RAISE EXCEPTION 'definer search path contains a schema writable by an unrelated role'; END IF;
END $trusted_paths$;

-- Reject unreviewed objects instead of silently promoting a newly introduced API.
DO $objects$
DECLARE obj record;
  approved_tables text[]:=ARRAY['schema_metadata','schema_migrations','works','productions','venues','sessions','people','organizations',
    'production_people','production_organizations','provider_offers','source_observations','source_claims','claim_evidence','evaluations',
    'promotions','promotion_targets','search_documents','publications','published_sessions','publication_evaluations','active_publication',
    'preparation_jobs','job_attempts','outbox','offer_identities','offer_revisions','publication_offers','offer_derivations',
    'publication_refresh_requests','outbox_attempts','publication_refresh_attempts','canonical_requests','canonical_revisions',
    'canonical_heads','canonical_source_mappings','canonical_preparations','offer_occurrence_bindings','canonical_occurrence_disputes',
    'preparation_storage_limits','preparation_batches','preparation_batch_items','preparation_batch_sessions',
    'source_page_observations','source_page_heads','preparation_batch_pages','preparation_batch_page_sessions','publication_offer_evidence'];
  approved_functions text[]:=ARRAY['reject_immutable_mutation','protect_publication_manifest','protect_validated_publication_rows',
    'activate_publication','claim_preparation_jobs','complete_preparation_job','ingest_prepared_payload','reject_immutable_offer_revision',
    'protect_candidate_publication_offer','accept_offer_revision','validate_publication_offers','enforce_publication_offer_validation',
    'protect_publication_refresh_request_identity','claim_offer_preparation_jobs','enqueue_missing_offer_preparation_jobs',
    'checkpoint_offer_preparation_job','finish_offer_preparation_job','fail_offer_preparation_job','claim_offer_outbox','deliver_offer_outbox',
    'fail_offer_outbox','offer_revision_term','claim_publication_refresh_requests','checkpoint_publication_refresh_request',
    'fail_publication_refresh_request','current_publication_offer_status','refresh_publication_request','canonical_text','canonical_occurrence',
    'legacy_offer_occurrence','bind_offer_occurrence','canonical_offer_support','accept_canonical_observation','claim_canonical_preparation_jobs',
    'canonical_preparation_input','fail_canonical_preparation_job','complete_canonical_preparation_job',
    'current_publication_offer_status_v4','refresh_publication_request_v4',
    'check_preparation_storage','begin_preparation_batch','accept_batch_observation','record_batch_quarantine','seal_preparation_batch',
    'cancel_preparation_batch','claim_batch_preparation_jobs','batch_preparation_input','complete_batch_preparation_job',
    'fail_batch_preparation_job','claim_batch_publication','batch_session_snapshot','publish_preparation_batch',
    'begin_preparation_batch_v2','record_batch_page','offer_page_support','canonical_offer_support_v5',
    'seal_preparation_batch_v2','publish_preparation_batch_v6','record_batch_page_v7','seal_preparation_batch_v2_v7',
    'publish_preparation_batch_v7','validate_publication_offers_v7','current_publication_offer_status_v7',
    'projected_session_snapshot','derive_offer_page_evidence','current_offer_page_evidence','session_projection_integrity',
    'offer_evidence_hash','publication_offer_term','publication_offer_evidence_current'];
BEGIN
  FOR obj IN SELECT c.oid,c.relname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='biplan' AND c.relkind IN ('r','p','v','m','S','f') LOOP
    IF obj.relkind NOT IN ('r','p') OR NOT(obj.relname=ANY(approved_tables)) THEN
      RAISE EXCEPTION 'unreviewed biplan relation %',obj.relname; END IF;
    EXECUTE format('ALTER TABLE biplan.%I OWNER TO biplan_owner',obj.relname);
  END LOOP;
  FOR obj IN SELECT p.oid,p.proname,p.prokind FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='biplan' LOOP
    IF obj.prokind<>'f' OR NOT(obj.proname=ANY(approved_functions))
      OR (SELECT count(*) FROM pg_proc p WHERE p.pronamespace='biplan'::regnamespace AND p.proname=obj.proname)<>1 THEN
      RAISE EXCEPTION 'unreviewed or overloaded biplan function %',obj.proname; END IF;
    EXECUTE format('ALTER FUNCTION %s OWNER TO biplan_owner',obj.oid::regprocedure);
    EXECUTE format('ALTER FUNCTION %s SECURITY INVOKER',obj.oid::regprocedure);
    EXECUTE format('ALTER FUNCTION %s SET search_path=pg_catalog,biplan,public,pg_temp',obj.oid::regprocedure);
  END LOOP;
END $objects$;

REVOKE ALL ON ALL TABLES IN SCHEMA biplan FROM PUBLIC,biplan_reader,biplan_prepare,biplan_web,biplan_preparer;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA biplan FROM PUBLIC,biplan_reader,biplan_prepare,biplan_web,biplan_preparer;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA biplan FROM PUBLIC,biplan_reader,biplan_prepare,biplan_web,biplan_preparer;

-- Existing HTTP pin/read/vector/readiness queries. No job, raw observation, claim,
-- canonical acceptance receipt or preparation-state tables are exposed to the web.
GRANT SELECT ON biplan.active_publication,biplan.publications,biplan.published_sessions,biplan.search_documents,
  biplan.publication_offers,biplan.offer_revisions,biplan.offer_identities,biplan.sessions,biplan.productions,
  biplan.publication_evaluations,biplan.evaluations TO biplan_reader;

-- Preparation stores inspect source identities and immutable revisions; they have
-- no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER privileges on any table.
GRANT SELECT ON biplan.active_publication,biplan.publications,biplan.published_sessions,biplan.offer_identities,
  biplan.offer_revisions,biplan.sessions,biplan.productions,biplan.venues,biplan.canonical_heads,
  biplan.canonical_source_mappings,biplan.preparation_batches,biplan.preparation_batch_items,biplan.preparation_batch_sessions TO biplan_prepare;

DO $api$
DECLARE signature text; function_id regprocedure;
  read_api text[]:=ARRAY['biplan.current_publication_offer_status(text,text,timestamp with time zone,interval)',
    'biplan.offer_revision_term(text)'];
  prepare_api text[]:=ARRAY['biplan.accept_offer_revision(jsonb,text)','biplan.accept_canonical_observation(jsonb)',
    'biplan.claim_offer_preparation_jobs(text,integer,interval)','biplan.enqueue_missing_offer_preparation_jobs(integer)',
    'biplan.checkpoint_offer_preparation_job(text,text,bigint,jsonb)','biplan.finish_offer_preparation_job(text,text,bigint,jsonb)',
    'biplan.fail_offer_preparation_job(text,text,bigint,jsonb,interval)','biplan.claim_offer_outbox(text,integer,interval)',
    'biplan.deliver_offer_outbox(text,text,bigint)','biplan.fail_offer_outbox(text,text,bigint,jsonb,interval)',
    'biplan.claim_publication_refresh_requests(text,integer,interval)','biplan.checkpoint_publication_refresh_request(text,text,bigint,jsonb)',
    'biplan.fail_publication_refresh_request(text,text,bigint,jsonb,interval)','biplan.refresh_publication_request(text,text,bigint,text)',
    'biplan.claim_canonical_preparation_jobs(text,integer,interval)','biplan.canonical_preparation_input(text,text,bigint)',
    'biplan.fail_canonical_preparation_job(text,text,bigint,jsonb)','biplan.complete_canonical_preparation_job(text,text,bigint,jsonb,text)',
    'biplan.begin_preparation_batch(jsonb)','biplan.accept_batch_observation(text,jsonb)',
    'biplan.record_batch_quarantine(text,text,jsonb,text)','biplan.seal_preparation_batch(text,jsonb)',
    'biplan.cancel_preparation_batch(text,text)','biplan.claim_batch_preparation_jobs(text,text,integer,interval)',
    'biplan.batch_preparation_input(text,text,bigint)','biplan.complete_batch_preparation_job(text,text,bigint,jsonb)',
    'biplan.fail_batch_preparation_job(text,text,bigint,jsonb)','biplan.claim_batch_publication(text,text,interval)',
    'biplan.publish_preparation_batch(text,text,text,bigint,text)'];
BEGIN
  IF EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='007-page-receipts') THEN
    read_api:=read_api||ARRAY['biplan.offer_page_support(text)'];
    prepare_api:=prepare_api||ARRAY['biplan.begin_preparation_batch_v2(jsonb)','biplan.record_batch_page(text,jsonb)',
      'biplan.seal_preparation_batch_v2(text,jsonb)'];
    GRANT SELECT ON biplan.source_page_observations,biplan.preparation_batch_pages TO biplan_prepare;
  END IF;
  IF EXISTS(SELECT 1 FROM biplan.schema_migrations WHERE version='008-offer-evidence-projections') THEN
    read_api:=read_api||ARRAY['biplan.publication_offer_term(text,text)','biplan.publication_offer_evidence_current(text,text)'];
  END IF;
  FOREACH signature IN ARRAY read_api LOOP
    function_id:=to_regprocedure(signature); IF function_id IS NULL THEN RAISE EXCEPTION 'missing read API %',signature; END IF;
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER',function_id);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO biplan_reader,biplan_prepare',function_id);
  END LOOP;
  FOREACH signature IN ARRAY prepare_api LOOP
    function_id:=to_regprocedure(signature); IF function_id IS NULL THEN RAISE EXCEPTION 'missing preparation API %',signature; END IF;
    EXECUTE format('ALTER FUNCTION %s SECURITY DEFINER',function_id);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO biplan_prepare',function_id);
  END LOOP;
END $api$;
GRANT EXECUTE ON FUNCTION biplan.canonical_text(text) TO biplan_prepare;

-- Both the deployment administrator and NOLOGIN owner must create future routines
-- closed by default. No default grants of future functions or tables to app roles.
-- PUBLIC's built-in EXECUTE default is global within this database; a schema-only
-- REVOKE cannot cancel that global default grant.
ALTER DEFAULT PRIVILEGES FOR ROLE biplan_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE biplan_owner IN SCHEMA biplan REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA biplan REVOKE ALL ON TABLES FROM PUBLIC;

COMMIT;
