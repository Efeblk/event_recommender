import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditDigest,
  indexAuditedBatch,
  parseAuditedIndexInput,
  type AuditedIndexInput,
} from '../lib/audited-index.ts';
import { createGcpStore } from '../lib/store.gcp.ts';
import { voyageCacheKey, voyageDocumentText, embedWithVoyage } from '../lib/voyage.ts';
import { recommend, validateInput } from '../lib/recommend.ts';
import { rankWithJev } from '../lib/jev.ts';
import { emptyFilters } from '../lib/types.ts';
import { emptyIntentState, intentQuery } from '../lib/input-state.ts';
import type {
  ControlStore,
  ControlTransaction,
  BlobStore,
} from '../lib/storage-contract.ts';
import type { EventRecord } from '../lib/types.ts';
class Control implements ControlStore {
  rows = new Map<string, Record<string, unknown>>();
  private queue: Promise<unknown> = Promise.resolve();
  fail = false;
  async get<T>(path: string) {
    return structuredClone(this.rows.get(path) ?? null) as T | null;
  }
  async list<T>(collection: string): Promise<{ id: string; data: T }[]> {
    return [...this.rows]
      .filter(
        ([key]) =>
          key.startsWith(collection + '/') &&
          !key.slice(collection.length + 1).includes('/'),
      )
      .map(([key, row]) => ({
        id: key.slice(collection.length + 1),
        data: structuredClone(row) as T,
      }));
  }
  transaction<T>(callback: (tx: ControlTransaction) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const changes = new Map<string, Record<string, unknown> | null>();
      const value = await callback({
        get: async <U>(path: string) => {
          assert.equal(changes.size, 0, 'Firestore reads precede writes');
          return this.get<U>(path);
        },
        set: (path, row) => {
          changes.set(path, structuredClone(row));
        },
        delete: (path) => {
          changes.set(path, null);
        },
      });
      if (this.fail) throw new Error('Injected control outage');
      for (const [key, row] of changes)
        if (row) this.rows.set(key, row);
        else this.rows.delete(key);
      return value;
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
}
class Blobs implements BlobStore {
  rows = new Map<string, string>();
  failSuffix = '';
  async get(key: string) {
    const body = this.rows.get(key);
    return body === undefined ? null : { body, bytes: Buffer.byteLength(body) };
  }
  async exists(key: string) {
    return this.rows.has(key);
  }
  async putImmutable(key: string, body: string) {
    if (this.failSuffix && key.endsWith(this.failSuffix))
      throw new Error('Injected audit outage');
    if (this.rows.has(key)) assert.equal(this.rows.get(key), body);
    this.rows.set(key, body);
  }
}
const instant = Date.parse('2026-09-27T10:00:00.000Z'),
  secret = 'offline-provider-key';
const config = {
    apiKey: secret,
    model: 'voyage-4-large',
    dimensions: 1024 as const,
  },
  profile = voyageCacheKey(config);
const vector = (n = 1) =>
  Array.from({ length: 1024 }, (_, i) => (i === 0 ? n : 0));
async function fixture(count = 1, description = 'Canlı müzik', prepared = false) {
  let time = instant,
    calls = 0;
  const control = new Control(),
    blobs = new Blobs(),
    store = createGcpStore({
      control,
      blobs,
      namespace: 'staging',
      now: () => time,
      ...(prepared ? { embeddingProfile: { profile, dimensions: config.dimensions } } : {}),
    });
  const events: EventRecord[] = Array.from({ length: count }, (_, i) => ({
    id: `id-${i}`,
    title: `Özgün konser ${i}`,
    description,
    venue: `Venue ${i}`,
    startsAt: '2026-10-03T18:00:00.000Z',
    checkedAt: new Date(instant).toISOString(),
    city: 'İstanbul',
    district: 'Kadıköy',
    address: '',
    price: 500,
    currency: 'TRY',
    url: `https://www.bubilet.com.tr/istanbul/etkinlik/id-${i}`,
    imageUrl: '',
    category: 'Konser',
    availability: 'available',
    source: 'bubilet',
  }));
  const sync = await store.acquireLease('sync_lock');
  assert.ok(sync);
  await store.importPages(
    events.map((e) => ({ url: e.url, events: [e] })),
    sync,
  );
  await store.publishCheckpoint(
    {
      finishedAt: new Date(instant).toISOString(),
      summary: {
        events: count,
        available: count,
        refreshedPages: count,
        missingSources: [],
      },
    },
    sync,
  );
  await store.releaseLease(sync);
  const input: AuditedIndexInput = {
    runId: '123',
    expectedProfile: profile,
    expectedRevision: 'c'.repeat(40),
    checkpointSha256: await auditDigest((await store.readCheckpoint())!),
    window: {
      startedAt: new Date(instant - 1000).toISOString(),
      until: new Date(instant + 48 * 3600000).toISOString(),
      maxCalls: 32,
    },
  };
  let action: typeof fetch = async (_url, init) => {
    const body = JSON.parse(init!.body as string);
    return new Response(
      JSON.stringify({
        data: body.input.map((_s: string, index: number) => ({
          index,
          embedding: vector(index + 1),
        })),
        usage: { total_tokens: 100 },
      }),
    );
  };
  const fetcher: typeof fetch = async (url, init) => {
    calls++;
    return action(url, init);
  };
  const deps = {
    store,
    control,
    blobs,
    namespace: 'staging',
    revision: 'c'.repeat(40),
    secrets: [secret],
    now: () => time,
    fetcher,
  };
  return {
    control,
    blobs,
    store,
    events,
    input,
    deps,
    get calls() {
      return calls;
    },
    action: (a: typeof fetch) => {
      action = a;
    },
    advance: () => {
      time += 61000;
    },
    run: async (request = input) => {
      const lease = await store.acquireLease('voyage_index_lock');
      assert.ok(lease);
      try {
        return await indexAuditedBatch(config, request, lease, deps);
      } finally {
        await store.releaseLease(lease).catch(() => undefined);
      }
    },
  };
}
await test('prepared publication to recommendation flow indexes only misses, activates, retrieves and applies Jev support without query-time document embedding', async () => {
  const f = await fixture(2, 'Canlı akustik müzik konseri.', true);
  assert.equal((await f.store.catalogStatus()).status, 'empty');
  assert.deepEqual(await f.store.candidates(emptyFilters), []);
  const firstHash = await auditDigest(voyageDocumentText(f.events[0]));
  const lease = await f.store.acquireLease('voyage_index_lock');
  assert.ok(lease);
  await f.store.saveVoyageVectors(profile, [{ hash: firstHash, vector: vector(7) }], lease);
  await f.store.releaseLease(lease);
  f.action(async (_url, init) => {
    const body = JSON.parse(init?.body as string);
    assert.equal(body.input_type, 'document');
    assert.deepEqual(body.input, [voyageDocumentText(f.events[1])]);
    assert.deepEqual(await f.store.candidates(emptyFilters), [], 'provider response must not expose pending search');
    return Response.json({ data: [{ index: 0, embedding: vector() }], usage: { total_tokens: 10 } });
  });
  const indexed = await f.run();
  assert.equal(indexed.embedded, 1);
  assert.ok('publication' in indexed);
  assert.deepEqual(indexed.publication, { activated: true, pending: 0 });
  assert.equal((await f.store.catalogStatus()).status, 'ready');
  const state = emptyIntentState({ ...emptyFilters, maxPrice: 1000 });
  let queryCalls = 0, rankCalls = 0;
  const result = await recommend(validateInput({ message: '1000 TL altı akustik konser', intentVersion: 1 }), {
    candidates: (filters) => f.store.candidates(filters),
    now: new Date(instant), config: { apiKey: 'offline', model: 'jev-test' },
    inputInterpreter: 'jev-v1',
    interpret: async () => ({ state, action: 'search', issue: null, query: intentQuery(state), origin: 'jev' }),
    embeddingConfig: config,
    vectors: async (events) => {
      const hashes = events.map((event) => event.preparedSearch!.documentHash);
      const stored = await f.store.voyageVectorsByHash(profile, hashes, 1024);
      assert.deepEqual(stored.get(firstHash), vector(7), 'cached vector remains unchanged');
      return new Map(events.map((event) => [event.id, stored.get(event.preparedSearch!.documentHash)!]));
    },
    embed: (config, texts, kind) => embedWithVoyage(config, texts, kind, async (_url, init) => {
      queryCalls++;
      const body = JSON.parse(init?.body as string);
      assert.equal(body.input_type, 'query');
      assert.equal(body.input.length, 1);
      return Response.json({ data: [{ index: 0, embedding: vector() }], usage: { total_tokens: 3 } });
    }),
    rank: (config, input, events) => rankWithJev(config, input, events, async (_url, init) => {
      rankCalls++;
      const body = JSON.parse(init?.body as string);
      assert.equal(body.state.candidates.length, 2);
      assert.ok(body.state.candidates.every((candidate: Record<string, unknown>) => !('preparedSearch' in candidate)));
      return Response.json({ model: 'jev-test', usage: { input_tokens: 1, output_tokens: 1 }, answers: Object.fromEntries(events.map((_, i) => [
        `candidate_${i}`, { type: 'score', score: i === 0 ? 3 : 1, confidence: 1, probabilities: i === 0 ? { 0: 0, 1: 0, 2: 0, 3: 1 } : { 0: 0, 1: 1, 2: 0, 3: 0 } },
      ])) });
    }),
  });
  assert.equal(result.mode, 'jev');
  assert.equal(result.totalCandidates, 2);
  assert.equal(result.recommendations.length, 1, 'below-threshold event is not used to fill results');
  assert.equal(result.recommendations[0].event.price, 500);
  assert.equal(result.diagnostics?.vectorCoverage.available, 2);
  assert.equal(queryCalls, 1);
  assert.equal(rankCalls, 1);
  assert.equal(f.calls, 1, 'only the one missing document was embedded');
  const replay = await f.run();
  assert.equal(replay.embedded, 0);
  assert.equal(f.calls, 1, 'replay does not call document provider');
});

await test('only missing exact-profile text hashes are embedded; old vectors remain exact and next run pays nothing', async () => {
  const f = await fixture(2),
    oldHash = await auditDigest(voyageDocumentText(f.events[0])),
    lease = await f.store.acquireLease('voyage_index_lock');
  assert.ok(lease);
  await f.store.saveVoyageVectors(
    profile,
    [{ hash: oldHash, vector: vector(7) }],
    lease,
  );
  await f.store.releaseLease(lease);
  const result = await f.run();
  assert.equal(result.embedded, 1);
  assert.equal(result.pending, 0);
  assert.equal(f.calls, 1);
  assert.deepEqual(
    (await f.store.voyageVectorsByHash(profile, [oldHash], 1024)).get(oldHash),
    vector(7),
  );
  const again = await f.run({ ...f.input, runId: '124' });
  assert.equal(again.embedded, 0);
  assert.equal(f.calls, 1);
  const original = [...f.blobs.rows].find(([k]) =>
    k.endsWith('-response.json'),
  )!;
  const receipt = JSON.parse(original[1]);
  assert.equal(receipt.complete, true);
  assert.equal(
    receipt.sha256,
    await auditDigest(Buffer.from(receipt.body, 'base64')),
  );
  assert.ok(result.audit?.keys.includes(original[0]));
});
await test('non2xx original bytes survive while app failure stays generic and later runs cannot repay', async () => {
  const f = await fixture();
  const original = '{ "error" : "rate limited", "usage":null }';
  f.action(async () => new Response(original, { status: 429 }));
  await assert.rejects(f.run(), /halted/);
  assert.equal(f.calls, 1);
  const raw = JSON.parse(
    [...f.blobs.rows].find(([k]) => k.endsWith('-response.json'))![1],
  );
  assert.equal(Buffer.from(raw.body, 'base64').toString(), original);
  assert.equal(raw.status, 429);
  assert.equal(
    (
      await f.store.voyageVectorsByHash(
        profile,
        [await auditDigest(voyageDocumentText(f.events[0]))],
        1024,
      )
    ).size,
    0,
  );
  await assert.rejects(f.run({ ...f.input, runId: '999' }), /halted/);
  assert.equal(f.calls, 1);
});
await test('byte and run call caps persist across instances and cannot be reset with repeated calls', async () => {
  const f = await fixture(10, 'x'.repeat(3000));
  for (let i = 0; i < 4; i++) {
    const result = await f.run();
    assert.equal(result.embedded, 2);
    f.advance();
  }
  const limited = await f.run();
  assert.equal(limited.outcome, 'bounded-stop');
  assert.equal(f.calls, 4);
  assert.equal(limited.pending, 2);
  for (const [key, body] of f.blobs.rows)
    if (key.endsWith('-request.json'))
      assert.ok(JSON.parse(body).inputBytes <= 8000);
});
await test('window call limit spans different collection run IDs', async () => {
  const f = await fixture(5, 'x'.repeat(3000));
  f.input.window.maxCalls = 1;
  await f.run();
  f.advance();
  const next = await f.run({ ...f.input, runId: '456' });
  assert.equal(next.outcome, 'bounded-stop');
  assert.equal(f.calls, 1);
});
await test('preflight checkpoint/profile/window mismatches cost zero provider attempts', async () => {
  for (const change of [
    (i: AuditedIndexInput) => {
      i.checkpointSha256 = 'a'.repeat(64);
    },
    (i: AuditedIndexInput) => {
      i.expectedProfile += '-changed';
    },
    (i: AuditedIndexInput) => {
      i.expectedRevision = 'd'.repeat(40);
    },
    (i: AuditedIndexInput) => {
      i.window.until = new Date(instant).toISOString();
    },
  ]) {
    const f = await fixture(),
      input = structuredClone(f.input);
    change(input);
    await assert.rejects(f.run(input));
    assert.equal(f.calls, 0);
  }
  assert.throws(() =>
    parseAuditedIndexInput(
      {
        runId: '1',
        expectedProfile: profile,
        expectedRevision: 'c'.repeat(40),
        checkpointSha256: 'a'.repeat(64),
        window: {
          startedAt: new Date(instant).toISOString(),
          until: new Date(instant + 61 * 3600000).toISOString(),
          maxCalls: 32,
        },
      },
      instant,
    ),
  );
});
await test('capture failure before provider and after response both fence later attempts', async () => {
  for (const suffix of ['-request.json', '-response.json']) {
    const f = await fixture();
    f.blobs.failSuffix = suffix;
    await assert.rejects(f.run(), /halted/);
    assert.equal(f.calls, suffix === '-request.json' ? 0 : 1);
    f.blobs.failSuffix = '';
    await assert.rejects(f.run({ ...f.input, runId: '456' }), /halted/);
  }
});
await test('unavailable halt persistence retains the durable inFlight reservation', async () => {
  const f = await fixture();
  f.action(async () => {
    f.control.fail = true;
    throw new Error('offline transport failure');
  });
  await assert.rejects(f.run(), /halted/);
  assert.equal(f.calls, 1);
  f.control.fail = false;
  // Simulate the route's bounded lease expiring during a control outage.
  for (let i = 0; i < 6; i++) f.advance();
  await assert.rejects(f.run({ ...f.input, runId: '456' }), /halted/);
  assert.equal(f.calls, 1);
});
await test('credential reflection including JSON escapes is suppressed from raw evidence', async () => {
  const f = await fixture();
  f.action(
    async () =>
      new Response(
        JSON.stringify({ error: secret }).replace('offline', '\\u006fffline'),
        { status: 400 },
      ),
  );
  await assert.rejects(f.run(), /halted/);
  const audits = [...f.blobs.rows].filter(([k]) =>
    k.startsWith('embedding-audit/'),
  );
  assert.ok(
    audits.some(([, v]) => JSON.parse(v).credentialSuppressed === true),
  );
  assert.ok(!audits.some(([k]) => k.endsWith('-response.json')));
  assert.ok(!audits.some(([, v]) => v.includes(secret)));
});
await test('uncertain vector publication preserves raw output and prevents automatic provider retry', async () => {
  const f = await fixture();
  f.deps.store = {
    ...f.store,
    saveVoyageVectors: async () => {
      throw new Error('Injected publication outage');
    },
  };
  await assert.rejects(f.run(), /halted/);
  assert.equal(f.calls, 1);
  assert.ok([...f.blobs.rows.keys()].some((k) => k.endsWith('-response.json')));
  await assert.rejects(f.run({ ...f.input, runId: '456' }), /halted/);
  assert.equal(f.calls, 1);
});
await test('observed-token overshoot is retained and halts after its one bounded charged call', async () => {
  const f = await fixture();
  f.action(
    async () =>
      new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: vector() }],
          usage: { total_tokens: 32001 },
        }),
      ),
  );
  await assert.rejects(f.run(), /halted/);
  assert.equal(f.calls, 1);
  const state = await f.control.get<{ tokens: number; halted: boolean }>(
    'biplan/staging/embeddingIndex/window',
  );
  assert.equal(state?.tokens, 32001);
  assert.equal(state?.halted, true);
});
await test('a later price-only collection reuses every existing vector', async () => {
  const f = await fixture();
  await f.run();
  f.advance();
  const lease = await f.store.acquireLease('sync_lock');
  assert.ok(lease);
  const event = {
    ...f.events[0],
    price: 750,
    checkedAt: new Date(instant + 61000).toISOString(),
  };
  await f.store.importPages([{ url: event.url, events: [event] }], lease);
  await f.store.publishCheckpoint(
    {
      finishedAt: event.checkedAt,
      summary: {
        events: 1,
        available: 1,
        refreshedPages: 1,
        missingSources: [],
      },
    },
    lease,
  );
  await f.store.releaseLease(lease);
  const result = await f.run({
    ...f.input,
    runId: '456',
    checkpointSha256: await auditDigest((await f.store.readCheckpoint())!),
  });
  assert.equal(result.embedded, 0);
  assert.equal(result.pending, 0);
  assert.equal(f.calls, 1);
});
await test('catalog change during the charged call preserves raw evidence without publishing vectors', async () => {
  const f = await fixture();
  // The dependencies store reference is read once by the batch, so mutate that
  // same object's method to model a changed backing catalog during the request.
  f.action(async () => {
    f.store.readCheckpoint = async () => 'changed';
    return new Response(
      JSON.stringify({
        data: [{ index: 0, embedding: vector() }],
        usage: { total_tokens: 100 },
      }),
    );
  });
  await assert.rejects(f.run(), /halted/);
  assert.equal(f.calls, 1);
  assert.ok([...f.blobs.rows.keys()].some((k) => k.endsWith('-response.json')));
  assert.equal(
    (
      await f.store.voyageVectorsByHash(
        profile,
        [await auditDigest(voyageDocumentText(f.events[0]))],
        1024,
      )
    ).size,
    0,
  );
});
await test('corrupt durable budget state fails closed before a paid request', async () => {
  const f = await fixture();
  f.control.rows.set('biplan/staging/embeddingIndex/window', {
    id: 'a'.repeat(64),
    calls: Number.NaN,
  });
  await assert.rejects(f.run(), /Invalid durable/);
  assert.equal(f.calls, 0);
});
await test('oversized provider output retains bounded partial bytes and stops', async () => {
  const f = await fixture();
  f.action(
    async () => new Response('x'.repeat(4 * 1024 * 1024 + 1), { status: 503 }),
  );
  await assert.rejects(f.run(), /halted/);
  assert.equal(f.calls, 1);
  const partial = JSON.parse(
    [...f.blobs.rows].find(([key]) => key.endsWith('-partial.json'))![1],
  );
  assert.equal(partial.complete, false);
  assert.equal(Buffer.from(partial.body, 'base64').length, 4 * 1024 * 1024);
  assert.ok(
    ![...f.blobs.rows.keys()].some((key) => key.endsWith('-response.json')),
  );
});
await test('an oversized single document stays pending without a paid request', async () => {
  const f = await fixture(1, 'x'.repeat(10000));
  const result = await f.run();
  assert.equal(result.outcome, 'bounded-stop');
  assert.equal(result.pending, 1);
  assert.equal(f.calls, 0);
});
await test('trimmed environment secrets and the actual Voyage key are always suppressed', async () => {
  for (const mode of ['padded-environment', 'config-key-only']) {
    const f = await fixture(),
      reflected =
        mode === 'padded-environment' ? 'protected-sync-fixture' : secret;
    f.deps.secrets =
      mode === 'padded-environment' ? ['  protected-sync-fixture  '] : [];
    f.action(
      async () =>
        new Response(JSON.stringify({ error: reflected }), { status: 400 }),
    );
    await assert.rejects(f.run(), /halted/);
    assert.ok(
      ![...f.blobs.rows.keys()].some((k) => k.endsWith('-response.json')),
    );
    const failure = JSON.parse(
      [...f.blobs.rows].find(([k]) => k.endsWith('-failure.json'))![1],
    );
    assert.equal(failure.credentialSuppressed, true);
    for (const [key, value] of f.blobs.rows)
      if (key.startsWith('embedding-audit/'))
        assert.ok(!value.includes(reflected));
  }
});
