import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile, link, unlink } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';

export const RAW_STORE_VERSION = 1;
export const DEFAULT_RAW_MAX_BYTES = 512 * 1024 * 1024;
const digest = body => createHash('sha256').update(body).digest('hex');
const safeHeaders = new Set(['content-type', 'content-language', 'date', 'etag', 'last-modified', 'retry-after', 'location']);

export function responseMetadata({ url, method = 'GET', status, headers = {}, fetchedAt, collectorRevision = 'unknown', complete = true }) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid_raw_url');
  if (!Number.isInteger(status) || status < 100 || status > 599 || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('invalid_fetch_metadata');
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return { version: RAW_STORE_VERSION, url, method: method.toUpperCase(), status,
    headers: Object.fromEntries(entries.filter(([key]) => safeHeaders.has(key.toLowerCase())).map(([key, value]) => [key.toLowerCase(), String(value)])),
    fetchedAt, collectorRevision, complete };
}

export function validateRawRef(ref) {
  if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || ref.key !== `bodies/${ref.sha256}.bin` || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0)
    throw new Error('invalid_raw_reference');
  return ref;
}

async function directoryBytes(root) {
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error('raw_store_symlink');
    if (entry.isDirectory()) bytes += await directoryBytes(path);
    else bytes += (await stat(path)).size;
  }
  return bytes;
}

/** Immutable bodies and fetch receipts. Admission limits growth; deletion requires
 * a separate reachability review because publications may still refer to bodies. */
export async function createFilesystemRawStore(directory, { maxBytes = DEFAULT_RAW_MAX_BYTES, mirror } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('invalid_raw_storage_limit');
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  let storedBytes = await directoryBytes(root);
  let queue = Promise.resolve();
  const metrics = { fetched: 0, bodiesCreated: 0, reusedBodies: 0, responseBytes: 0, storedBytes, maxBytes };
  const pathFor = key => {
    const path = resolve(root, key);
    if (relative(root, path).startsWith('..') || relative(root, path) === '') throw new Error('invalid_raw_path');
    return path;
  };
  async function immutableWrite(key, body) {
    const destination = pathFor(key);
    await mkdir(dirname(destination), { recursive: true });
    try {
      const existing = await readFile(destination);
      if (!existing.equals(body)) throw new Error('raw_content_conflict');
      return false;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (storedBytes + body.length > maxBytes) throw new Error('raw_storage_admission_exceeded');
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, body, { flag: 'wx' });
    try {
      try { await link(temporary, destination); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!(await readFile(destination)).equals(body)) throw new Error('raw_content_conflict');
        return false;
      }
      storedBytes += body.length;
      metrics.storedBytes = storedBytes;
      return true;
    } finally { await unlink(temporary); }
  }
  return {
    metrics,
    async put(body, metadata) {
      const bytes = Buffer.from(body);
      const fetchMetadata = responseMetadata(metadata);
      const sha256 = digest(bytes), key = `bodies/${sha256}.bin`;
      const coreRef = { sha256, key, bytes: bytes.length };
      const receipt = Buffer.from(JSON.stringify({ ...fetchMetadata, rawObjectRef: coreRef }) + '\n');
      const fetchId = digest(receipt);
      const pending = queue.then(async () => {
        const created = await immutableWrite(key, bytes);
        // Cloud verification must precede acceptance of a listing reference.
        const binding = mirror ? await mirror.put(bytes, coreRef) : undefined;
        if (mirror) await mirror.putReceipt(receipt, fetchId);
        await immutableWrite(`fetches/${fetchId}.json`, receipt);
        metrics.fetched++; metrics.responseBytes += bytes.length;
        metrics.bodiesCreated += Number(created); metrics.reusedBodies += Number(!created);
        metrics.storedBytes = storedBytes;
        return { fetchId, rawObjectRef: { ...coreRef, ...(binding ? { storage: binding } : {}) }, metadata: fetchMetadata };
      });
      queue = pending.catch(() => {});
      return pending;
    },
    async read(ref) {
      validateRawRef(ref);
      const body = await readFile(pathFor(ref.key));
      if (body.length !== ref.bytes || digest(body) !== ref.sha256) throw new Error('raw_integrity_failure');
      return body;
    },
  };
}
