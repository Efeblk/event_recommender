import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { atomicJson, endpointFor, requestJson, validateCollection } from "./remote.mjs";

// Keep source-page work below the Free D1 per-invocation query budget while
// reserving room for lock handling and current-seed database initialization.
export const MAX_IMPORT_PAGES = 3;
export const MAX_IMPORT_EVENTS = 2000;
export const MAX_IMPORT_BYTES = 3_500_000;
export const MAX_SOURCE_PAGE_EVENTS = 1000;
export const MAX_D1_QUERY_BUDGET = 50;

function estimatedUpsertStatements(events, bytes) {
  // Cloudflare starts a new statement at either 100 rows or 500 kB. Adding
  // both ceilings is a conservative upper bound when both limits split the
  // same page. Allow 48 bytes per row for the derived productionKey field.
  return Math.ceil(events / 100) + Math.ceil((bytes + 48 * events) / 500_000);
}

export function shouldFlushImportBatch({ pages, events, bytes, upserts = 0 }, { events: nextEvents, bytes: nextBytes }) {
  const nextUpserts = estimatedUpsertStatements(nextEvents, nextBytes);
  // 11 fixed steady-state queries (schema/existing-seed/lease) and six per
  // source page. Initial seed installation is a separate, pre-existing cost.
  const queries = 11 + 6 * (pages + 1) + upserts + nextUpserts;
  return pages >= MAX_IMPORT_PAGES || events + nextEvents > MAX_IMPORT_EVENTS ||
    bytes + nextBytes > MAX_IMPORT_BYTES || queries > MAX_D1_QUERY_BUDGET;
}

export function prepareImportPages(pages, now = new Date()) {
  const cutoff = now.getTime();
  const omittedExpiredIds = [];
  const prepared = [];
  for (const page of pages) {
    if ((page.retiredAt !== undefined && page.quarantinedAt !== undefined) ||
        (page.events.length && (page.retiredAt !== undefined || page.quarantinedAt !== undefined || page.quarantineReason !== undefined)) ||
        (page.quarantinedAt !== undefined && page.quarantineReason !== 'session_time_conflict') ||
        (page.quarantineReason !== undefined && page.quarantinedAt === undefined))
      throw new Error('Invalid empty source state');
    const events = page.events.filter((event) => {
      const expired = Number.isFinite(Date.parse(event.startsAt)) && Date.parse(event.startsAt) < cutoff;
      if (expired) omittedExpiredIds.push(event.id);
      return !expired;
    });
    if (events.length) prepared.push({ url: page.url, events });
    else if (page.events.length === 0 && page.retiredAt)
      prepared.push({ url: page.url, events: [], retiredAt: page.retiredAt });
    else if (page.events.length === 0 && page.quarantinedAt)
      prepared.push({ url: page.url, events: [], quarantinedAt: page.quarantinedAt, quarantineReason: page.quarantineReason });
  }
  return { pages: prepared, omittedExpiredIds };
}

export async function publish({ origin, token, report, checkpoint = false, snapshot, allowLoopbackHttp = false, now = () => new Date() }) {
  const importEndpoint = endpointFor(origin, "/api/admin/import", allowLoopbackHttp);
  if (report.schemaVersion !== 1 || report.summary?.blocked || !report.pages?.length)
    throw new Error("Only a validated, successful collection can be imported.");
  const prepared = prepareImportPages(report.pages, now());
  if (!prepared.pages.length)
    throw new Error("No future event sessions remain importable; checkpoint was not advanced.");
  const sizedPages = prepared.pages.map((page) => ({
    page,
    bytes: Buffer.byteLength(JSON.stringify(page)),
  }));
  for (const item of sizedPages) {
    if (item.bytes > MAX_IMPORT_BYTES) throw new Error("A source page exceeds the import limit.");
    if (item.page.events.length > MAX_SOURCE_PAGE_EVENTS) throw new Error("A source page exceeds the event import limit.");
  }
  let batch = [], bytes = 0, batchEvents = 0, batchUpserts = 0, imported = 0, sentBatches = 0, omittedCount = 0;
  const omittedIds = [];
  function recordOmissions(ids) {
    omittedCount += ids.length;
    omittedIds.push(...ids.slice(0, Math.max(0, 100 - omittedIds.length)));
  }
  recordOmissions(prepared.omittedExpiredIds);
  async function send() {
    if (!batch.length) return;
    const current = prepareImportPages(batch, now());
    recordOmissions(current.omittedExpiredIds);
    batch = [];
    bytes = 0;
    batchEvents = 0;
    batchUpserts = 0;
    if (!current.pages.length) return;
    const { response, result } = await requestJson(importEndpoint, { token, method: "POST", body: { schemaVersion: 1, pages: current.pages } });
    if (!response.ok) throw new Error(`Import returned HTTP ${response.status}; checkpoint was not advanced.`);
    imported += Number(result?.imported ?? 0);
    sentBatches += 1;
  }
  for (const { page: minimal, bytes: size } of sizedPages) {
    if (shouldFlushImportBatch(
      { pages: batch.length, events: batchEvents, bytes, upserts: batchUpserts },
      { events: minimal.events.length, bytes: size },
    )) await send();
    batch.push(minimal);
    bytes += size;
    batchEvents += minimal.events.length;
    batchUpserts += estimatedUpsertStatements(minimal.events.length, size);
  }
  await send();
  if (!sentBatches)
    throw new Error("No future event sessions remain importable; checkpoint was not advanced.");
  const omission = { count: omittedCount, ids: omittedIds };
  if (!checkpoint) return { imported, checkpointed: false, omittedExpired: omission };

  const collectionEndpoint = endpointFor(origin, "/api/admin/collection", allowLoopbackHttp);
  const expectedSources = Object.keys(report.summary.sources ?? {});
  const refreshedBySource = Object.fromEntries(expectedSources.map((source) => [source, report.pages.filter((page) => page.source === source).length]));
  const missingSources = expectedSources.filter((source) => refreshedBySource[source] === 0);
  const summary = { ...report.summary, missingSources, sourceHealth: { refreshedPages: refreshedBySource } };
  const saved = await requestJson(collectionEndpoint, { token, method: "POST", body: { schemaVersion: 1, report: { finishedAt: report.finishedAt, summary } } });
  if (!saved.response.ok) throw new Error(`Checkpoint save returned HTTP ${saved.response.status}.`);
  if (saved.result?.schemaVersion !== 1 || typeof saved.result.savedAt !== "string" || !Number.isFinite(Date.parse(saved.result.savedAt)) || !Number.isInteger(saved.result.events) || saved.result.events < 0 || saved.result.events > 20_000)
    throw new Error("Checkpoint save returned an invalid receipt.");
  const readback = await requestJson(collectionEndpoint, { token, timeout: 30_000 });
  if (!readback.response.ok) throw new Error(`Checkpoint readback returned HTTP ${readback.response.status}.`);
  const canonical = validateCollection(readback.result);
  if (canonical.savedAt !== saved.result.savedAt || canonical.events.length !== saved.result.events)
    throw new Error("Checkpoint readback does not match the save receipt.");
  if (Date.parse(canonical.report.finishedAt) < Date.parse(report.finishedAt))
    throw new Error("Checkpoint readback predates the submitted collection report.");
  const health = await requestJson(endpointFor(origin, "/api/health", allowLoopbackHttp), { timeout: 15_000 });
  const deployment = health.result?.deployment;
  if (!health.response.ok || health.result?.status !== "ok" || !["local", "staging", "production"].includes(deployment?.environment) || (deployment.environment !== "local" && !/^[0-9a-f]{40}$/.test(deployment.revision ?? "")))
    throw new Error("Post-checkpoint Worker identity is invalid.");
  if (snapshot) await atomicJson(snapshot, canonical.events);
  return { imported, checkpointed: true, canonicalReadback: true, artifactOnly: false, savedAt: canonical.savedAt, events: canonical.events.length, environment: deployment.environment, revision: deployment.revision ?? null, omittedExpired: omission };
}

async function main() {
  const { values } = parseArgs({ options: { report: { type: "string" }, receipt: { type: "string" }, checkpoint: { type: "boolean", default: false }, snapshot: { type: "string", default: "state/events.json" }, "allow-loopback-http": { type: "boolean", default: false } } });
  const { BIPLAN_URL: origin, SYNC_TOKEN: token } = process.env;
  if (!origin || !token) throw new Error("Set BIPLAN_URL and SYNC_TOKEN in the runner secret store.");
  endpointFor(origin, "/api/admin/import", values["allow-loopback-http"]);
  const reportPath = values.report ? resolve(values.report) : new URL("./output/report.json", import.meta.url);
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const result = await publish({ origin, token, report, checkpoint: values.checkpoint, snapshot: values.checkpoint ? resolve(values.snapshot) : undefined, allowLoopbackHttp: values["allow-loopback-http"] });
  if (values.receipt) await atomicJson(resolve(values.receipt), result);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
