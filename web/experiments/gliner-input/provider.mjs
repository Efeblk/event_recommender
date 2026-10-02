import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const web = resolve(import.meta.dirname, '../..');
export const work = resolve(web, 'work/gliner-input-20261001');
const sha = value => createHash('sha256').update(value).digest('hex');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
export const ledgerPath = resolve(work, 'provider-ledger.jsonl');
export async function entries() {
  try { return (await readFile(ledgerPath, 'utf8')).split('\n').filter(Boolean).map(JSON.parse); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
export async function summary() {
  const ledger = await entries();
  const reserved = ledger.filter(row => row.type === 'reserved');
  const complete = ledger.filter(row => row.type === 'complete');
  const authorization = await readJson(resolve(work, 'authorization.json'));
  const inputTokens = complete.reduce((total, row) => total + (row.usage?.input_tokens ?? 0), 0);
  const reservedUsd = reserved.reduce((total, row) => total + row.reservedUsd, 0);
  return {
    attemptedJevCalls: reserved.length, completedJevCalls: complete.length,
    failedJevCalls: ledger.filter(row => row.type === 'failed').length,
    inputTokens, listPriceUsd: inputTokens * authorization.jevInputUsdPerMillion / 1e6,
    reservedUsd, cumulativeReservedUsd: authorization.previousReservedUsd + reservedUsd,
    cumulativeListPriceUsd: authorization.previousListPriceUsd + inputTokens * authorization.jevInputUsdPerMillion / 1e6,
    cumulativeReservationCapUsd: authorization.cumulativeReservationCapUsd,
    creditBalanceVerified: false, actualBillingVerified: false,
    hostingExcluded: true, voyageCalls: 0, retries: 0,
  };
}
async function apiKey() {
  let key = process.env.TYPESAFE_API_KEY?.trim();
  for (const name of ['.dev.vars', '.env.staging.local', '.env.local']) {
    if (key) break;
    try { key = parseEnv(await readFile(resolve(web, name), 'utf8')).TYPESAFE_API_KEY?.trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(key, 'Missing local TypeSafe credentials.');
  return key;
}
let running = false;
let lastStart = 0;
export async function callJev(request, identity, captureDir) {
  assert.equal(running, false, 'Only one evaluation request may run at a time.');
  running = true;
  try {
    const authorizationRaw = await readFile(resolve(work, 'authorization.json'));
    const authorization = JSON.parse(authorizationRaw);
    assert.equal(authorization.authorizationStatus, 'authorized-by-existing-user-instructions');
    assert.equal(request.model, 'jev-1.13.0');
    assert.deepEqual(Object.keys(request).sort(), ['model', 'questions', 'state']);
    const questionCount = Object.keys(request.questions).length;
    assert.ok(questionCount > 0 && questionCount <= 63);
    const body = JSON.stringify(request);
    assert.ok(Buffer.byteLength(body) <= 100000, 'Request byte ceiling.');
    assert.ok(!/(?:semanticExpected|sourceSpansGold|expectedTypedFacts|goldIntent)/.test(body), 'Gold must not enter provider state.');
    const previous = await entries();
    assert.ok(!previous.some(row => row.type === 'failed'), 'Provider failure is preserved; stop this evaluation without retry.');
    const reservations = previous.filter(row => row.type === 'reserved');
    const ordinal = reservations.length + 1;
    assert.ok(ordinal <= authorization.maximumJevCalls);
    const main = reservations.filter(row => row.cohort !== 'final-confirmation').length;
    if (identity.cohort !== 'final-confirmation') assert.ok(main < authorization.maximumMainJevCalls, 'Final confirmation calls are reserved.');
    const reservedUsd = authorization.perCallReservationUsd;
    const phaseReservation = reservations.reduce((total, row) => total + row.reservedUsd, 0) + reservedUsd;
    assert.ok(phaseReservation <= authorization.maximumAdditionalReservationUsd + 1e-9);
    assert.ok(phaseReservation + authorization.previousReservedUsd <= authorization.cumulativeReservationCapUsd + 1e-9);
    const priorReceiptRaw = await readFile(resolve(web, authorization.previousReceipt));
    assert.equal(sha(priorReceiptRaw), authorization.previousReceiptSha256, 'Previous cost ledger receipt changed.');
    const wait = Math.max(0, authorization.minimumRequestSpacingMs - (Date.now() - lastStart));
    if (wait) await new Promise(done => setTimeout(done, wait));
    const key = await apiKey();
    await mkdir(captureDir, { recursive: true });
    await writeFile(resolve(captureDir, 'request.json'), JSON.stringify(request, null, 2), { flag: 'wx' });
    const reservation = { at: new Date().toISOString(), provider: 'jev', ordinal, ...identity,
      reservedUsd, requestSha256: sha(body), authorizationSha256: sha(authorizationRaw), requestBytes: Buffer.byteLength(body), questionCount };
    await appendFile(ledgerPath, JSON.stringify({ type: 'reserved', ...reservation }) + '\n');
    lastStart = Date.now();
    const started = performance.now();
    let response, raw;
    try {
      response = await fetch('https://api.typesafe.ai/v1/systemone', {
        method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body, signal: AbortSignal.timeout(10000),
      });
      raw = await response.text();
    } catch (error) {
      await appendFile(ledgerPath, JSON.stringify({ type: 'failed', ...reservation, elapsedMs: performance.now() - started, errorName: error.name }) + '\n');
      throw new Error(`Provider request stopped: ${error.name}`);
    }
    await writeFile(resolve(captureDir, 'response.raw.json'), raw, { flag: 'wx' });
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      await appendFile(ledgerPath, JSON.stringify({ type: 'failed', ...reservation, status: response.status, responseSha256: sha(raw), reason: 'non-json' }) + '\n');
      throw new Error('Provider returned non-JSON; preserved and stopped.');
    }
    const elapsedMs = performance.now() - started;
    const usage = parsed.usage;
    const validUsage = usage && Number.isSafeInteger(usage.input_tokens) && usage.input_tokens >= 0 && usage.input_tokens <= 64000;
    await appendFile(ledgerPath, JSON.stringify({ type: response.ok && validUsage ? 'complete' : 'failed', ...reservation,
      elapsedMs, status: response.status, usage: validUsage ? usage : null, responseSha256: sha(raw) }) + '\n');
    assert.ok(response.ok && validUsage, `Provider HTTP/usage failure ${response.status}; preserved and stopped.`);
    return { response: parsed, elapsedMs, ordinal, requestBytes: Buffer.byteLength(body), questionCount };
  } finally { running = false; }
}
