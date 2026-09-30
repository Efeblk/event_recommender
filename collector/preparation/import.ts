import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { prepareCatalogKnowledge } from '../../web/lib/catalog-knowledge.ts';
import { searchCatalogCandidates, type SearchCatalog } from '../../web/lib/materialized-catalog.ts';
import { emptyFilters } from '../../web/lib/types.ts';
import { sql, literal, work } from './db.mjs';
import { initializeCatalog, backfillFrozenImportOffers } from './migrate.mjs';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const expectedProfile = 'voyage-embedding-v1|endpoint=https://api.voyageai.com/v1/embeddings|model=voyage-4-large|dimensions=1024|input_type=document|text_profile=event-title-category-venue-description-v1';
const catalogPath = process.env.CATALOG_PREPARED_PATH ?? resolve(import.meta.dirname, '../../web/work/event-preparation-20260929/search-after.json');
const vectorsPath = process.env.CATALOG_VECTORS_PATH ?? resolve(import.meta.dirname, '../../web/work/event-preparation-20260929/vectors.json');
const [catalogText, vectorText] = await Promise.all([readFile(catalogPath, 'utf8'), readFile(vectorsPath, 'utf8')]);
const catalog = JSON.parse(catalogText) as SearchCatalog;
const vectors = JSON.parse(vectorText) as { profile: string; entries: { hash: string; vector: number[] }[] };
if (vectors.profile !== expectedProfile) throw new Error('Frozen vector profile differs; no vector recreation or inference is permitted');
const referenceAt = new Date(process.env.CATALOG_REFERENCE_AT ?? catalog.materializedAt);
const events = searchCatalogCandidates(catalog, emptyFilters, referenceAt);
const bundle = prepareCatalogKnowledge(events);
const eventMap = new Map(events.map(event => [event.id, event]));
const productionEvent = new Map(bundle.sessions.map(session => [session.productionId, eventMap.get(session.id)!]));
const vectorMap = new Map<string, number[]>();
for (const entry of vectors.entries) {
  if (entry.vector.length !== 1024 || entry.vector.some(value => !Number.isFinite(value)) || entry.vector.every(value => value === 0))
    throw new Error(`Invalid cached vector ${entry.hash}`);
  const prior = vectorMap.get(entry.hash);
  if (prior && JSON.stringify(prior) !== JSON.stringify(entry.vector)) throw new Error(`Conflicting cached vector ${entry.hash}`);
  vectorMap.set(entry.hash, entry.vector);
}
const documents = events.flatMap(event => {
  const prepared = event.preparedSearch;
  if (!prepared) return [];
  if (hash(prepared.documentText) !== prepared.documentHash) throw new Error(`Prepared document hash mismatch ${event.id}`);
  const embedding = vectorMap.get(prepared.documentHash);
  return [{ id: `document-${hash(`${event.id}|${prepared.documentHash}|${vectors.profile}`)}`, subjectType: 'session', subjectId: event.id,
    documentProfile: 'event-title-category-venue-description-v1', documentText: prepared.documentText,
    documentHash: prepared.documentHash, dependencyHash: prepared.documentHash,
    ...(embedding ? { embeddingProfile: vectors.profile, embedding } : {}) }];
});
const summary = { sessions: events.length, productions: bundle.productions.length, venues: bundle.venues.length,
  offers: bundle.providerOffers.length, observations: bundle.sourceObservations.length, pendingEvaluations: bundle.evaluations.length,
  documents: documents.length, embeddedSessions: documents.filter(document => 'embedding' in document).length };
const manifest = { version: 3, sourceKind: 'frozen_prepared_catalog', catalogHash: hash(catalogText), vectorSnapshotHash: hash(vectorText),
  referenceAt: referenceAt.toISOString(), normalizerVersion: bundle.normalizerVersion, inputHash: bundle.inputProvenance.inputHash,
  embeddingProfile: vectors.profile, requiredEvaluationCount: bundle.evaluations.length, requiredOfferCount: bundle.providerOffers.length,
  evaluationIdsHash: hash(JSON.stringify(bundle.evaluations.map(evaluation => evaluation.id))), summary };
const manifestHash = hash(JSON.stringify(manifest)), publicationId = `publication-${manifestHash}`;
await mkdir(work, { recursive: true });
await writeFile(resolve(work, 'import-plan.json'), JSON.stringify({ publicationId, manifest, state: 'planned' }, null, 2));
await initializeCatalog();
const previous = await sql('SELECT publication_id FROM biplan.active_publication WHERE singleton;');
if (previous === publicationId) {
  await sql(`SELECT biplan.validate_publication_offers(${literal(publicationId)});`);
  const replay = { at: new Date().toISOString(), publicationId, manifest, aiCalls: 0, cloudChanges: false, replay: true };
  await writeFile(resolve(work, 'import-receipt.json'), JSON.stringify(replay, null, 2));
  await writeFile(resolve(work, `import-${publicationId}-${Date.now()}.json`), JSON.stringify(replay, null, 2));
  console.log(JSON.stringify(replay));
  process.exit(0);
}

const enriched = { ...bundle,
  productions: bundle.productions.map(production => ({ ...production, title: productionEvent.get(production.id)!.title,
    synopsis: productionEvent.get(production.id)!.description,
    contentHash: hash(JSON.stringify({ ...production, title: productionEvent.get(production.id)!.title, synopsis: productionEvent.get(production.id)!.description })) })),
  venues: bundle.venues.map(venue => ({ ...venue, addressText: venue.address, locationPrecision: 'unknown', contentHash: hash(JSON.stringify(venue)) })),
  sessions: bundle.sessions.map(session => ({ ...session, timezone: 'Europe/Istanbul',
    status: session.availability === 'cancelled' ? 'canceled' : 'scheduled', attendancePolicy: session.attendanceTiming?.kind ?? 'unknown',
    admissionStartsAt: session.attendanceTiming?.kind === 'admission_window' ? session.attendanceTiming.validFrom : null,
    admissionEndsAt: session.attendanceTiming?.kind === 'admission_window' ? session.attendanceTiming.validThrough : null,
    contentHash: hash(JSON.stringify(session)) })),
  providerOffers: bundle.providerOffers.map(offer => ({ ...offer, provider: offer.source ?? 'unknown', providerRecordId: offer.id,
    sourceUrl: offer.url, sourcePayload: offer.raw, observedAt: offer.checkedAt,
    priceMinor: offer.price === null ? null : Math.round(offer.price * 100), priceKind: offer.price === null ? 'unknown' : 'starting_at',
    contentHash: hash(JSON.stringify(offer.raw)) })), summary };
console.log(`Importing ${summary.sessions} sessions and ${summary.offers} offers; no AI calls`);
await sql(`SELECT biplan.ingest_prepared_payload(${literal(JSON.stringify(enriched))}::jsonb);`);
// Frozen import creates legacy rows; backfill only their initial immutable revisions.
// Live updates must use accept_offer_revision rather than this strict importer.
await backfillFrozenImportOffers();
for (let offset = 0; offset < documents.length; offset += 128)
  await sql(`SELECT biplan.ingest_prepared_payload(${literal(JSON.stringify({ documents: documents.slice(offset, offset + 128) }))}::jsonb);`);

if (previous !== publicationId) {
  const documentMap = new Map(documents.map(document => [document.subjectId, document.id]));
  const rows = bundle.sessions.map(session => ({ sessionId: session.id, productionId: session.productionId, venueId: session.venueId,
    searchDocumentId: documentMap.get(session.id) ?? null, snapshotHash: hash(JSON.stringify(eventMap.get(session.id))),
    eligibilitySnapshot: eventMap.get(session.id) }));
  await sql(`BEGIN;
    INSERT INTO biplan.publications(id,manifest,manifest_hash,required_session_count,required_document_count,required_embedding_profile)
    VALUES(${literal(publicationId)},${literal(JSON.stringify(manifest))}::jsonb,${literal(manifestHash)},${summary.sessions},${summary.documents},${literal(vectors.profile)}) ON CONFLICT (id) DO NOTHING;
    INSERT INTO biplan.published_sessions(publication_id,session_id,production_id,venue_id,search_document_id,snapshot_hash,eligibility_snapshot)
    SELECT ${literal(publicationId)},r->>'sessionId',r->>'productionId',r->>'venueId',r->>'searchDocumentId',r->>'snapshotHash',r->'eligibilitySnapshot'
    FROM jsonb_array_elements(${literal(JSON.stringify(rows))}::jsonb) r;
    INSERT INTO biplan.publication_evaluations(publication_id,evaluation_id)
    SELECT ${literal(publicationId)},value FROM jsonb_array_elements_text(${literal(JSON.stringify(bundle.evaluations.map(evaluation => evaluation.id)))}::jsonb);
    INSERT INTO biplan.publication_offers(publication_id,session_id,offer_revision_id)
    SELECT ${literal(publicationId)},r->>'sessionId',r->>'id'
    FROM jsonb_array_elements(${literal(JSON.stringify(bundle.providerOffers.map(offer => ({ id: offer.id, sessionId: offer.sessionId }))))}::jsonb) r;
    SELECT biplan.validate_publication_offers(${literal(publicationId)});
    UPDATE biplan.publications SET state='validated',validated_at=clock_timestamp(),validation_hash=${literal(manifestHash)} WHERE id=${literal(publicationId)} AND state='candidate';
    SELECT biplan.activate_publication(${literal(publicationId)},${previous ? literal(previous) : 'NULL'});
    COMMIT;`);
}
const receipt = { at: new Date().toISOString(), publicationId, manifest, aiCalls: 0, cloudChanges: false, replay: previous === publicationId };
await writeFile(resolve(work, 'import-receipt.json'), JSON.stringify(receipt, null, 2));
await writeFile(resolve(work, `import-${publicationId}-${Date.now()}.json`), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt));
