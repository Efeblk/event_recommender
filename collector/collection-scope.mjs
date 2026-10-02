import { createHash } from 'node:crypto';

const providers = new Set(['biletinial', 'bubilet', 'biletix']);
const iso = (value, name) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value)
    throw new Error(`Invalid collection ${name}`);
  return value;
};
const text = (value, name, maximum = 250) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`Invalid collection ${name}`);
  return value;
};
const stable = value => Array.isArray(value) ? `[${value.map(stable).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');

export function collectionListingConfigHash(value) {
  if (!value || value.schemaVersion !== 1 || value.geography !== 'Istanbul' || !Array.isArray(value.providers) || !Array.isArray(value.listings))
    throw new Error('Invalid collection listing configuration');
  const selected = [...new Set(value.providers)];
  if (selected.length !== value.providers.length || selected.some(provider => !providers.has(provider)) ||
      stable(selected) !== stable([...selected].sort())) throw new Error('Invalid collection listing providers');
  const listings = value.listings.map(item => {
    if (!item || !selected.includes(item.provider) || typeof item.url !== 'string' ||
        (item.category !== null && typeof item.category !== 'string'))
      throw new Error('Invalid collection listing');
    const url = new URL(item.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid collection listing URL');
    return { provider: item.provider, url: url.href, category: item.category };
  }).sort((a, b) => a.provider.localeCompare(b.provider) || a.url.localeCompare(b.url) ||
    stable(a.category).localeCompare(stable(b.category)));
  if (new Set(listings.map(item => stable([item.provider, item.url, item.category]))).size !== listings.length)
    throw new Error('Duplicate collection listing');
  return hash({ schemaVersion: 1, geography: 'Istanbul', providers: selected, listings });
}

export function bindCollectionListingConfig(scope, resolvedListings, sourceConfigs) {
  const cycle = validateCollectionScope(scope);
  if (!(resolvedListings instanceof Map) || !sourceConfigs || typeof sourceConfigs !== 'object')
    throw new Error('Invalid resolved listing configuration');
  const listings = [];
  for (const provider of cycle.providers) {
    const source = sourceConfigs[provider], resolved = resolvedListings.get(provider);
    if (!source || typeof source.origin !== 'string' || !Array.isArray(resolved))
      throw new Error(`Missing resolved listing configuration for ${provider}`);
    for (const item of resolved) {
      if (!Array.isArray(item) || item.length !== 2) throw new Error(`Invalid resolved listing configuration for ${provider}`);
      listings.push({ provider, url: new URL(item[0], source.origin).href, category: item[1] });
    }
  }
  const actualHash = collectionListingConfigHash({ schemaVersion: 1, geography: cycle.scopeEvidence.geography,
    providers: cycle.providers, listings });
  if (actualHash !== cycle.scopeEvidence.listingConfigHash) throw new Error('Declared listing configuration hash does not match resolved listings');
  return actualHash;
}

export function validateCollectionScope(value) {
  if (!value || value.schemaVersion !== 2 || !['full', 'incremental', 'legacy_incremental'].includes(value.scope))
    throw new Error('Invalid collection scope');
  const selected = Array.isArray(value.providers) ? [...value.providers] : [];
  if (!selected.length || new Set(selected).size !== selected.length || selected.some(provider => !providers.has(provider)) ||
      stable(selected) !== stable([...selected].sort())) throw new Error('Invalid collection scope providers');
  const collectionRunId = text(value.collectionRunId, 'run id');
  const startedAt = iso(value.startedAt, 'startedAt');
  let horizonStart = value.horizonStart, horizonEnd = value.horizonEnd;
  if (value.scope === 'legacy_incremental') {
    if (horizonStart !== null || horizonEnd !== null) throw new Error('Legacy collection horizon must remain unknown');
  } else {
    horizonStart = iso(horizonStart, 'horizonStart'); horizonEnd = iso(horizonEnd, 'horizonEnd');
    if (Date.parse(horizonEnd) <= Date.parse(horizonStart)) throw new Error('Invalid collection horizon');
  }
  const evidence = value.scopeEvidence;
  if (!evidence || evidence.geography !== 'Istanbul' || typeof evidence.listingConfigHash !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.listingConfigHash))
    throw new Error('Invalid collection scope evidence');
  return { schemaVersion: 2, collectionRunId, scope: value.scope, providers: selected,
    horizonStart, horizonEnd, startedAt,
    scopeEvidence: { geography: 'Istanbul', listingConfigHash: evidence.listingConfigHash } };
}

export function attachCollectionCycle(coverage, supplied, { begin = false } = {}) {
  if (!coverage || typeof coverage !== 'object' || !Array.isArray(coverage.entries)) throw new Error('Invalid coverage checkpoint');
  if (supplied == null) {
    if (coverage.cycle) throw new Error('Explicit collection cycle scope is required to resume this checkpoint');
    return { state: coverage, cycle: null, mode: 'legacy' };
  }
  const requested = validateCollectionScope(supplied), existing = coverage.cycle ? validateCollectionScope(coverage.cycle) : null;
  if (existing?.collectionRunId === requested.collectionRunId) {
    if (stable(existing) !== stable(requested)) throw new Error('Collection cycle scope changed during resume');
    if (begin) throw new Error('Existing collection cycle cannot begin again');
    return { state: coverage, cycle: existing, mode: 'resume' };
  }
  if (!begin) throw new Error(existing ? 'New collection cycle requires explicit begin' : 'Legacy coverage requires explicit cycle begin');
  const state = structuredClone(coverage);
  state.cycle = requested;
  for (const entry of state.entries) delete entry.cycleObservation;
  return { state, cycle: requested, mode: 'begin' };
}

export function collectionCycleInventoryComplete(state, scope) {
  const cycle = validateCollectionScope(scope);
  const entries = Array.isArray(state?.entries) ? state.entries.filter(entry => cycle.providers.includes(entry.source)) : [];
  const terminal = entries.every(entry =>
    entry.cycleObservation?.cycleId === cycle.collectionRunId &&
    ['verified', 'retired'].includes(entry.cycleObservation.status));
  const evidence = collectionCycleEvidence(state, cycle);
  return terminal && evidence.counts.missingCheckpoint === 0 && evidence.counts.terminal === evidence.counts.known;
}

export function collectionCycleInventory(state, scope) {
  const cycle = validateCollectionScope(scope);
  if (!Array.isArray(state?.entries)) throw new Error('Invalid coverage checkpoint');
  const unique = new Map();
  for (const entry of state.entries) {
    if (!cycle.providers.includes(entry?.source) || typeof entry.url !== 'string' || !entry.url) continue;
    const item = { provider: entry.source, url: entry.url };
    unique.set(`${item.provider}\0${item.url}`, item);
  }
  return [...unique.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.url.localeCompare(b.url));
}

export function collectionCycleEvidence(state, scope, reportPages = []) {
  const cycle = validateCollectionScope(scope);
  if (!Array.isArray(state?.entries) || !Array.isArray(reportPages)) throw new Error('Invalid collection cycle evidence input');
  const reported = new Set(reportPages.flatMap(page =>
    typeof page?.source === 'string' && typeof page.url === 'string' ? [`${page.source}\0${page.url}`] : []));
  const counts = { known: 0, terminal: 0, verified: 0, retired: 0, failed: 0, quarantined: 0, missingCheckpoint: 0 };
  const countsByProvider = Object.fromEntries(cycle.providers.map(provider => [provider,
    { known: 0, terminal: 0, verified: 0, retired: 0, failed: 0, quarantined: 0, missingCheckpoint: 0 }]));
  const pages = [];
  let carriedRecordCount = 0;
  for (const entry of state.entries) {
    if (!cycle.providers.includes(entry?.source)) continue;
    counts.known += 1;
    countsByProvider[entry.source].known += 1;
    const observation = entry.cycleObservation;
    if (observation?.cycleId !== cycle.collectionRunId) continue;
    if (observation.status === 'failed') {
      counts.failed += 1; countsByProvider[entry.source].failed += 1; continue;
    }
    if (!['verified', 'retired', 'quarantined'].includes(observation.status)) continue;
    counts[observation.status] += 1;
    countsByProvider[entry.source][observation.status] += 1;
    if (observation.status !== 'quarantined') {
      counts.terminal += 1; countsByProvider[entry.source].terminal += 1;
    }
    const expectedCheckpointStatus = observation.status === 'verified' ? 'active' : observation.status;
    const valid = observation.attemptedAt === entry.eventsCheckpointAt && entry.eventsCheckpointUrl === entry.url &&
      entry.eventsCheckpointSource === entry.source && entry.eventsCheckpointStatus === expectedCheckpointStatus &&
      /^[a-f0-9]{64}$/.test(entry.eventsCheckpointContentHash ?? '') &&
      typeof entry.eventsCheckpointParserVersion === 'string' && entry.eventsCheckpointParserVersion.length > 0 &&
      Array.isArray(entry.events) && (observation.status === 'verified' || entry.events.length === 0);
    if (!valid) {
      if (observation.status !== 'quarantined') {
        counts.missingCheckpoint += 1; countsByProvider[entry.source].missingCheckpoint += 1;
      }
      continue;
    }
    const page = { provider: entry.source, url: entry.url, attemptedAt: observation.attemptedAt,
      status: observation.status, eventsCheckpointAt: entry.eventsCheckpointAt,
      contentHash: entry.eventsCheckpointContentHash, parserVersion: entry.eventsCheckpointParserVersion,
      events: structuredClone(entry.events) };
    pages.push(page);
    if (!reported.has(`${entry.source}\0${entry.url}`)) carriedRecordCount += entry.events.length;
  }
  pages.sort((a, b) => a.provider.localeCompare(b.provider) || a.url.localeCompare(b.url));
  return { schemaVersion: 1, collectionRunId: cycle.collectionRunId, pages, counts, countsByProvider, carriedRecordCount };
}

export function recordCollectionCycleObservation(state, url, observation) {
  const cycle = state?.cycle ? validateCollectionScope(state.cycle) : null;
  const entry = state?.entries?.find(candidate => candidate.url === url);
  if (!cycle || !entry || !observation || !['verified', 'retired', 'quarantined', 'failed'].includes(observation.status))
    throw new Error('Invalid collection cycle observation');
  entry.cycleObservation = {
    cycleId: cycle.collectionRunId,
    attemptedAt: iso(observation.attemptedAt, 'observation time'),
    status: observation.status,
  };
  return entry.cycleObservation;
}

export function collectionCycleReceipt(scope, { sourceCoverage, inventoryHash, inventoryComplete, finishedAt, stoppedBy = null }) {
  const cycle = validateCollectionScope(scope);
  if (!sourceCoverage || typeof sourceCoverage !== 'object' || typeof inventoryHash !== 'string' || !/^[a-f0-9]{64}$/.test(inventoryHash))
    throw new Error('Invalid collection cycle coverage');
  const complete = cycle.scope === 'full' && inventoryComplete === true && stoppedBy === null &&
    cycle.providers.every(provider => sourceCoverage[provider]?.complete === true);
  return { schemaVersion: 2, collectionRunId: cycle.collectionRunId, scope: cycle.scope,
    providers: cycle.providers, horizonStart: cycle.horizonStart, horizonEnd: cycle.horizonEnd,
    startedAt: cycle.startedAt, finishedAt: iso(finishedAt, 'finishedAt'), scopeEvidence: cycle.scopeEvidence,
    listingConfigHash: cycle.scopeEvidence.listingConfigHash, inventoryHash, complete,
    ...(stoppedBy ? { stoppedBy } : {}) };
}
