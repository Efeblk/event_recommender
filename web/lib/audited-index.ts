import { emptyFilters } from './types.ts';
import {
  embedWithVoyageDetailed,
  voyageCacheKey,
  voyageDocumentText,
  type VoyageConfig,
} from './voyage.ts';
import type {
  BlobStore,
  ControlStore,
  HighLevelStore,
  Lease,
} from './storage-contract.ts';

export const auditIndexLimits = Object.freeze({
  callsPerRun: 4,
  inputBytesPerCall: 8000,
  inputBytesPerRun: 32000,
  observedTokensPerRun: 32000,
  callsPerWindow: 32,
  windowHours: 60,
  intervalMs: 21000,
  rollingTokens: 9000,
  responseBytes: 4 * 1024 * 1024,
});
export interface AuditedIndexInput {
  runId: string;
  expectedProfile: string;
  expectedRevision: string;
  checkpointSha256: string;
  window: { startedAt: string; until: string; maxCalls: number };
}
export function parseAuditedIndexInput(
  value: unknown,
  now = Date.now(),
): AuditedIndexInput {
  if (!value || typeof value !== 'object')
    throw new Error('Invalid indexing request');
  const v = value as AuditedIndexInput,
    w = v.window;
  const iso = (s: unknown) =>
    typeof s === 'string' &&
    Number.isFinite(Date.parse(s)) &&
    new Date(s).toISOString() === s;
  if (
    !/^\d{1,20}$/.test(v.runId ?? '') ||
    typeof v.expectedProfile !== 'string' ||
    v.expectedProfile.length > 400 ||
    !/^[a-f0-9]{40}$/.test(v.expectedRevision ?? '') ||
    !/^[a-f0-9]{64}$/.test(v.checkpointSha256 ?? '') ||
    !w ||
    !iso(w.startedAt) ||
    !iso(w.until) ||
    Date.parse(w.startedAt) > now ||
    Date.parse(w.until) <= now ||
    Date.parse(w.until) - Date.parse(w.startedAt) >
      auditIndexLimits.windowHours * 3600000 ||
    !Number.isSafeInteger(w.maxCalls) ||
    w.maxCalls < 1 ||
    w.maxCalls > auditIndexLimits.callsPerWindow
  )
    throw new Error('Invalid or expired indexing window');
  return {
    runId: v.runId,
    expectedProfile: v.expectedProfile,
    expectedRevision: v.expectedRevision,
    checkpointSha256: v.checkpointSha256,
    window: { startedAt: w.startedAt, until: w.until, maxCalls: w.maxCalls },
  };
}
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).byteLength;
export async function auditDigest(value: string | Uint8Array) {
  const raw = typeof value === 'string' ? encoder.encode(value) : value;
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', raw as BufferSource)),
    (n) => n.toString(16).padStart(2, '0'),
  ).join('');
}
interface WindowState {
  id: string;
  until: string;
  calls: number;
  tokens: number;
  maxCalls: number;
  halted: boolean;
  inFlight: string;
  lastStartAt: number;
  recent: { flight: string; at: number; tokens: number }[];
}
interface RunState {
  windowId: string;
  profile: string;
  checkpoint: string;
  calls: number;
  inputBytes: number;
  tokens: number;
  accountedAttempt: number;
}
function validCounters(value: object, fields: string[]) {
  return fields.every(
    (key) =>
      Number.isSafeInteger((value as Record<string, unknown>)[key]) &&
      Number((value as Record<string, unknown>)[key]) >= 0,
  );
}
function validateWindow(value: WindowState | null) {
  if (
    value &&
    (!/^[a-f0-9]{64}$/.test(value.id) ||
      !Number.isFinite(Date.parse(value.until)) ||
      !validCounters(value, ['calls', 'tokens', 'maxCalls', 'lastStartAt']) ||
      value.maxCalls < 1 ||
      value.maxCalls > 32 ||
      value.calls > value.maxCalls ||
      typeof value.halted !== 'boolean' ||
      typeof value.inFlight !== 'string' ||
      !Array.isArray(value.recent) ||
      value.recent.length > 32 ||
      value.recent.some(
        (r) =>
          !validCounters(r, ['at', 'tokens']) || typeof r.flight !== 'string',
      ))
  )
    throw new Error('Invalid durable indexing budget');
}
function validateRun(value: RunState | null) {
  if (
    value &&
    (!/^[a-f0-9]{64}$/.test(value.windowId) ||
      !/^[a-f0-9]{64}$/.test(value.checkpoint) ||
      typeof value.profile !== 'string' ||
      !validCounters(value, [
        'calls',
        'inputBytes',
        'tokens',
        'accountedAttempt',
      ]) ||
      value.calls > 4 ||
      value.inputBytes > 32000 ||
      value.accountedAttempt > value.calls)
  )
    throw new Error('Invalid durable indexing run');
}
interface Dependencies {
  store: HighLevelStore;
  control: ControlStore;
  blobs: BlobStore;
  namespace: string;
  revision: string;
  secrets: string[];
  now?: () => number;
  fetcher?: typeof fetch;
}
export function auditPayloadIsSafe(raw: Uint8Array, secrets: string[]) {
  secrets = secrets.map((secret) => secret.trim()).filter(Boolean);
  const text = new TextDecoder().decode(raw),
    contains = (s: string) =>
      secrets.some((secret) => secret && s.includes(secret));
  if (contains(text)) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return true;
  }
  const pending: unknown[] = [parsed];
  let visited = 0;
  while (pending.length) {
    if (++visited > 100000) return false;
    const value = pending.pop();
    if (typeof value === 'string' && contains(value)) return false;
    if (value && typeof value === 'object')
      for (const [key, child] of Object.entries(value)) {
        if (contains(key)) return false;
        pending.push(child);
      }
  }
  return true;
}
function base64(raw: Uint8Array) {
  let value = '';
  for (let i = 0; i < raw.length; i += 8192)
    value += String.fromCharCode(...raw.subarray(i, i + 8192));
  return btoa(value);
}

/** Paid fetch is deliberately outside retryable control-store transactions. */
export async function indexAuditedBatch(
  config: VoyageConfig,
  input: AuditedIndexInput,
  lease: Lease,
  deps: Dependencies,
) {
  const now = deps.now ?? Date.now,
    fetcher = deps.fetcher ?? fetch;
  const secrets = [config.apiKey, ...deps.secrets];
  input = parseAuditedIndexInput(input, now());
  if (
    deps.namespace !== 'staging' ||
    deps.revision !== input.expectedRevision ||
    voyageCacheKey(config) !== input.expectedProfile
  )
    throw new Error('Audited indexing target/profile mismatch');
  const { store, control, blobs } = deps,
    profile = input.expectedProfile;
  const pin = async () => {
    const checkpoint = await store.readCheckpoint();
    if (
      !checkpoint ||
      (await auditDigest(checkpoint)) !== input.checkpointSha256
    )
      throw new Error('Indexing checkpoint changed');
  };
  await pin();
  const events = await store.candidates(emptyFilters, new Date(now())),
    documents = new Map<string, string>();
  for (const event of events) {
    const text = voyageDocumentText(event);
    documents.set(await auditDigest(text), text);
  }
  const cached = await store.voyageVectorsByHash(
    profile,
    [...documents.keys()],
    config.dimensions,
  );
  const pending = [...documents]
    .filter(([hash]) => !cached.has(hash))
    .sort(([a], [b]) => a.localeCompare(b));
  const status = {
    configured: true,
    profile,
    deploymentRevision: deps.revision,
    checkpointSha256: input.checkpointSha256,
    eligible: events.length,
    documents: documents.size,
    indexed: cached.size,
    pending: pending.length,
  };
  const base = `biplan/staging/embeddingIndex`,
    windowPath = `${base}/window`,
    runPath = `${base}/runs/entries/${input.runId}`;
  const windowId = await auditDigest(JSON.stringify(input.window));
  const oldWindow = await control.get<WindowState>(windowPath);
  validateWindow(oldWindow);
  if (oldWindow?.halted || oldWindow?.inFlight)
    throw new Error(
      'Audited indexing halted; review durable evidence before resuming',
    );
  if (!pending.length)
    return {
      ...status,
      outcome: 'complete',
      embedded: 0,
      hashes: [],
      usage: { totalTokens: 0 },
      audit: null,
    };
  const batch: [string, string][] = [];
  let inputBytes = 0;
  for (const document of pending) {
    const size = bytes(document[1]);
    if (size > auditIndexLimits.inputBytesPerCall) continue;
    if (
      batch.length === 32 ||
      inputBytes + size > auditIndexLimits.inputBytesPerCall
    )
      break;
    batch.push(document);
    inputBytes += size;
  }
  const stop = (reason: string) => ({
    ...status,
    outcome: 'bounded-stop',
    reason,
    embedded: 0,
    hashes: [],
    usage: { totalTokens: 0 },
    audit: null,
  });
  if (!batch.length)
    return stop('Document exceeds the reviewed input-byte cap');
  if (lease.key !== 'voyage_index_lock' || lease.expiresAt <= now() + 30000)
    throw new Error('Index lease is too close to expiry');
  await pin();
  const reservation = await control.transaction(async (tx) => {
    const previous = await tx.get<WindowState>(windowPath),
      previousRun = await tx.get<RunState>(runPath);
    validateWindow(previous);
    validateRun(previousRun);
    if (previous?.halted || previous?.inFlight)
      throw new Error(
        'Audited indexing halted; review durable evidence before resuming',
      );
    if (
      previous &&
      previous.id !== windowId &&
      Date.parse(previous.until) > now()
    )
      throw new Error('A different indexing window is active');
    if (
      previous?.id === windowId &&
      (previous.until !== input.window.until ||
        previous.maxCalls !== input.window.maxCalls)
    )
      throw new Error('Durable window identity mismatch');
    const window: WindowState =
      previous?.id === windowId
        ? previous
        : {
            id: windowId,
            until: input.window.until,
            maxCalls: input.window.maxCalls,
            calls: 0,
            tokens: 0,
            halted: false,
            inFlight: '',
            lastStartAt: 0,
            recent: [],
          };
    const run: RunState = previousRun ?? {
      windowId,
      profile,
      checkpoint: input.checkpointSha256,
      calls: 0,
      inputBytes: 0,
      tokens: 0,
      accountedAttempt: 0,
    };
    if (
      run.windowId !== windowId ||
      run.profile !== profile ||
      run.checkpoint !== input.checkpointSha256
    )
      throw new Error(
        'Run identity cannot be reused for another snapshot/window',
      );
    if (Date.parse(window.until) <= now())
      throw new Error('Indexing window expired');
    if (
      window.calls >= window.maxCalls ||
      run.calls >= auditIndexLimits.callsPerRun ||
      run.inputBytes + inputBytes > auditIndexLimits.inputBytesPerRun ||
      run.tokens + inputBytes > auditIndexLimits.observedTokensPerRun ||
      window.tokens + inputBytes >
        input.window.maxCalls * auditIndexLimits.inputBytesPerCall
    )
      return null;
    const recent = window.recent.filter((r) => r.at > now() - 60000);
    if (
      (window.lastStartAt &&
        now() - window.lastStartAt < auditIndexLimits.intervalMs) ||
      recent.reduce((n, r) => n + r.tokens, 0) + inputBytes >
        auditIndexLimits.rollingTokens
    )
      return null;
    const attempt = run.calls + 1,
      flight = `${input.runId}:${attempt}`;
    tx.set(windowPath, {
      ...window,
      calls: window.calls + 1,
      inFlight: flight,
      lastStartAt: now(),
      recent: [...recent, { flight, at: now(), tokens: inputBytes }],
    });
    tx.set(runPath, {
      ...run,
      calls: attempt,
      inputBytes: run.inputBytes + inputBytes,
    });
    return { attempt, flight };
  });
  if (!reservation) return stop('Run/window budget or pacing limit reached');
  const prefix = `embedding-audit/staging/${windowId}/${input.runId}/${reservation.attempt}`,
    keys: string[] = [];
  let tokens = 0,
    providerAttempted = false,
    credentialSuppressed = false,
    responseStatus: number | null = null;
  const write = async (kind: string, value: unknown) => {
    const key = `${prefix}-${kind}.json`;
    await blobs.putImmutable(key, JSON.stringify(value));
    keys.push(key);
    return key;
  };
  const settle = async (halted: boolean) =>
    control.transaction(async (tx) => {
      const window = await tx.get<WindowState>(windowPath),
        run = await tx.get<RunState>(runPath);
      if (
        !window ||
        !run ||
        window.id !== windowId ||
        run.windowId !== windowId ||
        window.inFlight !== reservation.flight
      )
        throw new Error('Indexing reservation changed');
      const additional =
        run.accountedAttempt < reservation.attempt ? tokens : 0;
      tx.set(windowPath, {
        ...window,
        tokens: window.tokens + additional,
        halted: window.halted || halted,
        inFlight: halted ? window.inFlight : '',
        recent: window.recent.map((r) =>
          r.flight === reservation.flight ? { ...r, tokens } : r,
        ),
      });
      tx.set(runPath, {
        ...run,
        tokens: run.tokens + additional,
        accountedAttempt: reservation.attempt,
      });
    });
  try {
    const capture: typeof fetch = async (url, init) => {
      if (
        typeof init?.body === 'string' &&
        !auditPayloadIsSafe(encoder.encode(init.body), secrets)
      )
        credentialSuppressed = true;
      if (
        providerAttempted ||
        url !== 'https://api.voyageai.com/v1/embeddings' ||
        typeof init?.body !== 'string' ||
        bytes(init.body) > 100000 ||
        credentialSuppressed
      )
        throw new Error('Provider request rejected');
      await write('request', {
        profile,
        deploymentRevision: deps.revision,
        window: input.window,
        runId: input.runId,
        checkpointSha256: input.checkpointSha256,
        hashes: batch.map(([hash]) => hash),
        body: init.body,
        sha256: await auditDigest(init.body),
        at: new Date(now()).toISOString(),
        inputBytes,
      });
      if (
        init.signal?.aborted ||
        now() >= Date.parse(input.window.until) ||
        lease.expiresAt <= now() + 30000
      )
        throw new Error('Indexing deadline expired');
      providerAttempted = true;
      let response: Response | undefined,
        raw = new Uint8Array(0),
        complete = false;
      try {
        response = await fetcher(url, init);
        responseStatus = response.status;
        const reader = response.body?.getReader(),
          chunks: Uint8Array[] = [];
        let length = 0;
        if (reader)
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              const remaining = auditIndexLimits.responseBytes - length;
              chunks.push(value.subarray(0, Math.max(0, remaining)));
              length += Math.min(value.byteLength, remaining);
              if (value.byteLength > remaining)
                throw new Error('Provider response exceeds cap');
            }
          } finally {
            raw = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
              raw.set(chunk, offset);
              offset += chunk.length;
            }
            await reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
        complete = true;
        if (!auditPayloadIsSafe(raw, secrets))
          throw new Error('Credential reflection suppressed');
        await write('response', {
          status: response.status,
          complete,
          at: new Date(now()).toISOString(),
          bytes: raw.length,
          sha256: await auditDigest(raw),
          encoding: 'base64',
          body: base64(raw),
        });
        return new Response(raw, {
          status: response.status,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch {
        const safe = auditPayloadIsSafe(raw, secrets);
        credentialSuppressed ||= !safe;
        await write('partial', {
          status: response?.status ?? null,
          complete: false,
          receivedCompleteBody: complete,
          credentialSuppressed: !safe,
          at: new Date(now()).toISOString(),
          bytes: raw.length,
          ...(safe
            ? {
                sha256: await auditDigest(raw),
                encoding: 'base64',
                body: base64(raw),
              }
            : {}),
        }).catch(() => undefined);
        throw new Error('Provider capture failed');
      }
    };
    const result = await embedWithVoyageDetailed(
      config,
      batch.map(([, text]) => text),
      'document',
      capture,
    );
    tokens = result.usage.totalTokens;
    await write('receipt', {
      status: responseStatus,
      hashes: batch.map(([hash]) => hash),
      usage: result.usage,
      providerResponseSha256: result.rawResponseSha256,
      at: new Date(now()).toISOString(),
    });
    // This is an observed-token stop, not a guarantee of exact pre-call billing.
    const run = await control.get<RunState>(runPath),
      window = await control.get<WindowState>(windowPath);
    if (
      !run ||
      !window ||
      run.tokens + tokens > auditIndexLimits.observedTokensPerRun ||
      window.tokens + tokens >
        input.window.maxCalls * auditIndexLimits.inputBytesPerCall
    )
      throw new Error('Observed token threshold crossed');
    await pin();
    await store.saveVoyageVectors(
      profile,
      batch.map(([hash], i) => ({ hash, vector: result.vectors[i] })),
      lease,
    );
    const saved = await store.voyageVectorsByHash(
      profile,
      batch.map(([hash]) => hash),
      config.dimensions,
    );
    for (let i = 0; i < batch.length; i++)
      if (
        JSON.stringify(saved.get(batch[i][0])) !==
        JSON.stringify(result.vectors[i])
      )
        throw new Error('Vector publication readback mismatch');
    await write('published', {
      at: new Date(now()).toISOString(),
      hashes: batch.map(([hash]) => hash),
      responseSha256: result.rawResponseSha256,
      usage: result.usage,
    });
    await settle(false);
    return {
      ...status,
      outcome: pending.length === batch.length ? 'complete' : 'progress',
      indexed: cached.size + batch.length,
      pending: pending.length - batch.length,
      embedded: batch.length,
      hashes: batch.map(([hash]) => hash),
      usage: result.usage,
      audit: {
        keys,
        responseSha256: result.rawResponseSha256,
        runId: input.runId,
        attempt: reservation.attempt,
        providerAttempted,
        inputBytes,
      },
    };
  } catch {
    await settle(true).catch(() => undefined); // An unavailable write leaves inFlight set.
    await write('failure', {
      at: new Date(now()).toISOString(),
      providerAttempted,
      status: responseStatus,
      observedTokens: tokens,
      credentialSuppressed,
      complete: false,
      reason: 'Indexing/capture/publication failed; no retry attempted',
    }).catch(() => undefined);
    throw new Error(
      'Audited indexing halted; review durable evidence before resuming',
    );
  }
}
