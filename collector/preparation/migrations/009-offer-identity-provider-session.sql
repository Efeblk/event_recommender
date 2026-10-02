BEGIN;

DO $guard$
DECLARE installed_hash text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM biplan.schema_migrations WHERE version='008-offer-evidence-projections') THEN
    RAISE EXCEPTION 'offer identity provider session compatibility requires migration 008';
  END IF;
  SELECT migration_hash INTO installed_hash FROM biplan.schema_migrations
    WHERE version='009-offer-identity-provider-session';
  IF installed_hash IS NOT NULL AND installed_hash<>'009-offer-identity-provider-session-v1' THEN
    RAISE EXCEPTION 'incompatible installed migration 009-offer-identity-provider-session: %',installed_hash;
  END IF;
END $guard$;

-- providerSessionId is mutable revision evidence, not part of the immutable
-- provider/record/tier identity. This nullable projection supports older readers
-- while refusing to choose between conflicting accepted historical aliases.
ALTER TABLE biplan.offer_identities ADD COLUMN IF NOT EXISTS provider_session_id text;

CREATE OR REPLACE FUNCTION biplan.sync_offer_identity_provider_session() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE aliases text[];
BEGIN
  SELECT array_agg(alias ORDER BY alias) INTO aliases FROM (
    SELECT DISTINCT provider_session_id alias
    FROM biplan.offer_revisions
    WHERE offer_id=NEW.id AND acceptance_status='accepted' AND btrim(provider_session_id)<>''
  ) accepted_aliases;
  NEW.provider_session_id:=CASE WHEN cardinality(aliases)=1 THEN aliases[1] ELSE NULL END;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION biplan.sync_offer_identity_provider_session() FROM PUBLIC;

DROP TRIGGER IF EXISTS offer_identity_provider_session_projection ON biplan.offer_identities;
CREATE TRIGGER offer_identity_provider_session_projection
BEFORE INSERT OR UPDATE OF current_revision_id ON biplan.offer_identities
FOR EACH ROW EXECUTE FUNCTION biplan.sync_offer_identity_provider_session();

UPDATE biplan.offer_identities identity SET provider_session_id=projected.alias
FROM (
  SELECT i.id,CASE WHEN count(DISTINCT r.provider_session_id) FILTER (WHERE btrim(r.provider_session_id)<>'')=1
    THEN min(r.provider_session_id) FILTER (WHERE btrim(r.provider_session_id)<>'') ELSE NULL END alias
  FROM biplan.offer_identities i LEFT JOIN biplan.offer_revisions r
    ON r.offer_id=i.id AND r.acceptance_status='accepted'
  GROUP BY i.id
) projected WHERE projected.id=identity.id
  AND identity.provider_session_id IS DISTINCT FROM projected.alias;

INSERT INTO biplan.schema_migrations(version,migration_hash)
VALUES('009-offer-identity-provider-session','009-offer-identity-provider-session-v1')
ON CONFLICT(version) DO NOTHING;

COMMIT;
