import { BasicCrawler, Configuration, NonRetryableError } from "@crawlee/basic";
import { load } from "cheerio";
import robotsParser from "robots-parser";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { sources, detailUrl, resolveListings } from "./adapters.mjs";
import { extractListings, listingToEvent } from './extract/index.mjs';
import { createFilesystemRawStore, DEFAULT_RAW_MAX_BYTES } from './raw/store.mjs';
import { retainProviderResponse } from './raw/fetch.mjs';
import { buildRawCollectionManifest } from './raw/collection.mjs';
import { createGcsRawMirror, STAGING_RAW_BUCKET, STAGING_RAW_PREFIX } from './raw/gcs.mjs';
import {
  sha,
  validateEvent,
  reconcile,
  publicationGate,
  readSnapshot,
  atomicJson,
} from "./pipeline.mjs";

import { expandListing } from "./discovery.mjs";
import { followDetailRedirects } from "./redirects.mjs";
import {
  addCoverageEntries,
  checkpointCoverageEvents,
  coverageBySource,
  fairCoverageOrder,
  normalizeCoverage,
  recordCoverageAttempt,
  serializedCheckpointWriter,
  recoverCoverageEvents,
  unpublishedCoveragePages,
  verifyCompletePage,
} from "./coverage.mjs";
import {
  attachCollectionCycle, bindCollectionListingConfig, collectionCycleEvidence, collectionCycleInventory,
  collectionCycleInventoryComplete, recordCollectionCycleObservation,
} from './collection-scope.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    sources: { type: "string", default: "biletinial,bubilet,biletix" },
    url: { type: "string", multiple: true },
    limit: { type: "string" },
    "max-details": { type: "string", default: "2000" },
    "max-http": { type: "string", default: "6000" },
    "max-minutes": { type: "string", default: "50" },
    coverage: { type: "string" },
    "discovery-pages": { type: "string", default: "20" },
    "discover-only": { type: "boolean", default: false },
    output: { type: "string", default: join(root, "output") },
    snapshot: { type: "string", default: join(root, "../web/data/events.json") },
    "save-html": { type: "boolean", default: false },
    "raw-directory": { type: "string" },
    "raw-max-bytes": { type: "string", default: String(DEFAULT_RAW_MAX_BYTES) },
    "cycle-id": { type: "string" },
    "cycle-scope": { type: "string" },
    "cycle-started-at": { type: "string" },
    "horizon-start": { type: "string" },
    "horizon-end": { type: "string" },
    geography: { type: "string" },
    "listing-config-hash": { type: "string" },
    "begin-cycle": { type: "boolean", default: false },
  },
});
const selected = [...new Set(values.sources.split(","))];
if (selected.some((name) => !sources[name])) throw new Error("Unknown source");
const cycleFields = ["cycle-id", "cycle-scope", "cycle-started-at", "geography", "listing-config-hash"];
const suppliedCycleFields = cycleFields.filter(field => values[field] !== undefined);
if (suppliedCycleFields.length !== 0 && suppliedCycleFields.length !== cycleFields.length)
  throw new Error('Explicit collection cycle requires every scope field');
if (!suppliedCycleFields.length && (values['begin-cycle'] || values['horizon-start'] !== undefined || values['horizon-end'] !== undefined))
  throw new Error('Collection cycle controls require an explicit cycle scope');
const explicitCycle = suppliedCycleFields.length ? {
  schemaVersion: 2,
  collectionRunId: values['cycle-id'],
  scope: values['cycle-scope'],
  providers: [...selected].sort(),
  horizonStart: values['cycle-scope'] === 'legacy_incremental' ? null : values['horizon-start'],
  horizonEnd: values['cycle-scope'] === 'legacy_incremental' ? null : values['horizon-end'],
  startedAt: values['cycle-started-at'],
  scopeEvidence: { geography: values.geography, listingConfigHash: values['listing-config-hash'] },
} : null;
if (explicitCycle?.scope === 'legacy_incremental' && (values['horizon-start'] !== undefined || values['horizon-end'] !== undefined))
  throw new Error('Legacy incremental collection cannot declare a horizon');
if (explicitCycle && explicitCycle.scope !== 'legacy_incremental' &&
    (values['horizon-start'] === undefined || values['horizon-end'] === undefined))
  throw new Error('Full and incremental collection cycles require both horizon bounds');
if (explicitCycle?.scope === 'full' && (values.url?.length || values['discover-only']))
  throw new Error('Full collection cycles require listing discovery and complete detail traversal');
if (values.limit !== undefined && values["max-details"] !== "2000")
  throw new Error("Use either --limit or --max-details, not both");
const maxDetails = Number(values.limit ?? values["max-details"]);
if (!Number.isInteger(maxDetails) || maxDetails < 1 || maxDetails > 10000)
  throw new Error("Detail limit must be 1–10000 per run");
const maxHttp = Number(values["max-http"]), maxMinutes = Number(values["max-minutes"]);
if (!Number.isInteger(maxHttp) || maxHttp < 1 || maxHttp > 30000) throw new Error("HTTP limit must be 1–30000 per run");
if (!Number.isInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 55) throw new Error("Time limit must be 1–55 minutes");
const maxPages = Number(values["discovery-pages"]);
if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50)
  throw new Error("Discovery pages must be 1–50");
const output = resolve(values.output),
  snapshot = resolve(values.snapshot);
const coveragePath = resolve(values.coverage ?? join(dirname(snapshot), "coverage.json"));
await mkdir(output, { recursive: true });
await mkdir(dirname(snapshot), { recursive: true });
const rawMirror = process.env.BIPLAN_RAW_GCS_ENABLED === 'true'
  ? createGcsRawMirror({ bucket: process.env.BIPLAN_RAW_GCS_BUCKET ?? STAGING_RAW_BUCKET,
    prefix: process.env.BIPLAN_RAW_GCS_PREFIX ?? STAGING_RAW_PREFIX,
    accessToken: async () => process.env.BIPLAN_RAW_GCS_ACCESS_TOKEN }) : undefined;
const rawStore = await createFilesystemRawStore(resolve(values['raw-directory'] ?? join(dirname(snapshot), 'raw')),
  { maxBytes: Number(values['raw-max-bytes']), mirror: rawMirror });
const rawResponses = new Map();
let rawResponseMemory = 0;
function rememberRawResponse(url, retained) {
  rawResponseMemory -= (rawResponses.get(url)?.body.length ?? 0) * 2;
  rawResponses.delete(url);
  rawResponses.set(url, retained);
  rawResponseMemory += retained.body.length * 2;
  // Raw bytes are durable on disk. Only a small working set belongs in memory.
  while (rawResponseMemory > 32 * 1024 * 1024 && rawResponses.size > 1) {
    const oldest = rawResponses.keys().next().value;
    rawResponseMemory -= rawResponses.get(oldest).body.length * 2;
    rawResponses.delete(oldest);
  }
}
const retainedResponses = new WeakMap();
const rawFetches = [];
const providerListings = new Map();
const rawPages = new Map();
if (values["save-html"]) await mkdir(join(output, "html"), { recursive: true });
const startedAt = new Date().toISOString();
const report = {
  schemaVersion: 1,
  startedAt,
  finishedAt: null,
  pages: [],
  listings: [],
  failures: [],
  quarantined: [],
  summary: {},
};
const snapshotEvents = await readSnapshot(snapshot);
let coverage;
try { coverage = normalizeCoverage(JSON.parse(await readFile(coveragePath, "utf8"))); }
catch (error) { if (error.code !== "ENOENT") throw error; coverage = normalizeCoverage(null); }
const cycleAttachment = attachCollectionCycle(coverage, explicitCycle, { begin: values['begin-cycle'] });
coverage = cycleAttachment.state;
const collectionCycle = cycleAttachment.cycle;
const previous = recoverCoverageEvents(snapshotEvents, coverage, validateEvent);
report.pages = unpublishedCoveragePages(snapshotEvents, coverage, validateEvent);
const snapshotVersions = new Set(snapshotEvents.map((event) => `${event.id}|${event.checkedAt}`));
const resumedEvents = previous.filter((event) => !snapshotVersions.has(`${event.id}|${event.checkedAt}`));
// Both crawler handlers may finish together. Serialize full-state snapshots so
// neither can rename the other's temporary file or overwrite newer progress.
const saveCoverage = serializedCheckpointWriter(() => atomicJson(coveragePath, coverage));
const targets = values.url ?? [];
if (targets.length && values["discover-only"])
  throw new Error("Use --url for detail refresh, not discovery");
for (const url of targets)
  if (!selected.some((source) => detailUrl(url, source))) throw new Error("Unsupported target URL");
const userAgent = "BiPlan/0.2 (+https://github.com/Efeblk/event_recommender)";
const robots = new Map();
let nextNetworkSlot = 0;
let httpRequests = 0, activeCrawler = null, budgetStop = null;
const enqueued = new Set();
const attemptedUrls = new Set(), verifiedUrls = new Set();
function upsertReportPage(page) {
  const index = report.pages.findIndex((candidate) => candidate.url === page.url);
  if (index >= 0) report.pages[index] = page;
  else report.pages.push(page);
}
function recordCycleObservation(url, status, attemptedAt) {
  if (collectionCycle) recordCollectionCycleObservation(coverage, url, { status, attemptedAt });
}
const headers = { "User-Agent": userAgent, "Accept-Language": "tr-TR,tr;q=0.9" };
async function get(url, options = {}, isRobots = false) {
  const { detailRedirectSource = null, ...fetchOptions } = options;
  const request = async (currentUrl) => {
    if (httpRequests >= maxHttp) {
      budgetStop = "http_budget";
      void activeCrawler?.autoscaledPool?.abort();
      throw new NonRetryableError("http_budget_exhausted");
    }
    httpRequests += 1;
    const origin = new URL(currentUrl).origin;
    if (!allowedOrigins.has(origin)) throw new NonRetryableError("origin_not_allowed");
    if (!isRobots) {
      if (!robots.has(origin)) await loadRobots(origin);
      if (!robots.get(origin)?.isAllowed(currentUrl, "BiPlan"))
        throw new NonRetryableError("robots_disallowed");
    }
    const slot = Math.max(Date.now(), nextNetworkSlot);
    nextNetworkSlot = slot + 1000;
    await delay(Math.max(0, slot - Date.now()));
    const response = await fetch(currentUrl, {
      ...fetchOptions,
      headers: { ...headers, ...fetchOptions.headers },
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    const { receipt, body, bodyError } = await retainProviderResponse(response,
      { url: currentUrl, method: fetchOptions.method ?? 'GET', fetchedAt: new Date().toISOString(),
        collectorRevision: process.env.BIPLAN_COLLECTOR_REVISION ?? process.env.GITHUB_SHA ?? 'local-uncommitted' },
      rawStore, isRobots ? 256000 : 4000000);
    rawFetches.push(receipt);
    const retained = { body, rawObjectRef: receipt.rawObjectRef,
      fetchedAt: receipt.metadata.fetchedAt, url: currentUrl };
    retainedResponses.set(response, retained);
    rememberRawResponse(currentUrl, retained);
    if (bodyError) throw bodyError.message === 'response_too_large' ? new NonRetryableError(bodyError.message) : bodyError;
    return response;
  };
  let response;
  try {
    response = detailRedirectSource
      ? (await followDetailRedirects({
          initialUrl: url, source: detailRedirectSource, request, detailUrl,
        })).response
      : await request(url);
  } catch (error) {
    if (error instanceof NonRetryableError) throw error;
    if (typeof error?.message === "string" &&
        (error.message.startsWith("redirect_") || error.message.includes(":redirect_")))
      throw new NonRetryableError(error.message);
    throw error;
  }
  if (isRobots && response.status === 404) {
    await response.body?.cancel();
    return "";
  }
  if (!response.ok) {
    const status = response.status;
    const retryAfter = Math.min(30, Number(response.headers.get("retry-after")) || 3);
    await response.body?.cancel();
    if (status === 429 || status >= 500) {
      await delay(retryAfter * 1000);
      throw new Error(`http_${status}`);
    }
    throw new NonRetryableError(`http_${status}`);
  }
  const retained = retainedResponses.get(response);
  rememberRawResponse(url, retained);
  return retained.body;
}
const allowedOrigins = new Set([
  ...Object.values(sources).map((s) => s.origin),
  "https://platform.api.bubilet.com.tr",
]);
async function loadRobots(origin) {
  const url = `${origin}/robots.txt`;
  robots.set(origin, robotsParser(url, await get(url, {}, true)));
}
// Fetch policies using our own user agent; fail closed on inaccessible robots files.
const seeds = [];
const resolvedListings = new Map();
for (const name of selected) {
  const source = sources[name],
    url = `${source.origin}/robots.txt`;
  let setupStage = 'robots';
  try {
    await loadRobots(source.origin);
    setupStage = 'taxonomy';
    const listings = targets.length ? [] : await resolveListings(name, get);
    resolvedListings.set(name, listings);
    for (const [path, category] of listings)
      seeds.push({
        url: source.origin + path,
        userData: { source: name, category, kind: "listing" },
      });
    // Previously known productions are revisited even if no longer promoted on listings.
    const known = targets.length
      ? targets.map((url) => ({
          url,
          category:
            previous.find((e) => e.url === url)?.category ??
            (/\/muzik\//.test(url) ? "Konser" : /\/tiyatro\//.test(url) ? "Tiyatro" : null),
        }))
      : values["discover-only"]
        ? []
        : previous;
    const knownCoverage = [];
    for (const event of known) {
      const detail = detailUrl(event.url, name);
      if (detail) knownCoverage.push({ url: detail, source: name, category: event.category, lastSuccessAt: event.checkedAt });
    }
    addCoverageEntries(coverage, knownCoverage);
  } catch (error) {
    report.failures.push({ source: name, url: setupStage === 'robots' ? url : source.origin, reason: `${setupStage}_unavailable:${error.message}` });
  }
}
if (collectionCycle) bindCollectionListingConfig(collectionCycle, resolvedListings, sources);
await saveCoverage();
if (!values["discover-only"] && targets.length) {
  const targetSet = targets.length ? new Set(targets.map((url) => new URL(url).href)) : null;
  const ordered = fairCoverageOrder(coverage, selected, undefined, undefined, collectionCycle?.collectionRunId ?? null)
    .filter((entry) => !targetSet || targetSet.has(entry.url));
  for (const entry of ordered) {
    enqueued.add(entry.url);
    seeds.push({ url: entry.url, userData: { source: entry.source, category: entry.category, kind: "event" } });
  }
}
const pendingListings = new Set(seeds.filter((seed) => seed.userData.kind === "listing").map((seed) => seed.url));
let detailsScheduled = targets.length > 0;
async function scheduleCoverageDetails(active) {
  if (detailsScheduled || values["discover-only"] || pendingListings.size) return;
  detailsScheduled = true;
  const candidates = fairCoverageOrder(coverage, selected, undefined, undefined, collectionCycle?.collectionRunId ?? null)
    .filter(({ url }) => !enqueued.has(url));
  for (const { url } of candidates) enqueued.add(url);
  await active.addRequests(candidates.map((entry) => ({ url: entry.url, userData: { source: entry.source, category: entry.category, kind: "event" } })));
}
const config = new Configuration({
  storageClientOptions: { localDataDirectory: join(output, "queue") },
  purgeOnStart: true,
  persistStorage: true,
});
const crawler = new BasicCrawler(
  {
    maxConcurrency: 2,
    maxRequestsPerMinute: 60,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 1200,
    // Listing requests do not consume the explicit detail budget.
    maxRequestsPerCrawl: maxDetails + [...resolvedListings.values()].reduce((count, listings) => count + listings.length, 0),
    useSessionPool: false,
    async requestHandler({ request, crawler: active }) {
      const { source, category, kind } = request.userData;
      const html = await get(
          request.url,
          kind === "event" ? { detailRedirectSource: source } : {},
        ),
        $ = load(html);
      if (values["save-html"])
        await writeFile(join(output, "html", `${sha(request.url)}.html`), html);
      if (kind === "listing") {
        const discovery = await expandListing($, source, request.url, get, {
          maxPages,
          continuation: coverage.listings[request.url]?.continuation ?? null,
        });
        const discovered = discovery.urls;
        if (!discovered.length && discovery.completion !== 'exhausted')
          throw new NonRetryableError(`listing_empty:${discovery.completion}`);
        // A source advertising a previously retired URL is explicit
        // reactivation evidence; retired URLs absent from listings stay on the
        // slower bounded recheck cadence.
        const discoveredEntries = discovered.map((url) => ({ url, source, category, reactivate: true }));
        addCoverageEntries(coverage, discoveredEntries);
        coverage.listings[request.url] = {
          source, completion: discovery.completion, discovered: discovered.length, checkedAt: new Date().toISOString(),
          ...(discovery.continuation ? { continuation: discovery.continuation } : {}),
        };
        await saveCoverage();
        report.listings.push({
          source,
          url: request.url,
          initial: discovery.initial,
          discovered: discovered.length,
          selected: 0,
          truncated: discovery.completion !== "exhausted",
          completion: discovery.completion,
          total: discovery.total,
          requests: discovery.requests,
          ...(values["discover-only"] ? { discoveredUrls: discovered } : {}),
        });
        pendingListings.delete(request.url);
        await scheduleCoverageDetails(active);
        return;
      }
      attemptedUrls.add(request.url);
      const raw = rawResponses.get(request.url);
      rawPages.set(request.url, { status: 'failed', observedAt: raw.fetchedAt, rawObjectRef: raw.rawObjectRef, responseUrl: raw.url });
      const extractionResponses = new Map([[request.url, raw]]);
      const extractionGet = async (url, options) => {
        const body = await get(url, options);
        extractionResponses.set(url, rawResponses.get(url));
        return body;
      };
      let events, listings;
      try {
        listings = await extractListings($, source, request.url, category, new Date(raw.fetchedAt), {
          get: extractionGet, rawObjectRef: raw.rawObjectRef, supplementaryResponses: extractionResponses,
        });
        events = listings.map(listingToEvent);
        rawPages.get(request.url).supplementaryRawObservations = [...extractionResponses.entries()]
          .filter(([url]) => url !== request.url).map(([url, retained]) => ({ url,
            fetchedAt: retained.fetchedAt, rawObjectRef: retained.rawObjectRef }));
      } catch (error) {
        if (error.message === 'session_time_conflict') {
          // Source evidence disproves the cached session time. Keep this distinct
          // from a verified retirement and from ordinary fetch/parser failures.
          const checkedAt = raw.fetchedAt;
          const provenance = { contentHash: raw.rawObjectRef.sha256, rawObjectRef: raw.rawObjectRef, parserVersion: '5' };
          rawPages.get(request.url).status = 'quarantined';
          recordCoverageAttempt(coverage, request.url, { success: false, quarantined: true, failure: error.message }, checkedAt);
          recordCycleObservation(request.url, 'quarantined', checkedAt);
          checkpointCoverageEvents(coverage, request.url, [], checkedAt, provenance);
          upsertReportPage({ source, url: request.url, checkedAt, quarantinedAt: checkedAt, quarantineReason: error.message, ...provenance, events: [] });
          report.quarantined.push({ source, url: request.url, errors: [error.message], checkedAt });
          report.failures.push({ source, url: request.url, reason: error.message, attempts: request.retryCount + 1 });
          await saveCoverage();
          return;
        }
        throw new NonRetryableError(error.message);
      }
      const { accepted, quarantined: pageQuarantine, complete: pageComplete } =
        verifyCompletePage(events, validateEvent, source, request.url);
      if (pageQuarantine.length) {
        rawPages.get(request.url).status = 'quarantined';
        report.quarantined.push(...pageQuarantine);
        throw new NonRetryableError("page_contains_quarantined_sessions");
      }
      if (!pageComplete) throw new NonRetryableError("page_incomplete");
      // Successful zero-record extraction is evidence of the page, not a
      // fabricated session cancellation or complete provider inventory.
      rawPages.get(request.url).status = 'verified';
      if (!accepted.length) {
        if (events.length) throw new NonRetryableError("all_sessions_quarantined");
        const checkedAt = raw.fetchedAt;
        attemptedUrls.add(request.url);
        recordCoverageAttempt(coverage, request.url, { success: false, retired: true, failure: "no_verified_sessions" }, checkedAt);
        recordCycleObservation(request.url, 'retired', checkedAt);
        const provenance = { contentHash: raw.rawObjectRef.sha256, rawObjectRef: raw.rawObjectRef, parserVersion: "4" };
        checkpointCoverageEvents(coverage, request.url, [], checkedAt, provenance);
        upsertReportPage({ source, url: request.url, checkedAt, retiredAt: checkedAt, ...provenance, events: [] });
        await saveCoverage();
        return;
      }
      for (const listing of listings) providerListings.set(listing.listingId, listing);
      const checkedAt = raw.fetchedAt, provenance = { contentHash: raw.rawObjectRef.sha256, rawObjectRef: raw.rawObjectRef, parserVersion: "4" };
      upsertReportPage({
        source,
        url: request.url,
        checkedAt,
        ...provenance,
        events: accepted,
      });
      verifiedUrls.add(request.url);
      recordCoverageAttempt(coverage, request.url, { success: true }, checkedAt);
      recordCycleObservation(request.url, 'verified', checkedAt);
      checkpointCoverageEvents(coverage, request.url, accepted, checkedAt, provenance);
      await saveCoverage();
      if (report.pages.length % 10 === 0)
        console.log(`Verified ${report.pages.length} event pages.`);
    },
    async failedRequestHandler({ request }, error) {
      report.failures.push({
        source: request.userData.source,
        url: request.url,
        reason: error.message,
        attempts: request.retryCount + 1,
      });
      if (request.userData.kind === "event") {
        const failedAt = new Date().toISOString();
        attemptedUrls.add(request.url);
        const page = rawPages.get(request.url);
        rawPages.set(request.url, { ...page, status: page?.status === 'quarantined' ? 'quarantined' : 'failed',
          observedAt: page?.observedAt ?? failedAt });
        recordCoverageAttempt(coverage, request.url, { success: false, failure: error.message }, failedAt);
        recordCycleObservation(request.url, 'failed', failedAt);
        await saveCoverage();
      } else if (request.userData.kind === "listing") {
        pendingListings.delete(request.url);
        await scheduleCoverageDetails(activeCrawler);
      }
    },
  },
  config,
);
activeCrawler = crawler;
await scheduleCoverageDetails(crawler);
let crawlError;
const deadline = setTimeout(() => { budgetStop = "time_budget"; void crawler.autoscaledPool?.abort(); }, maxMinutes * 60_000);
try {
  await crawler.run(seeds);
} catch (error) {
  crawlError = error;
  report.failures.push({ reason: error.message });
} finally {
  clearTimeout(deadline);
}
const listingCoverageComplete = (source) =>
  !targets.length &&
  (resolvedListings.get(source)?.length ?? 0) > 0 &&
  resolvedListings.get(source).every(([path]) => {
    const listing = coverage.listings[sources[source].origin + path];
    return listing?.completion === "exhausted" && Date.parse(listing.checkedAt) >= Date.parse(startedAt);
  });
await atomicJson(join(output, 'raw-fetches.json'), { schemaVersion: 1, fetches: rawFetches, storage: rawStore.metrics });
await atomicJson(join(output, 'provider-listings.json'), { schemaVersion: 1, listings: [...providerListings.values()].sort((a, b) => a.listingId.localeCompare(b.listingId)) });
const handoffUrls = new Set([...enqueued, ...attemptedUrls, ...targets]);
const rawInventory = coverage.entries.filter(entry => handoffUrls.has(entry.url))
  .map(entry => ({ url: entry.url, provider: entry.source, category: entry.category }));
for (const url of targets) if (!rawInventory.some(entry => entry.url === url)) {
  const provider = selected.find(source => detailUrl(url, source));
  if (provider) rawInventory.push({ url, provider });
}
await atomicJson(join(output, 'pipeline-raw-collection.json'), buildRawCollectionManifest({ startedAt,
  collectorRevision: process.env.BIPLAN_COLLECTOR_REVISION ?? process.env.GITHUB_SHA ?? 'local-uncommitted',
  inventory: rawInventory, receipts: rawPages, fetches: rawFetches,
  horizon: collectionCycle?.horizonStart ? { start: collectionCycle.horizonStart, end: collectionCycle.horizonEnd } : null }));
if (values["discover-only"]) {
  const listingComplete = Object.fromEntries(selected.map((source) => [source,
    listingCoverageComplete(source)
  ]));
  const sourceCoverage = coverageBySource(coverage, selected, attemptedUrls, verifiedUrls, report.quarantined, listingComplete, startedAt);
  report.finishedAt = new Date().toISOString();
  report.summary = {
    mode: "discovery_only",
    blocked: "discovery_only",
    discovered: new Set(report.listings.flatMap((l) => l.discoveredUrls)).size,
    completedListings: report.listings.filter((l) => l.completion === "exhausted").length,
    incompleteListings: report.listings.filter((l) => l.completion !== "exhausted").length,
    failedListings: report.failures.length,
    sourceCoverage,
    complete: collectionCycle
      ? collectionCycle.scope === 'full' && budgetStop === null && collectionCycleInventoryComplete(coverage, collectionCycle) &&
        selected.every((source) => sourceCoverage[source].complete)
      : selected.every((source) => sourceCoverage[source].complete),
    ...(collectionCycle ? { collectionCycle, collectionInventory: collectionCycleInventory(coverage, collectionCycle),
      collectionCycleEvidence: collectionCycleEvidence(coverage, collectionCycle, report.pages) } : {}),
  };
  await atomicJson(join(output, "discovery.json"), report);
  console.log(JSON.stringify(report.summary, null, 2));
  if (crawlError || report.failures.length || report.summary.incompleteListings)
    process.exitCode = 1;
} else {
  const { events, carried } = reconcile(previous, report.pages);
  const blocked = crawlError ? "crawl_failed" : publicationGate(previous, events, report);
  report.finishedAt = new Date().toISOString();
  const listingComplete = Object.fromEntries(selected.map((source) => [source,
    listingCoverageComplete(source)
  ]));
  const sourceCoverage = coverageBySource(coverage, selected, attemptedUrls, verifiedUrls, report.quarantined, listingComplete, startedAt);
  report.summary = {
    blocked,
    events: events.length,
    available: events.filter((e) => e.availability === "available").length,
    carried,
    resumedCheckpointEvents: resumedEvents.length,
    refreshedPages: report.pages.length,
    failedPages: report.failures.length,
    quarantined: report.quarantined.length,
    discovery: {
      completedListings: report.listings.filter((l) => l.completion === "exhausted").length,
      incompleteListings: report.listings.filter((l) => l.completion !== "exhausted").length,
      limitedListings: report.listings.filter((l) => l.truncated).length,
    },
    sources: Object.fromEntries(
      selected.map((name) => [name, events.filter((e) => e.source === name).length]),
    ),
    sourceCoverage,
    complete: collectionCycle
      ? collectionCycle.scope === 'full' && budgetStop === null && collectionCycleInventoryComplete(coverage, collectionCycle) &&
        selected.every((source) => sourceCoverage[source].complete)
      : selected.every((source) => sourceCoverage[source].complete),
    ...(collectionCycle ? { collectionCycle, collectionInventory: collectionCycleInventory(coverage, collectionCycle),
      collectionCycleEvidence: collectionCycleEvidence(coverage, collectionCycle, report.pages) } : {}),
    detailBudget: {
      max: maxDetails,
      attempted: attemptedUrls.size,
      remainingBacklog: coverage.entries.filter((entry) =>
        selected.includes(entry.source) && !entry.retiredAt &&
        (entry.failure || !entry.lastSuccessAt || Date.parse(entry.lastSuccessAt) < Date.parse(startedAt) - 72 * 60 * 60 * 1000)
      ).length,
    },
    runBudget: { maxHttp, httpRequests, maxMinutes, stoppedBy: budgetStop },
    coverage:
      "all known and discovered detail URLs are durably tracked; each run fairly rotates a bounded detail refresh across sources",
  };
  await atomicJson(join(output, "report.json"), report);
  await atomicJson(join(output, "events.json"), events);
  if (blocked)
    throw new Error(
      `Publication blocked: ${blocked}; previous snapshot preserved. See ${join(output, "report.json")}`,
    );
  await atomicJson(snapshot, events);
  console.log(JSON.stringify(report.summary, null, 2));
}
