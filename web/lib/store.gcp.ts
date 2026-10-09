import { buildSearchCatalog, searchCatalogCandidates, type SearchCatalog } from './materialized-catalog.ts';
import { sourcePageTimes } from './source-page.ts';
import {
  MAX_CHECKPOINT_BYTES,
  MAX_CHECKPOINT_EVENTS,
  parseCheckpointPointer,
  parseCollectionReport,
  type CheckpointPointer,
  type CollectionCheckpoint,
} from './operations.ts';
import { validVector } from './providers.ts';
import { emptyFilters, type EventRecord } from './types.ts';
import { voyageDocumentText } from './voyage.ts';
import { validateProviderListing } from '../../contracts/listing.ts';
import type {
  BlobStore,
  CatalogStatus,
  CheckpointPublicationAttempt,
  CheckpointPublicationFailureCode,
  CheckpointPublicationPhase,
  ControlStore,
  ControlTransaction,
  HighLevelStore,
  Lease,
  SourcePage,
  VectorEntry,
} from './storage-contract.ts';

interface SourceHead {
  url: string;
  key: string;
  hash: string;
  checkedAt: string;
  events: number;
  kind?: 'active' | 'retired' | 'quarantined';
}
interface SearchPointer {
  key: string;
  hash: string;
  bytes: number;
  profile?: string;
  dimensions?: number;
  checkpoint?: CheckpointPointer;
}
interface CatalogHead {
  revision: string;
  hash: string;
  pointer: CheckpointPointer;
  search?: SearchPointer;
  pendingSearch?: SearchPointer;
}
interface VectorHead {
  profile: string;
  revision: string;
  key: string;
  hash: string;
}
interface VectorSnapshot {
  schemaVersion: 1;
  profile: string;
  entries: VectorEntry[];
}

// Whole-profile snapshots keep reads independent of catalog size. Each indexing
// batch rewrites this object; measure that cost before increasing these bounds.
const MAX_VECTOR_BYTES = 128 * 1024 * 1024;
const MAX_VECTORS = 20_000;
const MAX_SOURCE_BYTES = 4_000_000;
const SOURCE_READ_CONCURRENCY = 8;
const encoder = new TextEncoder();
const bytes = (body: string) => encoder.encode(body).byteLength;
/** Checkpoint copy of an event: the full provider listing stays in the staged
 * source pages and collector artifacts, not in the restorable checkpoint. */
function checkpointEvent(event: EventRecord): EventRecord {
  const { providerListing: _providerListing, ...retained } = event;
  return retained;
}
function duplicateListingIdentity(event: EventRecord) {
  if (!event.providerListing) throw new Error('Conflicting source event identity');
  const listing = validateProviderListing(event.providerListing);
  if (
    !listing.providerEventId ||
    listing.listingId.slice(0, 24) !== event.id ||
    listing.provider !== event.source ||
    listing.url !== event.url ||
    listing.observedAt !== event.checkedAt
  )
    throw new Error('Conflicting source event identity');
  return listing;
}
const hashPattern = /^[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const attemptIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_DIAGNOSTIC_COUNT = 100_000;
const MAX_DIAGNOSTIC_BYTES = 512 * 1024 * 1024;
const MAX_DIAGNOSTIC_ELAPSED_MS = 24 * 3600 * 1000;
const publicationPhases = new Set<CheckpointPublicationPhase>([
  'source_heads',
  'source_reads',
  'materialize',
  'write_search',
  'write_checkpoint',
  'activate',
  'complete',
]);
const publicationFailures = new Set<CheckpointPublicationFailureCode>([
  'request_aborted',
  'deadline_exceeded',
  'publication_failed',
]);
function publicationAttempt(value: unknown): CheckpointPublicationAttempt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const attempt = value as Partial<CheckpointPublicationAttempt>;
  const timestamp = (input: unknown) => {
    if (typeof input !== 'string') return false;
    const parsed = Date.parse(input);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === input;
  };
  const count = (input: unknown, maximum: number) =>
    Number.isSafeInteger(input) && (input as number) >= 0 && (input as number) <= maximum;
  if (
    attempt.schemaVersion !== 1 ||
    typeof attempt.attemptId !== 'string' ||
    !attemptIdPattern.test(attempt.attemptId) ||
    (attempt.deploymentRevision !== null &&
      (typeof attempt.deploymentRevision !== 'string' ||
        !revisionPattern.test(attempt.deploymentRevision))) ||
    !timestamp(attempt.reportFinishedAt) ||
    !timestamp(attempt.startedAt) ||
    !publicationPhases.has(attempt.phase as CheckpointPublicationPhase) ||
    !count(attempt.sourcesTotal, MAX_DIAGNOSTIC_COUNT) ||
    !count(attempt.sourcesRead, MAX_DIAGNOSTIC_COUNT) ||
    (attempt.sourcesRead as number) > (attempt.sourcesTotal as number) ||
    !count(attempt.events, MAX_DIAGNOSTIC_COUNT) ||
    (attempt.searchBytes !== null && !count(attempt.searchBytes, MAX_DIAGNOSTIC_BYTES)) ||
    (attempt.checkpointBytes !== null && !count(attempt.checkpointBytes, MAX_DIAGNOSTIC_BYTES)) ||
    !count(attempt.elapsedMs, MAX_DIAGNOSTIC_ELAPSED_MS) ||
    (attempt.phaseStartedElapsedMs !== undefined &&
      (!count(attempt.phaseStartedElapsedMs, MAX_DIAGNOSTIC_ELAPSED_MS) ||
        (attempt.phaseStartedElapsedMs as number) > (attempt.elapsedMs as number))) ||
    !['running', 'succeeded', 'failed'].includes(attempt.outcome ?? '') ||
    (attempt.failureCode !== null &&
      !publicationFailures.has(attempt.failureCode as CheckpointPublicationFailureCode))
  )
    return null;
  if (
    (attempt.outcome === 'running' && (attempt.failureCode !== null || attempt.phase === 'complete')) ||
    (attempt.outcome === 'succeeded' && (attempt.failureCode !== null || attempt.phase !== 'complete')) ||
    (attempt.outcome === 'failed' && attempt.failureCode === null)
  )
    return null;
  return {
    schemaVersion: 1,
    attemptId: attempt.attemptId,
    deploymentRevision: attempt.deploymentRevision,
    reportFinishedAt: attempt.reportFinishedAt,
    startedAt: attempt.startedAt,
    phase: attempt.phase,
    sourcesTotal: attempt.sourcesTotal,
    sourcesRead: attempt.sourcesRead,
    events: attempt.events,
    searchBytes: attempt.searchBytes,
    checkpointBytes: attempt.checkpointBytes,
    elapsedMs: attempt.elapsedMs,
    ...(attempt.phaseStartedElapsedMs !== undefined
      ? { phaseStartedElapsedMs: attempt.phaseStartedElapsedMs }
      : {}),
    outcome: attempt.outcome,
    failureCode: attempt.failureCode,
  } as CheckpointPublicationAttempt;
}
class CheckpointPublicationStopped extends Error {
  readonly failureCode: CheckpointPublicationFailureCode;
  constructor(failureCode: CheckpointPublicationFailureCode) {
    super(`Checkpoint publication stopped: ${failureCode}`);
    this.failureCode = failureCode;
  }
}
async function digest(body: string) {
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(body));
  return Array.from(new Uint8Array(hash), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
function statusFor(events: Pick<EventRecord, 'startsAt' | 'checkedAt' | 'availability'>[], now: Date): CatalogStatus {
  const cutoff = new Date(now.getTime() - 72 * 3600000).toISOString();
  const time = now.toISOString();
  let oldestCheckedAt: string | null = null,
    lastCheckedAt: string | null = null;
  let eligible = 0,
    fresh = 0;
  for (const event of events) {
    if (!oldestCheckedAt || event.checkedAt < oldestCheckedAt)
      oldestCheckedAt = event.checkedAt;
    if (!lastCheckedAt || event.checkedAt > lastCheckedAt)
      lastCheckedAt = event.checkedAt;
    if (event.checkedAt >= cutoff) {
      fresh++;
      if (event.startsAt >= time && event.availability === 'available')
        eligible++;
    }
  }
  return {
    status: eligible ? 'ready' : events.length && !fresh ? 'stale' : 'empty',
    stored: events.length,
    eligible,
    lastCheckedAt,
    oldestCheckedAt,
    expiresAt: lastCheckedAt
      ? new Date(Date.parse(lastCheckedAt) + 72 * 3600000).toISOString()
      : null,
  };
}
function sameRevision(
  a: { revision: string } | null,
  b: { revision: string } | null,
) {
  return (a?.revision ?? null) === (b?.revision ?? null);
}
function profileDimensions(profile: string): number | null {
  const voyage = /(?:^|\|)dimensions=(\d+)(?:\||$)/.exec(profile);
  if (voyage) return Number(voyage[1]);
  try {
    const legacy = JSON.parse(profile);
    if (
      Array.isArray(legacy) &&
      legacy[0] === 'embedding-v2' &&
      Number.isSafeInteger(legacy[3])
    )
      return legacy[3];
  } catch {
    /* Unknown profiles still use exact identity and read-time dimensions. */
  }
  return null;
}

export function createGcpStore(options: {
  control: ControlStore;
  blobs: BlobStore;
  now?: () => number;
  namespace?: string;
  embeddingProfile?: { profile: string; dimensions: number };
}): HighLevelStore {
  const { control, blobs } = options;
  const now = options.now ?? Date.now;
  const embeddingProfile = options.embeddingProfile;
  if (embeddingProfile && (!embeddingProfile.profile || !Number.isSafeInteger(embeddingProfile.dimensions) || embeddingProfile.dimensions < 1 || embeddingProfile.dimensions > 16384))
    throw new Error('Invalid search embedding profile');
  const namespace = options.namespace ?? 'default';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace))
    throw new Error('Invalid storage namespace');
  const base = `biplan/${namespace}`;
  const catalogPath = `${base}/state/catalog`;
  const publicationPath = `${base}/state/checkpoint-publication`;
  // One catalog and one vector profile per instance; pointers are re-read on
  // every operation so another instance's publication is immediately visible.
  let catalogCache:
    | {
        key: string;
        hash: string;
        body: string;
      }
    | undefined;
  const searchCache = new Map<string, SearchCatalog>();
  const searchLoads = new Map<string, Promise<SearchCatalog>>();
  let vectorCache:
    | {
        key: string;
        hash: string;
        profile: string;
        entries: Map<string, number[]>;
      }
    | undefined;
  const leasePath = async (key: string) =>
    `${base}/leases/${await digest(key)}`;
  const profilePath = async (profile: string) =>
    `${base}/vectorProfiles/${await digest(profile)}`;

  async function liveLease(tx: ControlTransaction, lease: Lease, path: string) {
    const current = await tx.get<Lease>(path);
    if (
      !current ||
      current.key !== lease.key ||
      current.token !== lease.token ||
      current.expiresAt !== lease.expiresAt ||
      current.expiresAt <= now()
    )
      throw new Error('Storage lease expired or replaced');
  }
  function requireLeaseKind(lease: Lease, kinds: string[]) {
    if (!kinds.includes(lease.key)) throw new Error('Wrong storage lease');
  }
  async function catalogHead() {
    const head = await control.get<CatalogHead>(catalogPath);
    if (
      head &&
      (!hashPattern.test(head.hash) ||
        !head.revision ||
        !parseCheckpointPointer(JSON.stringify(head.pointer)))
    )
      throw new Error('Invalid catalog publication');
    return head;
  }
  async function readCatalog(head: CatalogHead | null) {
    if (!head) return null;
    if (
      catalogCache?.key === head.pointer.key &&
      catalogCache.hash === head.hash
    )
      return catalogCache;
    const object = await blobs.get(head.pointer.key);
    if (
      !object ||
      object.bytes > MAX_CHECKPOINT_BYTES ||
      object.bytes !== head.pointer.bytes ||
      bytes(object.body) !== object.bytes ||
      (await digest(object.body)) !== head.hash
    )
      throw new Error('Published catalog object unavailable or damaged');
    const checkpoint = JSON.parse(object.body) as CollectionCheckpoint;
    if (
      checkpoint.schemaVersion !== 1 ||
      checkpoint.savedAt !== head.pointer.savedAt ||
      checkpoint.report?.finishedAt !== head.pointer.finishedAt ||
      !Array.isArray(checkpoint.events) ||
      checkpoint.events.length !== head.pointer.events ||
      checkpoint.events.length > MAX_CHECKPOINT_EVENTS
    )
      throw new Error('Invalid published catalog');
    catalogCache = {
      key: head.pointer.key,
      hash: head.hash,
      body: object.body,
    };
    return catalogCache;
  }
  function matchesProfile(pointer: SearchPointer | undefined) {
    return !!pointer && (!embeddingProfile || (pointer.profile === embeddingProfile.profile && pointer.dimensions === embeddingProfile.dimensions));
  }
  async function readSearch(pointer: SearchPointer | undefined): Promise<SearchCatalog | null> {
    if (!pointer) return null;
    if (!pointer.key || !hashPattern.test(pointer.hash) || !Number.isSafeInteger(pointer.bytes) || pointer.bytes < 1 || pointer.bytes > 128 * 1024 * 1024)
      throw new Error('Invalid search catalog pointer');
    const cacheKey = `${pointer.key}:${pointer.hash}:${pointer.bytes}`;
    const cached = searchCache.get(cacheKey);
    if (cached) return cached;
    const existing = searchLoads.get(cacheKey);
    if (existing) return existing;
    const load = (async () => {
      const projection = await blobs.get(pointer.key);
      if (!projection || projection.bytes !== pointer.bytes || bytes(projection.body) !== projection.bytes || await digest(projection.body) !== pointer.hash)
        throw new Error('Published search catalog unavailable or damaged');
      const search = JSON.parse(projection.body) as SearchCatalog;
      if (search.schemaVersion !== 1 || !Number.isFinite(Date.parse(search.materializedAt)) || !Array.isArray(search.groups) || !Array.isArray(search.sourceStatus))
        throw new Error('Invalid published search catalog');
      if (searchCache.size >= 2) searchCache.clear();
      searchCache.set(cacheKey, search);
      return search;
    })();
    searchLoads.set(cacheKey, load);
    try {
      return await load;
    } finally {
      if (searchLoads.get(cacheKey) === load) searchLoads.delete(cacheKey);
    }
  }
  async function activeSearch(head: CatalogHead | null) {
    if (!head) return null;
    if (matchesProfile(head.search)) return readSearch(head.search);
    if (matchesProfile(head.pendingSearch)) return null;
    throw new Error('Search catalog requires publication');
  }
  async function documentsFor(search: SearchCatalog, at: Date) {
    const documents = new Map<string, EventRecord>();
    for (const group of search.groups) {
      for (let index = 0; index < group.versions.length; index++) {
        const version = group.versions[index];
        // The selected current version and every future version can become visible.
        if ((group.versions[index + 1]?.from ?? Infinity) <= at.getTime()) continue;
        for (const event of version.events) {
          const hash = event.preparedSearch?.documentHash ?? await digest(voyageDocumentText(event));
          if (!documents.has(hash)) documents.set(hash, event);
        }
      }
    }
    return documents;
  }
  async function activeStatus(head: CatalogHead | null, at: Date) {
    const search = await activeSearch(head);
    if (!search) return statusFor([], at);
    // Retain each family's last visible records for stale/empty diagnostics after
    // its expiry version becomes empty; eligibility still uses only active cards.
    const records = search.groups.flatMap(({ versions }) => {
      let latest: EventRecord[] = [];
      for (const version of versions) {
        if (version.from > at.getTime()) break;
        if (version.events.length) latest = version.events;
      }
      return latest;
    });
    const status = statusFor(records, at);
    const eligible = searchCatalogCandidates(search, emptyFilters, at).length;
    return { ...status, eligible, status: eligible ? 'ready' as const : status.status === 'ready' ? 'empty' as const : status.status };
  }
  async function readVectors(head: VectorHead | null, profile: string) {
    if (!head) return new Map<string, number[]>();
    if (head.profile !== profile || !hashPattern.test(head.hash))
      throw new Error('Invalid vector publication');
    if (
      vectorCache?.key === head.key &&
      vectorCache.hash === head.hash &&
      vectorCache.profile === profile
    )
      return vectorCache.entries;
    // Readers already holding the immutable Map keep their own reference. Drop
    // the obsolete cache before fetching its replacement so both snapshots do
    // not remain rooted through the blob read and JSON parse.
    vectorCache = undefined;
    const object = await blobs.get(head.key);
    // An unreadable transport still fails the operation. Damaged cache contents
    // are misses, allowing ordinary indexing to repair them without provider retries.
    const entries = new Map<string, number[]>();
    if (
      object &&
      object.bytes <= MAX_VECTOR_BYTES &&
      bytes(object.body) === object.bytes &&
      (await digest(object.body)) === head.hash
    ) {
      try {
        const snapshot = JSON.parse(object.body) as VectorSnapshot;
        if (
          snapshot.schemaVersion === 1 &&
          snapshot.profile === profile &&
          Array.isArray(snapshot.entries) &&
          snapshot.entries.length <= MAX_VECTORS
        ) {
          for (const entry of snapshot.entries)
            if (
              entry &&
              hashPattern.test(entry.hash) &&
              Array.isArray(entry.vector)
            )
              entries.set(entry.hash, entry.vector);
        }
      } catch {
        /* Damaged cache entries are misses. */
      }
    }
    vectorCache = { key: head.key, hash: head.hash, profile, entries };
    return entries;
  }

  return {
    async health() {
      await control.get(catalogPath);
    },
    async candidates(filters, at = new Date(now())) {
      const search = await activeSearch(await catalogHead());
      return search ? searchCatalogCandidates(search, filters, at) : [];
    },
    async embeddingCandidates(at = new Date(now())) {
      const head = await catalogHead();
      const pointer = head?.pendingSearch ?? head?.search;
      if (!pointer) {
        if (head) throw new Error('Search catalog requires publication');
        return [];
      }
      if (!matchesProfile(pointer)) throw new Error('Search embedding profile mismatch');
      const search = await readSearch(pointer);
      return [...(await documentsFor(search!, at)).values()];
    },
    async activateSearchCatalog(profile, lease) {
      requireLeaseKind(lease, ['voyage_index_lock']);
      const lockPath = await leasePath(lease.key);
      const vectorPath = await profilePath(profile);
      const captured = await control.transaction(async (tx) => {
        await liveLease(tx, lease, lockPath);
        const head = await tx.get<CatalogHead>(catalogPath);
        const vectors = await tx.get<VectorHead>(vectorPath);
        return { head, vectors };
      });
      const pending = captured.head?.pendingSearch;
      if (!pending) return { activated: false, pending: 0 };
      if (!embeddingProfile || profile !== embeddingProfile.profile || pending.profile !== profile || pending.dimensions !== embeddingProfile.dimensions)
        throw new Error('Search embedding profile mismatch');
      const search = await readSearch(pending);
      const documents = await documentsFor(search!, new Date(now()));
      const vectors = await readVectors(captured.vectors, profile);
      // Heads published before immediate activation may still hold a pending
      // catalog; activate it even with missing vectors and report how many.
      const missing = [...documents.keys()].filter((hash) => !validVector(vectors.get(hash), embeddingProfile.dimensions)).length;
      await control.transaction(async (tx) => {
        await liveLease(tx, lease, lockPath);
        const head = await tx.get<CatalogHead>(catalogPath);
        const vectorHead = await tx.get<VectorHead>(vectorPath);
        if (!sameRevision(head, captured.head) || !sameRevision(vectorHead, captured.vectors))
          throw new Error('Search activation publication changed');
        const { pendingSearch: _pending, ...retained } = head!;
        tx.set(catalogPath, { ...retained, revision: crypto.randomUUID(), search: pending });
      });
      return { activated: true, pending: missing };
    },
    async catalogStatus(at = new Date(now())) {
      return activeStatus(await catalogHead(), at);
    },
    async currentPublished(at = new Date(now())) {
      const head = await catalogHead();
      const search = await activeSearch(head);
      return {
        catalog: await activeStatus(head, at),
        checkpoint: head?.pointer ?? null,
        search: {
          pending: Boolean(head?.pendingSearch),
          checkpoint: search ? head?.search?.checkpoint ?? null : null,
          sourceCatalog: statusFor(search?.sourceStatus ?? [], at),
        },
      };
    },
    async consumeLimit(key, limit, expiresAt) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        !Number.isFinite(expiresAt)
      )
        throw new Error('Invalid request limit');
      const path = `${base}/limits/${await digest(key)}`;
      return control.transaction(async (tx) => {
        const previous = await tx.get<{ count: number; expiresAt: number }>(
          path,
        );
        const time = now();
        if (expiresAt <= time) return false;
        const count =
          previous && previous.expiresAt > time ? previous.count : 0;
        if (!Number.isSafeInteger(count) || count < 0)
          throw new Error('Invalid request counter');
        if (count >= limit) return false;
        tx.set(path, { count: count + 1, expiresAt });
        return true;
      });
    },
    async acquireLease(key, ttlMs = 300000) {
      if (!key || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 3600000)
        throw new Error('Invalid storage lease');
      const path = await leasePath(key);
      return control.transaction(async (tx) => {
        const previous = await tx.get<Lease>(path);
        const time = now();
        if (previous && previous.expiresAt > time) return null;
        const lease = {
          key,
          token: crypto.randomUUID(),
          expiresAt: time + ttlMs,
        };
        tx.set(path, lease);
        return lease;
      });
    },
    async releaseLease(lease) {
      const path = await leasePath(lease.key);
      await control.transaction(async (tx) => {
        const current = await tx.get<Lease>(path);
        if (current?.token === lease.token) tx.delete(path);
      });
    },
    async importPages(pages, lease) {
      requireLeaseKind(lease, ['sync_lock']);
      const lockPath = await leasePath(lease.key);
      let imported = 0,
        skipped = 0;
      for (const page of pages) {
        const { checked, latest, kind } = sourcePageTimes(page);
        const sourceHash = await digest(page.url);
        const path = `${base}/sources/${sourceHash}`;
        const body = JSON.stringify({
          url: page.url,
          events: page.events,
          ...(page.retiredAt ? { retiredAt: page.retiredAt } : {}),
          ...(page.quarantinedAt ? { quarantinedAt: page.quarantinedAt } : {}),
          ...(page.quarantineReason ? { quarantineReason: page.quarantineReason } : {}),
        } satisfies SourcePage);
        if (bytes(body) > MAX_SOURCE_BYTES)
          throw new Error('Source page exceeds limit');
        const hash = await digest(body);
        const key = `sources/${namespace}/${sourceHash}/${hash}.json`;
        // Skip old batches before upload, then repeat the check in the commit.
        const previous = await control.get<SourceHead>(path);
        if (previous?.checkedAt && (previous.checkedAt > checked ||
            (previous.checkedAt === checked && previous.events === 0 && page.events.length > 0))) {
          skipped++;
          continue;
        }
        await blobs.putImmutable(key, body);
        const changed = await control.transaction(async (tx) => {
          await liveLease(tx, lease, lockPath);
          const current = await tx.get<SourceHead>(path);
          if (current?.checkedAt && (current.checkedAt > checked ||
              (current.checkedAt === checked && current.events === 0 && page.events.length > 0))) return false;
          tx.set(path, {
            url: page.url,
            key,
            hash,
            checkedAt: latest,
            events: page.events.length,
            kind,
          });
          return true;
        });
        if (changed) imported += page.events.length;
        else skipped++;
      }
      return { imported, skipped };
    },
    async checkpointPointer() {
      return (await catalogHead())?.pointer ?? null;
    },
    async readCheckpoint() {
      return (await readCatalog(await catalogHead()))?.body ?? null;
    },
    async checkpointPublication() {
      return publicationAttempt(
        await control.get<CheckpointPublicationAttempt>(publicationPath),
      );
    },
    async checkpointExists(pointer) {
      return blobs.exists(pointer.key);
    },
    async publishCheckpoint(rawReport, lease, options = {}) {
      requireLeaseKind(lease, ['sync_lock']);
      const report = parseCollectionReport(
        { schemaVersion: 1, report: rawReport },
        now(),
      );
      const lockPath = await leasePath(lease.key);
      if (
        options.deadline !== undefined &&
        (!Number.isSafeInteger(options.deadline) || options.deadline <= 0)
      )
        throw new Error('Invalid checkpoint publication deadline');
      if (
        options.deploymentRevision !== undefined &&
        !revisionPattern.test(options.deploymentRevision)
      )
        throw new Error('Invalid deployment revision');
      const started = now();
      const attempt: CheckpointPublicationAttempt = {
        schemaVersion: 1,
        attemptId: crypto.randomUUID(),
        deploymentRevision: options.deploymentRevision ?? null,
        reportFinishedAt: report.finishedAt,
        startedAt: new Date(started).toISOString(),
        phase: 'source_heads',
        sourcesTotal: 0,
        sourcesRead: 0,
        events: 0,
        searchBytes: null,
        checkpointBytes: null,
        elapsedMs: 0,
        phaseStartedElapsedMs: 0,
        outcome: 'running',
        failureCode: null,
      };
      const elapsed = () => Math.max(0, Math.round(now() - started));
      const guard = () => {
        if (options.signal?.aborted)
          throw new CheckpointPublicationStopped('request_aborted');
        const time = now();
        if (options.deadline !== undefined && time >= options.deadline)
          throw new CheckpointPublicationStopped('deadline_exceeded');
      };
      const updateAttempt = async (requireLiveLease = true) => {
        attempt.elapsedMs = elapsed();
        await control.transaction(async (tx) => {
          if (requireLiveLease) await liveLease(tx, lease, lockPath);
          const current = await tx.get<CheckpointPublicationAttempt>(publicationPath);
          if (current?.attemptId !== attempt.attemptId)
            throw new CheckpointPublicationStopped('publication_failed');
          tx.set(publicationPath, { ...attempt });
        });
      };
      const enter = async (phase: CheckpointPublicationPhase) => {
        guard();
        attempt.phase = phase;
        attempt.phaseStartedElapsedMs = elapsed();
        await updateAttempt();
        guard();
      };
      let previous: CatalogHead | null = null;
      try {
        previous = await control.transaction(async (tx) => {
          await liveLease(tx, lease, lockPath);
          const head = await tx.get<CatalogHead>(catalogPath);
          tx.set(publicationPath, { ...attempt });
          return head;
        });
        guard();
        if (
          previous &&
          (report.finishedAt < previous.pointer.finishedAt ||
            (report.finishedAt === previous.pointer.finishedAt &&
              (matchesProfile(previous.pendingSearch) || matchesProfile(previous.search))))
        ) {
          attempt.phase = 'complete';
          attempt.phaseStartedElapsedMs = elapsed();
          attempt.events = previous.pointer.events;
          attempt.checkpointBytes = previous.pointer.bytes;
          attempt.outcome = 'succeeded';
          await updateAttempt();
          return previous.pointer;
        }
        const sources = await control.list<SourceHead>(`${base}/sources`);
        attempt.sourcesTotal = sources.length;
        await enter('source_reads');
        if (sources.length > MAX_CHECKPOINT_EVENTS)
          throw new Error('Checkpoint source limit exceeded');
        for (const { data: source } of sources) {
          const checkedAt = Date.parse(source.checkedAt);
          if (
            !source.url ||
            !source.key ||
            !hashPattern.test(source.hash) ||
            !Number.isFinite(checkedAt) ||
            new Date(checkedAt).toISOString() !== source.checkedAt ||
            !Number.isSafeInteger(source.events) ||
            source.events < 0
          )
            throw new Error('Invalid staged source head');
          if (source.checkedAt > report.finishedAt)
            throw new Error('Staged source is newer than collection report');
        }
        const selected = new Map<
          string,
          { event: EventRecord; checkpointBytes: number }
        >();
        let approximateBytes = 2;
        for (
          let offset = 0;
          offset < sources.length;
          offset += SOURCE_READ_CONCURRENCY
        ) {
          guard();
          // A bounded group avoids one network round trip per source in sequence
          // while keeping page bodies within a predictable memory envelope.
          const group = await Promise.all(
            sources
              .slice(offset, offset + SOURCE_READ_CONCURRENCY)
              .map(async ({ data: source }) => ({
                source,
                object: await blobs.get(source.key),
              })),
          );
          guard();
          for (const { source, object } of group) {
            if (
              !object ||
              object.bytes > MAX_SOURCE_BYTES ||
              bytes(object.body) !== object.bytes ||
              (await digest(object.body)) !== source.hash
            )
              throw new Error('Source page unavailable or damaged');
            const page = JSON.parse(object.body) as SourcePage;
            if (
              page.url !== source.url ||
              !Array.isArray(page.events) ||
              page.events.length !== source.events
            )
              throw new Error('Invalid source page object');
            const times = sourcePageTimes(page);
            if (times.latest !== source.checkedAt) throw new Error('Source page timestamp mismatch');
            if (source.kind && times.kind !== source.kind) throw new Error('Source page kind mismatch');
            const pageIds = new Set<string>();
            for (const event of page.events) {
              if (event.url !== source.url || pageIds.has(event.id))
                throw new Error('Conflicting source event identity');
              pageIds.add(event.id);
              const checkpointBytes = bytes(JSON.stringify(checkpointEvent(event))) + 1;
              const prior = selected.get(event.id);
              if (prior) {
                const priorListing = duplicateListingIdentity(prior.event);
                const listing = duplicateListingIdentity(event);
                if (
                  listing.listingId !== priorListing.listingId ||
                  event.checkedAt === prior.event.checkedAt
                )
                  throw new Error('Conflicting source event identity');
                if (event.checkedAt > prior.event.checkedAt) {
                  if (
                    approximateBytes + checkpointBytes - prior.checkpointBytes >
                    MAX_CHECKPOINT_BYTES
                  )
                    throw new Error('Checkpoint exceeds limit');
                  approximateBytes += checkpointBytes - prior.checkpointBytes;
                  selected.set(event.id, { event, checkpointBytes });
                }
                continue;
              }
              if (
                selected.size >= MAX_CHECKPOINT_EVENTS ||
                approximateBytes + checkpointBytes > MAX_CHECKPOINT_BYTES
              )
                throw new Error('Checkpoint exceeds limit');
              approximateBytes += checkpointBytes;
              selected.set(event.id, { event, checkpointBytes });
            }
          }
          attempt.sourcesRead += group.length;
          attempt.events = selected.size;
        }
        const events = [...selected.values()].map(({ event }) => event);
        if (!events.length)
          throw new Error('Cannot publish an empty staged catalog');
        events.sort((a, b) => a.id.localeCompare(b.id));
        attempt.events = events.length;
        await enter('materialize');
        const savedAt = new Date(now()).toISOString();
        // Materialization is synchronous. The guards around it prevent writes
        // after an abort or deadline, but cannot interrupt work already running.
        const searchBody = JSON.stringify(buildSearchCatalog(events, new Date(savedAt)));
        guard();
        const searchBytes = bytes(searchBody);
        attempt.searchBytes = searchBytes;
        await enter('write_search');
        if (searchBytes > 128 * 1024 * 1024) throw new Error('Search catalog exceeds limit');
        const searchKey = `search-catalog/${savedAt.replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`;
        await blobs.putImmutable(searchKey, searchBody);
        guard();
        // Identity used the full provider listings above; the durable checkpoint
        // omits those duplicated copies so it stays within transfer limits.
        const checkpoint: CollectionCheckpoint = {
          schemaVersion: 1,
          savedAt,
          events: events.map(checkpointEvent),
          report,
        };
        const body = JSON.stringify(checkpoint);
        const size = bytes(body);
        attempt.checkpointBytes = size;
        await enter('write_checkpoint');
        if (size > MAX_CHECKPOINT_BYTES)
          throw new Error('Checkpoint exceeds limit');
        const key = `collection/${savedAt.replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`;
        await blobs.putImmutable(key, body);
        guard();
        const pointer: CheckpointPointer = {
          schemaVersion: 1,
          key,
          savedAt,
          finishedAt: report.finishedAt,
          events: events.length,
          bytes: size,
          summary: report.summary,
        };
        const prepared: SearchPointer = {
          key: searchKey, hash: await digest(searchBody), bytes: searchBytes,
          checkpoint: pointer,
          ...(embeddingProfile ? { profile: embeddingProfile.profile, dimensions: embeddingProfile.dimensions } : {}),
        };
        // A validated catalog goes live at once. Embeddings are optional
        // enrichment: documents without a vector keep lexical retrieval, and
        // cancellations or time changes never wait behind paid indexing.
        const next: CatalogHead = {
          revision: crypto.randomUUID(),
          hash: await digest(body),
          pointer,
          search: prepared,
        };
        await enter('activate');
        guard();
        attempt.outcome = 'succeeded';
        await control.transaction(async (tx) => {
          await liveLease(tx, lease, lockPath);
          const current = await tx.get<CatalogHead>(catalogPath);
          const currentAttempt = await tx.get<CheckpointPublicationAttempt>(publicationPath);
          if (!sameRevision(current, previous))
            throw new Error('Catalog publication changed');
          if (currentAttempt?.attemptId !== attempt.attemptId)
            throw new CheckpointPublicationStopped('publication_failed');
          guard();
          const completedAt = elapsed();
          attempt.phase = 'complete';
          attempt.phaseStartedElapsedMs = completedAt;
          attempt.elapsedMs = completedAt;
          tx.set(catalogPath, { ...next });
          tx.set(publicationPath, { ...attempt });
        });
        return pointer;
      } catch (error) {
        const failureCode =
          error instanceof CheckpointPublicationStopped
            ? error.failureCode
            : options.signal?.aborted
              ? 'request_aborted'
              : options.deadline !== undefined && now() >= options.deadline
                ? 'deadline_exceeded'
                : 'publication_failed';
        attempt.elapsedMs = elapsed();
        attempt.outcome = 'failed';
        attempt.failureCode = failureCode;
        try {
          await updateAttempt(false);
        } catch {
          // A newer attempt owns the single diagnostic record, or storage failed.
        }
        throw error;
      }
    },
    async voyageVectorsByHash(profile, hashes, dimensions) {
      const head = await control.get<VectorHead>(await profilePath(profile));
      const entries = await readVectors(head, profile);
      const result = new Map<string, number[]>();
      for (const hash of hashes) {
        const vector = entries.get(hash);
        if (validVector(vector, dimensions)) result.set(hash, [...vector]);
      }
      return result;
    },
    async saveVoyageVectors(profile, entries, lease) {
      requireLeaseKind(lease, ['voyage_index_lock', 'sync_lock']);
      if (!profile || !entries.length) return;
      const dimensions = profileDimensions(profile);
      for (const entry of entries)
        if (
          !hashPattern.test(entry.hash) ||
          !validVector(entry.vector, dimensions ?? entry.vector?.length) ||
          entry.vector.length > 16384
        )
          throw new Error('Invalid vector entry');
      const path = await profilePath(profile);
      const lockPath = await leasePath(lease.key);
      const previous = await control.transaction(async (tx) => {
        await liveLease(tx, lease, lockPath);
        return tx.get<VectorHead>(path);
      });
      const combined = new Map(await readVectors(previous, profile));
      for (const entry of entries) combined.set(entry.hash, [...entry.vector]);
      if (combined.size > MAX_VECTORS)
        throw new Error('Vector snapshot entry limit exceeded');
      const snapshot: VectorSnapshot = {
        schemaVersion: 1,
        profile,
        entries: [...combined].map(([hash, vector]) => ({ hash, vector })),
      };
      const body = JSON.stringify(snapshot);
      if (bytes(body) > MAX_VECTOR_BYTES)
        throw new Error('Vector snapshot byte limit exceeded');
      const key = `vectors/${namespace}/${await digest(profile)}/${crypto.randomUUID()}.json`;
      await blobs.putImmutable(key, body);
      const next: VectorHead = {
        profile,
        key,
        revision: crypto.randomUUID(),
        hash: await digest(body),
      };
      await control.transaction(async (tx) => {
        await liveLease(tx, lease, lockPath);
        const current = await tx.get<VectorHead>(path);
        if (!sameRevision(current, previous))
          throw new Error('Vector publication changed');
        tx.set(path, { ...next });
      });
    },
  };
}
