import assert from 'node:assert/strict';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { GoogleAuth } from 'google-auth-library';

export const MODEL = 'gemini-3.1-flash-lite';
export const PROJECT = 'biplan-staging-efeblk';
export const WORK = resolve(import.meta.dirname, '../../work/semantic-learned-20261001/schema-corrected');
const ENDPOINT = `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/${MODEL}`;
export const CONFIG = { temperature: 1, candidateCount: 1, maxOutputTokens: 900,
  responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'MINIMAL' } };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ledgerPath = resolve(WORK, 'provider-ledger.jsonl');
const tokenLedger = resolve(WORK, 'tokenization-ledger.jsonl');
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
let running = false, lastStart = 0;

// Vertex rejects empty enum members. This reversible transport mapping does not
// change the frozen compiler's meanings or inspect source text/gold labels.
const sentinel = '__none__';
function transportSchema(value) {
  if (Array.isArray(value)) return value.map(transportSchema);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'enum' ? v.map(s => s === '' ? sentinel : s) : transportSchema(v)]));
  return value;
}
function decoded(value) {
  if (Array.isArray(value)) return value.map(decoded);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decoded(v)]));
  return value === sentinel ? '' : value;
}

export async function ledger() {
  try { return (await readFile(ledgerPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

async function headers() {
  const client = await auth.getClient();
  const got = await client.getAccessToken();
  assert.ok(got.token, 'Google ADC authentication is unavailable');
  // Headers/credentials are never written to receipts or printed.
  return { Authorization: `Bearer ${got.token}`, 'x-goog-user-project': PROJECT, 'Content-Type': 'application/json' };
}

export async function callModel(system, user, schema, identity) {
  assert.equal(running, false, 'Sequential bounded inference only'); running = true;
  try {
    const authorizationRaw = await readFile(resolve(WORK, 'authorization.json'));
    const authorization = JSON.parse(authorizationRaw);
    assert.equal(authorization.model, MODEL);
    assert.equal(authorization.project, PROJECT);
    assert.equal(authorization.status, 'authorized-within-existing-cumulative-cap');
    const previousReceipt = await readFile(resolve(import.meta.dirname, '../..', authorization.previousReceipt));
    assert.equal(sha(previousReceipt), authorization.previousReceiptSha256, 'Previous cumulative ledger changed');
    const old = await ledger(), reservations = old.filter((r) => r.type === 'reserved');
    assert.ok(!old.some((r) => r.type === 'failed'), 'Preserved provider failure; no automatic retry');
    assert.ok(!reservations.some((r) => r.id === identity.id), 'Case cannot be retried');
    const ordinal = reservations.length + 1;
    assert.ok(ordinal <= authorization.maximumCalls);
    if (identity.cohort !== 'final-confirmation') assert.ok(reservations.filter((r) => r.cohort !== 'final-confirmation').length < authorization.maximumMainCalls);
    const reserve = authorization.perCallReservationUsd;
    assert.ok(authorization.maximumInputTokens * authorization.inputUsdPerMillion / 1e6
      + CONFIG.maxOutputTokens * authorization.outputUsdPerMillion / 1e6 <= reserve + 1e-12,
    'Worst-case admitted token cost must fit each reservation');
    const currentReserved = reservations.reduce((n, r) => n + r.reservedUsd, 0) + reserve;
    assert.ok(currentReserved <= authorization.maximumAdditionalReservationUsd + 1e-9);
    assert.ok(currentReserved + authorization.previousReservedUsd <= authorization.cumulativeReservationCapUsd + 1e-9);
    const transportSystem = system.replaceAll('""', '"__none__"')
      + '\nTransport only: __none__ represents inapplicable string fields (including blank budget basis). It decodes to the empty string in code. Use the supplied enum members exactly.';
    const request = { systemInstruction: { parts: [{ text: transportSystem }] },
      contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { ...CONFIG, responseSchema: transportSchema(schema) } };
    const body = JSON.stringify(request);
    assert.ok(Buffer.byteLength(body) <= 50000, 'Bounded provider request bytes');
    assert.ok(!/(?:resultingPlan|unresolvedQuotes|semanticExpected|sourceSpansGold|goldIntent)/u.test(user), 'Gold is excluded from model input');
    const capture = resolve(WORK, 'calls', `${String(ordinal).padStart(2, '0')}-${identity.id}`);
    await mkdir(capture, { recursive: true });
    await writeFile(resolve(capture, 'request.json'), `${JSON.stringify(request, null, 2)}\n`, { flag: 'wx' });
    const requestHeaders = await headers();
    // Tokenize the complete serialized request (including schema), with a conservative
    // margin. This is admission estimation, not a claim that it equals billed prompt tokens.
    const countRequest = { contents: [{ role: 'user', parts: [{ text: body }] }] };
    const countedAt = performance.now();
    const counted = await fetch(`${ENDPOINT}:countTokens`, { method: 'POST', headers: requestHeaders,
      body: JSON.stringify(countRequest), signal: AbortSignal.timeout(15000) });
    const countRaw = await counted.text();
    await writeFile(resolve(capture, 'token-count.json'), countRaw, { flag: 'wx' });
    let countResult;
    try { countResult = JSON.parse(countRaw); } catch { throw new Error('Token admission returned non-JSON'); }
    const countMs = performance.now() - countedAt;
    await appendFile(tokenLedger, `${JSON.stringify({ at: new Date().toISOString(), ...identity, http: counted.status,
      countMs, totalTokens: countResult.totalTokens ?? null, tokenCountResponseSha256: sha(countRaw), inference: false })}\n`);
    assert.ok(counted.ok && Number.isSafeInteger(countResult.totalTokens), `Token admission failed (${counted.status}); no inference attempted`);
    const estimatedUpper = countResult.totalTokens + 512;
    assert.ok(estimatedUpper <= authorization.maximumInputTokens, 'Input exceeds bounded token admission');
    const wait = Math.max(0, authorization.minimumSpacingMs - (Date.now() - lastStart));
    if (wait) await new Promise((done) => setTimeout(done, wait));
    const reservation = { at: new Date().toISOString(), ...identity, provider: 'vertex', model: MODEL,
      ordinal, reservedUsd: reserve, estimatedUpperInputTokens: estimatedUpper, requestSha256: sha(body),
      authorizationSha256: sha(authorizationRaw) };
    await appendFile(ledgerPath, `${JSON.stringify({ type: 'reserved', ...reservation })}\n`);
    lastStart = Date.now(); const began = performance.now();
    let response, raw;
    try {
      response = await fetch(`${ENDPOINT}:generateContent`, { method: 'POST', headers: requestHeaders,
        body, signal: AbortSignal.timeout(15000) }); raw = await response.text();
    } catch (error) {
      await appendFile(ledgerPath, `${JSON.stringify({ type: 'failed', ...reservation, elapsedMs: performance.now() - began, errorName: error.name })}\n`);
      throw new Error(`Inference transport failed: ${error.name}; preserved without retry`);
    }
    const elapsedMs = performance.now() - began;
    await writeFile(resolve(capture, 'response.raw.json'), raw, { flag: 'wx' });
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const u = parsed?.usageMetadata;
    const validUsage = u && Number.isSafeInteger(u.promptTokenCount) && Number.isSafeInteger(u.totalTokenCount)
      && u.promptTokenCount >= 0 && u.totalTokenCount >= u.promptTokenCount;
    const inputTokens = validUsage ? u.promptTokenCount : null;
    const outputTokens = validUsage ? u.totalTokenCount - u.promptTokenCount : null;
    const price = validUsage ? (inputTokens * authorization.inputUsdPerMillion + outputTokens * authorization.outputUsdPerMillion) / 1e6 : null;
    const validBounds = validUsage && inputTokens <= authorization.maximumInputTokens && outputTokens <= CONFIG.maxOutputTokens && price <= reserve;
    const completed = response.ok && validBounds;
    await appendFile(ledgerPath, `${JSON.stringify({ type: completed ? 'complete' : 'failed', ...reservation,
      status: response.status, elapsedMs, countMs, inputTokens, outputTokens, thoughtsTokens: u?.thoughtsTokenCount ?? null,
      listPriceUsd: price, usage: u ?? null, finishReason: parsed?.candidates?.[0]?.finishReason ?? null,
      responseSha256: sha(raw) })}\n`);
    assert.ok(completed, `Provider HTTP/usage/bounds failure (${response.status}); captured and stopped`);
    const candidate = parsed.candidates?.[0];
    const text = candidate?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? '').join('') ?? '';
    let wire = null, wireError = null;
    if (candidate?.finishReason !== 'STOP') wireError = `finish_${candidate?.finishReason ?? 'missing'}`;
    else { try { wire = decoded(JSON.parse(text)); } catch { wireError = 'invalid_output_json'; } }
    return { wire, wireError, elapsedMs, countMs, ordinal, inputTokens, outputTokens, listPriceUsd: price, capture };
  } finally { running = false; }
}
