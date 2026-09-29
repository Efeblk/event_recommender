BEGIN;

DO $guard$
DECLARE base_version integer;
BEGIN
  SELECT schema_version INTO base_version FROM biplan.schema_metadata WHERE singleton;
  IF base_version IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'offer revision migration requires biplan base schema version 1, found %', base_version;
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS biplan.schema_migrations (
  version text PRIMARY KEY,
  migration_hash text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DO $guard$
DECLARE installed_hash text;
BEGIN
  SELECT migration_hash INTO installed_hash
  FROM biplan.schema_migrations WHERE version = '002-offer-revisions';
  IF installed_hash IS NOT NULL AND installed_hash <> '002-offer-revisions-v1' THEN
    RAISE EXCEPTION 'incompatible installed migration 002-offer-revisions: %', installed_hash;
  END IF;
END
$guard$;

CREATE TABLE IF NOT EXISTS biplan.offer_identities (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES biplan.sessions(id),
  provider text NOT NULL CHECK (btrim(provider) <> ''),
  provider_record_id text NOT NULL CHECK (btrim(provider_record_id) <> ''),
  provider_session_id text,
  ticket_tier_id text,
  current_revision_id text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE NULLS NOT DISTINCT (provider, provider_record_id, ticket_tier_id)
);

CREATE TABLE IF NOT EXISTS biplan.offer_revisions (
  id text PRIMARY KEY,
  offer_id text NOT NULL REFERENCES biplan.offer_identities(id),
  session_id text NOT NULL REFERENCES biplan.sessions(id),
  provider text NOT NULL CHECK (btrim(provider) <> ''),
  provider_record_id text NOT NULL CHECK (btrim(provider_record_id) <> ''),
  source_session_ids text[] NOT NULL DEFAULT '{}',
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
  supplied_content_hash text NOT NULL,
  server_content_hash text NOT NULL,
  semantic_content_hash text NOT NULL,
  immutable_record_hash text NOT NULL,
  source_payload jsonb NOT NULL CHECK (jsonb_typeof(source_payload) = 'object'),
  acceptance_status text NOT NULL
    CHECK (acceptance_status IN ('accepted','held_stale','held_conflict')),
  held_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (valid_until IS NULL OR valid_from IS NULL OR valid_until >= valid_from),
  CHECK ((acceptance_status = 'accepted') = (held_reason IS NULL))
);
ALTER TABLE biplan.offer_revisions ADD COLUMN IF NOT EXISTS provider_session_id text;
ALTER TABLE biplan.offer_revisions ADD COLUMN IF NOT EXISTS semantic_content_hash text;
CREATE INDEX IF NOT EXISTS offer_revisions_offer_chronology_idx
  ON biplan.offer_revisions(offer_id, source_updated_at DESC NULLS LAST, observed_at DESC);

DO $constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'biplan.offer_identities'::regclass
      AND conname = 'offer_identities_current_revision_fkey'
  ) THEN
    ALTER TABLE biplan.offer_identities
      ADD CONSTRAINT offer_identities_current_revision_fkey
      FOREIGN KEY (current_revision_id) REFERENCES biplan.offer_revisions(id) NOT VALID;
  END IF;
END
$constraint$;

CREATE TABLE IF NOT EXISTS biplan.publication_offers (
  publication_id text NOT NULL REFERENCES biplan.publications(id),
  session_id text NOT NULL REFERENCES biplan.sessions(id),
  offer_revision_id text NOT NULL REFERENCES biplan.offer_revisions(id),
  PRIMARY KEY (publication_id, session_id, offer_revision_id)
);

-- Preserve the frozen milestone as initial immutable revisions. Stable and revision
-- IDs intentionally retain the legacy ID so callers can trace the migration exactly.
INSERT INTO biplan.offer_identities(
  id, session_id, provider, provider_record_id, ticket_tier_id
)
SELECT id, session_id, provider, provider_record_id, ticket_tier_id
FROM biplan.provider_offers legacy
WHERE NOT EXISTS (SELECT 1 FROM biplan.offer_identities current WHERE current.id = legacy.id);

INSERT INTO biplan.offer_revisions(
  id, offer_id, session_id, provider, provider_record_id, source_session_ids,
  provider_session_id, source_url, ticket_tier_id, ticket_tier_name, currency, price, price_minor,
  fee_minor, price_kind, availability, observed_at, source_updated_at, valid_from,
  valid_until, supplied_content_hash, server_content_hash, semantic_content_hash, immutable_record_hash, source_payload,
  acceptance_status
)
SELECT id, id, session_id, provider, provider_record_id, source_session_ids,
  provider_session_id, source_url, ticket_tier_id, ticket_tier_name, currency, price, price_minor,
  fee_minor, price_kind, availability, observed_at, source_updated_at, valid_from,
  valid_until, content_hash, md5(source_payload::text),
  md5(jsonb_build_object(
    'sessionId',session_id,'provider',provider,'providerRecordId',provider_record_id,
    'providerSessionId',provider_session_id,'sourceSessionIds',to_jsonb(source_session_ids),
    'sourceUrl',source_url,'ticketTierId',ticket_tier_id,'ticketTierName',ticket_tier_name,
    'currency',currency,'price',price,'priceMinor',price_minor,'feeMinor',fee_minor,
    'priceKind',price_kind,'availability',availability,'validFrom',valid_from,
    'validUntil',valid_until,'contentHash',content_hash,'sourcePayload',source_payload
  )::text), md5(to_jsonb(legacy)::text), source_payload, 'accepted'
FROM biplan.provider_offers legacy
WHERE NOT EXISTS (SELECT 1 FROM biplan.offer_revisions revision WHERE revision.id = legacy.id);

-- This compatibility branch is reachable only when completing an interrupted
-- development application of this same migration. The strict trigger is restored
-- below in the same transaction.
SELECT set_config('biplan.offer_revision_migration', '002', true);
CREATE OR REPLACE FUNCTION biplan.reject_immutable_offer_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('biplan.offer_revision_migration', true) = '002' THEN RETURN NEW; END IF;
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END $$;
UPDATE biplan.offer_revisions revision
SET provider_session_id = legacy.provider_session_id,
    semantic_content_hash = md5(jsonb_build_object(
      'sessionId',legacy.session_id,'provider',legacy.provider,'providerRecordId',legacy.provider_record_id,
      'providerSessionId',legacy.provider_session_id,'sourceSessionIds',to_jsonb(legacy.source_session_ids),
      'sourceUrl',legacy.source_url,'ticketTierId',legacy.ticket_tier_id,'ticketTierName',legacy.ticket_tier_name,
      'currency',legacy.currency,'price',legacy.price,'priceMinor',legacy.price_minor,'feeMinor',legacy.fee_minor,
      'priceKind',legacy.price_kind,'availability',legacy.availability,'validFrom',legacy.valid_from,
      'validUntil',legacy.valid_until,'contentHash',legacy.content_hash,'sourcePayload',legacy.source_payload
    )::text)
FROM biplan.provider_offers legacy
WHERE revision.id = legacy.id AND revision.offer_id = legacy.id
  AND revision.semantic_content_hash IS NULL;
ALTER TABLE biplan.offer_revisions ALTER COLUMN semantic_content_hash SET NOT NULL;

UPDATE biplan.offer_identities identity
SET current_revision_id = identity.id, updated_at = clock_timestamp()
WHERE identity.current_revision_id IS NULL
  AND EXISTS (SELECT 1 FROM biplan.offer_revisions revision WHERE revision.id = identity.id);

-- Pin only exact raw offer snapshots. Missing/ambiguous matches stay unlinked and are
-- surfaced by validation; the migration never substitutes the current revision.
INSERT INTO biplan.publication_offers(publication_id, session_id, offer_revision_id)
SELECT DISTINCT published.publication_id, published.session_id, revision.id
FROM biplan.published_sessions published
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(published.eligibility_snapshot->'offers') = 'array'
    THEN published.eligibility_snapshot->'offers' ELSE '[]'::jsonb END
) snapshot_offer
JOIN biplan.offer_revisions revision
  ON revision.session_id = published.session_id
JOIN biplan.provider_offers legacy
  ON legacy.id = revision.id AND revision.offer_id = legacy.id
 AND legacy.session_id = published.session_id
 AND legacy.source_payload = snapshot_offer.value
WHERE NOT EXISTS (
  SELECT 1 FROM biplan.publication_offers pinned
  WHERE pinned.publication_id = published.publication_id
    AND pinned.session_id = published.session_id
    AND pinned.offer_revision_id = revision.id
)
AND NOT EXISTS (
  SELECT 1 FROM biplan.schema_migrations WHERE version = '002-offer-revisions'
);

CREATE OR REPLACE FUNCTION biplan.reject_immutable_offer_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
END $$;
CREATE OR REPLACE TRIGGER offer_revisions_immutable
BEFORE UPDATE OR DELETE ON biplan.offer_revisions
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_offer_revision();
CREATE OR REPLACE TRIGGER publication_offers_immutable
BEFORE UPDATE OR DELETE ON biplan.publication_offers
FOR EACH ROW EXECUTE FUNCTION biplan.reject_immutable_offer_revision();
CREATE OR REPLACE FUNCTION biplan.protect_candidate_publication_offer() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE publication_state text;
BEGIN
  SELECT state INTO publication_state FROM biplan.publications
  WHERE id = NEW.publication_id FOR SHARE;
  IF publication_state IS DISTINCT FROM 'candidate' THEN
    RAISE EXCEPTION 'cannot append offer rows to non-candidate publication %', NEW.publication_id;
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER publication_offers_candidate_only
BEFORE INSERT ON biplan.publication_offers
FOR EACH ROW EXECUTE FUNCTION biplan.protect_candidate_publication_offer();

CREATE OR REPLACE FUNCTION biplan.accept_offer_revision(
  payload jsonb, expected_current_revision_id text
) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE
  identity biplan.offer_identities%ROWTYPE;
  current_revision biplan.offer_revisions%ROWTYPE;
  revision_id text := payload->>'revisionId';
  identity_id text := payload->>'offerId';
  payload_session_id text := payload->>'sessionId';
  payload_provider text := payload->>'provider';
  payload_record_id text := payload->>'providerRecordId';
  payload_tier_id text := payload->>'ticketTierId';
  payload_observed_at timestamptz := (payload->>'observedAt')::timestamptz;
  payload_source_updated_at timestamptz := (payload->>'sourceUpdatedAt')::timestamptz;
  payload_raw jsonb := payload->'sourcePayload';
  supplied_hash text := payload->>'contentHash';
  computed_hash text;
  semantic_hash text;
  record_hash text;
  decision text := 'accepted';
  reason text;
  prior biplan.offer_revisions%ROWTYPE;
BEGIN
  IF jsonb_typeof(payload) <> 'object' OR revision_id IS NULL OR identity_id IS NULL
     OR payload_session_id IS NULL OR payload_provider IS NULL OR payload_record_id IS NULL
     OR payload_observed_at IS NULL OR supplied_hash IS NULL
     OR jsonb_typeof(payload_raw) <> 'object' THEN
    RAISE EXCEPTION 'offer revision payload is missing a required typed field';
  END IF;
  computed_hash := md5(payload_raw::text);
  semantic_hash := md5(jsonb_build_object(
    'sessionId',payload->'sessionId','provider',payload->'provider',
    'providerRecordId',payload->'providerRecordId','providerSessionId',payload->'providerSessionId',
    'sourceSessionIds',COALESCE(payload->'sourceSessionIds','[]'::jsonb),
    'sourceUrl',payload->'sourceUrl','ticketTierId',payload->'ticketTierId',
    'ticketTierName',payload->'ticketTierName','currency',payload->'currency',
    'price',payload->'price','priceMinor',payload->'priceMinor','feeMinor',payload->'feeMinor',
    'priceKind',to_jsonb(COALESCE(payload->>'priceKind','unknown')),
    'availability',to_jsonb(COALESCE(payload->>'availability','unknown')),
    'validFrom',payload->'validFrom','validUntil',payload->'validUntil',
    'contentHash',payload->'contentHash','sourcePayload',payload_raw
  )::text);
  record_hash := md5((payload - 'contentHash')::text);

  -- Row locks cannot serialize an identity that does not exist yet.
  PERFORM pg_advisory_xact_lock(hashtextextended('biplan.offer:' || identity_id, 0));

  SELECT * INTO prior FROM biplan.offer_revisions WHERE id = revision_id;
  IF FOUND THEN
    IF prior.offer_id IS DISTINCT FROM identity_id
       OR prior.supplied_content_hash IS DISTINCT FROM supplied_hash
       OR prior.server_content_hash IS DISTINCT FROM computed_hash
       OR prior.semantic_content_hash IS DISTINCT FROM semantic_hash
       OR prior.immutable_record_hash IS DISTINCT FROM record_hash THEN
      RAISE EXCEPTION 'offer revision id % was reused with different identity or content', revision_id;
    END IF;
    RETURN jsonb_build_object('status', prior.acceptance_status, 'reason', prior.held_reason, 'offerId', identity_id,
      'revisionId', revision_id, 'currentRevisionId',
      (SELECT current_revision_id FROM biplan.offer_identities WHERE id = identity_id),
      'idempotent', true);
  END IF;

  SELECT * INTO identity FROM biplan.offer_identities WHERE id = identity_id FOR UPDATE;
  IF NOT FOUND THEN
    IF expected_current_revision_id IS NOT NULL THEN
      RAISE EXCEPTION 'new offer identity % requires a null expected current revision', identity_id;
    END IF;
    INSERT INTO biplan.offer_identities(id, session_id, provider, provider_record_id, ticket_tier_id)
    VALUES(identity_id, payload_session_id, payload_provider, payload_record_id, payload_tier_id)
    RETURNING * INTO identity;
  ELSIF identity.session_id IS DISTINCT FROM payload_session_id
     OR identity.provider IS DISTINCT FROM payload_provider
     OR identity.provider_record_id IS DISTINCT FROM payload_record_id
     OR identity.ticket_tier_id IS DISTINCT FROM payload_tier_id THEN
    RAISE EXCEPTION 'offer identity % cannot change session, provider, record, or tier', identity_id;
  END IF;

  IF identity.current_revision_id IS DISTINCT FROM expected_current_revision_id THEN
    RAISE EXCEPTION 'offer revision guard failed for %: expected %, found %',
      identity_id, expected_current_revision_id, identity.current_revision_id;
  END IF;
  IF identity.current_revision_id IS NOT NULL THEN
    SELECT * INTO current_revision FROM biplan.offer_revisions
    WHERE id = identity.current_revision_id;
    IF current_revision.source_updated_at IS NOT NULL AND payload_source_updated_at IS NULL THEN
      decision := 'held_conflict'; reason := 'source_updated_at_missing_against_versioned_current';
    ELSIF current_revision.source_updated_at IS NOT NULL
       AND payload_source_updated_at < current_revision.source_updated_at THEN
      decision := 'held_stale'; reason := 'source_updated_at_older_than_current';
    ELSIF current_revision.source_updated_at IS NOT NULL
       AND payload_source_updated_at = current_revision.source_updated_at
       AND current_revision.semantic_content_hash IS DISTINCT FROM semantic_hash THEN
      decision := 'held_conflict'; reason := 'same_source_version_has_different_content';
    ELSIF current_revision.source_updated_at IS NOT NULL
       AND payload_source_updated_at = current_revision.source_updated_at
       AND payload_observed_at < current_revision.observed_at THEN
      decision := 'held_stale'; reason := 'observed_at_older_at_same_source_version';
    ELSIF current_revision.source_updated_at IS NULL AND payload_source_updated_at IS NULL
       AND payload_observed_at < current_revision.observed_at THEN
      decision := 'held_stale'; reason := 'observed_at_older_without_source_version';
    ELSIF current_revision.source_updated_at IS NULL AND payload_source_updated_at IS NULL
       AND payload_observed_at = current_revision.observed_at
       AND current_revision.semantic_content_hash IS DISTINCT FROM semantic_hash THEN
      decision := 'held_conflict'; reason := 'same_observation_time_has_different_content';
    END IF;
  END IF;

  INSERT INTO biplan.offer_revisions(
    id, offer_id, session_id, provider, provider_record_id, source_session_ids,
    provider_session_id, source_url, ticket_tier_id, ticket_tier_name, currency, price, price_minor,
    fee_minor, price_kind, availability, observed_at, source_updated_at, valid_from,
    valid_until, supplied_content_hash, server_content_hash, semantic_content_hash, immutable_record_hash, source_payload,
    acceptance_status, held_reason
  ) VALUES (
    revision_id, identity_id, payload_session_id, payload_provider, payload_record_id,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(payload->'sourceSessionIds','[]'::jsonb))),
    payload->>'providerSessionId', payload->>'sourceUrl', payload_tier_id, payload->>'ticketTierName', payload->>'currency',
    (payload->>'price')::numeric, (payload->>'priceMinor')::bigint,
    (payload->>'feeMinor')::bigint, COALESCE(payload->>'priceKind','unknown'),
    COALESCE(payload->>'availability','unknown'), payload_observed_at,
    payload_source_updated_at, (payload->>'validFrom')::timestamptz,
    (payload->>'validUntil')::timestamptz, supplied_hash, computed_hash, semantic_hash, record_hash, payload_raw,
    decision, reason
  );

  IF decision = 'accepted' THEN
    UPDATE biplan.offer_identities SET current_revision_id = revision_id,
      updated_at = clock_timestamp() WHERE id = identity_id;
    -- Derived work is content-addressed: a fresh A -> B -> A observation advances
    -- the head and emits a revision outbox event, but reuses A's prior derivation.
    INSERT INTO biplan.preparation_jobs(
      id, stage, stage_version, subject_type, subject_id, input_hash
    ) VALUES (
      'offer-revision:' || revision_id, 'offer_revision_accepted', '1',
      'offer', identity_id, semantic_hash
    ) ON CONFLICT (stage, stage_version, subject_type, subject_id, input_hash) DO NOTHING;
    INSERT INTO biplan.outbox(
      id, topic, aggregate_type, aggregate_id, payload, idempotency_key
    ) VALUES (
      'offer-revision:' || revision_id, 'offer.revision.accepted', 'offer', identity_id,
      jsonb_build_object('offerId', identity_id, 'revisionId', revision_id),
      'offer.revision.accepted:' || revision_id
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('status', decision, 'reason', reason, 'offerId', identity_id,
    'revisionId', revision_id, 'currentRevisionId',
    CASE WHEN decision = 'accepted' THEN revision_id ELSE identity.current_revision_id END,
    'idempotent', false);
END $$;

CREATE OR REPLACE FUNCTION biplan.validate_publication_offers(p_publication_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE publication biplan.publications%ROWTYPE; required_count integer; actual_count integer;
BEGIN
  SELECT * INTO publication FROM biplan.publications WHERE id = p_publication_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'publication % does not exist', p_publication_id; END IF;
  IF EXISTS (
    SELECT 1 FROM biplan.publication_offers pinned
    JOIN biplan.offer_revisions revision ON revision.id = pinned.offer_revision_id
    LEFT JOIN biplan.published_sessions published
      ON published.publication_id = pinned.publication_id AND published.session_id = pinned.session_id
    WHERE pinned.publication_id = p_publication_id
      AND (pinned.session_id IS DISTINCT FROM revision.session_id
        OR revision.acceptance_status <> 'accepted' OR published.session_id IS NULL)
  ) THEN RAISE EXCEPTION 'publication % has an invalid offer revision link', p_publication_id; END IF;
  IF EXISTS (
    SELECT 1
    FROM biplan.published_sessions published
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(published.eligibility_snapshot->'offers') = 'array'
        THEN published.eligibility_snapshot->'offers' ELSE '[]'::jsonb END
    ) snapshot_offer
    WHERE published.publication_id = p_publication_id
      AND 1 <> (
        SELECT count(*) FROM biplan.publication_offers pinned
        JOIN biplan.offer_revisions revision ON revision.id = pinned.offer_revision_id
        WHERE pinned.publication_id = published.publication_id
          AND pinned.session_id = published.session_id
          AND revision.source_payload = snapshot_offer.value
      )
  ) OR EXISTS (
    SELECT 1 FROM biplan.publication_offers pinned
    JOIN biplan.offer_revisions revision ON revision.id = pinned.offer_revision_id
    JOIN biplan.published_sessions published
      ON published.publication_id = pinned.publication_id AND published.session_id = pinned.session_id
    WHERE pinned.publication_id = p_publication_id
      AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(
          CASE WHEN jsonb_typeof(published.eligibility_snapshot->'offers') = 'array'
            THEN published.eligibility_snapshot->'offers' ELSE '[]'::jsonb END
        ) snapshot_offer WHERE snapshot_offer.value = revision.source_payload
      )
  ) THEN RAISE EXCEPTION 'publication % offer pins do not exactly cover its snapshots', p_publication_id; END IF;
  IF publication.manifest ? 'requiredOfferCount' THEN
    required_count := (publication.manifest->>'requiredOfferCount')::integer;
    IF required_count < 0 THEN RAISE EXCEPTION 'publication % has a negative required offer count', p_publication_id; END IF;
    SELECT count(*) INTO actual_count FROM biplan.publication_offers
    WHERE publication_offers.publication_id = p_publication_id;
    IF actual_count <> required_count THEN
      RAISE EXCEPTION 'publication % integrity failed: offers %/%', p_publication_id,
        actual_count, required_count;
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION biplan.enforce_publication_offer_validation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state IN ('validated','active') AND NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM biplan.validate_publication_offers(NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE TRIGGER publications_validate_offer_pins
BEFORE UPDATE OF state ON biplan.publications
FOR EACH ROW EXECUTE FUNCTION biplan.enforce_publication_offer_validation();

INSERT INTO biplan.schema_migrations(version, migration_hash)
VALUES ('002-offer-revisions', '002-offer-revisions-v1')
ON CONFLICT (version) DO NOTHING;

COMMIT;
