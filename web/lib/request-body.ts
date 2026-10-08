export class RequestBodyTooLargeError extends Error {
  constructor() {
    super('Request body is too large.');
    this.name = 'RequestBodyTooLargeError';
  }
}

/** Read a request body without ever retaining more than the permitted bytes. */
export async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new Error('Invalid request body limit.');
  const declared = request.headers.get('content-length');
  if (/^\d+$/.test(declared ?? '') && BigInt(declared!) > BigInt(maxBytes)) {
    await request.body?.cancel().catch(() => undefined);
    throw new RequestBodyTooLargeError();
  }
  if (signal?.aborted) {
    await request.body?.cancel().catch(() => undefined);
    signal.throwIfAborted();
  }
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let length = 0;
  let onAbort: (() => void) | undefined;
  const interrupted = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;
  try {
    for (;;) {
      const { done, value } = await (interrupted
        ? Promise.race([reader.read(), interrupted])
        : reader.read());
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new RequestBodyTooLargeError();
      chunks.push(value);
    }
  } finally {
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
