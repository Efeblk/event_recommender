import { isSourceQuarantineReason } from '../contracts/source-evidence.ts';

export const COVERAGE_SCHEMA_VERSION = 1;

export function serializedCheckpointWriter(write) {
  let tail = Promise.resolve();
  return () => {
    const pending = tail.then(write);
    tail = pending.catch(() => {});
    return pending;
  };
}

export function normalizeCoverage(value) {
  if (!value || value.schemaVersion !== COVERAGE_SCHEMA_VERSION || !Array.isArray(value.entries))
    return { schemaVersion: COVERAGE_SCHEMA_VERSION, updatedAt: null, entries: [], listings: {} };
  return {
    schemaVersion: COVERAGE_SCHEMA_VERSION,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    entries: value.entries.filter(validEntry).map((entry) => ({ ...entry })),
    listings: value.listings && typeof value.listings === 'object' && !Array.isArray(value.listings) ? { ...value.listings } : {},
    ...(value.cycle && typeof value.cycle === 'object' && !Array.isArray(value.cycle)
      ? { cycle: structuredClone(value.cycle) } : {}),
  };
}

export function addCoverageEntries(state, entries, now = new Date().toISOString()) {
  const byUrl = new Map(state.entries.map((entry) => [entry.url, entry]));
  for (const candidate of entries) {
    if (!candidate?.url || !candidate?.source) continue;
    const current = byUrl.get(candidate.url);
    if (current) {
      if (!current.category && candidate.category) current.category = candidate.category;
      if (current.retiredAt && candidate.reactivate === true) current.reactivateAt = now;
      continue;
    }
    const entry = {
      url: candidate.url, source: candidate.source, category: candidate.category ?? null,
      discoveredAt: now, lastAttemptAt: null, lastSuccessAt: candidate.lastSuccessAt ?? null,
      lastFailureAt: null, attempts: 0, failure: null,
    };
    state.entries.push(entry); byUrl.set(entry.url, entry);
  }
  state.updatedAt = now;
  return state;
}

export function fairCoverageOrder(state, selectedSources, now = new Date().toISOString(), retiredRecheckMs = 7 * 86400000, cycleId = null) {
  const allowed = new Set(selectedSources);
  const buckets = new Map(selectedSources.map((source) => [source, []]));
  const current = Date.parse(now);
  for (const entry of state.entries) {
    if (!allowed.has(entry.source)) continue;
    if (entry.retiredAt) {
      const unobservedInCycle = cycleId !== null && entry.cycleObservation?.cycleId !== cycleId;
      const due = Number.isFinite(Date.parse(entry.retiredAt)) && current - Date.parse(entry.retiredAt) >= retiredRecheckMs;
      const reactive = Number.isFinite(Date.parse(entry.reactivateAt)) && Date.parse(entry.reactivateAt) > Date.parse(entry.lastAttemptAt ?? 0);
      if (!unobservedInCycle && !due && !reactive) continue;
    }
    buckets.get(entry.source).push(entry);
  }
  for (const entries of buckets.values()) entries.sort((a, b) => {
    if (cycleId !== null) {
      const aObserved = a.cycleObservation?.cycleId === cycleId;
      const bObserved = b.cycleObservation?.cycleId === cycleId;
      if (aObserved !== bObserved) return aObserved ? 1 : -1;
    }
    return priority(a, b);
  });
  const ordered = [];
  for (let index = 0; ; index++) {
    let added = false;
    for (const source of selectedSources) if (buckets.get(source)[index]) { ordered.push(buckets.get(source)[index]); added = true; }
    if (!added) break;
  }
  return ordered;
}

export function recordCoverageAttempt(state, url, { success, failure = null, retired = false, quarantined = false }, now = new Date().toISOString()) {
  const entry = state.entries.find((candidate) => candidate.url === url);
  if (!entry) return;
  if (quarantined && (success || retired || !isSourceQuarantineReason(failure))) throw new Error('Invalid source quarantine');
  entry.attempts += 1; entry.lastAttemptAt = now;
  if (success) { entry.lastSuccessAt = now; entry.failure = null; entry.retiredAt = null; entry.quarantinedAt = null; entry.quarantineReason = null; }
  else if (retired) { entry.lastFailureAt = now; entry.failure = null; entry.retiredAt = now; entry.quarantinedAt = null; entry.quarantineReason = null; }
  else if (quarantined) { entry.lastFailureAt = now; entry.failure = failure; entry.retiredAt = null; entry.quarantinedAt = now; entry.quarantineReason = failure; }
  else { entry.lastFailureAt = now; entry.failure = failure ?? 'unknown'; }
  state.updatedAt = now;
}

export function checkpointCoverageEvents(state, url, events, now = new Date().toISOString(), provenance = {}) {
  const entry = state.entries.find((candidate) => candidate.url === url);
  if (entry) {
    entry.events = events.map((event) => ({ ...event }));
    entry.eventsCheckpointAt = now;
    entry.eventsCheckpointUrl = entry.url;
    entry.eventsCheckpointSource = entry.source;
    entry.eventsCheckpointStatus = events.length ? 'active' : entry.quarantinedAt === now ? 'quarantined' : 'retired';
    if (typeof provenance.contentHash === 'string') entry.eventsCheckpointContentHash = provenance.contentHash;
    else delete entry.eventsCheckpointContentHash;
    if (typeof provenance.parserVersion === 'string') entry.eventsCheckpointParserVersion = provenance.parserVersion;
    else delete entry.eventsCheckpointParserVersion;
  }
}

/** Replace, rather than union, snapshot rows for trustworthy completed URL checkpoints. */
export function recoverCoverageEvents(snapshot, state, validate = () => [], now = new Date()) {
  const replacements = recoverableCoverageEntries(snapshot, state, validate, now);
  const combined = snapshot.filter((event) => !replacements.has(event.url));
  for (const entry of replacements.values()) combined.push(...entry.events);
  return [...new Map(combined.map((event) => [event.id, event])).values()];
}

/** Pages durably fetched after the last published snapshot, ready for a later run. */
export function unpublishedCoveragePages(snapshot, state, validate = () => [], now = new Date()) {
  const snapshotInventory = inventoryByUrl(snapshot);
  const snapshotEvents = eventsByUrl(snapshot);
  return [...recoverableCoverageEntries(snapshot, state, validate, now).values()]
    .filter((entry) => entry.status === 'retired' || entry.status === 'quarantined' || entry.events.length > 0)
    .filter((entry) => {
      const current = snapshotInventory.get(entry.url) ?? new Set();
      // An empty snapshot is not proof that its remote watermark was published.
      // Replay explicit empty states until a newer verified source page replaces them.
      // Beyond the import freshness window, an older active replay is itself
      // inadmissible. Keep the durable state but do not send an expired marker.
      if (entry.status === 'retired' || entry.status === 'quarantined')
        return Date.parse(entry.checkpointAt) >= now.getTime() - 72 * 3600000;
      const cached = new Set(entry.events.map((event) => `${event.id}|${event.checkedAt}`));
      return current.size !== cached.size || [...cached].some((key) => !current.has(key)) ||
        comparablePage(snapshotEvents.get(entry.url) ?? []) !== comparablePage(entry.events);
    })
    .map((entry) => ({
      source: entry.source,
      url: entry.url,
      checkedAt: entry.checkpointAt,
      ...(entry.status === 'retired' ? { retiredAt: entry.checkpointAt } : {}),
      ...(entry.status === 'quarantined' ? { quarantinedAt: entry.checkpointAt, quarantineReason: entry.quarantineReason } : {}),
      ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
      ...(entry.parserVersion ? { parserVersion: entry.parserVersion } : {}),
      events: entry.events.map((event) => ({ ...event })),
      recoveredFromCoverage: true,
    }));
}

function inventoryByUrl(events) {
  const result = new Map();
  for (const event of events) {
    if (typeof event?.url !== 'string') continue;
    const inventory = result.get(event.url) ?? new Set();
    inventory.add(`${event.id}|${event.checkedAt}`);
    result.set(event.url, inventory);
  }
  return result;
}

function eventsByUrl(events) {
  const result = new Map();
  for (const event of events) {
    if (typeof event?.url !== 'string') continue;
    const group = result.get(event.url) ?? [];
    group.push(event);
    result.set(event.url, group);
  }
  return result;
}

function comparablePage(events) {
  return canonicalJson(events.map((event) => {
    const { productionKey: _derived, ...source } = event;
    return source;
  }).sort((a, b) => `${a.id}|${a.checkedAt}`.localeCompare(`${b.id}|${b.checkedAt}`)));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function recoverableCoverageEntries(snapshot, state, validate, now) {
  const replacements = new Map();
  const newestSnapshotByUrl = new Map();
  for (const event of snapshot) {
    const checked = Date.parse(event?.checkedAt);
    if (!Number.isFinite(checked) || typeof event?.url !== 'string') continue;
    newestSnapshotByUrl.set(event.url, Math.max(newestSnapshotByUrl.get(event.url) ?? -Infinity, checked));
  }
  const current = now.getTime(), sequencingToleranceMs = 60_000;
  for (const entry of state.entries) {
    if (!Array.isArray(entry.events) || entry.eventsCheckpointUrl !== entry.url || entry.eventsCheckpointSource !== entry.source ||
        !Number.isFinite(Date.parse(entry.eventsCheckpointAt))) continue;
    try { if (new URL(entry.url).protocol !== 'https:') continue; } catch { continue; }
    const checkpointAt = Date.parse(entry.eventsCheckpointAt);
    if (checkpointAt > current + sequencingToleranceMs || (newestSnapshotByUrl.get(entry.url) ?? -Infinity) > checkpointAt) continue;
    const successAt = Date.parse(entry.lastSuccessAt), retiredAt = Date.parse(entry.retiredAt);
    const active = entry.eventsCheckpointStatus === 'active' && entry.events.length > 0 && Number.isFinite(successAt) &&
      checkpointAt >= successAt && checkpointAt - successAt <= sequencingToleranceMs;
    const retired = entry.eventsCheckpointStatus === 'retired' && entry.events.length === 0 && Number.isFinite(retiredAt) &&
      checkpointAt === retiredAt;
    const quarantined = entry.eventsCheckpointStatus === 'quarantined' && entry.events.length === 0 &&
      Number.isFinite(Date.parse(entry.quarantinedAt)) && checkpointAt === Date.parse(entry.quarantinedAt) &&
      isSourceQuarantineReason(entry.quarantineReason);
    if (!active && !retired && !quarantined) continue;
    const recoverableEvents = entry.events.filter((event) => {
      const startsAt = Date.parse(event?.startsAt);
      return !Number.isFinite(startsAt) || startsAt >= current;
    });
    if (recoverableEvents.some((event) => event?.url !== entry.url || event?.source !== entry.source ||
        !Number.isFinite(Date.parse(event.checkedAt)) || Date.parse(event.checkedAt) > checkpointAt + sequencingToleranceMs ||
        Date.parse(event.checkedAt) > successAt + sequencingToleranceMs || validate(event).length)) continue;
    replacements.set(entry.url, {
      url: entry.url,
      source: entry.source,
      checkpointAt: entry.eventsCheckpointAt,
      status: entry.eventsCheckpointStatus,
      quarantineReason: entry.quarantineReason ?? null,
      events: recoverableEvents.map((event) => ({ ...event })),
      contentHash: typeof entry.eventsCheckpointContentHash === 'string' ? entry.eventsCheckpointContentHash : null,
      parserVersion: typeof entry.eventsCheckpointParserVersion === 'string' ? entry.eventsCheckpointParserVersion : null,
    });
  }
  return replacements;
}

export function verifyCompletePage(events, validate, source, url) {
  const accepted = [], quarantined = [];
  for (const event of events) {
    const errors = validate(event);
    if (errors.length) quarantined.push({ source, url, id: event?.id, errors });
    else accepted.push(event);
  }
  return { accepted, quarantined, complete: quarantined.length === 0 };
}

export function coverageBySource(state, selectedSources, attemptedUrls, verifiedUrls, quarantined, listingComplete, runStartedAt, freshnessMs = 72 * 60 * 60 * 1000) {
  const attempted = new Set(attemptedUrls), verified = new Set(verifiedUrls);
  const started = Date.parse(runStartedAt), freshAfter = started - freshnessMs;
  return Object.fromEntries(selectedSources.map((source) => {
    const entries = state.entries.filter((entry) => entry.source === source);
    const failures = entries.filter((entry) => entry.failure !== null);
    const unvisited = entries.filter((entry) => entry.lastAttemptAt === null);
    const retired = entries.filter((entry) => entry.retiredAt);
    const stale = entries.filter((entry) => !entry.retiredAt && (!entry.lastSuccessAt || Date.parse(entry.lastSuccessAt) < freshAfter));
    const unattemptedThisRun = entries.filter((entry) => !entry.lastAttemptAt || Date.parse(entry.lastAttemptAt) < started);
    return [source, {
      discovered: entries.length, attempted: entries.filter((entry) => attempted.has(entry.url)).length,
      verified: entries.filter((entry) => verified.has(entry.url)).length,
      quarantined: quarantined.filter((item) => item.source === source).length,
      unvisited: unvisited.length, stale: stale.length, unattemptedThisRun: unattemptedThisRun.length,
      failure: failures.length, retired: retired.length,
      complete: Boolean(listingComplete[source]) && unvisited.length === 0 && stale.length === 0 && failures.length === 0,
    }];
  }));
}

function priority(a, b) {
  return Number(Boolean(a.retiredAt)) - Number(Boolean(b.retiredAt)) ||
    Number(a.lastAttemptAt !== null) - Number(b.lastAttemptAt !== null) ||
    String(a.lastAttemptAt ?? '').localeCompare(String(b.lastAttemptAt ?? '')) ||
    a.url.localeCompare(b.url);
}
function validEntry(entry) {
  return entry && typeof entry.url === 'string' && typeof entry.source === 'string' &&
    Number.isInteger(entry.attempts) && entry.attempts >= 0;
}
