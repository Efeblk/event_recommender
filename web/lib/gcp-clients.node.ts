import { createHash } from 'node:crypto';
import type {
  BlobStore,
  ControlStore,
  ControlTransaction,
} from './storage-contract.ts';

const DEFAULT_MAX_BLOB_BYTES = 128 * 1024 * 1024;
const MAX_CONFIGURABLE_BLOB_BYTES = 128 * 1024 * 1024;
const RESOURCE_ERROR = 'GCP storage operation failed.';
type Environment = Readonly<Record<string, string | undefined>>;

type Data = Record<string, unknown>;

interface DocumentSnapshotLike {
  exists: boolean;
  data(): Data | undefined;
}

interface DocumentReferenceLike {
  get(): Promise<DocumentSnapshotLike>;
}

interface QuerySnapshotLike {
  docs: Array<{ id: string; data(): Data }>;
}

interface CollectionReferenceLike {
  get(): Promise<QuerySnapshotLike>;
}

interface TransactionLike {
  get(reference: DocumentReferenceLike): Promise<DocumentSnapshotLike>;
  set(reference: DocumentReferenceLike, data: Data): void;
  delete(reference: DocumentReferenceLike): void;
}

export interface FirestoreLike {
  doc(path: string): DocumentReferenceLike;
  collection(path: string): CollectionReferenceLike;
  runTransaction<T>(
    callback: (transaction: TransactionLike) => Promise<T>,
    options: { maxAttempts: number },
  ): Promise<T>;
}

interface FileMetadata {
  generation?: string | number;
  size?: string | number;
}

interface FileLike {
  getMetadata(): Promise<[FileMetadata]>;
  createReadStream(options?: { validation?: 'crc32c' | false }): NodeJS.ReadableStream;
  save(
    body: string,
    options: {
      resumable: false;
      validation: 'crc32c';
      preconditionOpts: { ifGenerationMatch: 0 };
      metadata: { metadata: { biplanSha256: string } };
    },
  ): Promise<unknown>;
}

interface BucketLike {
  file(key: string, options?: { generation?: string }): FileLike;
}

export interface StorageLike {
  bucket(name: string): BucketLike;
}

export interface GcpStorageConfig {
  environment: 'staging' | 'production';
  projectId: string;
  bucket: string;
  databaseId: string;
  maxBlobBytes: number;
}

export interface GcpSdkClients {
  firestore: FirestoreLike;
  storage: StorageLike;
}

export interface GcpSdkConstructors {
  Firestore: new (options: {
    projectId: string;
    databaseId: string;
  }) => FirestoreLike;
  Storage: new (options: { projectId: string }) => StorageLike;
}

function required(env: Environment, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing GCP configuration: ${name}.`);
  if (/\r|\n/.test(value)) throw new Error(`Invalid GCP configuration: ${name}.`);
  return value;
}

export function gcpStorageConfigFromEnv(
  env: Environment = process.env,
): GcpStorageConfig {
  const environment = required(env, 'DEPLOYMENT_ENV');
  if (environment !== 'staging' && environment !== 'production')
    throw new Error('DEPLOYMENT_ENV must be staging or production.');
  const projectId = required(env, 'BIPLAN_GCP_PROJECT');
  const bucket = required(env, 'GCP_STORAGE_BUCKET');
  const databaseId = env.FIRESTORE_DATABASE?.trim() || '(default)';
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId))
    throw new Error('BIPLAN_GCP_PROJECT is invalid.');
  if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket))
    throw new Error('GCP_STORAGE_BUCKET is invalid.');
  if (!/^\(default\)$|^[a-z][a-z0-9-]{2,62}$/.test(databaseId))
    throw new Error('FIRESTORE_DATABASE is invalid.');
  const configuredLimit = env.GCP_MAX_BLOB_BYTES?.trim();
  const maxBlobBytes = configuredLimit
    ? Number(configuredLimit)
    : DEFAULT_MAX_BLOB_BYTES;
  if (
    !Number.isSafeInteger(maxBlobBytes) ||
    maxBlobBytes < 1 ||
    maxBlobBytes > MAX_CONFIGURABLE_BLOB_BYTES
  )
    throw new Error('GCP_MAX_BLOB_BYTES must be an integer from 1 to 134217728.');
  return { environment, projectId, bucket, databaseId, maxBlobBytes };
}

function documentPath(path: string) {
  const parts = path.split('/');
  if (!path || parts.some((part) => !part) || parts.length % 2 !== 0)
    throw new Error('Invalid document path.');
  return path;
}

function collectionPath(path: string) {
  const parts = path.split('/');
  if (!path || parts.some((part) => !part) || parts.length % 2 !== 1)
    throw new Error('Invalid collection path.');
  return path;
}

function objectKey(key: string) {
  if (!key || key.startsWith('/') || key.endsWith('/') || key.includes('..'))
    throw new Error('Invalid object key.');
  return key;
}

function statusCode(error: unknown) {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { code?: unknown; statusCode?: unknown };
  return Number(value.code ?? value.statusCode);
}

function storageFailure(): never {
  throw new Error(RESOURCE_ERROR);
}

async function metadataOrMissing(file: FileLike) {
  try {
    const [metadata] = await file.getMetadata();
    return metadata;
  } catch (error) {
    if (statusCode(error) === 404) return null;
    storageFailure();
  }
}

async function readBounded(
  bucket: BucketLike,
  key: string,
  maxBytes: number,
) {
  const initial = bucket.file(key);
  const metadata = await metadataOrMissing(initial);
  if (!metadata) return null;
  const generation = String(metadata.generation ?? '');
  if (!generation) storageFailure();
  const declared = Number(metadata.size);
  if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes)
    storageFailure();
  const pinned = bucket.file(key, { generation });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const value of pinned.createReadStream({ validation: 'crc32c' })) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > maxBytes || bytes > declared) storageFailure();
      chunks.push(chunk);
    }
  } catch {
    storageFailure();
  }
  if (bytes !== declared) storageFailure();
  return { body: Buffer.concat(chunks, bytes).toString('utf8'), bytes };
}

export function createGcpStores(
  config: GcpStorageConfig,
  clients: GcpSdkClients,
): { control: ControlStore; blobs: BlobStore } {
  const bucket = clients.storage.bucket(config.bucket);
  const control: ControlStore = {
    async get<T>(path: string) {
      try {
        const snapshot = await clients.firestore.doc(documentPath(path)).get();
        return snapshot.exists ? (snapshot.data() as T) : null;
      } catch {
        storageFailure();
      }
    },
    async list<T>(collection: string) {
      try {
        const snapshot = await clients.firestore
          .collection(collectionPath(collection))
          .get();
        return snapshot.docs.map((document) => ({
          id: document.id,
          data: document.data() as T,
        }));
      } catch {
        storageFailure();
      }
    },
    async transaction<T>(callback: (transaction: ControlTransaction) => Promise<T>) {
      try {
        return await clients.firestore.runTransaction(
          async (transaction) => {
            let mutated = false;
            return callback({
              async get<Value>(path: string) {
                if (mutated)
                  throw new Error('Transaction reads must precede writes.');
                const snapshot = await transaction.get(
                  clients.firestore.doc(documentPath(path)),
                );
                return snapshot.exists ? (snapshot.data() as Value) : null;
              },
              set(path: string, data: Data) {
                mutated = true;
                transaction.set(clients.firestore.doc(documentPath(path)), data);
              },
              delete(path: string) {
                mutated = true;
                transaction.delete(clients.firestore.doc(documentPath(path)));
              },
            });
          },
          { maxAttempts: 5 },
        );
      } catch (error) {
        if (error instanceof Error && error.message === 'Transaction reads must precede writes.')
          throw error;
        storageFailure();
      }
    },
  };
  const blobs: BlobStore = {
    get(key: string) {
      return readBounded(bucket, objectKey(key), config.maxBlobBytes);
    },
    async exists(key: string) {
      const metadata = await metadataOrMissing(bucket.file(objectKey(key)));
      return metadata !== null;
    },
    async putImmutable(key: string, body: string) {
      const checkedKey = objectKey(key);
      const bytes = Buffer.byteLength(body);
      if (bytes > config.maxBlobBytes) storageFailure();
      const digest = createHash('sha256').update(body).digest('hex');
      try {
        await bucket.file(checkedKey).save(body, {
          resumable: false,
          validation: 'crc32c',
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { metadata: { biplanSha256: digest } },
        });
      } catch (error) {
        if (statusCode(error) !== 412) storageFailure();
        const existing = await readBounded(bucket, checkedKey, config.maxBlobBytes);
        if (!existing || createHash('sha256').update(existing.body).digest('hex') !== digest)
          throw new Error('Immutable object collision.');
      }
    },
  };
  return { control, blobs };
}

export async function createGcpClients(
  env: Environment = process.env,
  constructors?: GcpSdkConstructors,
) {
  const config = gcpStorageConfigFromEnv(env);
  const sdk =
    constructors ??
    ((await Promise.all([
      import('@google-cloud/firestore'),
      import('@google-cloud/storage'),
    ]).then(([firestore, storage]) => ({
      Firestore: firestore.Firestore,
      Storage: storage.Storage,
    }))) as GcpSdkConstructors);
  return createGcpStores(config, {
    firestore: new sdk.Firestore({
      projectId: config.projectId,
      databaseId: config.databaseId,
    }),
    storage: new sdk.Storage({ projectId: config.projectId }),
  });
}
