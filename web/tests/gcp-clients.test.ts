import assert from 'node:assert/strict';
import { PassThrough, Readable, Transform, pipeline } from 'node:stream';
import test from 'node:test';
import {
  createGcpClients,
  createGcpStores,
  gcpStorageConfigFromEnv,
  type FirestoreLike,
  type GcpSdkConstructors,
  type GcpStorageConfig,
  type StorageLike,
} from '../lib/gcp-clients.node.ts';

const config: GcpStorageConfig = {
  environment: 'staging',
  projectId: 'biplan-demo-2026',
  bucket: 'biplan-demo-staging-data',
  databaseId: '(default)',
  maxBlobBytes: 1024,
};

function error(code: number, message = 'sensitive provider detail') {
  return Object.assign(new Error(message), { code });
}

function firestoreFake(initial: Record<string, Record<string, unknown>> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: string[] = [];
  let maxAttempts = 0;
  const snapshot = (path: string) => ({
    exists: values.has(path),
    data: () => values.get(path),
  });
  const firestore: FirestoreLike = {
    doc: (path) => ({ get: async () => snapshot(path), path } as never),
    collection: (path) => ({
      get: async () => ({
        docs: [...values.entries()]
          .filter(([key]) => key.split('/').slice(0, -1).join('/') === path)
          .map(([key, data]) => ({ id: key.split('/').at(-1)!, data: () => data })),
      }),
    }),
    async runTransaction(callback, options) {
      maxAttempts = options.maxAttempts;
      return callback({
        get: async (reference) => snapshot((reference as never as { path: string }).path),
        set(reference, data) {
          const path = (reference as never as { path: string }).path;
          writes.push(`set:${path}`);
          values.set(path, data);
        },
        delete(reference) {
          const path = (reference as never as { path: string }).path;
          writes.push(`delete:${path}`);
          values.delete(path);
        },
      });
    },
  };
  return { firestore, values, writes, maxAttempts: () => maxAttempts };
}

interface StoredObject {
  body: string;
  generation: string;
}

function storageFake(initial: Record<string, StoredObject> = {}) {
  const values = new Map(Object.entries(initial));
  const calls: Array<Record<string, unknown>> = [];
  let generation = 10;
  let metadataError: unknown;
  const storage: StorageLike = {
    bucket(bucketName) {
      return {
        file(key, options) {
          calls.push({ operation: 'file', bucketName, key, options });
          return {
            async getMetadata() {
              if (metadataError) throw metadataError;
              const value = values.get(key);
              if (!value) throw error(404);
              return [{ generation: value.generation, size: Buffer.byteLength(value.body) }];
            },
            createReadStream() {
              const value = values.get(key);
              if (!value || (options?.generation && options.generation !== value.generation))
                return new Readable({
                  read() {
                    this.destroy(error(412));
                  },
                });
              return Readable.from([Buffer.from(value.body)]);
            },
            async save(body, options) {
              calls.push({ operation: 'save', key, options });
              if (values.has(key)) throw error(412);
              values.set(key, { body, generation: String(++generation) });
            },
          };
        },
      };
    },
  };
  return {
    storage,
    values,
    calls,
    setMetadataError(value: unknown) {
      metadataError = value;
    },
  };
}

void test('validates explicit environment and bounded blob configuration', () => {
  assert.equal(
    gcpStorageConfigFromEnv({
      DEPLOYMENT_ENV: 'staging',
      BIPLAN_GCP_PROJECT: 'biplan-demo-2026',
      GCP_STORAGE_BUCKET: 'existing-staging-bucket',
    }).maxBlobBytes,
    128 * 1024 * 1024,
  );
  assert.deepEqual(
    gcpStorageConfigFromEnv({
      DEPLOYMENT_ENV: 'production',
      BIPLAN_GCP_PROJECT: 'biplan-demo-2026',
      GCP_STORAGE_BUCKET: 'existing-production-bucket',
      FIRESTORE_DATABASE: '(default)',
      GCP_MAX_BLOB_BYTES: '1024',
    }),
    {
      environment: 'production',
      projectId: 'biplan-demo-2026',
      bucket: 'existing-production-bucket',
      databaseId: '(default)',
      maxBlobBytes: 1024,
    },
  );
  assert.throws(
    () =>
      gcpStorageConfigFromEnv({
        DEPLOYMENT_ENV: 'preview',
        BIPLAN_GCP_PROJECT: 'biplan-demo-2026',
        GCP_STORAGE_BUCKET: 'bucket-name',
      }),
    /DEPLOYMENT_ENV/,
  );
  assert.throws(
    () =>
      gcpStorageConfigFromEnv({
        DEPLOYMENT_ENV: 'staging',
        BIPLAN_GCP_PROJECT: 'biplan-demo-2026',
        GCP_STORAGE_BUCKET: 'bucket-name',
        GCP_MAX_BLOB_BYTES: String(129 * 1024 * 1024),
      }),
    /GCP_MAX_BLOB_BYTES/,
  );
});

void test('constructs official SDK clients with project and database configuration', async () => {
  const seen: Record<string, unknown> = {};
  const fire = firestoreFake();
  const store = storageFake();
  class Firestore {
    constructor(options: unknown) {
      seen.firestore = options;
      return fire.firestore;
    }
  }
  class Storage {
    constructor(options: unknown) {
      seen.storage = options;
      return store.storage;
    }
  }
  await createGcpClients(
    {
      DEPLOYMENT_ENV: 'staging',
      BIPLAN_GCP_PROJECT: 'biplan-demo-2026',
      GCP_STORAGE_BUCKET: 'biplan-staging-data',
    },
    { Firestore, Storage } as unknown as GcpSdkConstructors,
  );
  assert.deepEqual(seen, {
    firestore: { projectId: 'biplan-demo-2026', databaseId: '(default)' },
    storage: { projectId: 'biplan-demo-2026' },
  });
});

void test('control store supports nested paths and enforces transaction reads first', async () => {
  const fire = firestoreFake({
    'biplan/staging/runs/one': { state: 'ready' },
    'biplan/staging/runs/two': { state: 'pending' },
  });
  const { control } = createGcpStores(config, {
    firestore: fire.firestore,
    storage: storageFake().storage,
  });
  assert.deepEqual(await control.get('biplan/staging/runs/one'), { state: 'ready' });
  assert.equal((await control.list('biplan/staging/runs')).length, 2);
  await control.transaction(async (transaction) => {
    assert.deepEqual(await transaction.get('biplan/staging/runs/one'), { state: 'ready' });
    transaction.set('biplan/staging/runs/three', { state: 'new' });
    transaction.delete('biplan/staging/runs/two');
  });
  assert.equal(fire.maxAttempts(), 5);
  assert.deepEqual(fire.writes, [
    'set:biplan/staging/runs/three',
    'delete:biplan/staging/runs/two',
  ]);
  await assert.rejects(
    control.transaction(async (transaction) => {
      transaction.set('biplan/staging/runs/three', { state: 'changed' });
      await transaction.get('biplan/staging/runs/one');
    }),
    /reads must precede writes/,
  );
});

void test('blob reads pin generation and map only 404 to missing', async () => {
  const store = storageFake({ checkpoint: { body: 'hello', generation: '7' } });
  const { blobs } = createGcpStores(config, {
    firestore: firestoreFake().firestore,
    storage: store.storage,
  });
  assert.deepEqual(await blobs.get('checkpoint'), { body: 'hello', bytes: 5 });
  assert.equal(await blobs.get('missing'), null);
  assert.equal(await blobs.exists('missing'), false);
  assert.ok(store.calls.some((call) =>
    (call.options as { generation?: string } | undefined)?.generation === '7',
  ));
  store.setMetadataError(error(403, 'token and headers must not escape'));
  await assert.rejects(blobs.get('checkpoint'), (failure: Error) => {
    assert.equal(failure.message, 'GCP storage operation failed.');
    return true;
  });
});

void test('blob reads reject declared and streamed oversized objects', async () => {
  const declared = storageFake({ large: { body: '12345', generation: '1' } });
  const tinyConfig = { ...config, maxBlobBytes: 4 };
  const declaredBlobs = createGcpStores(tinyConfig, {
    firestore: firestoreFake().firestore,
    storage: declared.storage,
  }).blobs;
  await assert.rejects(declaredBlobs.get('large'), /GCP storage operation failed/);

  const streamed = storageFake({ changing: { body: '1234', generation: '1' } });
  const baseBucket = streamed.storage.bucket('x');
  const overflowStream = Readable.from([Buffer.from('12345')]);
  const storage: StorageLike = {
    bucket: () => ({
      file(key, options) {
        const file = baseBucket.file(key, options);
        if (options?.generation) file.createReadStream = () => overflowStream;
        return file;
      },
    }),
  };
  const streamedBlobs = createGcpStores(tinyConfig, {
    firestore: firestoreFake().firestore,
    storage,
  }).blobs;
  await assert.rejects(streamedBlobs.get('changing'), /GCP storage operation failed/);
  assert.equal(overflowStream.destroyed, true);
});

void test('blob reads consume SDK-style pipelines without listener warnings', async () => {
  const output = new PassThrough();
  const source = new PassThrough();
  const validator = new Transform({
    transform(chunk, _encoding, callback) {
      callback(null, chunk);
    },
  });
  pipeline(source, validator, output, () => undefined);

  // The Storage SDK returns the output of a validation pipeline. Retry cleanup
  // can leave it close to EventEmitter's default listener threshold.
  while (output.listenerCount('error') < 9) output.on('error', () => undefined);
  while (output.listenerCount('close') < 10) output.on('close', () => undefined);

  const warnings: Error[] = [];
  const onWarning = (warning: Error & { emitter?: unknown }) => {
    if (warning.name === 'MaxListenersExceededWarning' && warning.emitter === output)
      warnings.push(warning);
  };
  process.on('warning', onWarning);
  try {
    const base = storageFake({ piped: { body: 'hello', generation: '1' } });
    const baseBucket = base.storage.bucket('x');
    const storage: StorageLike = {
      bucket: () => ({
        file(key, options) {
          const file = baseBucket.file(key, options);
          if (options?.generation) file.createReadStream = () => output;
          return file;
        },
      }),
    };
    const reading = createGcpStores(config, {
      firestore: firestoreFake().firestore,
      storage,
    }).blobs.get('piped');
    source.end('hello');
    assert.deepEqual(await reading, { body: 'hello', bytes: 5 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(warnings, []);
  } finally {
    process.removeListener('warning', onWarning);
  }
});

void test('blob reads reject SDK checksum failures and premature closes', async () => {
  async function expectPipelineFailure(kind: 'checksum' | 'close') {
    const output = new PassThrough();
    const source = new PassThrough();
    const validator = new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, chunk);
      },
      flush(callback) {
        callback(kind === 'checksum' ? new Error('checksum mismatch') : null);
      },
    });
    pipeline(source, validator, output, () => undefined);
    const base = storageFake({ object: { body: 'hello', generation: '1' } });
    const baseBucket = base.storage.bucket('x');
    const storage: StorageLike = {
      bucket: () => ({
        file(key, options) {
          const file = baseBucket.file(key, options);
          if (options?.generation) file.createReadStream = () => output;
          return file;
        },
      }),
    };
    const reading = createGcpStores(config, {
      firestore: firestoreFake().firestore,
      storage,
    }).blobs.get('object');
    source.write('hello');
    if (kind === 'close') source.destroy();
    else source.end();
    await assert.rejects(reading, /GCP storage operation failed/);
  }

  await expectPipelineFailure('checksum');
  await expectPipelineFailure('close');
});

void test('blob reads reject a bare returned stream closed without an error', async () => {
  const stream = new PassThrough();
  const base = storageFake({ object: { body: 'hello', generation: '1' } });
  const baseBucket = base.storage.bucket('x');
  const storage: StorageLike = {
    bucket: () => ({
      file(key, options) {
        const file = baseBucket.file(key, options);
        if (options?.generation) file.createReadStream = () => stream;
        return file;
      },
    }),
  };
  const reading = createGcpStores(config, {
    firestore: firestoreFake().firestore,
    storage,
  }).blobs.get('object');
  stream.write('hello');
  stream.destroy();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      Promise.race([
        reading,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('read timed out')), 1_000);
        }),
      ]),
      /GCP storage operation failed/,
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
});

void test('immutable puts use create-only precondition and verify retry collisions', async () => {
  const store = storageFake();
  const { blobs } = createGcpStores(config, {
    firestore: firestoreFake().firestore,
    storage: store.storage,
  });
  await blobs.putImmutable('checkpoints/one.json', 'same');
  await blobs.putImmutable('checkpoints/one.json', 'same');
  await assert.rejects(
    blobs.putImmutable('checkpoints/one.json', 'different'),
    /Immutable object collision/,
  );
  const save = store.calls.find((call) => call.operation === 'save');
  assert.deepEqual(
    (save!.options as { preconditionOpts: unknown }).preconditionOpts,
    { ifGenerationMatch: 0 },
  );
});
