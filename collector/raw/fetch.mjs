/** Drain a bounded response into durable raw storage before any parser sees it.
 * Failed statuses, incomplete transfers and over-limit prefixes remain receipts. */
export async function retainProviderResponse(response, metadata, store, maxBytes) {
  const reader = response.body?.getReader();
  const parts = []; let size = 0, complete = true, bodyError;
  try {
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value.subarray(0, Math.max(0, maxBytes - size)));
      size += value.byteLength;
      if (size > maxBytes) { complete = false; bodyError = new Error('response_too_large'); break; }
    }
  } catch (error) { complete = false; bodyError = error; }
  finally {
    if (reader) {
      try { await reader.cancel(); } catch { /* preserve incomplete-transfer evidence */ }
      reader.releaseLock();
    }
  }
  const bytes = Buffer.concat(parts);
  const receipt = await store.put(bytes, { ...metadata, status: response.status, headers: response.headers, complete });
  return { receipt, body: bytes.toString('utf8'), bodyError };
}
