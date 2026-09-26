import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { restoreCheckpoint } from "../checkpoint.mjs";
import { checkReady } from "../monitor.mjs";
import { prepareImportPages, publish } from "../publish.mjs";
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

test("48-hour soak verification requires overlapping healthy unique workflow evidence", () => {
  const revision = "b".repeat(40);
  const provenance = (id) => ({ githubRunId: String(id), githubRunAttempt: "1", githubEventName: "schedule" });
  const collections = Array.from({ length: 5 }, (_, index) => ({
    schemaVersion: 2, kind: "collection-run", environment: "staging", revision,
    provenance: provenance(100 + index),
    publication: { artifactOnly: false, canonicalReadback: true },
    run: { finishedAt: new Date(Date.UTC(2026, 8, 24, index * 12)).toISOString() },
    sourceHealth: { refreshedPages: { biletinial: 1, bubilet: 1, biletix: 1 }, missingSources: [] },
  }));
  const monitors = Array.from({ length: 49 }, (_, index) => ({
    schemaVersion: 1, kind: "readiness-monitor", environment: "staging", revision,
    provenance: provenance(1000 + index), ready: true, reasons: [],
    recordedAt: new Date(Date.UTC(2026, 8, 24, index)).toISOString(),
  }));
  const pass = verifySoakEvidence({ collections, monitors, environment: "staging", revision });
  assert.equal(pass.status, "pass");
  assert.equal(pass.overlap.spanHours, 48);

  const broken = structuredClone(monitors);
  broken[24].ready = false;
  broken[24].reasons = ["checkpoint_stale"];
  broken[25].recordedAt = broken[23].recordedAt;
  broken[25].provenance = broken[24].provenance;
  const fail = verifySoakEvidence({ collections: collections.slice(0, 4), monitors: broken, environment: "staging", revision });
  assert.equal(fail.status, "fail");
  assert.equal(fail.reasons.includes("healthy_overlap_under_48h"), true);
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
