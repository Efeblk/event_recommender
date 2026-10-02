import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from './db.mjs';

const versions = ['002-offer-revisions', '003-workers', '004-publication-refresh', '005-canonical-preparation',
  '006-batched-publication', '007-page-receipts', '008-offer-evidence-projections',
  '009-offer-identity-provider-session', '010-offer-identity-session-index', '011-publication-serving-artifacts',
  '012-bulk-seal-integrity', '013-bulk-publication-projections'];
const expected = new Map(versions.map(version => [version, `${version}-v1`]));
const guarded = ['012-bulk-seal-integrity', '013-bulk-publication-projections'];

async function migrationFiles() {
  const directory = resolve(import.meta.dirname, 'migrations');
  const names = (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort();
  if (JSON.stringify(names) !== JSON.stringify(versions.map(version => `${version}.sql`)))
    throw new Error('Migration files differ from the reviewed version manifest');
  return new Map(await Promise.all(versions.map(async version =>
    [version, await readFile(resolve(directory, `${version}.sql`), 'utf8')])));
}

async function installedState(query) {
  const presence = JSON.parse(await query(`SELECT jsonb_build_object(
    'schema',to_regnamespace('biplan') IS NOT NULL,
    'metadata',to_regclass('biplan.schema_metadata') IS NOT NULL,
    'migrations',to_regclass('biplan.schema_migrations') IS NOT NULL)::text;`));
  if (!presence.metadata) {
    if (presence.schema || presence.migrations) throw new Error('Existing catalog is missing schema metadata; refusing initialization');
    return null;
  }
  const metadata = JSON.parse(await query('SELECT COALESCE(jsonb_agg(schema_version),\'[]\'::jsonb)::text FROM biplan.schema_metadata WHERE singleton;'));
  if (metadata.length !== 1 || metadata[0] !== 1) throw new Error('Incompatible catalog schema metadata; expected version 1');
  const rows = presence.migrations ? JSON.parse(await query(
    "SELECT COALESCE(jsonb_agg(jsonb_build_object('version',version,'hash',migration_hash) ORDER BY version),'[]'::jsonb)::text FROM biplan.schema_migrations;")) : [];
  const installed = new Set();
  for (const row of rows) {
    if (!expected.has(row.version) || expected.get(row.version) !== row.hash || installed.has(row.version))
      throw new Error(`Unknown or incompatible installed migration: ${String(row.version)}`);
    installed.add(row.version);
  }
  let missing = false;
  for (const version of versions) {
    if (!installed.has(version)) missing = true;
    else if (missing) throw new Error(`Non-contiguous installed migration history: ${version}`);
  }
  return installed;
}

async function install(query, initialize) {
  // Read and validate all local files and installed markers before any DDL.
  const files = await migrationFiles();
  let installed = await installedState(query);
  const fresh = installed === null;
  if (fresh) {
    if (!initialize) throw new Error('Catalog schema is not initialized');
    await query(await readFile(resolve(import.meta.dirname, 'schema.sql'), 'utf8'));
    installed = new Set();
  }
  // Installed guarded migrations verify complete bodies and existing markers;
  // they cannot repair drift or re-create historical functions.
  for (const version of guarded) if (installed.has(version)) await query(files.get(version));
  const applied = [];
  for (const version of versions) {
    if (installed.has(version)) continue;
    await query(files.get(version));
    applied.push(version);
  }
  for (const version of guarded) await query(files.get(version));
  return { initialized: fresh, applied };
}

/** Inject query(sql)->text for isolated installers/verifiers; default stays local. */
export const initializeCatalog = (query = sql) => install(query, true);
export const migrate = (query = sql) => install(query, false);

/** Frozen-import compatibility only: initial immutable revisions for new legacy
 * rows, without replaying migration 002 or changing existing identities/heads. */
export async function backfillFrozenImportOffers(query = sql) {
  await migrate(query);
  await query(`BEGIN;
    CREATE TEMP TABLE biplan_frozen_import_new_offers ON COMMIT DROP AS
      SELECT legacy.* FROM biplan.provider_offers legacy
      WHERE NOT EXISTS(SELECT 1 FROM biplan.offer_identities identity WHERE identity.id=legacy.id);
    INSERT INTO biplan.offer_identities(id,session_id,provider,provider_record_id,ticket_tier_id)
      SELECT id,session_id,provider,provider_record_id,ticket_tier_id FROM biplan_frozen_import_new_offers;
    INSERT INTO biplan.offer_revisions(id,offer_id,session_id,provider,provider_record_id,source_session_ids,
      provider_session_id,source_url,ticket_tier_id,ticket_tier_name,currency,price,price_minor,fee_minor,price_kind,
      availability,observed_at,source_updated_at,valid_from,valid_until,supplied_content_hash,server_content_hash,
      semantic_content_hash,immutable_record_hash,source_payload,acceptance_status)
    SELECT id,id,session_id,provider,provider_record_id,source_session_ids,provider_session_id,source_url,
      ticket_tier_id,ticket_tier_name,currency,price,price_minor,fee_minor,price_kind,availability,observed_at,
      source_updated_at,valid_from,valid_until,content_hash,md5(source_payload::text),
      md5(jsonb_build_object('sessionId',session_id,'provider',provider,'providerRecordId',provider_record_id,
        'providerSessionId',provider_session_id,'sourceSessionIds',to_jsonb(source_session_ids),'sourceUrl',source_url,
        'ticketTierId',ticket_tier_id,'ticketTierName',ticket_tier_name,'currency',currency,'price',price,
        'priceMinor',price_minor,'feeMinor',fee_minor,'priceKind',price_kind,'availability',availability,
        'validFrom',valid_from,'validUntil',valid_until,'contentHash',content_hash,'sourcePayload',source_payload)::text),
      md5(to_jsonb(legacy)::text),source_payload,'accepted' FROM biplan_frozen_import_new_offers legacy;
    UPDATE biplan.offer_identities identity SET current_revision_id=identity.id,updated_at=clock_timestamp()
      WHERE identity.id IN (SELECT id FROM biplan_frozen_import_new_offers) AND identity.current_revision_id IS NULL;
    COMMIT;`);
}
