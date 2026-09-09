import { BasicCrawler, Configuration, NonRetryableError } from "@crawlee/basic";
import { load } from "cheerio";
import robotsParser from "robots-parser";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { sources, discover, extract, detailUrl } from "./adapters.mjs";
import {
  sha,
  validateEvent,
  reconcile,
  publicationGate,
  readSnapshot,
  atomicJson,
} from "./pipeline.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    sources: { type: "string", default: "biletinial,bubilet,biletix" },
    limit: { type: "string", default: "20" },
    output: { type: "string", default: join(root, "output") },
    snapshot: { type: "string", default: join(root, "../web/data/events.json") },
    "save-html": { type: "boolean", default: false },
  },
});
const selected = [...new Set(values.sources.split(","))];
if (selected.some((name) => !sources[name])) throw new Error("Unknown source");
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 100)
  throw new Error("Limit must be 1–100 per listing");
const output = resolve(values.output),
  snapshot = resolve(values.snapshot);
await mkdir(output, { recursive: true });
await mkdir(dirname(snapshot), { recursive: true });
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
const previous = await readSnapshot(snapshot);
const userAgent = "BiPlan/0.2 (+https://github.com/Efeblk/event_recommender)";
const robots = new Map();
const nextDomainSlot = new Map();
const enqueued = new Set();
const headers = { "User-Agent": userAgent, "Accept-Language": "tr-TR,tr;q=0.9" };
async function get(url, isRobots = false) {
  const response = await fetch(url, {
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
  });
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
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > (isRobots ? 256000 : 4000000)) throw new NonRetryableError("response_too_large");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(parts).toString("utf8");
}
// Fetch policies using our own user agent; fail closed on inaccessible robots files.
const seeds = [];
for (const name of selected) {
  const source = sources[name],
    url = `${source.origin}/robots.txt`;
  try {
    const rules = robotsParser(url, await get(url, true));
    robots.set(name, rules);
    for (const [path, category] of source.paths)
      seeds.push({
        url: source.origin + path,
        userData: { source: name, category, kind: "listing" },
      });
    // Previously known productions are revisited even if no longer promoted on listings.
    for (const event of previous) {
      const detail = detailUrl(event.url, name);
      if (detail && !enqueued.has(detail) && enqueued.size < 1000) {
        enqueued.add(detail);
        seeds.push({
          url: detail,
          userData: { source: name, category: event.category, kind: "event" },
        });
      }
    }
  } catch (error) {
    report.failures.push({ source: name, url, reason: `robots_unavailable:${error.message}` });
  }
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
    requestHandlerTimeoutSecs: 75,
    maxRequestsPerCrawl: 2000,
    useSessionPool: false,
    async requestHandler({ request, crawler: active }) {
      const { source, category, kind } = request.userData;
      if (!robots.get(source)?.isAllowed(request.url, "BiPlan"))
        throw new NonRetryableError("robots_disallowed");
      // Reserve a per-origin slot inside the task: delayed queue reclaims must not
      // consume Crawlee's requests-per-minute allowance without making requests.
      const slot = Math.max(Date.now(), nextDomainSlot.get(source) ?? 0);
      nextDomainSlot.set(source, slot + 1000);
      await delay(Math.max(0, slot - Date.now()));
      const html = await get(request.url),
        $ = load(html);
      if (values["save-html"])
        await writeFile(join(output, "html", `${sha(request.url)}.html`), html);
      if (kind === "listing") {
        const discovered = discover($, source);
        if (!discovered.length) throw new NonRetryableError("listing_empty");
        const candidates = discovered.filter((url) => !enqueued.has(url)).slice(0, limit);
        for (const url of candidates) enqueued.add(url);
        report.listings.push({
          source,
          url: request.url,
          discovered: discovered.length,
          selected: candidates.length,
          truncated: discovered.length > limit,
        });
        await active.addRequests(
          candidates.map((url) => ({ url, userData: { source, category, kind: "event" } })),
        );
        return;
      }
      let events;
      try {
        events = await extract($, source, request.url, category);
      } catch (error) {
        throw new NonRetryableError(error.message);
      }
      const accepted = [];
      for (const event of events) {
        const errors = validateEvent(event);
        if (errors.length)
          report.quarantined.push({ source, url: request.url, id: event.id, errors });
        else accepted.push(event);
      }
      if (!accepted.length) throw new NonRetryableError("all_sessions_quarantined");
      report.pages.push({
        source,
        url: request.url,
        checkedAt: new Date().toISOString(),
        contentHash: sha(html),
        parserVersion: "2",
        events: accepted,
      });
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
    },
  },
  config,
);
let crawlError;
try {
  await crawler.run(seeds);
} catch (error) {
  crawlError = error;
  report.failures.push({ reason: error.message });
}
const { events, carried } = reconcile(previous, report.pages);
const blocked = crawlError ? "crawl_failed" : publicationGate(previous, events, report);
report.finishedAt = new Date().toISOString();
report.summary = {
  blocked,
  events: events.length,
  available: events.filter((e) => e.availability === "available").length,
  carried,
  refreshedPages: report.pages.length,
  failedPages: report.failures.length,
  quarantined: report.quarantined.length,
  sources: Object.fromEntries(
    selected.map((name) => [name, events.filter((e) => e.source === name).length]),
  ),
  coverage: "bounded listings plus previously known productions; not an exhaustive city catalog",
};
await atomicJson(join(output, "report.json"), report);
await atomicJson(join(output, "events.json"), events);
if (blocked)
  throw new Error(
    `Publication blocked: ${blocked}; previous snapshot preserved. See ${join(output, "report.json")}`,
  );
await atomicJson(snapshot, events);
console.log(JSON.stringify(report.summary, null, 2));
