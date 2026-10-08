import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MAX_CHECKPOINT_BYTES, restoreCheckpoint } from "../checkpoint.mjs";
import { checkReady } from "../monitor.mjs";
import { CHECKPOINT_SAVE_TIMEOUT_MS, MAX_IMPORT_EVENTS, MAX_IMPORT_PAGES, MAX_SOURCE_PAGE_EVENTS, prepareImportPages, publish } from "../publish.mjs";
import { buildSoakEvidence } from "../soak-report.mjs";
import { verifySoakEvidence } from "../soak-verify.mjs";

async function fixture(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

test("a missing durable snapshot bootstraps only on 404", async (t) => {
  const remote = await fixture((request, response) => json(response, 404, { error: "missing" }));
  t.after(remote.close);
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-"));
  const fallback = join(dir, "fallback.json"), output = join(dir, "nested", "events.json");
  await writeFile(fallback, '[{"id":"seed"}]');
  const result = await restoreCheckpoint({ origin: remote.origin, token: "secret", output, fallback, allowLoopbackHttp: true });
  assert.equal(result.status, "bootstrap");
  assert.deepEqual(JSON.parse(await readFile(output)), [{ id: "seed" }]);
});

test("authentication and service failures never fall back", async (t) => {
  for (const status of [401, 503]) {
    const remote = await fixture((request, response) => json(response, status, { error: "unavailable" }));
    t.after(remote.close);
    const dir = await mkdtemp(join(tmpdir(), "checkpoint-"));
    const fallback = join(dir, "fallback.json"), output = join(dir, "events.json");
    await writeFile(fallback, "[]");
    await assert.rejects(restoreCheckpoint({ origin: remote.origin, token: "bad", output, fallback, allowLoopbackHttp: true }), new RegExp(`HTTP ${status}`));
    await assert.rejects(readFile(output), /ENOENT/);
  }
});

test("malformed bootstrap and remote snapshots are rejected", async (t) => {
  const malformedRemote = await fixture((request, response) => json(response, 200, { schemaVersion: 1, savedAt: "invalid", events: [null], report: { finishedAt: "invalid", summary: [] } }));
  t.after(malformedRemote.close);
  const dir = await mkdtemp(join(tmpdir(), "checkpoint-"));
  const fallback = join(dir, "fallback.json"), output = join(dir, "events.json");
  await writeFile(fallback, "[null]");
  await assert.rejects(restoreCheckpoint({ origin: malformedRemote.origin, token: "secret", output, fallback, allowLoopbackHttp: true }), /invalid snapshot/);
  const missing = await fixture((request, response) => json(response, 404, { error: "missing" }));
  t.after(missing.close);
  await assert.rejects(restoreCheckpoint({ origin: missing.origin, token: "secret", output, fallback, allowLoopbackHttp: true }), /Bootstrap snapshot/);
});

test("checkpoint publish reads canonical state back to disk", async (t) => {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const deadlines = [];
  t.mock.method(AbortSignal, "timeout", (milliseconds) => {
    deadlines.push(milliseconds);
    return timeout(milliseconds);
  });
  const canonical = { schemaVersion: 1, savedAt: "2026-09-22T10:00:00.000Z", events: [{ id: "canonical" }], report: { finishedAt: "2026-09-22T09:59:00.000Z", summary: { events: 1 } } };
  const calls = [];
  let checkpointBody;
  const remote = await fixture(async (request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.url === "/api/health") return json(response, 200, { status: "ok", deployment: { environment: "staging", revision: "a".repeat(40) } });
    if (request.url === "/api/admin/import") return json(response, 200, { imported: 1, skipped: 0 });
    if (request.method === "POST") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      checkpointBody = JSON.parse(Buffer.concat(chunks));
      return json(response, 200, { schemaVersion: 1, savedAt: canonical.savedAt, key: "x", events: 1 });
    }
    json(response, 200, canonical);
  });
  t.after(remote.close);
  const dir = await mkdtemp(join(tmpdir(), "publish-")), snapshot = join(dir, "events.json");
  const report = { schemaVersion: 1, finishedAt: canonical.report.finishedAt, summary: { events: 1, sources: { biletix: 1, bubilet: 0 } }, pages: [{ source: "biletix", url: "https://source.test/a", events: [{ id: "submitted" }] }] };
  const result = await publish({ origin: remote.origin, token: "secret", report, checkpoint: true, snapshot, allowLoopbackHttp: true });
  assert.equal(result.checkpointed, true);
  assert.deepEqual(JSON.parse(await readFile(snapshot)), canonical.events);
  assert.deepEqual(calls, ["POST /api/admin/import", "POST /api/admin/collection", "GET /api/admin/collection", "GET /api/health"]);
  assert.deepEqual(checkpointBody.report.summary.missingSources, ["bubilet"]);
  assert.deepEqual(checkpointBody.report.summary.sourceHealth.refreshedPages, { biletix: 1, bubilet: 0 });
  assert.deepEqual(deadlines, [60_000, CHECKPOINT_SAVE_TIMEOUT_MS, 30_000, 15_000]);
});

test("an ambiguous checkpoint timeout never reads back or overwrites the local snapshot", async (t) => {
  const calls = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  const checkpointAbort = new AbortController();
  t.mock.method(AbortSignal, "timeout", (milliseconds) =>
    milliseconds === CHECKPOINT_SAVE_TIMEOUT_MS ? checkpointAbort.signal : timeout(milliseconds));
  const remote = await fixture((request, response) => {
    calls.push(`${request.method} ${request.url}`);
    if (request.url === "/api/admin/import")
      return json(response, 200, { imported: 1, skipped: 0 });
    if (request.method === "POST" && request.url === "/api/admin/collection") {
      request.resume();
      request.on("aborted", () => response.destroy());
      queueMicrotask(() => checkpointAbort.abort(new DOMException("Checkpoint timed out", "TimeoutError")));
      return;
    }
    json(response, 500, { error: "unexpected_request" });
  });
  t.after(remote.close);
  const dir = await mkdtemp(join(tmpdir(), "publish-timeout-"));
  const snapshot = join(dir, "events.json");
  const original = [{ id: "preserved-local-snapshot" }];
  await writeFile(snapshot, JSON.stringify(original));
  const report = {
    schemaVersion: 1,
    finishedAt: "2026-09-28T18:00:00.000Z",
    summary: { events: 1, sources: { biletix: 1 } },
    pages: [{
      source: "biletix",
      url: "https://source.test/a",
      events: [{ id: "submitted", startsAt: "2026-09-29T18:00:00.000Z" }],
    }],
  };

  await assert.rejects(
    publish({ origin: remote.origin, token: "secret", report, checkpoint: true, snapshot, allowLoopbackHttp: true, now: () => new Date("2026-09-28T18:00:00.000Z") }),
    /aborted|timeout/i,
  );
  assert.deepEqual(calls, ["POST /api/admin/import", "POST /api/admin/collection"]);
  assert.deepEqual(JSON.parse(await readFile(snapshot, "utf8")), original);
});

test("checkpoint restore uses the shared 32 MiB boundary", () => {
  assert.equal(MAX_CHECKPOINT_BYTES, 32 * 1024 * 1024);
});

test("publisher omits only sessions that started after collection and reports them", () => {
  const pages = [
    {
      url: "https://source.test/a",
      events: [
        { id: "past", startsAt: "2026-09-26T09:59:59.000Z" },
        { id: "future", startsAt: "2026-09-26T10:00:01.000Z" },
        { id: "invalid-date", startsAt: "invalid" },
      ],
    },
    { url: "https://source.test/empty", events: [{ id: "past-only", startsAt: "2026-09-25T10:00:00.000Z" }] },
  ];
  const prepared = prepareImportPages(pages, new Date("2026-09-26T10:00:00.000Z"));
  assert.deepEqual(prepared.omittedExpiredIds, ["past", "past-only"]);
  assert.deepEqual(prepared.pages, [
    {
      url: "https://source.test/a",
      events: [
        { id: "future", startsAt: "2026-09-26T10:00:01.000Z" },
        { id: "invalid-date", startsAt: "invalid" },
      ],
    },
  ]);
});

test("publisher preserves explicit verified retirement without treating unknown empty pages as retired", async (t) => {
  const bodies = [];
  const remote = await fixture(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks))); json(response, 200, { imported: 0 });
  });
  t.after(remote.close);
  const page = { url: 'https://source.test/retired', events: [], retiredAt: new Date(Date.now() - 3600000).toISOString() };
  assert.deepEqual(prepareImportPages([page, { url: 'https://source.test/unknown', events: [] }]).pages, [page]);
  const result = await publish({ origin: remote.origin, token: 'secret', report: { schemaVersion: 1, summary: {}, pages: [page] }, allowLoopbackHttp: true });
  assert.deepEqual(bodies, [{ schemaVersion: 1, pages: [page] }]);
  assert.equal(result.imported, 0);
});

test("publisher rechecks expiration immediately before each import request", async (t) => {
  const bodies = [];
  const remote = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks)));
    json(response, 200, { imported: 30 });
  });
  t.after(remote.close);
  const pages = Array.from({ length: MAX_IMPORT_PAGES + 1 }, (_, index) => ({
    url: `https://source.test/${index}`,
    events: index === MAX_IMPORT_PAGES
      ? [
          { id: "expires-between-requests", startsAt: "2026-09-26T10:01:00.000Z" },
          { id: "remains-future", startsAt: "2026-09-26T11:00:00.000Z" },
        ]
      : [{ id: `future-${index}`, startsAt: "2026-09-26T11:00:00.000Z" }],
  }));
  const times = ["2026-09-26T10:00:00.000Z", "2026-09-26T10:00:00.000Z", "2026-09-26T10:02:00.000Z"];
  const result = await publish({
    origin: remote.origin,
    token: "secret",
    report: { schemaVersion: 1, summary: {}, pages },
    allowLoopbackHttp: true,
    now: () => new Date(times.shift()),
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].pages[0].events.map((event) => event.id), ["remains-future"]);
  assert.deepEqual(result.omittedExpired, { count: 1, ids: ["expires-between-requests"] });
});

test("publisher rechecks stale observations immediately before each import request", async (t) => {
  const bodies = [];
  const remote = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    bodies.push(JSON.parse(Buffer.concat(chunks)));
    json(response, 200, { imported: 3 });
  });
  t.after(remote.close);
  const pages = Array.from({ length: MAX_IMPORT_PAGES + 1 }, (_, index) => ({
    url: `https://source.test/stale-${index}`,
    events: index === MAX_IMPORT_PAGES
      ? [
          { id: "stale-between-requests", startsAt: "2026-10-10T12:00:00.000Z", checkedAt: "2026-10-04T11:00:00.000Z" },
          { id: "remains-fresh", startsAt: "2026-10-10T12:00:00.000Z", checkedAt: "2026-10-04T12:00:00.000Z" },
        ]
      : [{ id: `fresh-${index}`, startsAt: "2026-10-10T12:00:00.000Z", checkedAt: "2026-10-04T12:00:00.000Z" }],
  }));
  const times = ["2026-10-07T09:59:00.000Z", "2026-10-07T09:59:00.000Z", "2026-10-07T10:01:00.000Z"];
  const result = await publish({
    origin: remote.origin,
    token: "secret",
    report: { schemaVersion: 1, summary: {}, pages },
    allowLoopbackHttp: true,
    now: () => new Date(times.shift()),
  });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].pages[0].events.map((event) => event.id), ["remains-fresh"]);
  assert.deepEqual(result.omittedStale, { count: 1, ids: ["stale-between-requests"] });
});

test("publisher partitions large reports into at most three whole source pages per request", async (t) => {
  const pageCounts = [];
  const remote = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    pageCounts.push(JSON.parse(Buffer.concat(chunks)).pages.length);
    json(response, 200, { imported: 1 });
  });
  t.after(remote.close);
  const pages = Array.from({ length: MAX_IMPORT_PAGES * 3 + 1 }, (_, index) => ({
    url: `https://source.test/${index}`,
    events: [{ id: String(index), startsAt: "2026-09-27T12:00:00.000Z" }],
  }));
  await publish({
    origin: remote.origin,
    token: "secret",
    report: { schemaVersion: 1, summary: {}, pages },
    allowLoopbackHttp: true,
    now: () => new Date("2026-09-27T10:00:00.000Z"),
  });
  assert.deepEqual(pageCounts, [MAX_IMPORT_PAGES, MAX_IMPORT_PAGES, MAX_IMPORT_PAGES, 1]);
});

test("publisher keeps a 314-session source page atomic and batches by envelope event count", async (t) => {
  const bodies = [];
  const remote = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    bodies.push(body);
    json(response, 200, { imported: body.pages.reduce((sum, page) => sum + page.events.length, 0) });
  });
  t.after(remote.close);
  const makePage = (name, count) => ({
    url: `https://source.test/${name}`,
    events: Array.from({ length: count }, (_, index) => ({
      id: `${name}-${index}`,
      startsAt: "2026-09-27T12:00:00.000Z",
    })),
  });
  const pages = [makePage('real-shape', 314), makePage('large-a', 900), makePage('large-b', 900)];
  const result = await publish({
    origin: remote.origin,
    token: "secret",
    report: { schemaVersion: 1, summary: {}, pages },
    allowLoopbackHttp: true,
    now: () => new Date("2026-09-27T10:00:00.000Z"),
  });
  assert.deepEqual(bodies.map(body => body.pages.map(page => page.events.length)), [[314, 900], [900]]);
  assert.ok(bodies.every(body => body.pages.reduce((sum, page) => sum + page.events.length, 0) <= MAX_IMPORT_EVENTS));
  assert.deepEqual(bodies.flatMap(body => body.pages).flatMap(page => page.events.map(event => event.id)), pages.flatMap(page => page.events.map(event => event.id)));
  assert.equal(result.imported, 2114);
});

test("publisher preflights the 1000-session source-page bound before network access", async (t) => {
  let requests = 0;
  const remote = await fixture((request, response) => {
    requests += 1;
    json(response, 200, { imported: 0 });
  });
  t.after(remote.close);
  const events = Array.from({ length: MAX_SOURCE_PAGE_EVENTS + 1 }, (_, index) => ({
    id: `too-large-${index}`,
    startsAt: "2026-09-27T12:00:00.000Z",
  }));
  await assert.rejects(publish({
    origin: remote.origin,
    token: "secret",
    report: { schemaVersion: 1, summary: {}, pages: [{ url: "https://source.test/too-large", events }] },
    allowLoopbackHttp: true,
    now: () => new Date("2026-09-27T10:00:00.000Z"),
  }), /source page exceeds the event import limit/);
  assert.equal(requests, 0);
});

test("publisher splits a three-page envelope before the steady-state D1 query budget", async (t) => {
  const pageCounts = [];
  const remote = await fixture(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    pageCounts.push(JSON.parse(Buffer.concat(chunks)).pages.map(page => page.events.length));
    json(response, 200, { imported: 1 });
  });
  t.after(remote.close);
  const makePage = (name, count) => ({
    url: `https://source.test/${name}`,
    events: Array.from({ length: count }, (_, index) => ({ id: `${name}-${index}`, startsAt: "2026-09-27T12:00:00.000Z" })),
  });
  await publish({
    origin: remote.origin,
    token: "secret",
    report: { schemaVersion: 1, summary: {}, pages: [makePage("a", 901), makePage("b", 901), makePage("c", 198)] },
    allowLoopbackHttp: true,
    now: () => new Date("2026-09-27T10:00:00.000Z"),
  });
  assert.deepEqual(pageCounts, [[901, 901], [198]]);
});

test("publisher does not send or checkpoint when every session expires before the first request", async (t) => {
  let requests = 0;
  const remote = await fixture((request, response) => {
    requests += 1;
    json(response, 200, {});
  });
  t.after(remote.close);
  const times = ["2026-09-26T10:00:00.000Z", "2026-09-26T10:02:00.000Z"];
  await assert.rejects(publish({
    origin: remote.origin,
    token: "secret",
    report: { schemaVersion: 1, summary: {}, pages: [{ url: "https://source.test/a", events: [{ id: "expired", startsAt: "2026-09-26T10:01:00.000Z" }] }] },
    checkpoint: true,
    allowLoopbackHttp: true,
    now: () => new Date(times.shift()),
  }), /No future event sessions remain importable/);
  assert.equal(requests, 0);
});

test("soak evidence flags selected sources with no retained events or refreshed pages", () => {
  const evidence = buildSoakEvidence(
    {
      startedAt: "2026-09-26T00:00:00.000Z",
      finishedAt: "2026-09-26T00:01:00.000Z",
      summary: { sources: { biletix: 1, bubilet: 0, biletinial: 2 } },
      pages: [
        { source: "biletix" },
        { source: "biletinial" },
      ],
    },
    [
      { source: "biletix" },
      { source: "biletinial" },
    ],
    new Date("2026-09-26T00:02:00.000Z"),
  );
  assert.deepEqual(evidence.sourceHealth.refreshedPages, {
    biletix: 1,
    bubilet: 0,
    biletinial: 1,
  });
  assert.deepEqual(evidence.sourceHealth.missingSources, ["bubilet"]);
  assert.equal(evidence.observation.includes("does not claim"), true);
});

test("seven-day soak verification requires overlapping healthy unique workflow evidence", () => {
  const revision = "b".repeat(40);
  const provenance = (id) => ({ githubRunId: String(id), githubRunAttempt: "1", githubEventName: "schedule" });
  const collections = Array.from({ length: 29 }, (_, index) => ({
    schemaVersion: 2, kind: "collection-run", environment: "staging", revision,
    provenance: provenance(100 + index),
    publication: { artifactOnly: false, canonicalReadback: true },
    run: { finishedAt: new Date(Date.UTC(2026, 8, 24, index * 6)).toISOString() },
    sourceHealth: { refreshedPages: { biletinial: 1, bubilet: 1, biletix: 1 }, missingSources: [] },
  }));
  const monitors = Array.from({ length: 169 }, (_, index) => ({
    schemaVersion: 1, kind: "readiness-monitor", environment: "staging", revision,
    provenance: provenance(1000 + index), ready: true, reasons: [],
    recordedAt: new Date(Date.UTC(2026, 8, 24, index)).toISOString(),
  }));
  const pass = verifySoakEvidence({ collections, monitors, environment: "staging", revision });
  assert.equal(pass.status, "pass");
  assert.equal(pass.overlap.spanHours, 168);

  const fortyEightHours = verifySoakEvidence({
    collections: collections.slice(0, 9),
    monitors: monitors.slice(0, 49),
    environment: "staging",
    revision,
  });
  assert.equal(fortyEightHours.status, "fail");
  assert.equal(fortyEightHours.reasons.includes("healthy_overlap_under_168h"), true);

  const broken = structuredClone(monitors);
  broken[84].ready = false;
  broken[84].reasons = ["checkpoint_stale"];
  broken[85].recordedAt = broken[83].recordedAt;
  broken[85].provenance = broken[84].provenance;
  const fail = verifySoakEvidence({ collections: collections.slice(0, 28), monitors: broken, environment: "staging", revision });
  assert.equal(fail.status, "fail");
  assert.equal(fail.reasons.includes("healthy_overlap_under_168h"), true);
  assert.equal(fail.reasons.includes("monitor_run_provenance_reused"), true);
  assert.equal(fail.reasons.some((reason) => reason.includes("not_ready:checkpoint_stale")), true);

  const manual = structuredClone(collections);
  manual[0].provenance.githubEventName = "workflow_dispatch";
  const manualFail = verifySoakEvidence({ collections: manual, monitors, environment: "staging", revision });
  assert.equal(manualFail.status, "fail");
  assert.equal(manualFail.reasons.includes("collection[0]:not_scheduled"), true);

  const invalidRefreshCounts = [undefined, "1", Number.NaN, Number.POSITIVE_INFINITY, 1.5, 0];
  for (const count of invalidRefreshCounts) {
    const unhealthy = structuredClone(collections);
    unhealthy[0].sourceHealth.refreshedPages.biletix = count;
    const unhealthyResult = verifySoakEvidence({ collections: unhealthy, monitors, environment: "staging", revision });
    assert.equal(unhealthyResult.reasons.includes("collection[0]:source_unhealthy:biletix"), true);
  }
});

test("a partial import failure never advances the checkpoint", async (t) => {
  let imports = 0, checkpointCalls = 0;
  const remote = await fixture((request, response) => {
    if (request.url === "/api/admin/import") return json(response, ++imports === 1 ? 200 : 503, { imported: 30 });
    checkpointCalls += 1;
    json(response, 200, {});
  });
  t.after(remote.close);
  const pages = Array.from({ length: 31 }, (_, index) => ({ url: `https://source.test/${index}`, events: [{ id: String(index) }] }));
  await assert.rejects(publish({ origin: remote.origin, token: "secret", report: { schemaVersion: 1, finishedAt: new Date().toISOString(), summary: {}, pages }, checkpoint: true, allowLoopbackHttp: true }), /checkpoint was not advanced/);
  assert.equal(checkpointCalls, 0);
});

test("mismatched checkpoint readback does not overwrite local state", async (t) => {
  const savedAt = "2026-09-22T10:00:00.000Z";
  const remote = await fixture((request, response) => {
    if (request.url === "/api/admin/import") return json(response, 200, { imported: 1 });
    if (request.method === "POST") return json(response, 200, { schemaVersion: 1, savedAt, key: "x", events: 2 });
    return json(response, 200, { schemaVersion: 1, savedAt, events: [{ id: "only-one" }], report: { finishedAt: savedAt, summary: {} } });
  });
  t.after(remote.close);
  const dir = await mkdtemp(join(tmpdir(), "publish-")), snapshot = join(dir, "events.json");
  await writeFile(snapshot, '[{"id":"old"}]');
  await assert.rejects(publish({ origin: remote.origin, token: "secret", report: { schemaVersion: 1, finishedAt: savedAt, summary: {}, pages: [{ url: "https://source.test/a", events: [{ id: "new" }] }] }, checkpoint: true, snapshot, allowLoopbackHttp: true }), /does not match/);
  assert.deepEqual(JSON.parse(await readFile(snapshot)), [{ id: "old" }]);
});

test("monitor requires explicit readiness and reports reasons", async (t) => {
  let mode = "fresh";
  const remote = await fixture((request, response) => {
    if (mode === "fresh") return json(response, 200, { ready: true, eligible: 12, checkpointAgeHours: 2 });
    if (mode === "false") return json(response, 200, { ready: false, reasons: ["missing_sources:biletix"] });
    return json(response, 503, { ready: false, reasons: ["checkpoint_stale"] });
  });
  t.after(remote.close);
  assert.equal((await checkReady({ origin: remote.origin, allowLoopbackHttp: true })).ready, true);
  mode = "false";
  await assert.rejects(checkReady({ origin: remote.origin, allowLoopbackHttp: true }), /missing_sources:biletix/);
  mode = "stale";
  await assert.rejects(checkReady({ origin: remote.origin, allowLoopbackHttp: true }), /checkpoint_stale/);
});
