import { createHash } from 'node:crypto';
import { validateRawRef } from './store.mjs';

export const STAGING_RAW_BUCKET = 'biplan-staging-efeblk-biplan-staging-data';
export const STAGING_RAW_PREFIX = 'staging/pipeline/raw/v1/';

/** REST adapter accepts a short-lived OAuth credential provider; it never logs
 * response bodies or credentials and verifies the exact immutable generation. */
export function createGcsRawMirror({ bucket, prefix, accessToken, fetchImpl = fetch, timeoutMs = 20000 }) {
  if (bucket !== STAGING_RAW_BUCKET || prefix !== STAGING_RAW_PREFIX || typeof accessToken !== 'function') throw new Error('unapproved_raw_storage_destination');
  const objectUrl = key => `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(prefix + key)}`;
  async function request(url, options = {}) {
    const token = await accessToken();
    if (typeof token !== 'string' || !token) throw new Error('missing_raw_storage_credential');
    return fetchImpl(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
  }
  async function putObject(body, ref) {
      const bytes = Buffer.from(body);
      if (bytes.length !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error('raw_integrity_failure');
      const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&ifGenerationMatch=0&name=${encodeURIComponent(prefix + ref.key)}`;
      const result = await request(uploadUrl, { method: 'POST', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
      if (!result.ok && result.status !== 412) throw new Error(`raw_upload_failed_${result.status}`);
      await result.body?.cancel();
      const metadataResponse = await request(objectUrl(ref.key));
      if (!metadataResponse.ok) throw new Error(`raw_metadata_failed_${metadataResponse.status}`);
      const metadata = await metadataResponse.json();
      if (!/^\d+$/.test(String(metadata.generation)) || Number(metadata.size) !== ref.bytes) throw new Error('raw_storage_binding_mismatch');
      const response = await request(`${objectUrl(ref.key)}?alt=media&generation=${metadata.generation}`);
      if (!response.ok) throw new Error(`raw_verification_failed_${response.status}`);
      // The uploaded source limit is 4 MB. Bound a hostile or corrupt response too.
      const reader = response.body.getReader();
      const parts = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > ref.bytes) throw new Error('raw_storage_binding_mismatch');
          parts.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      if (size !== ref.bytes || createHash('sha256').update(Buffer.concat(parts)).digest('hex') !== ref.sha256) throw new Error('raw_storage_binding_mismatch');
      return { bucket, key: prefix + ref.key, generation: String(metadata.generation) };
  }
  return {
    async put(body, ref) {
      validateRawRef(ref);
      return putObject(body, ref);
    },
    async putReceipt(body, fetchId) {
      if (!/^[a-f0-9]{64}$/.test(fetchId)) throw new Error('invalid_fetch_reference');
      return putObject(body, { key: `fetches/${fetchId}.json`, sha256: fetchId, bytes: body.length });
    },
  };
}
