import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { atomicJson, endpointFor } from "./remote.mjs";

const MAX_DIAGNOSTIC_BYTES = 32 * 1024 * 1024;

function timestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value ? value : null;
}

function contentType(value) {
  const type = String(value ?? "").split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(type) ? type : null;
}

async function boundedBytes(response) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DIAGNOSTIC_BYTES) throw new Error("Diagnostic response exceeded the size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function safeJson(bytes) {
  try { return bytes.length ? JSON.parse(bytes.toString("utf8")) : null; }
  catch { return null; }
}

function summarize(kind, body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  if (kind === "health") return {
    status: typeof body.status === "string" ? body.status : null,
    deployment: {
      environment: typeof body.deployment?.environment === "string" ? body.deployment.environment : null,
      revision: typeof body.deployment?.revision === "string" ? body.deployment.revision : null,
    },
  };
  if (kind === "ready") return {
    ready: body.ready === true,
    reasons: Array.isArray(body.reasons) ? body.reasons.slice(0, 20).map((item) =>
      typeof item === "string" && /^[a-z0-9_:-]{1,80}$/.test(item) ? item : "invalid_reason") : null,
    checkedAt: timestamp(body.checkedAt),
    catalog: { status: typeof body.catalog?.status === "string" ? body.catalog.status : null, stored: Number.isSafeInteger(body.catalog?.stored) ? body.catalog.stored : null, eligible: Number.isSafeInteger(body.catalog?.eligible) ? body.catalog.eligible : null },
    search: { pending: body.search?.pending === false ? false : body.search?.pending === true ? true : null, latestCollectedAt: timestamp(body.search?.latestCollectedAt), activeCollectedAt: timestamp(body.search?.activeCollectedAt) },
    checkpoint: { savedAt: timestamp(body.checkpoint?.savedAt), finishedAt: timestamp(body.checkpoint?.finishedAt), events: Number.isSafeInteger(body.checkpoint?.events) ? body.checkpoint.events : null },
  };
  if (kind === "publication") return {
    schemaVersion: body.schemaVersion === 1 ? 1 : null,
    attemptId: typeof body.attemptId === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(body.attemptId) ? body.attemptId : null,
    deploymentRevision: typeof body.deploymentRevision === "string" ? body.deploymentRevision : null,
    reportFinishedAt: timestamp(body.reportFinishedAt),
    startedAt: timestamp(body.startedAt),
    phase: typeof body.phase === "string" ? body.phase : null,
    sourcesTotal: Number.isSafeInteger(body.sourcesTotal) ? body.sourcesTotal : null,
    sourcesRead: Number.isSafeInteger(body.sourcesRead) ? body.sourcesRead : null,
    events: Number.isSafeInteger(body.events) ? body.events : null,
    searchBytes: Number.isSafeInteger(body.searchBytes) ? body.searchBytes : null,
    checkpointBytes: Number.isSafeInteger(body.checkpointBytes) ? body.checkpointBytes : null,
    elapsedMs: Number.isSafeInteger(body.elapsedMs) ? body.elapsedMs : null,
    phaseStartedElapsedMs: Number.isSafeInteger(body.phaseStartedElapsedMs) && body.phaseStartedElapsedMs >= 0 && body.phaseStartedElapsedMs <= body.elapsedMs ? body.phaseStartedElapsedMs : null,
    outcome: typeof body.outcome === "string" ? body.outcome : null,
    failureCode: typeof body.failureCode === "string" ? body.failureCode : null,
  };
  const events = Array.isArray(body.events) ? body.events : null;
  const validSnapshot = body.schemaVersion === 1 && timestamp(body.savedAt) && timestamp(body.report?.finishedAt) &&
    events && events.length <= 20_000 && events.every((event) => event && typeof event === "object" && !Array.isArray(event)) &&
    body.report?.summary && typeof body.report.summary === "object" && !Array.isArray(body.report.summary);
  return {
    validSnapshot: Boolean(validSnapshot),
    schemaVersion: body.schemaVersion === 1 ? 1 : null,
    savedAt: timestamp(body.savedAt),
    reportFinishedAt: timestamp(body.report?.finishedAt),
    events: events ? events.length : null,
    eventsSha256: events ? createHash("sha256").update(JSON.stringify(events)).digest("hex") : null,
  };
}

export async function collectDiagnostic({ kind, endpoint, token, serverlessToken, fetcher = fetch }) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (serverlessToken) headers["X-Serverless-Authorization"] = `Bearer ${serverlessToken}`;
  const response = await fetcher(endpoint, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  const bytes = await boundedBytes(response);
  const body = safeJson(bytes);
  return {
    schemaVersion: 1,
    kind,
    httpStatus: response.status,
    contentType: contentType(response.headers.get("content-type")),
    bytes: bytes.length,
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
    validJson: body !== null,
    value: summarize(kind, body),
  };
}

export function validateDiagnostics(results, expectedRevision) {
  const health = results.health, ready = results.ready, canonical = results.canonical, publication = results.publication;
  const problems = [];
  if (!(health.httpStatus === 200 && health.validJson && health.value?.status === "ok" &&
    health.value.deployment?.environment === "staging" && health.value.deployment?.revision === expectedRevision)) problems.push("health");
  if (!(ready.httpStatus === 200 && ready.validJson)) problems.push("ready");
  if (!(canonical.httpStatus === 200 && canonical.validJson && canonical.value?.validSnapshot === true && canonical.value?.schemaVersion === 1 &&
    canonical.value.savedAt && canonical.value.reportFinishedAt && Number.isSafeInteger(canonical.value.events) && canonical.value.eventsSha256)) problems.push("canonical");
  if (!(publication.httpStatus === 200 && publication.validJson && publication.value?.schemaVersion === 1 &&
    publication.value.reportFinishedAt && publication.value.startedAt && publication.value.phase && publication.value.outcome)) problems.push("publication");
  return { schemaVersion: 1, completed: true, expectedRevision, problems };
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: "string" }, "expected-revision": { type: "string" }, "allow-loopback-http": { type: "boolean", default: false } } });
  if (!/^[0-9a-f]{40}$/.test(values["expected-revision"] ?? "")) throw new Error("Expected revision is invalid.");
  const { BIPLAN_URL: origin, SYNC_TOKEN: token, SERVERLESS_ID_TOKEN: serverlessToken } = process.env;
  if (!origin || !token || !serverlessToken || !values.output) throw new Error("Diagnostic destination, credentials, and output are required.");
  const results = {};
  for (const [kind, pathname] of [["health", "/api/health"], ["ready", "/api/ready"], ["canonical", "/api/admin/collection"], ["publication", "/api/admin/collection?publication=latest"]]) {
    try { results[kind] = await collectDiagnostic({ kind, endpoint: endpointFor(origin, pathname, values["allow-loopback-http"]), token: ["canonical", "publication"].includes(kind) ? token : undefined, serverlessToken }); }
    catch (error) { results[kind] = { schemaVersion: 1, kind, httpStatus: null, validJson: false, value: null, error: error?.name === "TimeoutError" ? "timeout" : "request_failed" }; }
    await atomicJson(`${values.output}/${kind}.json`, results[kind]);
  }
  const validation = validateDiagnostics(results, values["expected-revision"]);
  await atomicJson(`${values.output}/validation.json`, validation);
  if (validation.problems.length) throw new Error(`Staging diagnostics failed: ${validation.problems.join(",")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
