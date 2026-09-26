import assert from 'node:assert/strict';
import test from 'node:test';
import { createGcpStore } from '../lib/store.gcp.ts';
import type {
  BlobStore,
  ControlStore,
  ControlTransaction,
  Lease,
  SourcePage,
} from '../lib/storage-contract.ts';
import type { CollectionReport } from '../lib/operations.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';

class MemoryControl implements ControlStore {
  documents = new Map<string, Record<string, unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  failCatalogCommit = false;
  get<T>(path: string): Promise<T | null> {
    return Promise.resolve(
      structuredClone(this.documents.get(path) ?? null) as T | null,
    );
  }
  list<T>(collection: string) {
    return Promise.resolve(
      [...this.documents]
        .filter(
          ([path]) =>
            path.startsWith(collection + '/') &&
            !path.slice(collection.length + 1).includes('/'),
        )
        .map(([path, data]) => ({
          id: path.slice(collection.length + 1),
          data: structuredClone(data) as T,
        })),
    );
  }
  transaction<T>(callback: (tx: ControlTransaction) => Promise<T>): Promise<T> {
    const work = this.queue.then(async () => {
      const pending = new Map<string, Record<string, unknown> | null>();
      const result = await callback({
        get: async <U>(path: string) => {
          assert.equal(
            pending.size,
            0,
            'Firestore requires all reads before writes',
          );
          return this.get<U>(path);
        },
        set: (path, data) => {
          pending.set(path, structuredClone(data));
        },
        delete: (path) => {
          pending.set(path, null);
        },
      });
      if (
        this.failCatalogCommit &&
        [...pending.keys()].some((path) => path.endsWith('/state/catalog'))
      )
        throw new Error('Injected publication failure');
      for (const [path, data] of pending)
        if (data) this.documents.set(path, data);
        else this.documents.delete(path);
      return result;
    });
    this.queue = work.catch(() => undefined);
    return work;
  }
}
class MemoryBlobs implements BlobStore {
  objects = new Map<string, string>();
  reads = 0;
  writes: string[] = [];
  onPut?: (key: string) => void;
  failGet?: string;
  async get(key: string) {
    this.reads++;
    if (this.failGet === key) throw new Error('Injected object outage');
    const body = this.objects.get(key);
    return body === undefined ? null : { body, bytes: Buffer.byteLength(body) };
  }
  async putImmutable(key: string, body: string) {
    const previous = this.objects.get(key);
    if (previous !== undefined && previous !== body)
      throw new Error('Immutable object conflict');
    this.objects.set(key, body);
    this.writes.push(key);
    this.onPut?.(key);
  }
  async exists(key: string) {
    return this.objects.has(key);
  }
}
const instant = Date.parse('2026-09-27T10:00:00.000Z');
function fixture() {
  let time = instant;
  const control = new MemoryControl();
  const blobs = new MemoryBlobs();
  const makeStore = () => createGcpStore({ control, blobs, now: () => time });
  return {
    control,
    blobs,
    store: makeStore(),
    makeStore,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
function event(id = 'one', changes: Partial<EventRecord> = {}): EventRecord {
  return {
    id,
    title: `Konser ${id}`,
    description: 'Canlı müzik',
    venue: `Sahne ${id}`,
    startsAt: '2026-09-29T18:00:00.000Z',
    checkedAt: new Date(instant).toISOString(),
    city: 'İstanbul',
    district: 'Kadıköy',
    address: '',
    price: 500,
    currency: 'TRY',
    url: `https://www.bubilet.com.tr/istanbul/etkinlik/${id}`,
    imageUrl: '',
    category: 'Konser',
    availability: 'available',
    source: 'bubilet',
    ...changes,
  };
}
const page = (item: EventRecord): SourcePage => ({
  url: item.url,
  events: [item],
});
function report(offset = 0): CollectionReport {
  return {
    finishedAt: new Date(instant + offset).toISOString(),
    summary: { events: 1, available: 1, refreshedPages: 1, missingSources: [] },
  };
}
async function syncLease(store: ReturnType<typeof createGcpStore>) {
  const lease = await store.acquireLease('sync_lock');
  assert.ok(lease);
  return lease;
}
const hashA = 'a'.repeat(64),
  hashB = 'b'.repeat(64);
const profileA =
  'voyage-embedding-v1|model=voyage-4-large|dimensions=1024|input_type=document';
const profileB =
  'voyage-embedding-v1|model=voyage-4-lite|dimensions=1024|input_type=document';
const vector = (value = 1) =>
  Array.from({ length: 1024 }, (_, i) => (i === 0 ? value : 0));

await test('health is a control-plane probe and an unpublished GCP store has no seed catalog', async () => {
  const f = fixture();
  await f.store.health();
  assert.equal(f.blobs.reads, 0);
  assert.equal((await f.store.catalogStatus()).status, 'empty');
  assert.equal(await f.store.checkpointPointer(), null);
  assert.equal(await f.store.readCheckpoint(), null);
  assert.deepEqual(await f.store.candidates(emptyFilters), []);
});

await test('imports stage durable source pages; one publication exposes every page and exact checkpoint bytes', async () => {
  const f = fixture();
  const lease = await syncLease(f.store);
  assert.deepEqual(
    await f.store.importPages([page(event()), page(event('two'))], lease),
    { imported: 2, skipped: 0 },
  );
  assert.equal((await f.store.catalogStatus()).stored, 0);
  assert.equal(
    f.blobs.writes.filter((key) => key.startsWith('collection/')).length,
    0,
  );
  const pointer = await f.store.publishCheckpoint(report(), lease);
  assert.equal(pointer.events, 2);
  assert.equal(await f.store.checkpointExists(pointer), true);
  assert.equal(
    await f.store.readCheckpoint(),
    f.blobs.objects.get(pointer.key),
  );
  assert.equal((await f.store.candidates(emptyFilters)).length, 2);
  assert.equal((await f.store.currentPublished()).checkpoint?.key, pointer.key);
  assert.equal(
    f.blobs.writes.filter((key) => key.startsWith('collection/')).length,
    1,
  );
});

await test('replacing one source keeps prior failed sources, skips older batches, and replays reports without rollback', async () => {
  const f = fixture();
  const lease = await syncLease(f.store);
  const original = event();
  await f.store.importPages(
    [page(original), page(event('failed-source'))],
    lease,
  );
  await f.store.publishCheckpoint(report(), lease);
  f.advance(1000);
  const newer = event('replacement', {
    url: original.url,
    checkedAt: new Date(instant + 1000).toISOString(),
  });
  await f.store.importPages([page(newer)], lease);
  const writes = f.blobs.writes.length;
  assert.deepEqual(await f.store.importPages([page(original)], lease), {
    imported: 0,
    skipped: 1,
  });
  assert.equal(f.blobs.writes.length, writes);
  const next = await f.store.publishCheckpoint(report(1000), lease);
  const results = await f.store.candidates(emptyFilters);
  assert.deepEqual(results.map((item) => item.id).sort(), [
    'failed-source',
    'replacement',
  ]);
  assert.equal(
    (await f.store.publishCheckpoint(report(), lease)).key,
    next.key,
  );
  assert.equal(
    (await f.store.publishCheckpoint(report(1000), lease)).key,
    next.key,
  );
});

await test('an older report cannot publish a newer staged source or replace the prior publication', async () => {
  const f = fixture();
  const lease = await syncLease(f.store);
  await f.store.importPages([page(event())], lease);
  const previous = await f.store.publishCheckpoint(report(), lease);
  await f.store.importPages([
    page(
      event('newer-source', {
        checkedAt: new Date(instant + 2000).toISOString(),
      }),
    ),
  ], lease);
  await assert.rejects(
    f.store.publishCheckpoint(report(1000), lease),
    /newer than collection report/,
  );
  assert.equal((await f.store.checkpointPointer())?.key, previous.key);
  assert.equal((await f.store.catalogStatus()).stored, 1);
});

await test('all eligible catalog entries are returned before downstream retrieval shortlisting', async () => {
  const f = fixture();
  const lease = await syncLease(f.store);
  const url = event().url;
  const events = Array.from({ length: 250 }, (_, i) =>
    event(`full-${i}`, { url }),
  );
  await f.store.importPages([{ url, events }], lease);
  await f.store.publishCheckpoint(report(), lease);
  assert.equal((await f.store.candidates(emptyFilters)).length, 250);
});

await test('expiry during source upload fences the durable head and releasing an old lease preserves the new owner', async () => {
  const f = fixture();
  const old = await syncLease(f.store);
  f.blobs.onPut = () => f.advance(300001);
  await assert.rejects(
    f.store.importPages([page(event())], old),
    /lease expired/,
  );
  assert.equal((await f.control.list('biplan/default/sources')).length, 0);
  f.blobs.onPut = undefined;
  const next = await syncLease(f.store);
  await f.store.releaseLease(old);
  assert.equal(await f.store.acquireLease('sync_lock'), null);
  await f.store.importPages([page(event())], next);
});

await test('failure after checkpoint upload never advances the public pointer; retry keeps staged progress', async () => {
  const f = fixture();
  const lease = await syncLease(f.store);
  await f.store.importPages([page(event())], lease);
  const original = await f.store.publishCheckpoint(report(), lease);
  await f.store.importPages([page(event('two'))], lease);
  f.advance(1000);
  f.control.failCatalogCommit = true;
  await assert.rejects(
    f.store.publishCheckpoint(report(1000), lease),
    /publication failure/,
  );
  assert.equal((await f.store.checkpointPointer())?.key, original.key);
  assert.equal((await f.store.catalogStatus()).stored, 1);
  f.control.failCatalogCommit = false;
  assert.equal(
    (await f.store.publishCheckpoint(report(1000), lease)).events,
    2,
  );
});

await test('expiry during checkpoint upload prevents a stale writer publishing', async () => {
  const f = fixture();
  const lease = await syncLease(f.store);
  await f.store.importPages([page(event())], lease);
  f.blobs.onPut = (key) => {
    if (key.startsWith('collection/')) f.advance(300001);
  };
  await assert.rejects(
    f.store.publishCheckpoint(report(), lease),
    /lease expired/,
  );
  assert.equal(await f.store.checkpointPointer(), null);
});

await test('source corruption fails publication and catalog corruption fails closed', async () => {
  const f = fixture();
  const lease = await syncLease(f.store);
  await f.store.importPages([page(event())], lease);
  const sourceKey = f.blobs.writes[0];
  const body = f.blobs.objects.get(sourceKey)!;
  f.blobs.objects.set(sourceKey, '{}');
  await assert.rejects(f.store.publishCheckpoint(report(), lease), /damaged/);
  assert.equal(await f.store.checkpointPointer(), null);
  f.blobs.objects.set(sourceKey, body);
  const pointer = await f.store.publishCheckpoint(report(), lease);
  f.blobs.objects.set(pointer.key, '{}');
  await assert.rejects(f.store.candidates(emptyFilters), /damaged/);
});

await test('another instance sees publication changes and caches only immutable catalog content', async () => {
  const f = fixture();
  const reader = f.makeStore();
  const lease = await syncLease(f.store);
  await f.store.importPages([page(event())], lease);
  await f.store.publishCheckpoint(report(), lease);
  assert.equal((await reader.catalogStatus()).stored, 1);
  const reads = f.blobs.reads;
  await reader.candidates(emptyFilters);
  assert.equal(f.blobs.reads, reads);
  await f.store.importPages([page(event('two'))], lease);
  f.advance(1000);
  const next = await f.store.publishCheckpoint(report(1000), lease);
  const state = await reader.currentPublished();
  assert.equal(state.catalog.stored, 2);
  assert.equal(state.checkpoint?.key, next.key);
});

await test('atomic counters enforce concurrent caps and reset expired documents without relying on TTL deletion', async () => {
  const f = fixture();
  const other = f.makeStore();
  const results = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      (i % 2 ? f.store : other).consumeLimit('daily', 7, instant + 1000),
    ),
  );
  assert.equal(results.filter(Boolean).length, 7);
  f.advance(1001);
  assert.equal(await f.store.consumeLimit('daily', 7, instant + 2000), true);
  assert.equal(await f.store.consumeLimit('expired', 7, instant), false);
});

await test('readiness remains coherent when a new generation publishes between its pointer and object reads', async () => {
  const f = fixture();
  const lease = await syncLease(f.store);
  await f.store.importPages([page(event())], lease);
  const first = await f.store.publishCheckpoint(report(), lease);
  await f.store.importPages([page(event('two'))], lease);
  f.advance(1000);
  let publishDuringRead = true;
  const control: ControlStore = {
    get: async <T>(path: string) => {
      const captured = await f.control.get<T>(path);
      if (publishDuringRead && path.endsWith('/state/catalog')) {
        publishDuringRead = false;
        await f.store.publishCheckpoint(report(1000), lease);
      }
      return captured;
    },
    list: f.control.list.bind(f.control),
    transaction: f.control.transaction.bind(f.control),
  };
  const reader = createGcpStore({
    control,
    blobs: f.blobs,
    now: () => instant + 1000,
  });
  const captured = await reader.currentPublished();
  assert.equal(captured.catalog.stored, 1);
  assert.equal(captured.checkpoint?.key, first.key);
  const next = await reader.currentPublished();
  assert.equal(next.catalog.stored, 2);
  assert.notEqual(next.checkpoint?.key, first.key);
});

await test('vector snapshots reuse exact profile and document hashes, preserve 1024 dimensions and refresh other instances', async () => {
  const f = fixture();
  const reader = f.makeStore();
  const lease = (await f.store.acquireLease('voyage_index_lock')) as Lease;
  await f.store.saveVoyageVectors(
    profileA,
    [{ hash: hashA, vector: vector() }],
    lease,
  );
  assert.equal(
    (await reader.voyageVectorsByHash(profileA, [hashA], 1024)).size,
    1,
  );
  assert.equal(
    (await reader.voyageVectorsByHash(profileB, [hashA], 1024)).size,
    0,
  );
  assert.equal(
    (await reader.voyageVectorsByHash(profileA, [hashA], 512)).size,
    0,
  );
  const reads = f.blobs.reads;
  await reader.voyageVectorsByHash(profileA, [hashA], 1024);
  assert.equal(f.blobs.reads, reads);
  await f.store.saveVoyageVectors(
    profileA,
    [{ hash: hashB, vector: vector(2) }],
    lease,
  );
  const all = await reader.voyageVectorsByHash(
    profileA,
    [hashA, hashB, 'c'.repeat(64)],
    1024,
  );
  assert.equal(all.size, 2);
  all.get(hashA)![0] = 999;
  assert.equal(
    (await reader.voyageVectorsByHash(profileA, [hashA], 1024)).get(hashA)?.[0],
    1,
  );
});

await test('damaged vector objects are cache misses and indexing repairs them without touching catalog publication', async () => {
  const f = fixture();
  const lease = (await f.store.acquireLease('voyage_index_lock')) as Lease;
  await f.store.saveVoyageVectors(
    profileA,
    [{ hash: hashA, vector: vector() }],
    lease,
  );
  const key = f.blobs.writes.at(-1)!;
  f.blobs.objects.set(key, '{bad');
  assert.equal(
    (await f.makeStore().voyageVectorsByHash(profileA, [hashA], 1024)).size,
    0,
  );
  await f.store.saveVoyageVectors(
    profileA,
    [{ hash: hashA, vector: vector(3) }],
    lease,
  );
  assert.equal(
    (await f.makeStore().voyageVectorsByHash(profileA, [hashA], 1024)).get(
      hashA,
    )?.[0],
    3,
  );
  assert.equal(await f.store.checkpointPointer(), null);
});

await test('vector publication is lease-fenced and rejects invalid vectors', async () => {
  const f = fixture();
  const lease = (await f.store.acquireLease('voyage_index_lock')) as Lease;
  await assert.rejects(
    f.store.saveVoyageVectors(
      profileA,
      [{ hash: hashA, vector: [NaN] }],
      lease,
    ),
    /Invalid vector/,
  );
  await assert.rejects(
    f.store.saveVoyageVectors(
      profileA,
      [{ hash: hashA, vector: [1, 2] }],
      lease,
    ),
    /Invalid vector/,
  );
  f.blobs.onPut = () => f.advance(300001);
  await assert.rejects(
    f.store.saveVoyageVectors(
      profileA,
      [{ hash: hashA, vector: vector() }],
      lease,
    ),
    /lease expired/,
  );
  assert.equal(
    (await f.store.voyageVectorsByHash(profileA, [hashA], 1024)).size,
    0,
  );
});

await test('vector pointer compare-and-swap rejects concurrent lost updates even across different valid lease kinds', async () => {
  const f = fixture();
  let releaseUploads!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseUploads = resolve;
  });
  let uploads = 0;
  const blobs: BlobStore = {
    get: f.blobs.get.bind(f.blobs),
    exists: f.blobs.exists.bind(f.blobs),
    putImmutable: async (key, body) => {
      await f.blobs.putImmutable(key, body);
      if (key.startsWith('vectors/')) {
        if (++uploads === 2) releaseUploads();
        await gate;
      }
    },
  };
  const first = createGcpStore({
    control: f.control,
    blobs,
    now: () => instant,
  });
  const second = createGcpStore({
    control: f.control,
    blobs,
    now: () => instant,
  });
  const sync = (await first.acquireLease('sync_lock')) as Lease;
  const indexing = (await second.acquireLease('voyage_index_lock')) as Lease;
  const outcomes = await Promise.allSettled([
    first.saveVoyageVectors(
      profileA,
      [{ hash: hashA, vector: vector() }],
      sync,
    ),
    second.saveVoyageVectors(
      profileA,
      [{ hash: hashB, vector: vector(2) }],
      indexing,
    ),
  ]);
  assert.equal(
    outcomes.filter((outcome) => outcome.status === 'fulfilled').length,
    1,
  );
  const failed = outcomes.find(
    (outcome) => outcome.status === 'rejected',
  ) as PromiseRejectedResult;
  assert.match(failed.reason.message, /publication changed/);
  assert.equal(
    (await first.voyageVectorsByHash(profileA, [hashA, hashB], 1024)).size,
    1,
  );
});

await test('namespace separates control records and rejects invalid paths', async () => {
  const f = fixture();
  const staging = createGcpStore({
    control: f.control,
    blobs: f.blobs,
    now: () => instant,
    namespace: 'staging',
  });
  await syncLease(f.store);
  assert.ok(await staging.acquireLease('sync_lock'));
  assert.throws(
    () =>
      createGcpStore({
        control: f.control,
        blobs: f.blobs,
        namespace: '../other',
      }),
    /namespace/,
  );
});
