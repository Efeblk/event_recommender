import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createGcpStore } from '../lib/store.gcp.ts';
import { voyageDocumentText } from '../lib/voyage.ts';
import type {
  BlobStore,
  ControlStore,
  ControlTransaction,
  Lease,
  SourcePage,
} from '../lib/storage-contract.ts';
import type { CollectionReport } from '../lib/operations.ts';
import { emptyFilters, type EventRecord } from '../lib/types.ts';
import {
  expectedProviderListingId,
  type ProviderListingV1,
} from '../../contracts/listing.ts';

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
function fixture(embeddingProfile?: { profile: string; dimensions: number }) {
  let time = instant;
  const control = new MemoryControl();
  const blobs = new MemoryBlobs();
  const makeStore = () => createGcpStore({ control, blobs, now: () => time, embeddingProfile });
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
function listedEvent(
  slug: string,
  checkedAt: string,
  changes: Partial<EventRecord> = {},
): EventRecord {
  const url = `https://www.bubilet.com.tr/istanbul/etkinlik/${slug}`;
  const title = changes.title ?? `Konser ${slug}`;
  const startsAt = changes.startsAt ?? '2026-09-29T18:00:00.000Z';
  const availability = changes.availability ?? 'available';
  const listing: ProviderListingV1 = {
    contractVersion: 'provider-listing.v1',
    listingId: '',
    provider: 'bubilet',
    providerEventId: '18220',
    providerSessionIds: ['258163'],
    url,
    title,
    description: 'Canlı müzik',
    category: 'Konser',
    startsAt,
    timezoneEvidence: { kind: 'explicit_offset', sourceValue: startsAt },
    venue: { name: changes.venue ?? `Sahne ${slug}`, district: 'Kadıköy' },
    tiers: [{ price: changes.price ?? 500, currency: 'TRY', availability }],
    availability,
    observedAt: checkedAt,
    extractorVersion: 'fixture.v1',
    rawObjectRef: {
      sha256: 'a'.repeat(64),
      key: `bodies/${'a'.repeat(64)}.bin`,
      bytes: 1,
    },
    city: 'İstanbul',
  };
  listing.listingId = expectedProviderListingId(listing);
  return event(listing.listingId.slice(0, 24), {
    title,
    startsAt,
    checkedAt,
    venue: listing.venue.name,
    price: changes.price ?? 500,
    url,
    availability,
    providerListing: listing,
    ...changes,
  });
}
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
const documentHash = (item: EventRecord) => createHash('sha256').update(voyageDocumentText(item)).digest('hex');

// Heads written before immediate activation can still hold a pending catalog.
function legacyPendingHead(f: ReturnType<typeof fixture>) {
  const path = 'biplan/default/state/catalog';
  const { search, ...head } = f.control.documents.get(path)!;
  f.control.documents.set(path, { ...head, revision: 'legacy-pending', pendingSearch: search });
}

await test('publication activates immediately; vectors are optional enrichment', async () => {
  const f = fixture({ profile: profileA, dimensions: 1024 });
  const sync = await syncLease(f.store);
  const older = event('older', {
    title: 'Ortak konser', venue: 'Ortak sahne', source: 'biletinial',
    description: 'İlk kaynağın açıklaması',
    checkedAt: new Date(instant - 48 * 3600000).toISOString(),
  });
  const fresh = event('fresh', {
    title: older.title, venue: older.venue, description: 'İkinci kaynağın açıklaması',
  });
  await f.store.importPages([page(older), page(fresh)], sync);
  const pointer = await f.store.publishCheckpoint(report(), sync);
  assert.equal(JSON.parse((await f.store.readCheckpoint())!).events.length, 2);
  const state = await f.store.currentPublished();
  assert.equal(state.checkpoint?.key, pointer.key);
  assert.equal(state.search?.pending, false);
  assert.equal(state.search?.checkpoint?.key, pointer.key);
  assert.equal(f.control.documents.get('biplan/default/state/catalog')!.pendingSearch, undefined);
  const active = await f.makeStore().candidates(emptyFilters);
  assert.equal(active.length, 1, 'searchable before any vector exists');
  assert.equal(active[0].offers?.length, 2);
  assert.equal((await f.store.catalogStatus()).eligible, 1);
  const docs = await f.store.embeddingCandidates();
  assert.deepEqual(new Set(docs.map(documentHash)), new Set([documentHash(older), documentHash(fresh)]));
  const indexing = await f.store.acquireLease('voyage_index_lock');
  assert.ok(indexing);
  await assert.rejects(f.store.activateSearchCatalog(profileA, sync), /Wrong storage lease/);
  assert.deepEqual(await f.store.activateSearchCatalog(profileA, indexing), { activated: false, pending: 0 });
  f.advance(24 * 3600000 + 1);
  const afterExpiry = await f.store.candidates(emptyFilters);
  assert.equal(afterExpiry.length, 1);
  assert.equal(documentHash(afterExpiry[0]), documentHash(fresh));
  assert.deepEqual(afterExpiry[0].offers?.map(({ id }) => id), [fresh.id]);
});

await test('a newer publication replaces the active search at once', async () => {
  const f = fixture({ profile: profileA, dimensions: 1024 });
  const sync = await syncLease(f.store);
  const old = event();
  await f.store.importPages([page(old)], sync);
  await f.store.publishCheckpoint(report(), sync);
  assert.deepEqual((await f.store.candidates(emptyFilters)).map(({ id }) => id), [old.id]);
  f.advance(1000);
  const newer = event('replacement', { url: old.url, checkedAt: new Date(instant + 1000).toISOString() });
  await f.store.importPages([page(newer)], sync);
  const pointer = await f.store.publishCheckpoint(report(1000), sync);
  const state = await f.store.currentPublished();
  assert.equal(state.search?.pending, false);
  assert.equal(state.search?.checkpoint?.key, pointer.key);
  assert.deepEqual((await f.makeStore().candidates(emptyFilters)).map(({ id }) => id), [newer.id]);
  assert.deepEqual((await f.store.embeddingCandidates()).map(documentHash), [documentHash(newer)]);
});

await test('gated same-report upgrade replaces an unverified legacy projection with the profiled one', async () => {
  const f = fixture();
  const sync = await syncLease(f.store);
  await f.store.importPages([page(event())], sync);
  await f.store.publishCheckpoint(report(), sync);
  const gated = createGcpStore({ control: f.control, blobs: f.blobs, now: () => instant, embeddingProfile: { profile: profileA, dimensions: 1024 } });
  await assert.rejects(gated.candidates(emptyFilters), /requires publication/);
  await gated.publishCheckpoint(report(), sync);
  assert.equal((await gated.candidates(emptyFilters)).length, 1);
  const head = f.control.documents.get('biplan/default/state/catalog')!;
  assert.equal((head.search as { profile?: string }).profile, profileA);
  assert.equal(head.pendingSearch, undefined);
});

await test('a legacy pending catalog activates with missing vectors and keeps its guards', async () => {
  const f = fixture({ profile: profileA, dimensions: 1024 });
  const sync = await syncLease(f.store);
  const indexing = await f.store.acquireLease('voyage_index_lock');
  assert.ok(indexing);
  await f.store.importPages([page(event())], sync);
  await f.store.publishCheckpoint(report(), sync);
  legacyPendingHead(f);
  assert.equal((await f.store.currentPublished()).search?.pending, true);
  await assert.rejects(f.store.activateSearchCatalog(profileB, indexing), /profile mismatch/);
  await assert.rejects(f.store.activateSearchCatalog(profileA, sync), /Wrong storage lease/);
  f.control.failCatalogCommit = true;
  await assert.rejects(f.store.activateSearchCatalog(profileA, indexing), /publication failure/);
  assert.ok(f.control.documents.get('biplan/default/state/catalog')!.pendingSearch);
  f.control.failCatalogCommit = false;
  assert.deepEqual(await f.store.activateSearchCatalog(profileA, indexing), { activated: true, pending: 1 });
  assert.equal((await f.makeStore().candidates(emptyFilters)).length, 1);
  assert.equal(f.control.documents.get('biplan/default/state/catalog')!.pendingSearch, undefined);
});

await test('activation rejects catalog or vector publication races after validating immutable vectors', async () => {
  for (const changed of ['catalog', 'vector'] as const) {
    const f = fixture({ profile: profileA, dimensions: 1024 });
    const sync = await syncLease(f.store);
    const indexing = await f.store.acquireLease('voyage_index_lock');
    assert.ok(indexing);
    await f.store.importPages([page(event())], sync);
    await f.store.publishCheckpoint(report(), sync);
    legacyPendingHead(f);
    await f.store.saveVoyageVectors(profileA, [{ hash: documentHash(event()), vector: vector() }], indexing);
    let raced = false;
    const blobs: BlobStore = {
      get: async (key) => {
        const object = await f.blobs.get(key);
        if (!raced && key.startsWith('vectors/')) {
          raced = true;
          const path = changed === 'catalog'
            ? 'biplan/default/state/catalog'
            : [...f.control.documents.keys()].find((value) => value.includes('/vectorProfiles/'))!;
          f.control.documents.get(path)!.revision = 'concurrent-publication';
        }
        return object;
      },
      exists: f.blobs.exists.bind(f.blobs),
      putImmutable: f.blobs.putImmutable.bind(f.blobs),
    };
    const reader = createGcpStore({ control: f.control, blobs, now: () => instant, embeddingProfile: { profile: profileA, dimensions: 1024 } });
    await assert.rejects(reader.activateSearchCatalog(profileA, indexing), /activation publication changed/);
    assert.equal(raced, true);
    assert.deepEqual(await f.store.candidates(emptyFilters), []);
    assert.ok(f.control.documents.get('biplan/default/state/catalog')!.pendingSearch);
  }
});

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

await test('a newer complete provider listing supersedes the same session at an old URL', async () => {
  for (const reverse of [false, true]) {
    const f = fixture();
    const lease = await syncLease(f.store);
    const older = listedEvent(
      'old-slug',
      new Date(instant).toISOString(),
      { title: 'Old title', price: 400 },
    );
    const newer = listedEvent(
      'new-slug',
      new Date(instant + 1000).toISOString(),
      { title: 'New title', price: 650 },
    );
    await f.store.importPages(reverse ? [page(newer), page(older)] : [page(older), page(newer)], lease);
    const pointer = await f.store.publishCheckpoint(report(1000), lease);
    assert.equal(pointer.events, 1);
    const [result] = await f.store.candidates(emptyFilters);
    assert.equal(result.title, newer.title);
    assert.equal(result.url, newer.url);
    assert.equal(result.price, newer.price);
    assert.equal(result.checkedAt, newer.checkedAt);
    assert.deepEqual(result.offers?.map(({ id }) => id), [newer.id]);
  }
});

await test('a newer unavailable listing suppresses an older available observation', async () => {
  for (const availability of ['sold_out', 'cancelled'] as const) {
    const f = fixture();
    const lease = await syncLease(f.store);
    const older = listedEvent('old-available', new Date(instant).toISOString());
    const newer = listedEvent(
      'new-unavailable',
      new Date(instant + 1000).toISOString(),
      { availability },
    );
    await f.store.importPages([page(older), page(newer)], lease);
    const pointer = await f.store.publishCheckpoint(report(1000), lease);
    assert.equal(pointer.events, 1);
    const checkpoint = JSON.parse((await f.store.readCheckpoint())!) as {
      events: EventRecord[];
    };
    assert.equal(checkpoint.events[0].availability, availability);
    assert.deepEqual(await f.store.candidates(emptyFilters), []);
  }
});

await test('ambiguous duplicate source identities fail without replacing the active catalog', async () => {
  const cases: SourcePage[][] = [];
  const checkedAt = new Date(instant + 1000).toISOString();
  const first = listedEvent('first-alias', checkedAt);
  const second = listedEvent('second-alias', checkedAt, { title: 'Different title' });
  cases.push([page(first), page(second)]);
  cases.push([{ url: first.url, events: [first, first] }]);
  cases.push([
    page({ ...first, providerListing: undefined }),
    page({ ...second, providerListing: undefined }),
  ]);
  const mismatched = structuredClone(second);
  mismatched.providerListing!.providerEventId = 'different-provider-event';
  mismatched.providerListing!.listingId = expectedProviderListingId(
    mismatched.providerListing!,
  );
  cases.push([page(first), page(mismatched)]);
  cases.push([page(first), page({ ...second, source: 'biletix' })]);

  for (const pages of cases) {
    const f = fixture();
    const lease = await syncLease(f.store);
    await f.store.importPages([page(event('survivor'))], lease);
    const active = await f.store.publishCheckpoint(report(), lease);
    await f.store.importPages(pages, lease);
    await assert.rejects(
      f.store.publishCheckpoint(report(1000), lease),
      /Conflicting source event identity|Invalid provider listing/,
    );
    assert.equal((await f.store.checkpointPointer())?.key, active.key);
    assert.deepEqual(
      (await f.store.candidates(emptyFilters)).map(({ id }) => id),
      ['survivor'],
    );
  }
});

await test('verified retirement removes a source and older imports cannot resurrect it', async () => {
  const f = fixture(), lease = await syncLease(f.store), original = event();
  await f.store.importPages([page(original), page(event('survivor'))], lease);
  await f.store.publishCheckpoint(report(), lease);
  f.advance(1000);
  const retiredAt = new Date(instant + 1000).toISOString();
  await f.store.importPages([{ url: original.url, events: [], retiredAt }], lease);
  await f.store.publishCheckpoint(report(1000), lease);
  assert.deepEqual((await f.store.candidates(emptyFilters)).map(item => item.id), ['survivor']);
  assert.deepEqual(await f.store.importPages([page(original)], lease), { imported: 0, skipped: 1 });
  assert.deepEqual(await f.store.importPages([page({ ...original, checkedAt: retiredAt })], lease), { imported: 0, skipped: 1 });
  await assert.rejects(f.store.importPages([{ url: original.url, events: [] }], lease), /retirement/);
  f.advance(1000);
  await f.store.importPages([page({ ...original, checkedAt: new Date(instant + 2000).toISOString() })], lease);
  await f.store.publishCheckpoint(report(2000), lease);
  assert.deepEqual((await f.store.candidates(emptyFilters)).map(item => item.id).sort(), ['one', 'survivor']);
});

await test('source quarantine removes only the conflicting provider until newer verified evidence returns', async () => {
  const f = fixture(), lease = await syncLease(f.store), original = event();
  const corroborating = event('other-provider', {
    title: original.title,
    startsAt: original.startsAt,
    venue: original.venue,
    url: 'https://www.biletix.com/etkinlik/ABC123/ISTANBUL/tr',
    source: 'biletix',
  });
  await f.store.importPages([page(original), page(corroborating)], lease);
  await f.store.publishCheckpoint(report(), lease);
  f.advance(1000);
  const quarantinedAt = new Date(instant + 1000).toISOString();
  await f.store.importPages([{
    url: original.url,
    events: [],
    quarantinedAt,
    quarantineReason: 'session_time_conflict',
  }], lease);
  assert.ok([...f.blobs.objects.values()].some(body => {
    const saved = JSON.parse(body) as SourcePage;
    return saved.url === original.url && saved.quarantinedAt === quarantinedAt &&
      saved.quarantineReason === 'session_time_conflict' && saved.events.length === 0;
  }));
  await f.store.publishCheckpoint(report(1000), lease);
  assert.deepEqual((await f.store.candidates(emptyFilters)).map(item => item.id), ['other-provider']);
  assert.deepEqual(await f.store.importPages([page(original)], lease), { imported: 0, skipped: 1 });
  assert.deepEqual(await f.store.importPages([page({ ...original, checkedAt: quarantinedAt })], lease), { imported: 0, skipped: 1 });
  f.advance(1000);
  await f.store.importPages([page({ ...original, checkedAt: new Date(instant + 2000).toISOString() })], lease);
  await f.store.publishCheckpoint(report(2000), lease);
  const restored = await f.store.candidates(emptyFilters);
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].offers?.map(offer => offer.source).sort(), ['biletix', 'bubilet']);
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
  await assert.rejects(f.store.readCheckpoint(), /damaged/);
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

await test('search projection is published atomically and corruption fails closed', async () => {
  const f = fixture();
  const lease = await syncLease(f.store);
  await f.store.importPages([page(event())], lease);
  const original = await f.store.publishCheckpoint(report(), lease);
  const head = f.control.documents.get('biplan/default/state/catalog')!;
  const search = head.search as { key: string };
  assert.ok(search.key.startsWith('search-catalog/'));
  f.blobs.objects.set(search.key, '{}');
  await assert.rejects(f.makeStore().candidates(emptyFilters), /search catalog.*damaged/);
  f.advance(1000);
  f.control.failCatalogCommit = true;
  await assert.rejects(f.store.publishCheckpoint(report(1000), lease), /publication failure/);
  assert.deepEqual(f.control.documents.get('biplan/default/state/catalog'), head);
  assert.equal((await f.store.checkpointPointer())?.key, original.key);
});

await test('legacy raw publication requires explicit materialization and same-report upgrade retains raw checkpoint records', async () => {
  const f = fixture();
  const lease = await syncLease(f.store);
  await f.store.importPages([page(event())], lease);
  await f.store.publishCheckpoint(report(), lease);
  const head = f.control.documents.get('biplan/default/state/catalog')!;
  delete head.search;
  const reader = f.makeStore();
  await assert.rejects(reader.candidates(emptyFilters), /requires publication/);
  await reader.publishCheckpoint(report(), lease);
  assert.ok(f.control.documents.get('biplan/default/state/catalog')!.search);
  assert.equal((await reader.candidates(emptyFilters)).length, 1);
  assert.deepEqual(JSON.parse((await reader.readCheckpoint())!).events, [event()]);
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

await test('the durable checkpoint omits provider listings that identity still used', async () => {
  const f = fixture({ profile: profileA, dimensions: 1024 });
  const sync = await syncLease(f.store);
  const base = event();
  const listed = {
    ...base,
    providerListing: {
      listingId: 'f'.repeat(64), provider: base.source, providerSessionIds: [], url: base.url,
      title: base.title, description: 'x'.repeat(5000), category: base.category, startsAt: base.startsAt,
      venue: { name: base.venue, address: base.address, district: base.district }, city: base.city,
    },
  } as unknown as EventRecord;
  await f.store.importPages([page(listed)], sync);
  await f.store.publishCheckpoint(report(), sync);
  const saved = JSON.parse((await f.store.readCheckpoint())!) as { events: EventRecord[] };
  assert.equal(saved.events.length, 1);
  assert.equal(saved.events[0].providerListing, undefined);
  assert.equal(saved.events[0].id, listed.id);
  assert.equal((await f.store.candidates(emptyFilters)).length, 1);
});
