BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM biplan.schema_migrations WHERE version='004-publication-refresh') THEN
    RAISE EXCEPTION 'canonical preparation requires 004-publication-refresh';
  END IF;
  IF EXISTS (SELECT 1 FROM biplan.schema_migrations WHERE version='005-canonical-preparation'
    AND migration_hash<>'005-canonical-preparation-v1') THEN RAISE EXCEPTION 'incompatible canonical migration'; END IF;
END $guard$;

CREATE TABLE IF NOT EXISTS biplan.canonical_requests (
  id text PRIMARY KEY, request_hash text NOT NULL, payload jsonb NOT NULL,
  receipt jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS biplan.canonical_revisions (
  id text PRIMARY KEY, session_id text NOT NULL REFERENCES biplan.sessions(id),
  previous_revision_id text REFERENCES biplan.canonical_revisions(id),
  source_name text NOT NULL, source_record_id text NOT NULL,
  observation_id text NOT NULL REFERENCES biplan.source_observations(id),
  observed_at timestamptz NOT NULL, source_updated_at timestamptz,
  facts jsonb NOT NULL CHECK(jsonb_typeof(facts)='object'),
  semantic_hash text NOT NULL, dependency_hash text NOT NULL,
  adapter_version text NOT NULL, normalizer_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS biplan.canonical_heads (
  session_id text PRIMARY KEY REFERENCES biplan.sessions(id),
  revision_id text NOT NULL UNIQUE REFERENCES biplan.canonical_revisions(id)
);
CREATE TABLE IF NOT EXISTS biplan.canonical_source_mappings (
  source_name text NOT NULL, source_record_id text NOT NULL,
  session_id text NOT NULL REFERENCES biplan.sessions(id),
  offer_id text NOT NULL REFERENCES biplan.offer_identities(id),
  observation_id text NOT NULL REFERENCES biplan.source_observations(id),
  PRIMARY KEY(source_name,source_record_id)
);
CREATE TABLE IF NOT EXISTS biplan.canonical_preparations (
  revision_id text PRIMARY KEY REFERENCES biplan.canonical_revisions(id),
  document_id text NOT NULL REFERENCES biplan.search_documents(id),
  result jsonb NOT NULL, result_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE TRIGGER canonical_requests_immutable BEFORE UPDATE OR DELETE ON biplan.canonical_requests
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();
CREATE OR REPLACE TRIGGER canonical_revisions_immutable BEFORE UPDATE OR DELETE ON biplan.canonical_revisions
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();
CREATE OR REPLACE TRIGGER canonical_mappings_immutable BEFORE UPDATE OR DELETE ON biplan.canonical_source_mappings
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();
CREATE OR REPLACE TRIGGER canonical_preparations_immutable BEFORE UPDATE OR DELETE ON biplan.canonical_preparations
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();

-- Same text may have different dependencies or acquire a compatible vector later.
-- All versions remain immutable; NULL is a real lexical-only profile version.
DO $documents$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid='biplan.search_documents'::regclass AND c.contype='u'
      AND pg_get_constraintdef(c.oid)='UNIQUE (subject_type, subject_id, document_profile, document_hash)'
  LOOP EXECUTE format('ALTER TABLE biplan.search_documents DROP CONSTRAINT %I',constraint_name); END LOOP;
END $documents$;
CREATE UNIQUE INDEX IF NOT EXISTS search_documents_dependency_version_idx ON biplan.search_documents
  (subject_type,subject_id,document_profile,document_hash,dependency_hash,embedding_profile) NULLS NOT DISTINCT;

CREATE OR REPLACE FUNCTION biplan.canonical_text(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT regexp_replace(btrim(COALESCE(p_text,'')),'\s+',' ','g') $$;

-- An offer identity is not proof that its current checkout link supports a corrected
-- occurrence. Bind each revision to immutable occurrence evidence independently.
CREATE TABLE IF NOT EXISTS biplan.offer_occurrence_bindings (
  offer_revision_id text PRIMARY KEY REFERENCES biplan.offer_revisions(id),
  session_id text NOT NULL REFERENCES biplan.sessions(id), facts jsonb NOT NULL,
  evidence_basis text NOT NULL CHECK(evidence_basis IN ('full_source_record','inherited')),
  evidence_observed_at timestamptz NOT NULL, evidence_source_updated_at timestamptz,
  predecessor_revision_id text REFERENCES biplan.offer_revisions(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS biplan.canonical_occurrence_disputes (
  request_id text PRIMARY KEY, session_id text NOT NULL REFERENCES biplan.sessions(id),
  offer_id text REFERENCES biplan.offer_identities(id), source_name text NOT NULL, source_record_id text NOT NULL,
  observation_id text NOT NULL REFERENCES biplan.source_observations(id),
  facts jsonb NOT NULL, observed_at timestamptz NOT NULL, source_updated_at timestamptz,
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS canonical_occurrence_disputes_session_idx ON biplan.canonical_occurrence_disputes(session_id,offer_id);
CREATE INDEX IF NOT EXISTS publication_offers_revision_idx ON biplan.publication_offers(offer_revision_id);
CREATE OR REPLACE TRIGGER offer_occurrence_bindings_immutable BEFORE UPDATE OR DELETE ON biplan.offer_occurrence_bindings
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();
CREATE OR REPLACE TRIGGER canonical_occurrence_disputes_immutable BEFORE UPDATE OR DELETE ON biplan.canonical_occurrence_disputes
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_mutation();

CREATE OR REPLACE FUNCTION biplan.canonical_occurrence(p_facts jsonb) RETURNS jsonb
LANGUAGE sql STABLE STRICT AS $$
  SELECT jsonb_build_object('title',biplan.canonical_text(p_facts->>'title'),
    'venue',biplan.canonical_text(p_facts->>'venue'),'district',biplan.canonical_text(p_facts->>'district'),
    'address',biplan.canonical_text(p_facts->>'address'),
    'startsAt',to_char((p_facts->>'startsAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'attendanceTiming',NULLIF(p_facts->'attendanceTiming','null'::jsonb),
    'status',CASE WHEN p_facts->>'availability'='cancelled' OR p_facts->>'status'='canceled' THEN 'canceled' ELSE 'scheduled' END)
$$;

CREATE OR REPLACE FUNCTION biplan.legacy_offer_occurrence(p_revision_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE result jsonb; raw jsonb;
BEGIN
  -- The earliest immutable pin retains the original conservative merge's supported
  -- canonical title/venue. Never bind legacy offers to today's mutable session.
  SELECT biplan.canonical_occurrence(ps.eligibility_snapshot) INTO result
    FROM biplan.publication_offers po JOIN biplan.published_sessions ps
      ON ps.publication_id=po.publication_id AND ps.session_id=po.session_id
    JOIN biplan.publications p ON p.id=po.publication_id
    WHERE po.offer_revision_id=p_revision_id ORDER BY p.created_at,p.id LIMIT 1;
  IF result IS NULL THEN
    SELECT source_payload INTO raw FROM biplan.offer_revisions WHERE id=p_revision_id;
    IF raw->>'title' IS NOT NULL AND raw->>'venue' IS NOT NULL AND raw->>'startsAt' IS NOT NULL THEN
      result:=biplan.canonical_occurrence(raw);
    END IF;
  END IF;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION biplan.bind_offer_occurrence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_id text; previous_binding biplan.offer_occurrence_bindings%ROWTYPE; bound jsonb; key text;
BEGIN
  IF NEW.acceptance_status<>'accepted' THEN RETURN NEW; END IF;
  SELECT current_revision_id INTO previous_id FROM biplan.offer_identities WHERE id=NEW.offer_id;
  IF NEW.source_payload->>'title' IS NOT NULL AND NEW.source_payload->>'venue' IS NOT NULL
    AND NEW.source_payload->>'startsAt' IS NOT NULL THEN
    INSERT INTO biplan.offer_occurrence_bindings(offer_revision_id,session_id,facts,evidence_basis,evidence_observed_at,evidence_source_updated_at,predecessor_revision_id)
      VALUES(NEW.id,NEW.session_id,biplan.canonical_occurrence(NEW.source_payload),'full_source_record',NEW.observed_at,NEW.source_updated_at,previous_id);
  ELSE
    SELECT * INTO previous_binding FROM biplan.offer_occurrence_bindings WHERE offer_revision_id=previous_id;
    bound:=COALESCE(previous_binding.facts,biplan.legacy_offer_occurrence(previous_id));
    IF bound IS NOT NULL THEN
      -- Explicit partial corrections cannot hide behind inherited occurrence facts.
      FOREACH key IN ARRAY ARRAY['title','venue','district','address','startsAt','attendanceTiming'] LOOP
        IF NEW.source_payload?key THEN bound:=jsonb_set(bound,ARRAY[key],COALESCE(NEW.source_payload->key,'null'::jsonb)); END IF;
      END LOOP;
      IF NEW.source_payload->>'availability'='cancelled' THEN bound:=jsonb_set(bound,'{status}','"canceled"'::jsonb); END IF;
      bound:=biplan.canonical_occurrence(bound);
      INSERT INTO biplan.offer_occurrence_bindings(offer_revision_id,session_id,facts,evidence_basis,evidence_observed_at,evidence_source_updated_at,predecessor_revision_id)
        VALUES(NEW.id,NEW.session_id,bound,'inherited',COALESCE(previous_binding.evidence_observed_at,
          (SELECT observed_at FROM biplan.offer_revisions WHERE id=previous_id)),previous_binding.evidence_source_updated_at,previous_id);
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER offer_revisions_bind_occurrence AFTER INSERT ON biplan.offer_revisions
FOR EACH ROW EXECUTE FUNCTION biplan.bind_offer_occurrence();

CREATE OR REPLACE FUNCTION biplan.canonical_offer_support(p_session_id text,p_facts jsonb) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  WITH current_offers AS (
    SELECT i.id,i.provider,i.provider_record_id,r.source_session_ids,i.current_revision_id,r.availability,
      b.facts,b.evidence_basis,b.evidence_observed_at,b.evidence_source_updated_at,
      COALESCE(b.facts,biplan.legacy_offer_occurrence(r.id)) bound
    FROM biplan.offer_identities i JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
      LEFT JOIN biplan.offer_occurrence_bindings b ON b.offer_revision_id=r.id WHERE i.session_id=p_session_id
  ), unresolved_disputes AS (
    SELECT d.* FROM biplan.canonical_occurrence_disputes d WHERE d.session_id=p_session_id
      AND NOT EXISTS(SELECT 1 FROM current_offers proof WHERE proof.provider=d.source_name
        AND (proof.id=d.offer_id OR proof.provider_record_id=d.source_record_id OR d.source_record_id=ANY(proof.source_session_ids))
        AND proof.evidence_basis='full_source_record' AND (
          (d.source_updated_at IS NOT NULL AND proof.evidence_source_updated_at>d.source_updated_at)
          OR (d.source_updated_at IS NULL AND proof.evidence_observed_at>d.observed_at)
          OR (proof.evidence_source_updated_at IS NOT DISTINCT FROM d.source_updated_at AND proof.evidence_observed_at>d.observed_at)))
  ), statuses AS (
    SELECT o.id,CASE WHEN EXISTS(SELECT 1 FROM unresolved_disputes d WHERE d.offer_id=o.id OR d.offer_id IS NULL) THEN 'disputed'
      WHEN o.availability IN ('sold_out','unavailable') THEN 'not_selectable'
      WHEN o.bound IS NULL THEN 'unknown_occurrence'
      WHEN o.bound IS DISTINCT FROM biplan.canonical_occurrence(p_facts) THEN 'occurrence_mismatch'
      ELSE 'supported' END support FROM current_offers o
  ) SELECT jsonb_build_object('usable',COALESCE(bool_and(support IN ('supported','not_selectable')),false),
    'offers',COALESCE(jsonb_agg(jsonb_build_object('offerId',id,'support',support) ORDER BY id),'[]'::jsonb)) FROM statuses
$$;

-- Retain content-addressed raw observations and separately record every refresh in
-- immutable request/revision receipts (including repeated identical raw content).
CREATE OR REPLACE FUNCTION biplan.accept_canonical_observation(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql AS $$
#variable_conflict use_variable
<<canonical_accept>>
DECLARE rec jsonb:=p_payload->'record'; req_id text:=p_payload->>'requestId';
  request_hash text:=md5((p_payload-'expectedCanonicalRevisionId'-'expectedOfferRevisionId')::text);
  prior biplan.canonical_requests%ROWTYPE; current_rev biplan.canonical_revisions%ROWTYPE;
  old_offer biplan.offer_identities%ROWTYPE; old_terms biplan.offer_revisions%ROWTYPE;
  sess biplan.sessions%ROWTYPE; prod biplan.productions%ROWTYPE; venue biplan.venues%ROWTYPE;
  ids text[]; source_name text:=rec->>'source'; source_id text; sid text; oid text; pid text; vid text;
  matches integer; reason text; observation_id text; revision_id text; offer_revision_id text; job_id text;
  facts jsonb; facts_hash text; dependency_hash text; receipt jsonb; offer_payload jsonb; offer_result jsonb;
  observed timestamptz; source_updated timestamptz; starts timestamptz; price_minor bigint;
  raw_hash text; field record; claim_id text; current_id text; existing_title text; is_new boolean:=false;
BEGIN
  IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR jsonb_typeof(rec) IS DISTINCT FROM 'object'
    OR req_id IS NULL OR btrim(req_id)='' OR length(req_id)>250
    OR p_payload->>'adapterVersion' IS DISTINCT FROM 'normalized-source-v1'
    OR p_payload->>'normalizerVersion' IS DISTINCT FROM 'canonical-base-v1'
    OR NOT(p_payload?'expectedCanonicalRevisionId') OR NOT(p_payload?'expectedOfferRevisionId') THEN
    RAISE EXCEPTION 'unsupported or incomplete canonical observation contract';
  END IF;
  -- Serialize resolution, including currently absent source mappings. Acquire offer
  -- table lock BEFORE session/head rows to agree with publication lock ordering.
  PERFORM pg_advisory_xact_lock(hashtextextended('biplan.canonical.acceptance',0));
  SELECT * INTO prior FROM biplan.canonical_requests WHERE id=req_id;
  IF FOUND THEN
    IF prior.request_hash<>request_hash OR (prior.payload-'expectedCanonicalRevisionId'-'expectedOfferRevisionId')<>
      (p_payload-'expectedCanonicalRevisionId'-'expectedOfferRevisionId') THEN RAISE EXCEPTION 'canonical request id reused with different payload'; END IF;
    RETURN prior.receipt||jsonb_build_object('idempotent',true);
  END IF;
  IF source_name NOT IN ('biletix','bubilet','biletinial') OR source_name IS NULL
    OR biplan.canonical_text(rec->>'title')='' OR biplan.canonical_text(rec->>'venue')=''
    OR jsonb_typeof(rec->'sourceSessionIds') IS DISTINCT FROM 'array'
    OR jsonb_array_length(rec->'sourceSessionIds')=0
    OR rec->>'currency' IS DISTINCT FROM 'TRY'
    OR COALESCE(rec->>'availability','') NOT IN ('available','unknown','cancelled','sold_out') THEN
    RAISE EXCEPTION 'invalid canonical source record';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(rec->'sourceSessionIds') x
    WHERE jsonb_typeof(x) NOT IN ('string','number') OR btrim(x#>>'{}')='') THEN RAISE EXCEPTION 'invalid source identities'; END IF;
  IF COALESCE(rec->>'url','') !~ (CASE source_name
    WHEN 'biletix' THEN '^https://([a-zA-Z0-9-]+\.)*biletix\.com/'
    WHEN 'bubilet' THEN '^https://([a-zA-Z0-9-]+\.)*bubilet\.com\.tr/'
    ELSE '^https://([a-zA-Z0-9-]+\.)*biletinial\.com/' END) THEN RAISE EXCEPTION 'invalid canonical source URL'; END IF;
  observed:=(rec->>'checkedAt')::timestamptz; starts:=(rec->>'startsAt')::timestamptz;
  source_updated:=(p_payload->>'sourceUpdatedAt')::timestamptz;
  IF observed IS NULL OR starts IS NULL OR NOT isfinite(observed) OR NOT isfinite(starts)
    OR (source_updated IS NOT NULL AND NOT isfinite(source_updated)) THEN RAISE EXCEPTION 'invalid canonical observation time'; END IF;
  IF rec->>'price' IS NOT NULL THEN
    IF rec->>'price' !~ '^\d+(\.\d{1,2})?$' OR (rec->>'price')::numeric*100>9007199254740991 THEN RAISE EXCEPTION 'invalid canonical price'; END IF;
    price_minor:=((rec->>'price')::numeric*100)::bigint;
  END IF;
  IF rec->'attendanceTiming' IS NOT NULL AND rec->'attendanceTiming'<>'null'::jsonb
    AND jsonb_typeof(rec->'attendanceTiming')<>'object' THEN RAISE EXCEPTION 'invalid attendance timing'; END IF;
  SELECT array_agg(DISTINCT value ORDER BY value) INTO ids FROM jsonb_array_elements_text(rec->'sourceSessionIds');
  source_id:=ids[1]; raw_hash:=md5(rec::text);
  LOCK TABLE biplan.offer_identities IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*),min(x.offer_id),min(x.session_id) INTO matches,oid,sid FROM (
    SELECT i.id offer_id,i.session_id FROM biplan.offer_identities i
    LEFT JOIN biplan.offer_revisions r ON r.id=i.current_revision_id
    WHERE i.provider=source_name AND (i.provider_record_id=ANY(ids) OR i.provider_session_id=ANY(ids)
      OR r.source_payload->>'id'=ANY(ids) OR COALESCE(r.source_session_ids,'{}')&&ids)
    UNION SELECT m.offer_id,m.session_id FROM biplan.canonical_source_mappings m
      WHERE m.source_name=source_name AND m.source_record_id=ANY(ids)
  ) x;
  IF matches>1 THEN reason:='ambiguous_source_identity'; sid:=NULL; oid:=NULL; END IF;
  IF matches=0 THEN
    -- Match only a unique exact occurrence with fully resolved venue evidence.
    -- Conflicting explicit production keys preserve distinct adaptations; never use
    -- fuzzy title similarity or infer a work/production relationship across sessions.
    IF biplan.canonical_text(rec->>'district')<>'' AND biplan.canonical_text(rec->>'address')<>'' THEN
      SELECT count(*),min(s.id) INTO matches,sid FROM biplan.sessions s
      JOIN biplan.productions p ON p.id=s.production_id JOIN biplan.venues v ON v.id=s.venue_id
      WHERE (NULLIF(rec->>'canonicalProductionKey','') IS NULL OR p.canonical_production_key IS NULL
          OR p.canonical_production_key=rec->>'canonicalProductionKey')
        AND biplan.canonical_text(p.title)=biplan.canonical_text(rec->>'title')
        AND s.starts_at=starts AND biplan.canonical_text(v.name)=biplan.canonical_text(rec->>'venue')
        AND biplan.canonical_text(v.district)=biplan.canonical_text(rec->>'district')
        AND biplan.canonical_text(v.address_text)=biplan.canonical_text(rec->>'address');
      IF matches>1 THEN reason:='ambiguous_canonical_identity'; sid:=NULL; END IF;
    END IF;
    IF reason IS NULL THEN
      IF sid IS NULL THEN sid:='canonical-session:'||md5(source_name||':'||source_id); is_new:=true; END IF;
      oid:='canonical-offer:'||md5(source_name||':'||source_id);
    END IF;
  END IF;
  observation_id:='canonical-observation:'||md5(source_name||':'||source_id||':'||raw_hash);
  SELECT id INTO observation_id FROM biplan.source_observations
    WHERE source_observations.source_name=canonical_accept.source_name
      AND source_record_id=source_id AND content_hash=raw_hash;
  observation_id:=COALESCE(observation_id,'canonical-observation:'||md5(source_name||':'||source_id||':'||raw_hash));
  INSERT INTO biplan.source_observations(id,source_name,source_record_id,source_url,subject_type,subject_id,
    content_hash,observed_at,source_updated_at,refresh_status,raw_payload)
  VALUES(observation_id,source_name,source_id,rec->>'url','session',sid,raw_hash,observed,source_updated,
    CASE WHEN reason IS NULL THEN 'current' ELSE 'quarantined' END,rec) ON CONFLICT DO NOTHING;
  IF reason IS NULL THEN
    SELECT * INTO old_offer FROM biplan.offer_identities WHERE id=oid;
    IF old_offer.current_revision_id IS DISTINCT FROM p_payload->>'expectedOfferRevisionId' THEN RAISE EXCEPTION 'canonical offer head guard failed'; END IF;
    SELECT h.revision_id INTO current_id FROM biplan.canonical_heads h WHERE h.session_id=sid FOR UPDATE;
    IF current_id IS DISTINCT FROM p_payload->>'expectedCanonicalRevisionId' THEN RAISE EXCEPTION 'canonical revision guard failed'; END IF;
    IF current_id IS NOT NULL THEN SELECT * INTO current_rev FROM biplan.canonical_revisions WHERE id=current_id; END IF;
    SELECT * INTO sess FROM biplan.sessions WHERE id=sid FOR UPDATE;
    IF FOUND THEN
      SELECT * INTO prod FROM biplan.productions WHERE id=sess.production_id;
      SELECT * INTO venue FROM biplan.venues WHERE id=sess.venue_id;
      pid:=sess.production_id; vid:=sess.venue_id;
      IF biplan.canonical_text(prod.title)<>biplan.canonical_text(rec->>'title')
        AND (SELECT count(*) FROM biplan.sessions WHERE production_id=pid)>1 THEN reason:='shared_production_change_requires_fanout'; END IF;
    ELSIF NOT is_new THEN RAISE EXCEPTION 'resolved canonical session missing'; END IF;
    facts:=jsonb_build_object('title',biplan.canonical_text(rec->>'title'),'category',COALESCE(NULLIF(rec->>'category',''),'Diğer'),
      'description',COALESCE(rec->>'description',''),'imageUrl',rec->>'imageUrl',
      'venue',biplan.canonical_text(rec->>'venue'),'city',COALESCE(rec->>'city','İstanbul'),
      'district',COALESCE(rec->>'district',''),'address',COALESCE(rec->>'address',''),
      'startsAt',to_char(starts AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'attendanceTiming',COALESCE(NULLIF(rec->'attendanceTiming','null'::jsonb),'null'::jsonb),
      'canonicalProductionKey',COALESCE(NULLIF(rec->>'canonicalProductionKey',''),prod.canonical_production_key),
      'status',CASE WHEN rec->>'availability'='cancelled' THEN 'canceled' ELSE 'scheduled' END);
    facts_hash:=md5(facts::text);
    SELECT * INTO old_terms FROM biplan.offer_revisions WHERE id=old_offer.current_revision_id;
    IF current_id IS NOT NULL THEN
      IF current_rev.source_name<>source_name AND current_rev.semantic_hash<>facts_hash THEN reason:='cross_source_canonical_conflict';
      ELSIF current_rev.source_name=source_name AND current_rev.source_updated_at IS NOT NULL AND source_updated IS NULL THEN reason:='source_clock_missing';
      ELSIF current_rev.source_name=source_name AND source_updated<current_rev.source_updated_at THEN reason:='stale_source_clock';
      ELSIF current_rev.source_name=source_name AND source_updated=current_rev.source_updated_at AND facts_hash<>current_rev.semantic_hash THEN reason:='equal_source_clock_conflict';
      ELSIF current_rev.source_name=source_name AND (source_updated IS NOT DISTINCT FROM current_rev.source_updated_at) AND observed<current_rev.observed_at THEN reason:='stale_observation';
      ELSIF current_rev.source_name=source_name AND (source_updated IS NOT DISTINCT FROM current_rev.source_updated_at) AND observed=current_rev.observed_at
        AND facts_hash<>current_rev.semantic_hash THEN reason:='equal_observation_conflict'; END IF;
    ELSE
      IF old_terms.source_updated_at IS NOT NULL AND source_updated IS NULL THEN reason:='source_clock_missing';
      ELSIF source_updated<old_terms.source_updated_at OR (source_updated IS NOT DISTINCT FROM old_terms.source_updated_at AND observed<old_terms.observed_at)
        THEN reason:='stale_observation'; END IF;
    END IF;
    -- Preflight the exact offer's independent clock before mutating canonical rows.
    IF old_terms.id IS NOT NULL THEN
      IF old_terms.source_updated_at IS NOT NULL AND source_updated IS NULL THEN reason:='source_clock_missing';
      ELSIF source_updated<old_terms.source_updated_at THEN reason:='stale_source_clock';
      ELSIF source_updated=old_terms.source_updated_at AND raw_hash<>old_terms.server_content_hash THEN reason:='equal_source_clock_conflict';
      ELSIF source_updated IS NOT DISTINCT FROM old_terms.source_updated_at THEN
        IF observed<old_terms.observed_at THEN reason:='stale_observation';
        ELSIF observed=old_terms.observed_at AND raw_hash<>old_terms.server_content_hash THEN reason:='equal_observation_conflict'; END IF;
      END IF;
    END IF;
  END IF;
  IF reason IS NOT NULL THEN
    -- A fresh conflicting mandatory observation is negative evidence even when it
    -- cannot replace canonical facts. Preserve it and withhold the family immediately.
    -- Only compare clocks within this same provider offer, never across providers.
    IF sid IS NOT NULL AND facts IS NOT NULL AND reason NOT LIKE 'stale%'
      AND (old_terms.id IS NULL OR source_updated>old_terms.source_updated_at OR (observed>=old_terms.observed_at
        AND (source_updated IS NULL OR old_terms.source_updated_at IS NULL OR source_updated>=old_terms.source_updated_at)))
      AND biplan.canonical_occurrence(facts) IS DISTINCT FROM biplan.canonical_occurrence(COALESCE(current_rev.facts,
        jsonb_build_object('title',prod.title,'venue',venue.name,'district',venue.district,'address',venue.address_text,
          'startsAt',sess.starts_at,'attendanceTiming',sess.attendance_timing,'status',sess.status))) THEN
      INSERT INTO biplan.canonical_occurrence_disputes(request_id,session_id,offer_id,source_name,source_record_id,observation_id,facts,observed_at,source_updated_at,reason)
        VALUES(req_id,sid,old_offer.id,source_name,source_id,observation_id,biplan.canonical_occurrence(facts),observed,source_updated,reason);
    END IF;
    receipt:=jsonb_build_object('status','held','reason',reason,'sessionId',sid,'offerId',oid,'observationId',observation_id,'idempotent',false);
    INSERT INTO biplan.canonical_requests(id,request_hash,payload,receipt) VALUES(req_id,request_hash,p_payload,receipt);
    RETURN receipt;
  END IF;
  IF pid IS NULL THEN
    pid:='canonical-production:'||md5(source_name||':'||source_id);
    INSERT INTO biplan.productions(id,title,production_type,synopsis,canonical_production_key,identity_basis,status,content_hash)
    VALUES(pid,facts->>'title',facts->>'category',facts->>'description',facts->>'canonicalProductionKey','isolated_source_record','active',facts_hash);
  ELSIF biplan.canonical_text(prod.title)<>facts->>'title' THEN
    -- Shared-title corrections were held above; no shared entity mutation occurs.
    UPDATE biplan.productions SET title=facts->>'title',content_hash=facts_hash,updated_at=clock_timestamp() WHERE id=pid;
  END IF;
  IF vid IS NULL OR biplan.canonical_text(venue.name)<>facts->>'venue'
    OR biplan.canonical_text(venue.address_text)<>biplan.canonical_text(facts->>'address')
    OR biplan.canonical_text(venue.district)<>biplan.canonical_text(facts->>'district') THEN
    -- Location corrections create an immutable scoped identity; do not edit a shared venue.
    vid:='canonical-venue:'||md5(jsonb_build_array(sid,facts->'venue',facts->'address',facts->'district')::text);
    INSERT INTO biplan.venues(id,name,address_text,district,location_precision,identity_basis,content_hash)
    VALUES(vid,facts->>'venue',facts->>'address',facts->>'district','unknown','source_scoped_location',md5((facts-'description')::text)) ON CONFLICT(id) DO NOTHING;
  END IF;
  INSERT INTO biplan.sessions(id,production_id,venue_id,starts_at,status,attendance_timing,source_session_ids,availability,content_hash)
  VALUES(sid,pid,vid,starts,facts->>'status',NULLIF(facts->'attendanceTiming','null'::jsonb),ids,rec->>'availability',facts_hash)
  ON CONFLICT(id) DO UPDATE SET venue_id=EXCLUDED.venue_id,starts_at=EXCLUDED.starts_at,status=EXCLUDED.status,
    attendance_timing=EXCLUDED.attendance_timing,source_session_ids=ARRAY(SELECT DISTINCT x FROM unnest(biplan.sessions.source_session_ids||EXCLUDED.source_session_ids)x ORDER BY x),
    availability=EXCLUDED.availability,content_hash=EXCLUDED.content_hash,updated_at=clock_timestamp();
  revision_id:='canonical-revision:'||md5(req_id); offer_revision_id:='canonical-offer-revision:'||md5(req_id);
  dependency_hash:=md5(jsonb_build_object('facts',facts,'productionId',pid,'venueId',vid,
    'sourceObservationId',observation_id,'sourceName',source_name,'sourceRecordId',source_id,
    'adapterVersion',p_payload->'adapterVersion','normalizerVersion',p_payload->'normalizerVersion')::text);
  INSERT INTO biplan.canonical_revisions(id,session_id,previous_revision_id,source_name,source_record_id,observation_id,observed_at,
    source_updated_at,facts,semantic_hash,dependency_hash,adapter_version,normalizer_version)
  VALUES(revision_id,sid,current_id,source_name,source_id,observation_id,observed,source_updated,facts,facts_hash,dependency_hash,
    p_payload->>'adapterVersion',p_payload->>'normalizerVersion');
  FOR field IN SELECT key,value FROM jsonb_each(facts) LOOP
    claim_id:='canonical-claim:'||md5(revision_id||':'||field.key);
    INSERT INTO biplan.source_claims(id,observation_id,subject_type,subject_id,field_name,value_json,claim_status,evidence_class,content_hash)
    VALUES(claim_id,observation_id,'session',sid,field.key,field.value,
      CASE WHEN field.value='null'::jsonb OR field.value='""'::jsonb THEN 'unknown' ELSE 'supported' END,'provider_listing',md5(revision_id||':'||field.key));
    INSERT INTO biplan.claim_evidence(claim_id,observation_id) VALUES(claim_id,observation_id);
  END LOOP;
  offer_payload:=jsonb_build_object('revisionId',offer_revision_id,'offerId',oid,'sessionId',sid,'provider',source_name,
    'providerRecordId',COALESCE(old_offer.provider_record_id,source_id),'providerSessionId',old_offer.provider_session_id,
    'sourceSessionIds',to_jsonb(ids),'sourceUrl',rec->>'url','ticketTierId',old_offer.ticket_tier_id,
    'ticketTierName',old_terms.ticket_tier_name,'currency',CASE WHEN price_minor IS NOT NULL THEN 'TRY' END,
    'price',CASE WHEN price_minor IS NOT NULL THEN rec->>'price' END,'priceMinor',price_minor::text,
    'feeMinor',NULL,'priceKind',CASE WHEN price_minor IS NULL THEN 'unknown' ELSE 'starting_at' END,
    'availability',CASE rec->>'availability' WHEN 'cancelled' THEN 'unavailable' ELSE rec->>'availability' END,
    'observedAt',observed,'sourceUpdatedAt',source_updated,'validFrom',NULL,'validUntil',NULL,'contentHash',raw_hash,'sourcePayload',rec);
  offer_result:=biplan.accept_offer_revision(offer_payload,p_payload->>'expectedOfferRevisionId');
  IF offer_result->>'status'<>'accepted' THEN RAISE EXCEPTION 'canonical offer rejected: %',offer_result->>'reason'; END IF;
  INSERT INTO biplan.canonical_source_mappings(source_name,source_record_id,session_id,offer_id,observation_id)
    SELECT source_name,x,sid,oid,observation_id FROM unnest(ids)x ON CONFLICT DO NOTHING;
  IF EXISTS(SELECT 1 FROM biplan.canonical_source_mappings m WHERE m.source_name=canonical_accept.source_name
    AND m.source_record_id=ANY(ids) AND (m.session_id<>sid OR m.offer_id<>oid)) THEN RAISE EXCEPTION 'canonical mapping collision'; END IF;
  INSERT INTO biplan.canonical_heads(session_id,revision_id) VALUES(sid,revision_id)
    ON CONFLICT(session_id) DO UPDATE SET revision_id=EXCLUDED.revision_id;
  job_id:='canonical-base:'||revision_id;
  INSERT INTO biplan.preparation_jobs(id,stage,stage_version,subject_type,subject_id,input_hash,priority,checkpoint)
  VALUES(job_id,'canonical-base','1','session',sid,revision_id,100,jsonb_build_object('revisionId',revision_id));
  receipt:=jsonb_build_object('status','accepted','sessionId',sid,'revisionId',revision_id,'offerId',oid,
    'offerRevisionId',offer_revision_id,'jobId',job_id,'observationId',observation_id,'dependencyHash',dependency_hash,'idempotent',false);
  INSERT INTO biplan.canonical_requests(id,request_hash,payload,receipt) VALUES(req_id,request_hash,p_payload,receipt);
  RETURN receipt;
END $$;

CREATE OR REPLACE FUNCTION biplan.claim_canonical_preparation_jobs(
  p_worker_id text,p_batch_limit integer,p_lease_for interval DEFAULT interval '5 minutes'
) RETURNS SETOF biplan.preparation_jobs LANGUAGE plpgsql AS $$
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id)='' OR p_batch_limit IS NULL OR p_batch_limit NOT BETWEEN 1 AND 100
    OR p_lease_for IS NULL OR p_lease_for<=interval '0 seconds' OR p_lease_for>interval '15 minutes' THEN
    RAISE EXCEPTION 'invalid bounded canonical lease request'; END IF;
  WITH exhausted AS (
    SELECT id,fencing_token FROM biplan.preparation_jobs WHERE stage='canonical-base' AND stage_version='1'
      AND subject_type='session' AND state='leased' AND lease_expires_at<=clock_timestamp() AND attempt_count>=max_attempts
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT p_batch_limit
  ), attempts AS (
    UPDATE biplan.job_attempts a SET finished_at=clock_timestamp(),outcome='stale',details='{"reason":"attempts_exhausted"}'::jsonb
      FROM exhausted e WHERE a.job_id=e.id AND a.fencing_token=e.fencing_token AND a.finished_at IS NULL RETURNING a.job_id
  ) UPDATE biplan.preparation_jobs j SET state='failed',lease_owner=NULL,lease_expires_at=NULL,
      last_error='{"code":"attempts_exhausted","retryable":false}'::jsonb FROM exhausted e WHERE j.id=e.id;
  RETURN QUERY WITH candidates AS (
    SELECT id,fencing_token FROM biplan.preparation_jobs WHERE stage='canonical-base' AND stage_version='1'
      AND subject_type='session' AND attempt_count<max_attempts AND available_at<=clock_timestamp()
      AND (state='pending' OR (state='leased' AND lease_expires_at<=clock_timestamp()))
      ORDER BY priority DESC,created_at,id FOR UPDATE SKIP LOCKED LIMIT p_batch_limit
  ), stale AS (
    UPDATE biplan.job_attempts a SET finished_at=clock_timestamp(),outcome='stale',details='{"reason":"lease_reclaimed"}'::jsonb
      FROM candidates c WHERE a.job_id=c.id AND a.fencing_token=c.fencing_token AND a.finished_at IS NULL RETURNING a.job_id
  ), updated AS (
    UPDATE biplan.preparation_jobs j SET state='leased',lease_owner=p_worker_id,lease_expires_at=clock_timestamp()+p_lease_for,
      fencing_token=j.fencing_token+1,attempt_count=j.attempt_count+1,updated_at=clock_timestamp()
      FROM candidates c WHERE j.id=c.id RETURNING j.*
  ), attempts AS (
    INSERT INTO biplan.job_attempts(job_id,fencing_token,attempt_number,worker_id)
      SELECT id,fencing_token,attempt_count,p_worker_id FROM updated RETURNING job_id,fencing_token
  ) SELECT u.* FROM updated u JOIN attempts a ON a.job_id=u.id AND a.fencing_token=u.fencing_token;
END $$;

CREATE OR REPLACE FUNCTION biplan.canonical_preparation_input(p_job_id text,p_worker_id text,p_fence bigint)
RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE; r biplan.canonical_revisions%ROWTYPE;
BEGIN
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job_id;
  IF NOT FOUND OR j.stage<>'canonical-base' OR j.stage_version<>'1' OR j.subject_type<>'session'
    OR j.state<>'leased' OR j.lease_owner IS DISTINCT FROM p_worker_id OR j.fencing_token IS DISTINCT FROM p_fence
    OR j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'unsupported stage or stale canonical lease'; END IF;
  SELECT * INTO r FROM biplan.canonical_revisions WHERE id=j.input_hash AND session_id=j.subject_id;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM biplan.canonical_heads WHERE session_id=r.session_id AND revision_id=r.id)
    THEN RAISE EXCEPTION 'canonical dependency head changed'; END IF;
  RETURN jsonb_build_object('revisionId',r.id,'sessionId',r.session_id,'facts',r.facts,'dependencyHash',r.dependency_hash);
END $$;

CREATE OR REPLACE FUNCTION biplan.fail_canonical_preparation_job(p_job_id text,p_worker_id text,p_fence bigint,p_error jsonb)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j biplan.preparation_jobs%ROWTYPE; next_state text;
BEGIN
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.stage<>'canonical-base' OR j.stage_version<>'1' OR j.state<>'leased'
    OR j.lease_owner IS DISTINCT FROM p_worker_id OR j.fencing_token IS DISTINCT FROM p_fence
    OR j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale canonical failure'; END IF;
  next_state:=CASE WHEN p_error->>'retryable'='true' AND j.attempt_count<j.max_attempts THEN 'pending' ELSE 'failed' END;
  UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='failed',details=p_error,cost_units=0
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker_id AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing canonical attempt'; END IF;
  UPDATE biplan.preparation_jobs SET state=next_state,lease_owner=NULL,lease_expires_at=NULL,last_error=p_error,
    updated_at=clock_timestamp() WHERE id=j.id;
  RETURN jsonb_build_object('status',next_state,'jobId',j.id);
END $$;

CREATE OR REPLACE FUNCTION biplan.complete_canonical_preparation_job(
  p_job_id text,p_worker_id text,p_fence bigint,p_result jsonb,p_expected_base_publication_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
#variable_conflict use_variable
DECLARE j biplan.preparation_jobs%ROWTYPE; r biplan.canonical_revisions%ROWTYPE; s biplan.sessions%ROWTYPE;
  base biplan.publications%ROWTYPE; active_id text; target_id text; doc_id text; doc_hash text;
  cached biplan.search_documents%ROWTYPE; snap jsonb; manifest jsonb; receipt jsonb;
  terms jsonb; raws jsonb; heads jsonb; summary jsonb; keep_ids text[];
  session_count integer; offer_count integer; eval_count integer; v_result_hash text:=md5(p_result::text);
BEGIN
  -- Active -> offers -> job -> canonical rows. Acceptance takes offers before rows
  -- and never active; offer-only refresh uses the same active -> offers order.
  PERFORM pg_advisory_xact_lock(hashtextextended('biplan.active_publication',0));
  LOCK TABLE biplan.offer_identities IN SHARE MODE;
  SELECT * INTO j FROM biplan.preparation_jobs WHERE id=p_job_id FOR UPDATE;
  IF NOT FOUND OR j.stage<>'canonical-base' OR j.stage_version<>'1' OR j.subject_type<>'session' THEN RAISE EXCEPTION 'unsupported canonical completion stage'; END IF;
  IF j.state='succeeded' AND j.fencing_token=p_fence AND EXISTS(SELECT 1 FROM biplan.job_attempts
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker_id AND outcome='succeeded') THEN
    IF j.checkpoint->>'resultHash' IS DISTINCT FROM v_result_hash THEN RAISE EXCEPTION 'canonical completion replay result changed'; END IF;
    RETURN j.checkpoint||jsonb_build_object('idempotent',true);
  END IF;
  IF j.state<>'leased' OR j.lease_owner IS DISTINCT FROM p_worker_id OR j.fencing_token IS DISTINCT FROM p_fence
    OR j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'stale canonical completion lease'; END IF;
  SELECT publication_id INTO active_id FROM biplan.active_publication WHERE singleton FOR UPDATE;
  IF active_id IS DISTINCT FROM p_expected_base_publication_id THEN RAISE EXCEPTION 'active publication guard failed'; END IF;
  SELECT * INTO base FROM biplan.publications WHERE id=active_id;
  SELECT * INTO r FROM biplan.canonical_revisions WHERE id=j.input_hash AND session_id=j.subject_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'canonical revision missing'; END IF;
  PERFORM 1 FROM biplan.canonical_heads WHERE session_id=r.session_id AND revision_id=r.id FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'canonical dependency head changed'; END IF;
  SELECT * INTO s FROM biplan.sessions WHERE id=r.session_id FOR SHARE;
  IF NOT FOUND OR s.content_hash<>r.semantic_hash THEN RAISE EXCEPTION 'canonical typed facts changed'; END IF;
  IF s.status='scheduled' AND (biplan.canonical_offer_support(s.id,r.facts)->>'usable') IS DISTINCT FROM 'true' THEN
    RAISE EXCEPTION 'canonical offer occurrence evidence is conflicting, disputed or unknown';
  END IF;
  IF jsonb_typeof(p_result) IS DISTINCT FROM 'object'
    OR p_result->>'documentProfile' IS DISTINCT FROM 'event-title-category-venue-description-v1'
    OR p_result->>'dependencyHash' IS DISTINCT FROM r.dependency_hash
    OR COALESCE(p_result->>'documentText','')='' OR length(p_result->>'documentText')>100000
    OR jsonb_typeof(p_result->'lexicalTokens') IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_result->'lexicalTokens') x WHERE jsonb_typeof(x)<>'string')
    THEN RAISE EXCEPTION 'invalid canonical document result'; END IF;
  doc_hash:=encode(sha256(convert_to(p_result->>'documentText','UTF8')),'hex');
  IF p_result->>'documentHash' IS DISTINCT FROM doc_hash THEN RAISE EXCEPTION 'canonical document hash mismatch'; END IF;
  -- Cache reuse is exact text/hash plus document and embedding profile compatibility.
  SELECT * INTO cached FROM biplan.search_documents d WHERE d.document_hash=doc_hash
    AND d.document_text=p_result->>'documentText' AND d.document_profile=p_result->>'documentProfile'
    AND d.embedding IS NOT NULL AND d.embedding_profile=base.required_embedding_profile ORDER BY d.id LIMIT 1;
  doc_id:='canonical-document:'||md5(jsonb_build_array(r.session_id,doc_hash,r.dependency_hash,
    p_result->>'documentProfile',cached.embedding_profile)::text);
  INSERT INTO biplan.search_documents(id,subject_type,subject_id,document_profile,embedding_profile,document_text,document_hash,dependency_hash,embedding)
  VALUES(doc_id,'session',r.session_id,p_result->>'documentProfile',cached.embedding_profile,p_result->>'documentText',doc_hash,r.dependency_hash,cached.embedding)
    ON CONFLICT DO NOTHING;
  SELECT id INTO doc_id FROM biplan.search_documents d WHERE subject_type='session' AND subject_id=r.session_id
    AND document_profile=p_result->>'documentProfile' AND document_hash=doc_hash AND dependency_hash=r.dependency_hash
    AND embedding_profile IS NOT DISTINCT FROM cached.embedding_profile;
  IF doc_id IS NULL THEN RAISE EXCEPTION 'canonical document version collision'; END IF;
  INSERT INTO biplan.canonical_preparations(revision_id,document_id,result,result_hash)
    VALUES(r.id,doc_id,p_result,v_result_hash);
  IF EXISTS(SELECT 1 FROM biplan.offer_identities i LEFT JOIN biplan.offer_revisions v
    ON v.id=i.current_revision_id AND v.offer_id=i.id AND v.session_id=i.session_id AND v.acceptance_status='accepted'
    WHERE i.session_id=s.id AND v.id IS NULL) THEN RAISE EXCEPTION 'canonical current offer head missing'; END IF;
  SELECT jsonb_agg(biplan.offer_revision_term(v.id) ORDER BY i.id),jsonb_agg(v.source_payload ORDER BY i.id),
    jsonb_object_agg(i.id,v.id ORDER BY i.id) INTO terms,raws,heads
    FROM biplan.offer_identities i JOIN biplan.offer_revisions v ON v.id=i.current_revision_id WHERE i.session_id=s.id;
  IF terms IS NULL THEN RAISE EXCEPTION 'canonical session requires offer evidence'; END IF;
  SELECT jsonb_build_object('availability',CASE WHEN bool_or(eligible) THEN 'available'
      WHEN bool_and(fresh AND availability IN ('sold_out','unavailable')) THEN 'unavailable' ELSE 'unknown' END,
    'displayPrice',min(price_minor) FILTER(WHERE eligible)/100.0,
    'displayPriceMinor',(min(price_minor) FILTER(WHERE eligible))::text,
    'currency',CASE WHEN bool_or(eligible) THEN 'TRY' END,
    'displayPriceIsHardBudgetTotal',false,
    'sourceUrl',(array_agg(source_url ORDER BY price_minor,id) FILTER(WHERE eligible))[1]) INTO summary
  FROM (SELECT v.*,v.observed_at<=clock_timestamp() AND v.observed_at>=clock_timestamp()-interval '3 days'
      AND (v.valid_from IS NULL OR v.valid_from<=clock_timestamp()) AND (v.valid_until IS NULL OR v.valid_until>=clock_timestamp()) fresh,
    v.currency='TRY' AND v.price_minor IS NOT NULL AND (v.price IS NULL OR v.price*100=v.price_minor)
      AND v.availability IN ('available','limited') AND v.price_kind<>'unknown'
      AND v.observed_at<=clock_timestamp() AND v.observed_at>=clock_timestamp()-interval '3 days'
      AND (v.valid_from IS NULL OR v.valid_from<=clock_timestamp()) AND (v.valid_until IS NULL OR v.valid_until>=clock_timestamp()) eligible
    FROM biplan.offer_identities i JOIN biplan.offer_revisions v ON v.id=i.current_revision_id WHERE i.session_id=s.id) q;
  snap:=r.facts||jsonb_build_object('id',s.id,'source',r.source_name,'sourceSessionIds',to_jsonb(s.source_session_ids),
    'checkedAt',r.observed_at,'canonicalRevisionId',r.id,'canonicalDependencyHash',r.dependency_hash,
    'offers',raws,'offerTerms',terms,'offerTermsVersion',1,'offerSummary',summary,
    'availability',summary->'availability','price',summary->'displayPrice','currency',summary->'currency','url',summary->'sourceUrl',
    'preparedSearch',jsonb_build_object('version',1,'documentText',p_result->'documentText','documentHash',doc_hash,'lexicalTokens',p_result->'lexicalTokens'),
    'indexingStatus',CASE WHEN cached.embedding IS NULL THEN 'lexical_only' ELSE 'cached_vector' END,'qualityStatus','unknown');
  -- Prune all canceled carried sessions. Other frozen rows remain pinned and final
  -- revalidation withholds a changed head until its own bounded preparation finishes.
  SELECT COALESCE(array_agg(ps.session_id),'{}') INTO keep_ids FROM biplan.published_sessions ps
    JOIN biplan.sessions cs ON cs.id=ps.session_id WHERE ps.publication_id=active_id AND ps.session_id<>s.id AND cs.status<>'canceled';
  session_count:=cardinality(keep_ids)+CASE WHEN s.status='scheduled' THEN 1 ELSE 0 END;
  SELECT count(*) INTO offer_count FROM biplan.publication_offers WHERE publication_id=active_id AND session_id=ANY(keep_ids);
  IF s.status='scheduled' THEN offer_count:=offer_count+jsonb_array_length(terms); END IF;
  SELECT count(*) INTO eval_count FROM biplan.publication_evaluations pe JOIN biplan.evaluations e ON e.id=pe.evaluation_id
    WHERE pe.publication_id=active_id AND e.status<>'complete' AND NOT(e.subject_type='session' AND e.subject_id=s.id);
  target_id:='canonical-publication:'||md5(j.id);
  manifest:=jsonb_build_object('schemaVersion',5,'kind','canonical-base','basePublicationId',active_id,'revisionId',r.id,
    'affectedSessionId',s.id,'capturedOfferHeads',heads,'requiredOfferCount',offer_count,'requiredEvaluationCount',eval_count,
    'evaluationInvalidationReason','canonical_dependencies_changed_completed_evaluations_not_reused');
  INSERT INTO biplan.publications(id,state,manifest,manifest_hash,required_session_count,required_document_count,required_embedding_profile)
    VALUES(target_id,'candidate',manifest,md5(manifest::text),session_count,session_count,base.required_embedding_profile);
  INSERT INTO biplan.published_sessions SELECT target_id,session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot
    FROM biplan.published_sessions WHERE publication_id=active_id AND session_id=ANY(keep_ids);
  INSERT INTO biplan.publication_offers SELECT target_id,session_id,offer_revision_id FROM biplan.publication_offers
    WHERE publication_id=active_id AND session_id=ANY(keep_ids);
  IF s.status='scheduled' THEN
    INSERT INTO biplan.published_sessions VALUES(target_id,s.id,s.production_id,s.venue_id,doc_id,md5(snap::text),snap);
    INSERT INTO biplan.publication_offers SELECT target_id,s.id,current_revision_id FROM biplan.offer_identities WHERE session_id=s.id;
  END IF;
  INSERT INTO biplan.publication_evaluations SELECT target_id,pe.evaluation_id FROM biplan.publication_evaluations pe
    JOIN biplan.evaluations e ON e.id=pe.evaluation_id WHERE pe.publication_id=active_id AND e.status<>'complete'
    AND NOT(e.subject_type='session' AND e.subject_id=s.id);
  PERFORM biplan.validate_publication_offers(target_id);
  UPDATE biplan.publications SET state='validated',validated_at=clock_timestamp(),validation_hash=md5(manifest::text||':validated') WHERE id=target_id;
  IF j.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'canonical lease expired before activation'; END IF;
  PERFORM biplan.activate_publication(target_id,active_id);
  receipt:=jsonb_build_object('status','completed','jobId',j.id,'revisionId',r.id,'sessionId',s.id,
    'basePublicationId',active_id,'resultPublicationId',target_id,'documentId',doc_id,'resultHash',v_result_hash,
    'indexingStatus',snap->'indexingStatus','idempotent',false);
  UPDATE biplan.job_attempts SET finished_at=clock_timestamp(),outcome='succeeded',cost_units=0,details=receipt
    WHERE job_id=j.id AND fencing_token=p_fence AND worker_id=p_worker_id AND finished_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing canonical completion attempt'; END IF;
  UPDATE biplan.preparation_jobs SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,checkpoint=receipt,updated_at=clock_timestamp()
    WHERE id=j.id AND state='leased' AND fencing_token=p_fence AND lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'canonical lease expired during completion'; END IF;
  RETURN receipt;
END $$;

-- Keep SQL004's implementation intact. Wrappers add canonical pins while legacy
-- snapshots without a canonical head retain exactly the previous null semantics.
DO $wrappers$
DECLARE definition text;
BEGIN
  IF to_regprocedure('biplan.current_publication_offer_status_v4(text,text,timestamp with time zone,interval)') IS NULL THEN
    SELECT pg_get_functiondef('biplan.current_publication_offer_status(text,text,timestamp with time zone,interval)'::regprocedure) INTO definition;
    EXECUTE replace(definition,'FUNCTION biplan.current_publication_offer_status(','FUNCTION biplan.current_publication_offer_status_v4(');
  END IF;
  IF to_regprocedure('biplan.refresh_publication_request_v4(text,text,bigint,text)') IS NULL THEN
    SELECT pg_get_functiondef('biplan.refresh_publication_request(text,text,bigint,text)'::regprocedure) INTO definition;
    EXECUTE replace(definition,'FUNCTION biplan.refresh_publication_request(','FUNCTION biplan.refresh_publication_request_v4(');
  END IF;
END $wrappers$;
CREATE OR REPLACE FUNCTION biplan.current_publication_offer_status(
  p_publication_id text,p_session_id text,p_checked_at timestamptz DEFAULT clock_timestamp(),p_max_age interval DEFAULT interval '72 hours'
) RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE result jsonb; head text; pinned text; support jsonb; facts jsonb;
BEGIN
  result:=biplan.current_publication_offer_status_v4(p_publication_id,p_session_id,p_checked_at,p_max_age);
  SELECT revision_id INTO head FROM biplan.canonical_heads WHERE session_id=p_session_id;
  SELECT eligibility_snapshot->>'canonicalRevisionId',eligibility_snapshot INTO pinned,facts FROM biplan.published_sessions
    WHERE publication_id=p_publication_id AND session_id=p_session_id;
  support:=biplan.canonical_offer_support(p_session_id,facts);
  IF head IS DISTINCT FROM pinned THEN
    result:=result||jsonb_build_object('usable',false,'availabilityUsable',false,'verifiedTotalEligible',false,
      'canonicalSessionUsable',false,'status','unusable','reasons',(result->'reasons')||'["canonical_revision_changed"]'::jsonb);
  END IF;
  IF support->>'usable' IS DISTINCT FROM 'true' THEN
    result:=result||jsonb_build_object('usable',false,'availabilityUsable',false,'verifiedTotalEligible',false,
      'canonicalSessionUsable',false,'status','unusable','reasons',(result->'reasons')||'["canonical_offer_occurrence_unproven"]'::jsonb);
  END IF;
  result:=result||jsonb_build_object('canonicalOfferSupport',support);
  RETURN result;
END $$;
CREATE OR REPLACE FUNCTION biplan.refresh_publication_request(
  p_request_id text,p_worker_id text,p_fence bigint,p_expected_base_publication_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE sid text; head text; pinned text; completed boolean; facts jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('biplan.active_publication',0));
  LOCK TABLE biplan.offer_identities IN SHARE MODE;
  SELECT v.session_id,q.state='completed' INTO sid,completed FROM biplan.publication_refresh_requests q
    JOIN biplan.offer_revisions v ON v.id=q.offer_revision_id WHERE q.id=p_request_id;
  IF completed IS NOT TRUE THEN
    SELECT revision_id INTO head FROM biplan.canonical_heads WHERE session_id=sid;
    SELECT eligibility_snapshot->>'canonicalRevisionId',eligibility_snapshot INTO pinned,facts FROM biplan.published_sessions
      WHERE publication_id=p_expected_base_publication_id AND session_id=sid;
    IF head IS DISTINCT FROM pinned THEN RAISE EXCEPTION 'canonical preparation required before offer refresh'; END IF;
    IF facts IS NOT NULL AND (biplan.canonical_offer_support(sid,facts)->>'usable') IS DISTINCT FROM 'true' THEN
      RAISE EXCEPTION 'canonical offer occurrence evidence is conflicting, disputed or unknown'; END IF;
  END IF;
  RETURN biplan.refresh_publication_request_v4(p_request_id,p_worker_id,p_fence,p_expected_base_publication_id);
END $$;

INSERT INTO biplan.schema_migrations(version,migration_hash)
VALUES('005-canonical-preparation','005-canonical-preparation-v1') ON CONFLICT(version) DO NOTHING;
COMMIT;
