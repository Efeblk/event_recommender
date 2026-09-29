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
  sessions: number | string;
  documents: number | string;
  offers: number | string;
  missingReferences: number | string;
  canceledSessions: number | string;
  invalidOfferPins: number | string;
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

export function assessPostgresPreparedCatalogReadiness(raw: Raw, now = Date.now()): PostgresPreparedCatalogReadiness {
  const reasons: string[] = [], manifest = object(raw.manifest);
  const sessions = count(raw.sessions), documents = count(raw.documents), offers = count(raw.offers);
  const requiredSessions = count(raw.requiredSessions), requiredDocuments = count(raw.requiredDocuments);
  const requiredOffers = count(raw.requiredOffers);
  const missingReferences = count(raw.missingReferences), canceledSessions = count(raw.canceledSessions);
  const invalidOfferPins = count(raw.invalidOfferPins);
  const sourceCoverage = object(manifest?.collectorCoverage);
  const preparationReceipt = object(manifest?.preparationReceipt);

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
  if (missingReferences !== 0 || canceledSessions !== 0 || invalidOfferPins !== 0)
    reasons.push('postgres_reference_integrity_failed');

  if (!sourceCoverage) reasons.push('collector_coverage_missing');
  else {
    const failed = count(sourceCoverage.failedPages), unvisited = count(sourceCoverage.unvisited);
    const complete = sourceCoverage.complete === true;
    const finishedAt = sourceCoverage.finishedAt;
    const finished = typeof finishedAt === 'string' ? Date.parse(finishedAt) : NaN;
    if (!Number.isFinite(finished) || new Date(finished).toISOString() !== finishedAt || finished > now + 300000)
      reasons.push('collector_coverage_time_invalid');
    else if (now - finished >= 24 * 3600000) reasons.push('collector_coverage_stale');
    if (failed < 0 || unvisited < 0) reasons.push('collector_coverage_invalid');
    else {
      if (failed > 0) reasons.push('source_refresh_failed');
      if (!complete || unvisited > 0) reasons.push('source_coverage_incomplete');
    }
  }
  if (!preparationReceipt) reasons.push('preparation_receipt_missing');
  else if (
    !(typeof preparationReceipt.status === 'string' && ['verified', 'completed'].includes(preparationReceipt.status)) ||
    preparationReceipt.publicationId !== raw.publicationId
  ) reasons.push('preparation_receipt_invalid');

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
  'requiredOffers',m.required_offer_count,'sessions',m.sessions,'documents',m.documents,
  'offers',m.offers,'missingReferences',m.missing_references,'canceledSessions',m.canceled_sessions,
  'invalidOfferPins',m.invalid_offer_pins,'pendingEvaluations',m.pending_evaluations,
  'failedEvaluations',m.failed_evaluations,'staleEvaluations',m.stale_evaluations,
  'unknownEvaluations',m.unknown_evaluations)::text
FROM metrics m;`;

export async function readPostgresPreparedCatalogReadiness(queryText: QueryText) {
  const text = await queryText(postgresPreparedCatalogReadinessSql);
  if (!text) return assessPostgresPreparedCatalogReadiness({
    publicationId: null, state: null, switchedAt: null, validatedAt: null, validationHash: null,
    manifest: null, requiredSessions: null, requiredDocuments: null, requiredOffers: null,
    sessions: 0, documents: 0, offers: 0, missingReferences: 0, canceledSessions: 0,
    invalidOfferPins: 0, pendingEvaluations: 0, failedEvaluations: 0, staleEvaluations: 0, unknownEvaluations: 0,
  });
  return assessPostgresPreparedCatalogReadiness(JSON.parse(text) as Raw);
}
