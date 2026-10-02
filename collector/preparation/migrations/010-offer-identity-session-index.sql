BEGIN;

DO $guard$
DECLARE installed_hash text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM biplan.schema_migrations WHERE version='009-offer-identity-provider-session') THEN
    RAISE EXCEPTION 'offer identity session index requires migration 009';
  END IF;
  SELECT migration_hash INTO installed_hash FROM biplan.schema_migrations
    WHERE version='010-offer-identity-session-index';
  IF installed_hash IS NOT NULL AND installed_hash<>'010-offer-identity-session-index-v1' THEN
    RAISE EXCEPTION 'incompatible installed migration 010-offer-identity-session-index: %',installed_hash;
  END IF;
END $guard$;

-- The page-evidence integrity guard deliberately checks every scheduled session.
-- Give its per-session offer lookup a direct access path without narrowing the
-- invariant or changing any result.
CREATE INDEX IF NOT EXISTS offer_identities_session_idx
  ON biplan.offer_identities USING btree(session_id);

DO $index_guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid
    WHERE x.indrelid='biplan.offer_identities'::regclass
      AND i.relname='offer_identities_session_idx' AND x.indisvalid AND x.indisready
      AND NOT x.indisunique AND x.indpred IS NULL
      AND pg_get_indexdef(x.indexrelid)='CREATE INDEX offer_identities_session_idx ON biplan.offer_identities USING btree (session_id)'
  ) THEN RAISE EXCEPTION 'incompatible offer identity session index'; END IF;
END $index_guard$;

INSERT INTO biplan.schema_migrations(version,migration_hash)
VALUES('010-offer-identity-session-index','010-offer-identity-session-index-v1')
ON CONFLICT(version) DO NOTHING;

COMMIT;
