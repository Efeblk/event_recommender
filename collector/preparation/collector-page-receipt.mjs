import { createHash } from 'node:crypto';
import { canonicalRequestId } from './canonical-adapter.mjs';
import { stableJson } from './source-adapter.mjs';

const sha = value => createHash('sha256').update(stableJson(value)).digest('hex');
const iso = (value, name) => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`invalid ${name}`);
  return value;
};
const supported = new Set(['biletix', 'bubilet', 'biletinial']);

export function legacyListingConfigHash(report, providers) {
  const listings = (report.listings ?? []).map(item => ({ provider: item.source, url: item.url, category: item.category ?? null }))
    .sort((a, b) => `${a.provider}|${a.url}|${a.category ?? ''}`.localeCompare(`${b.provider}|${b.url}|${b.category ?? ''}`));
  return sha({ schemaVersion: 1, geography: 'Istanbul', providers: [...providers].sort(), listings });
}

export function pageBatchInputHash(envelope) {
  const header = { ...envelope.header }; delete header.inputHash;
  return sha({ header, pages: envelope.pages, records: envelope.records, collectorCoverage: envelope.collectorCoverage });
}

export function discoveryInventoryHash(urls) {
  const rows = urls.map(item => `${item.provider}\t${item.url}`).sort();
  return createHash('sha256').update(rows.map(row => `${row}\n`).join('')).digest('hex');
}

/** Adapt a preserved collector report without upgrading legacy evidence into a fresh/full claim. */
export function collectorPageReceiptFromReport(report, { batchId, collectionRunId } = {}) {
  if (!report || report.schemaVersion !== 1 || !Array.isArray(report.pages) || !Array.isArray(report.failures) ||
      !Array.isArray(report.listings) || !report.summary?.sourceCoverage) throw new Error('invalid preserved collector report');
  iso(report.startedAt, 'collector startedAt'); iso(report.finishedAt, 'collector finishedAt');
  if (!batchId) throw new Error('batchId is required');
  const providerNames = Object.keys(report.summary.sourceCoverage).sort();
  if (!providerNames.length || providerNames.some(provider => !supported.has(provider))) throw new Error('invalid collector providers');
  // Historical reports did not persist a declared horizon. They can only be
  // represented as incomplete legacy incremental evidence.
  const cycle = report.summary.collectionCycle;
  const legacy = !cycle;
  if (legacy && !collectionRunId) throw new Error('collectionRunId is required for a legacy report');
  if (cycle && (cycle.schemaVersion !== 2 || cycle.collectionRunId !== (collectionRunId ?? cycle.collectionRunId) ||
      stableJson(cycle.providers) !== stableJson(providerNames) || !['full', 'incremental'].includes(cycle.scope)))
    throw new Error('invalid declared collection cycle');
  const runId = cycle?.collectionRunId ?? collectionRunId;
  const listingConfigHash = cycle?.scopeEvidence?.listingConfigHash ?? legacyListingConfigHash(report, providerNames);
  const cycleEvidence = report.summary.collectionCycleEvidence;
  let sourcePages = report.pages;
  let cycleCounts = null;
  let cycleCarried = 0;
  if (cycleEvidence !== undefined) {
    if (!cycle || cycleEvidence?.schemaVersion !== 1 || cycleEvidence.collectionRunId !== runId || !Array.isArray(cycleEvidence.pages) ||
        !cycleEvidence.counts || !cycleEvidence.countsByProvider || !Number.isSafeInteger(cycleEvidence.carriedRecordCount) || cycleEvidence.carriedRecordCount < 0)
      throw new Error('invalid collection cycle evidence');
    for (const field of ['known', 'terminal', 'verified', 'retired', 'failed', 'quarantined', 'missingCheckpoint'])
      if (!Number.isSafeInteger(cycleEvidence.counts[field]) || cycleEvidence.counts[field] < 0) throw new Error('invalid collection cycle evidence counts');
    for (const provider of providerNames) for (const field of ['known', 'terminal', 'verified', 'retired', 'failed', 'quarantined', 'missingCheckpoint'])
      if (!Number.isSafeInteger(cycleEvidence.countsByProvider[provider]?.[field]) || cycleEvidence.countsByProvider[provider][field] < 0)
        throw new Error('invalid collection cycle provider counts');
    for (const field of ['known', 'terminal', 'verified', 'retired', 'failed', 'quarantined', 'missingCheckpoint'])
      if (providerNames.reduce((sum, provider) => sum + cycleEvidence.countsByProvider[provider][field], 0) !== cycleEvidence.counts[field])
        throw new Error('collection cycle provider counts do not match totals');
    if (cycleEvidence.counts.missingCheckpoint > 0) throw new Error('collection cycle evidence is missing a required checkpoint');
    const evidencePages = cycleEvidence.pages.map(page => {
      if (!page || !providerNames.includes(page.provider) || !['verified', 'retired', 'quarantined'].includes(page.status) ||
          page.attemptedAt !== page.eventsCheckpointAt || !/^[0-9a-f]{64}$/.test(page.contentHash ?? '') ||
          typeof page.parserVersion !== 'string' || !page.parserVersion || !Array.isArray(page.events))
        throw new Error('invalid collection cycle evidence page');
      iso(page.attemptedAt, 'cycle page attemptedAt');
      if (page.status !== 'verified' && page.events.length) throw new Error('invalid empty collection cycle evidence page');
      return { source: page.provider, url: page.url, checkedAt: page.eventsCheckpointAt, contentHash: page.contentHash,
        parserVersion: page.parserVersion, events: structuredClone(page.events),
        ...(page.status === 'retired' ? { retiredAt: page.eventsCheckpointAt } : {}),
        ...(page.status === 'quarantined' ? { quarantinedAt: page.eventsCheckpointAt } : {}) };
    });
    const keys = evidencePages.map(page => `${page.source}\0${page.url}`);
    const terminalPages = evidencePages.filter(page => !page.quarantinedAt);
    if (new Set(keys).size !== keys.length || cycleEvidence.counts.terminal !== terminalPages.length ||
        cycleEvidence.counts.verified !== evidencePages.filter(page => !page.retiredAt && !page.quarantinedAt).length ||
        cycleEvidence.counts.retired !== evidencePages.filter(page => page.retiredAt).length ||
        evidencePages.filter(page => page.quarantinedAt).length > cycleEvidence.counts.quarantined ||
        cycleEvidence.counts.terminal + cycleEvidence.counts.failed + cycleEvidence.counts.quarantined > cycleEvidence.counts.known)
      throw new Error('collection cycle evidence counts do not match pages');
    const byKey = new Map(evidencePages.map(page => [`${page.source}\0${page.url}`, page]));
    sourcePages = [...report.pages.filter(page => !byKey.has(`${page.source}\0${page.url}`)), ...evidencePages];
    cycleCounts = cycleEvidence.counts; cycleCarried = cycleEvidence.carriedRecordCount;
  }
  const records = [], pages = [], requestIds = new Set(), pageIds = new Set();
  for (const sourcePage of sourcePages) {
    if (!sourcePage || !providerNames.includes(sourcePage.source) || typeof sourcePage.url !== 'string' || !Array.isArray(sourcePage.events))
      throw new Error('invalid collector page');
    const observedAt = iso(sourcePage.checkedAt, 'page checkedAt');
    const status = sourcePage.retiredAt ? 'retired' : sourcePage.quarantinedAt ? 'quarantined' : 'verified';
    if (status === 'retired') iso(sourcePage.retiredAt, 'page retiredAt');
    if (status === 'quarantined') iso(sourcePage.quarantinedAt, 'page quarantinedAt');
    const refs = sourcePage.events.map(record => {
      if (record.source !== sourcePage.source || record.url !== sourcePage.url) throw new Error('page record provenance mismatch');
      const requestId = canonicalRequestId(record);
      if (requestIds.has(requestId)) throw new Error('duplicate record across collector pages');
      requestIds.add(requestId); records.push(structuredClone(record));
      return { requestId, sourceRecordId: String(record.id) };
    });
    if (status !== 'verified' && refs.length) throw new Error('non-verified page cannot submit records');
    const evidenceHash = sha(sourcePage);
    const recovered = sourcePage.recoveredFromCoverage && (!cycle || Date.parse(observedAt) < Date.parse(cycle.startedAt));
    const origin = recovered ? 'recovered' : 'current_run';
    const pageId = `source-page-${sha({ provider: sourcePage.source, url: sourcePage.url, observedAt, status, evidenceHash }).slice(0, 32)}`;
    if (pageIds.has(pageId)) throw new Error('duplicate collector page observation'); pageIds.add(pageId);
    pages.push({ pageId, provider: sourcePage.source, url: sourcePage.url, observedAt, sourceUpdatedAt: null, evidenceHash,
      ...(/^[0-9a-f]{64}$/.test(sourcePage.contentHash ?? '') ? { rawResponseHash: sourcePage.contentHash } : {}),
      evidenceKind: 'normalized_page', parserVersion: String(sourcePage.parserVersion ?? 'unknown'), status, origin,
      originRunId: origin === 'current_run' ? runId : null, records: refs,
      complete: status === 'verified' || status === 'retired' });
  }
  const inventoryUrls = Array.isArray(report.summary.collectionInventory) ? report.summary.collectionInventory
    .map(item => ({ provider: item.provider, url: item.url })).sort((a, b) => `${a.provider}\t${a.url}` < `${b.provider}\t${b.url}` ? -1 : 1) : null;
  const cycleEvidenceComplete = Boolean(cycleCounts && inventoryUrls && cycleCounts.known === inventoryUrls.length &&
    cycleCounts.known === cycleCounts.terminal && cycleCounts.failed === 0 && cycleCounts.quarantined === 0 && cycleCounts.missingCheckpoint === 0);
  const inventory = providerNames.map(provider => {
    const source = report.summary.sourceCoverage[provider];
    for (const field of ['discovered', 'attempted', 'verified', 'retired', 'quarantined', 'unattemptedThisRun', 'unvisited', 'stale', 'failure'])
      if (!Number.isSafeInteger(source[field]) || source[field] < 0) throw new Error(`invalid source coverage ${field}`);
    const quarantinedUrls = new Set(pages.filter(page => page.provider === provider && page.origin === 'current_run' && page.status === 'quarantined').map(page => page.url));
    if (cycleCounts) {
      const counts = cycleEvidence.countsByProvider[provider];
      const known = inventoryUrls.filter(item => item.provider === provider).length;
      if (known !== counts.known) throw new Error('collection cycle provider inventory count mismatch');
      const attempted = counts.terminal + counts.failed + counts.quarantined;
      if (attempted > known) throw new Error('invalid collection cycle provider attempted count');
      return { provider, known, attemptedThisRun: attempted, verifiedThisRun: counts.verified,
        retiredThisRun: counts.retired, failedThisRun: counts.failed, quarantinedThisRun: counts.quarantined,
        unattemptedThisRun: known - attempted, neverVisited: source.unvisited, stale: source.stale, outstandingFailures: source.failure };
    }
    return { provider, known: source.discovered, attemptedThisRun: source.attempted, verifiedThisRun: source.verified,
      retiredThisRun: pages.filter(page => page.provider === provider && page.origin === 'current_run' && page.status === 'retired').length,
      failedThisRun: report.failures.filter(item => item.source === provider && !quarantinedUrls.has(item.url)).length,
      quarantinedThisRun: quarantinedUrls.size,
      unattemptedThisRun: source.unattemptedThisRun, neverVisited: source.unvisited, stale: source.stale,
      outstandingFailures: source.failure };
  });
  const currentRun = pages.filter(page => page.origin === 'current_run').reduce((sum, page) => sum + page.records.length, 0);
  const recovered = pages.filter(page => page.origin === 'recovered').reduce((sum, page) => sum + page.records.length, 0);
  const terminalCurrentUrls = new Set(pages.filter(page => page.origin === 'current_run' && page.complete && ['verified', 'retired'].includes(page.status))
    .map(page => `${page.provider}\t${page.url}`));
  const canComplete = !legacy && cycle.scope === 'full' && report.summary.complete === true && report.summary.quarantined === 0 &&
    report.summary.runBudget?.stoppedBy == null && cycleEvidenceComplete &&
    inventoryUrls !== null && pages.every(page => page.origin === 'current_run' && page.complete && ['verified', 'retired'].includes(page.status)) &&
    inventoryUrls.every(item => terminalCurrentUrls.has(`${item.provider}\t${item.url}`));
  const resolvedTimes = canComplete ? [...pages.map(page => Date.parse(page.observedAt)), ...records.map(record => Date.parse(record.checkedAt))] : [];
  const oldestResolvedAt = resolvedTimes.length ? new Date(Math.min(...resolvedTimes)).toISOString() : null;
  const listingExhausted = providerNames.every(provider => report.listings.some(item => item.source === provider)) &&
    report.listings.every(item => item.completion === 'exhausted' && item.truncated !== true);
  const collectorCoverage = { schemaVersion: 2, complete: canComplete, finishedAt: report.finishedAt,
    discovery: { unit: 'detail_url', listingConfigHash, inventoryHash: inventoryUrls ? discoveryInventoryHash(inventoryUrls) : null,
      exhausted: listingExhausted, ...(inventoryUrls ? { urls: inventoryUrls } : {}) }, inventory,
    freshness: { maxSourceAgeMs: 86400000, oldestResolvedAt,
      validUntil: oldestResolvedAt ? new Date(Date.parse(oldestResolvedAt) + 86400000).toISOString() : null },
    records: { unit: 'event_record', submitted: records.length, currentRun, recovered,
      carried: Number.isSafeInteger(report.summary.carried) ? Math.max(0, report.summary.carried - cycleCarried) : null,
      sourceQuarantined: Number.isSafeInteger(report.summary.quarantined) ? report.summary.quarantined : null },
    legacyEvidence: { unknownOriginalHorizon: legacy, blocked: report.summary.blocked ?? null,
      runBudget: structuredClone(report.summary.runBudget ?? null), detailBudget: structuredClone(report.summary.detailBudget ?? null),
      failures: structuredClone(report.failures), invocationSourceCoverage: structuredClone(report.summary.sourceCoverage) } };
  const header = { schemaVersion: 2, batchId, collectionRunId: runId, scope: legacy ? 'legacy_incremental' : cycle.scope, providers: providerNames,
    horizonStart: legacy ? null : cycle.horizonStart, horizonEnd: legacy ? null : cycle.horizonEnd, startedAt: cycle?.startedAt ?? report.startedAt,
    scopeEvidence: { geography: 'Istanbul', listingConfigHash } };
  const envelope = { header, pages, records, collectorCoverage }; header.inputHash = pageBatchInputHash(envelope);
  return envelope;
}
