function abortError(signal: AbortSignal, fallback: string) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(fallback);
}

export class DeadlineExceededError extends Error {}

function combinedSignal(signals: (AbortSignal | null | undefined)[]) {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 1) return active[0];
  return AbortSignal.any(active);
}

/** Add a request-wide cancellation signal to a fetch that has its own deadline. */
export function fetchWithSignal(
  requestSignal: AbortSignal,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requestSignal.throwIfAborted();
    return fetcher(input, {
      ...init,
      signal: combinedSignal([requestSignal, init?.signal]),
    });
  }) as typeof fetch;
}

export async function withDeadline<T>(
  timeoutMs: number,
  timeoutMessage: string,
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error('Invalid request timeout.');

  const controller = new AbortController();
  const signal = combinedSignal([controller.signal, parentSignal]);
  const timer = setTimeout(
    () => controller.abort(new DeadlineExceededError(timeoutMessage)),
    timeoutMs,
  );
  if (signal.aborted) {
    clearTimeout(timer);
    throw abortError(signal, timeoutMessage);
  }
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError(signal, timeoutMessage));
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    return await Promise.race([operation(signal), interrupted]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
