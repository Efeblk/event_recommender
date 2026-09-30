import { createHash } from 'node:crypto';

const shaPattern = /^[a-f0-9]{64}$/;
const safeStorageError = error => {
  if (error instanceof Error && error.message.startsWith('Source artifact ')) throw error;
  throw new Error('Source artifact storage read failed');
};

export async function loadPinnedGcsArtifact({ storage, bucket, key, generation, expectedSha256, maxBytes, signal }) {
  if (!storage || typeof bucket !== 'string' || !bucket || key !== `staging/preparation/sources/${expectedSha256}.json` ||
      typeof generation !== 'string' || !/^[1-9]\d*$/.test(generation) || !shaPattern.test(expectedSha256 ?? '') ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024)
    throw new Error('Invalid source artifact reference');
  if (signal?.aborted) throw new Error('Source artifact load interrupted');
  const bucketClient = storage.bucket(bucket), initial = bucketClient.file(key);
  let removeAbort = () => {};
  const aborted = new Promise((_, reject) => {
    const abort = () => reject(new Error('Source artifact load interrupted'));
    signal?.addEventListener('abort', abort, { once: true });
    removeAbort = () => signal?.removeEventListener('abort', abort);
  });
  let metadata;
  try { [metadata] = await Promise.race([initial.getMetadata(), aborted]); }
  catch (error) { safeStorageError(error); }
  finally { removeAbort(); }
  if (signal?.aborted) throw new Error('Source artifact load interrupted');
  if (String(metadata?.generation ?? '') !== generation) throw new Error('Source artifact generation mismatch');
  const declared = Number(metadata?.size);
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > maxBytes) throw new Error('Source artifact size is invalid');
  if (signal?.aborted) throw new Error('Source artifact load interrupted');
  const stream = bucketClient.file(key, { generation }).createReadStream({ validation: 'crc32c' });
  const chunks = []; let bytes = 0;
  const abort = () => stream.destroy(new Error('Source artifact load interrupted'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const value of stream) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.length;
      if (bytes > declared || bytes > maxBytes) { stream.destroy(); throw new Error('Source artifact size is invalid'); }
      chunks.push(chunk);
    }
  } catch (error) { safeStorageError(error); }
  finally { signal?.removeEventListener('abort', abort); }
  if (bytes !== declared) throw new Error('Source artifact size is invalid');
  const body = Buffer.concat(chunks, bytes);
  if (createHash('sha256').update(body).digest('hex') !== expectedSha256) throw new Error('Source artifact SHA-256 mismatch');
  return body.toString('utf8');
}
