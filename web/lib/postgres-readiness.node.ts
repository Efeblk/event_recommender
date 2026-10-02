export type PostgresPreparedCatalogReadiness = {
  backend: 'postgres';
  ready: boolean;
  publicationId: string | null;
  reasons: string[];
  publication: {
    state: string | null;
    switchedAt: string | null;
    validatedAt: string | null;
    sessions: number;
    documents: number;
    offers: number;
  };
  sourceCoverage: Record<string, unknown> | null;
  preparationReceipt: Record<string, unknown> | null;
  optionalEnrichment: { pending: number; failed: number; stale: number; unknown: number };
};

type QueryText = (statement: string) => Promise<string>;
type Raw = {
  publicationId: string | null;
  state: string | null;
  switchedAt: string | null;
  validatedAt: string | null;
  validationHash: string | null;
  manifest: unknown;
  requiredSessions: number | string | null;
  requiredDocuments: number | string | null;
  requiredOffers: string | null;
  requiredOfferEvidence: string | null;
  sessions: number | string;
  documents: number | string;
  offers: number | string;
  missingReferences: number | string;
  canceledSessions: number | string;
  invalidOfferPins: number | string;
  unresolvedPageOffers: number | string;
  pendingEvaluations: number | string;
  failedEvaluations: number | string;
  staleEvaluations: number | string;
  unknownEvaluations: number | string;
};

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const count = (value: unknown) => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) return -1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : -1;
};
const instant = (value: unknown) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value ? parsed : NaN;
};

function coverageReasons(coverage: Record<string, unknown>, now: number): string[] {
  const reasons: string[] = [];
  const finished = instant(coverage.finishedAt);
  if (!Number.isFinite(finished) || finished > now + 300000)
    reasons.push('collector_coverage_time_invalid');
  else if (now - finished >= 24 * 3600000) reasons.push('collector_coverage_stale');
  // Legacy URL totals and normalized record totals use different units. The
  // v2 publisher verifies the page inventory; v1 fixture receipts cannot qualify
  // a managed service as ready, even when their declared complete flag is true.
  if (coverage.schemaVersion !== 2) return [...reasons, 'collector_coverage_version_unsupported'];
  const discovery = object(coverage.discovery), records = object(coverage.records);
  const freshness = object(coverage.freshness);
  if (discovery?.unit !== 'detail_url' || records?.unit !== 'event_record' ||
      typeof discovery.listingConfigHash !== 'string' || !/^[a-f0-9]{64}$/.test(discovery.listingConfigHash) ||
      typeof discovery.inventoryHash !== 'string' || !/^[a-f0-9]{64}$/.test(discovery.inventoryHash) ||
      !Array.isArray(coverage.inventory) || !coverage.inventory.length)
    reasons.push('collector_coverage_invalid');
  if (coverage.complete !== true || coverage.scope !== 'full' || discovery?.exhausted !== true)
    reasons.push('source_coverage_incomplete');
  const scopeEvidence = object(coverage.scopeEvidence);
  const providers = coverage.providers;
  const from = instant(coverage.horizonStart), to = instant(coverage.horizonEnd), started = instant(coverage.startedAt);
  if (scopeEvidence?.geography !== 'Istanbul' || scopeEvidence.listingConfigHash !== discovery?.listingConfigHash ||
      !Array.isArray(providers) || !providers.length ||
      providers.some(p => typeof p !== 'string' || !['biletix', 'bubilet', 'biletinial'].includes(p)) ||
      new Set(providers).size !== providers.length || !Number.isFinite(from) || !Number.isFinite(to) || to <= from ||
      !Number.isFinite(started) || started > finished || typeof coverage.collectionRunId !== 'string' || !coverage.collectionRunId ||
      typeof coverage.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(coverage.inputHash))
    reasons.push('collector_coverage_scope_invalid');
  const inventory = Array.isArray(coverage.inventory) ? coverage.inventory : [];
  const seen = new Set<string>();
  const knownByProvider = new Map<string, number>();
  for (const value of inventory) {
    const entry = object(value);
    const fields = ['known', 'attemptedThisRun', 'verifiedThisRun', 'retiredThisRun', 'failedThisRun',
      'quarantinedThisRun', 'unattemptedThisRun', 'neverVisited', 'stale', 'outstandingFailures'] as const;
    if (!entry || typeof entry.provider !== 'string' || seen.has(entry.provider) ||
        !Array.isArray(providers) || !providers.includes(entry.provider) || fields.some(f => count(entry[f]) < 0)) {
      reasons.push('collector_coverage_invalid'); continue;
    }
    seen.add(entry.provider);
    const counts = Object.fromEntries(fields.map(f => [f, count(entry[f])]));
    knownByProvider.set(entry.provider, counts.known);
    if (counts.known !== counts.attemptedThisRun + counts.unattemptedThisRun ||
        counts.attemptedThisRun !== counts.verifiedThisRun + counts.retiredThisRun + counts.failedThisRun + counts.quarantinedThisRun ||
        ['neverVisited', 'stale', 'outstandingFailures'].some(f => counts[f] > counts.known))
      reasons.push('collector_coverage_invalid');
    if (counts.outstandingFailures > 0 || counts.failedThisRun > 0 || counts.quarantinedThisRun > 0)
      reasons.push('source_refresh_failed');
    if (counts.neverVisited > 0 || counts.stale > 0) reasons.push('source_coverage_incomplete');
    if (counts.unattemptedThisRun > 0) reasons.push('source_coverage_incomplete');
  }
  if (Array.isArray(providers) && seen.size !== providers.length) reasons.push('collector_coverage_invalid');
  const urls = discovery?.urls, urlIds = new Set<string>(), urlCounts = new Map<string, number>();
  if (!Array.isArray(urls) || !urls.length || urls.length > 20000) reasons.push('collector_coverage_inventory_invalid');
  else {
    for (const value of urls) {
      const entry = object(value);
      if (!entry || typeof entry.provider !== 'string' || !knownByProvider.has(entry.provider) ||
          typeof entry.url !== 'string' || !entry.url || /[\r\n\t]/.test(entry.url)) {
        reasons.push('collector_coverage_inventory_invalid'); continue;
      }
      const id = `${entry.provider}\t${entry.url}`;
      if (urlIds.has(id)) reasons.push('collector_coverage_inventory_invalid');
      urlIds.add(id);
      urlCounts.set(entry.provider, (urlCounts.get(entry.provider) ?? 0) + 1);
    }
    if ([...knownByProvider].some(([provider, known]) => urlCounts.get(provider) !== known))
      reasons.push('collector_coverage_inventory_invalid');
  }
  const recordFields = ['submitted', 'currentRun', 'recovered', 'carried', 'sourceQuarantined'];
  if (!records || recordFields.some(f => count(records[f]) < 0) ||
      count(records.submitted) !== count(records.currentRun) + count(records.recovered))
    reasons.push('collector_coverage_invalid');
  else if (count(records.sourceQuarantined) > 0) reasons.push('source_refresh_failed');
  if (records && coverage.complete === true && count(records.recovered) !== 0)
    reasons.push('collector_coverage_invalid');
  const maxAge = count(freshness?.maxSourceAgeMs);
  const oldest = instant(freshness?.oldestResolvedAt), until = instant(freshness?.validUntil);
  if (maxAge <= 0 || maxAge > 24 * 3600000 || !Number.isFinite(oldest) || !Number.isFinite(until) ||
      oldest > finished || until !== oldest + maxAge)
    reasons.push('collector_coverage_freshness_invalid');
  else if (until <= now) reasons.push('collector_coverage_stale');
  return [...new Set(reasons)];
}

export function assessPostgresPreparedCatalogReadiness(raw: Raw, now = Date.now()): PostgresPreparedCatalogReadiness {
  const reasons: string[] = [], manifest = object(raw.manifest);
  const sessions = count(raw.sessions), documents = count(raw.documents), offers = count(raw.offers);
  const requiredSessions = count(raw.requiredSessions), requiredDocuments = count(raw.requiredDocuments);
  const requiredOffers = count(raw.requiredOffers);
  const requiredOfferEvidence = count(raw.requiredOfferEvidence);
  const missingReferences = count(raw.missingReferences), canceledSessions = count(raw.canceledSessions);
  const invalidOfferPins = count(raw.invalidOfferPins);
  const unresolvedPageOffers = count(raw.unresolvedPageOffers);
  const sourceCoverage = object(manifest?.collectorCoverage);
  const preparationReceipt = object(manifest?.preparationReceipt);
  const hasProjectionVersion = !!manifest && Object.prototype.hasOwnProperty.call(manifest, 'offerProjectionVersion');
  const projectionVersion = hasProjectionVersion ? manifest?.offerProjectionVersion : null;

  if (!raw.publicationId) reasons.push('postgres_publication_missing');
  if (raw.state !== 'active') reasons.push('postgres_publication_not_active');
  if (!raw.validatedAt || !raw.validationHash) reasons.push('postgres_publication_not_validated');
  if (!manifest) reasons.push('postgres_manifest_invalid');
  if (sessions < 0 || requiredSessions < 0 || sessions !== requiredSessions)
    reasons.push('postgres_session_count_mismatch');
  if (documents < 0 || requiredDocuments < 0 || documents !== requiredDocuments)
    reasons.push('postgres_document_count_mismatch');
  if (requiredOffers < 0) reasons.push('postgres_offer_count_missing');
  else if (offers < 0 || offers !== requiredOffers) reasons.push('postgres_offer_count_mismatch');
  if (hasProjectionVersion && projectionVersion !== 1) reasons.push('postgres_offer_projection_unsupported');
  if (projectionVersion === 1 && (requiredOfferEvidence < 0 || requiredOfferEvidence !== requiredOffers))
    reasons.push('postgres_offer_evidence_count_mismatch');
  if (missingReferences !== 0 || canceledSessions !== 0 || invalidOfferPins !== 0)
    reasons.push('postgres_reference_integrity_failed');
  if (unresolvedPageOffers !== 0) reasons.push('provider_page_reconciliation_required');

  if (!sourceCoverage) reasons.push('collector_coverage_missing');
  else reasons.push(...coverageReasons(sourceCoverage, now));
  if (!preparationReceipt) reasons.push('preparation_receipt_missing');
  else {
    const common = preparationReceipt.publicationId === raw.publicationId &&
      typeof preparationReceipt.batchId === 'string' && !!preparationReceipt.batchId &&
      preparationReceipt.inputHash === sourceCoverage?.inputHash;
    const legacy = !hasProjectionVersion && preparationReceipt.version === 'canonical-batch-v1' &&
      typeof preparationReceipt.status === 'string' && ['verified', 'completed'].includes(preparationReceipt.status);
    const projected = projectionVersion === 1 && preparationReceipt.version === 'provider-page-offer-v1' &&
      preparationReceipt.status === 'verified' && count(preparationReceipt.acceptedRecords) >= 0 &&
      count(preparationReceipt.pageAffectedSessions) >= 0 && Number.isFinite(instant(preparationReceipt.checkedAt)) &&
      preparationReceipt.optionalEmbeddingsRequired === false;
    if (!common || (!legacy && !projected)) reasons.push('preparation_receipt_invalid');
  }

  return {
    backend: 'postgres', ready: reasons.length === 0, publicationId: raw.publicationId, reasons,
    publication: { state: raw.state, switchedAt: raw.switchedAt, validatedAt: raw.validatedAt, sessions, documents, offers },
    sourceCoverage, preparationReceipt,
    optionalEnrichment: {
      pending: count(raw.pendingEvaluations), failed: count(raw.failedEvaluations),
      stale: count(raw.staleEvaluations), unknown: count(raw.unknownEvaluations),
    },
  };
}

// One statement captures the active pointer and every related count from that
// pinned publication. Successive queries could otherwise mix generations.
export const postgresPreparedCatalogReadinessSql = `
WITH active AS MATERIALIZED (
  SELECT p.*, a.switched_at
  FROM biplan.active_publication a
  JOIN biplan.publications p ON p.id = a.publication_id
  WHERE a.singleton
), metrics AS (
  SELECT a.id AS publication_id, a.state, a.switched_at, a.validated_at,
    a.validation_hash, a.manifest, a.required_session_count,
    a.required_document_count,
    CASE WHEN (a.manifest->>'requiredOfferCount') ~ '^[0-9]+$'
      THEN a.manifest->>'requiredOfferCount' END AS required_offer_count,
    CASE WHEN (a.manifest->>'requiredOfferEvidenceCount') ~ '^[0-9]+$'
      THEN a.manifest->>'requiredOfferEvidenceCount' END AS required_offer_evidence_count,
    (SELECT count(*) FROM biplan.published_sessions ps WHERE ps.publication_id=a.id) AS sessions,
    (SELECT count(ps.search_document_id) FROM biplan.published_sessions ps WHERE ps.publication_id=a.id) AS documents,
    (SELECT count(*) FROM biplan.publication_offers po WHERE po.publication_id=a.id) AS offers,
    (SELECT count(*) FROM biplan.published_sessions ps
      LEFT JOIN biplan.sessions s ON s.id=ps.session_id
      LEFT JOIN biplan.productions p ON p.id=ps.production_id
      LEFT JOIN biplan.search_documents d ON d.id=ps.search_document_id
      WHERE ps.publication_id=a.id AND (s.id IS NULL OR p.id IS NULL OR d.id IS NULL)) AS missing_references,
    (SELECT count(*) FROM biplan.published_sessions ps JOIN biplan.sessions s ON s.id=ps.session_id
      WHERE ps.publication_id=a.id AND s.status='canceled') AS canceled_sessions,
    (SELECT count(*) FROM biplan.publication_offers po
      LEFT JOIN biplan.offer_revisions r ON r.id=po.offer_revision_id
      LEFT JOIN biplan.offer_identities i ON i.id=r.offer_id
      LEFT JOIN biplan.published_sessions ps ON ps.publication_id=po.publication_id AND ps.session_id=po.session_id
      WHERE po.publication_id=a.id AND (r.id IS NULL OR i.id IS NULL OR ps.session_id IS NULL
        OR r.session_id IS DISTINCT FROM po.session_id OR r.acceptance_status<>'accepted')) AS invalid_offer_pins,
    (SELECT count(*) FROM biplan.publication_offers po JOIN biplan.offer_revisions r ON r.id=po.offer_revision_id
      WHERE po.publication_id=a.id AND CASE
        WHEN a.manifest->'offerProjectionVersion'='1'::jsonb
          THEN biplan.publication_offer_evidence_current(a.id,r.offer_id) IS DISTINCT FROM true
        WHEN NOT (a.manifest ? 'offerProjectionVersion')
          THEN (biplan.offer_page_support(r.offer_id)->>'usable') IS DISTINCT FROM 'true'
        ELSE true END) AS unresolved_page_offers,
    (SELECT count(*) FROM biplan.publication_evaluations pe JOIN biplan.evaluations e ON e.id=pe.evaluation_id
      WHERE pe.publication_id=a.id AND e.status='pending') AS pending_evaluations,
    (SELECT count(*) FROM biplan.publication_evaluations pe JOIN biplan.evaluations e ON e.id=pe.evaluation_id
      WHERE pe.publication_id=a.id AND e.status='failed') AS failed_evaluations,
    (SELECT count(*) FROM biplan.publication_evaluations pe JOIN biplan.evaluations e ON e.id=pe.evaluation_id
      WHERE pe.publication_id=a.id AND e.status='stale') AS stale_evaluations,
    (SELECT count(*) FROM biplan.publication_evaluations pe JOIN biplan.evaluations e ON e.id=pe.evaluation_id
      WHERE pe.publication_id=a.id AND e.status='unknown') AS unknown_evaluations
  FROM active a
)
SELECT jsonb_build_object(
  'publicationId',m.publication_id,'state',m.state,'switchedAt',m.switched_at,
  'validatedAt',m.validated_at,'validationHash',m.validation_hash,'manifest',m.manifest,
  'requiredSessions',m.required_session_count,'requiredDocuments',m.required_document_count,
  'requiredOffers',m.required_offer_count,'requiredOfferEvidence',m.required_offer_evidence_count,
  'sessions',m.sessions,'documents',m.documents,
  'offers',m.offers,'missingReferences',m.missing_references,'canceledSessions',m.canceled_sessions,
  'invalidOfferPins',m.invalid_offer_pins,'unresolvedPageOffers',m.unresolved_page_offers,'pendingEvaluations',m.pending_evaluations,
  'failedEvaluations',m.failed_evaluations,'staleEvaluations',m.stale_evaluations,
  'unknownEvaluations',m.unknown_evaluations)::text
FROM metrics m;`;

export async function readPostgresPreparedCatalogReadiness(queryText: QueryText) {
  const text = await queryText(postgresPreparedCatalogReadinessSql);
  if (!text) return assessPostgresPreparedCatalogReadiness({
    publicationId: null, state: null, switchedAt: null, validatedAt: null, validationHash: null,
    manifest: null, requiredSessions: null, requiredDocuments: null, requiredOffers: null, requiredOfferEvidence: null,
    sessions: 0, documents: 0, offers: 0, missingReferences: 0, canceledSessions: 0,
    invalidOfferPins: 0, unresolvedPageOffers: 0, pendingEvaluations: 0, failedEvaluations: 0, staleEvaluations: 0, unknownEvaluations: 0,
  });
  return assessPostgresPreparedCatalogReadiness(JSON.parse(text) as Raw);
}
