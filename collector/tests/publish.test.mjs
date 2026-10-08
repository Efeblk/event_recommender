import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import test from "node:test";
import { prepareImportPages, publish } from '../publish.mjs';

test('publication preserves quarantine watermarks and rejects conflicting empty states', () => {
  const page = { url: 'https://biletinial.com/tr-tr/tiyatro/example', events: [], quarantinedAt: '2026-09-28T01:00:00.000Z', quarantineReason: 'session_time_conflict' };
  const now = new Date('2026-09-28T02:00:00.000Z');
  assert.deepEqual(prepareImportPages([page], now).pages, [page]);
  assert.deepEqual(prepareImportPages(prepareImportPages([page], now).pages, now).pages, [page]);
  const availability = { ...page, quarantineReason: 'session_availability_conflict' };
  assert.deepEqual(prepareImportPages([availability], now).pages, [availability]);
  const venue = { ...page, quarantineReason: 'venue_conflict' };
  assert.deepEqual(prepareImportPages([venue], now).pages, [venue]);
  assert.throws(() => prepareImportPages([{ ...page, retiredAt: page.quarantinedAt }], now), /Invalid empty source state/);
  assert.throws(() => prepareImportPages([{ ...page, quarantineReason: 'http_503' }], now), /Invalid empty source state/);
  assert.throws(() => prepareImportPages([{ ...page, quarantinedAt: undefined }], now), /Invalid empty source state/);
});

test('publication skips carried-forward inactive pages the server would reject as stale', () => {
  const now = new Date('2026-10-05T10:20:00.000Z');
  const retired = (retiredAt) => ({ url: `https://biletinial.com/tr-tr/muzik/${retiredAt}`, events: [], retiredAt });
  const quarantined = { url: 'https://biletinial.com/tr-tr/tiyatro/q', events: [], quarantinedAt: '2026-10-02T10:00:00.000Z', quarantineReason: 'session_time_conflict' };
  const fresh = retired('2026-10-02T12:00:00.000Z');
  assert.deepEqual(prepareImportPages([retired('2026-10-02T10:02:03.402Z'), quarantined, fresh], now).pages, [fresh]);
});

test('publication omits carried-forward events with stale observations without changing fresh records', () => {
  const now = new Date('2026-10-07T06:51:44.000Z');
  const stale = { id: 'cocuk-stand-up', startsAt: '2026-10-10T18:00:00.000Z', checkedAt: '2026-10-04T06:24:22.201Z' };
  const fresh = { id: 'fresh', startsAt: '2026-10-10T20:00:00.000Z', checkedAt: '2026-10-04T07:51:44.000Z' };
  const invalid = { id: 'invalid', startsAt: '2026-10-10T21:00:00.000Z', checkedAt: '2026-10-04 06:24:22Z' };
  const prepared = prepareImportPages([{ url: 'https://www.bubilet.com.tr/istanbul/etkinlik/cocuk-stand-up', events: [stale, fresh, invalid] }], now);
  assert.deepEqual(prepared.pages[0].events, [fresh, invalid]);
  assert.deepEqual(prepared.omittedStaleIds, ['cocuk-stand-up']);
  assert.equal(prepared.pages[0].events[0].checkedAt, fresh.checkedAt);
});

const publishPath = resolve(import.meta.dirname, "../publish.mjs");

function invoke(origin, extra = []) {
  return spawnSync(
    process.execPath,
    [publishPath, "--report", "/definitely/missing-report.json", ...extra],
    {
      encoding: "utf8",
      env: { ...process.env, BIPLAN_URL: origin, SYNC_TOKEN: "test-only" },
    },
  );
}

test("plain HTTP remains blocked for remote targets", () => {
  const result = invoke("http://example.com", ["--allow-loopback-http"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires HTTPS/);
  assert.doesNotMatch(result.stderr, /missing-report/);
});

test("the explicit HTTP exception accepts only loopback hosts", () => {
  for (const origin of ["http://localhost:3001", "http://127.0.0.1:3001", "http://[::1]:3001"]) {
    const result = invoke(origin, ["--allow-loopback-http"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing-report/);
    assert.doesNotMatch(result.stderr, /requires HTTPS/);
  }
  const withoutFlag = invoke("http://127.0.0.1:3001");
  assert.match(withoutFlag.stderr, /requires HTTPS/);
});

function reportWithPages(count) {
  const finishedAt = "2026-10-09T10:00:00.000Z";
  return {
    schemaVersion: 1,
    finishedAt,
    summary: { blocked: null, sources: { bubilet: count } },
    pages: Array.from({ length: count }, (_, index) => ({
      source: "bubilet",
      url: `https://www.bubilet.com.tr/istanbul/etkinlik/${index}`,
      events: [],
      retiredAt: finishedAt,
    })),
  };
}

async function server(handler) {
  const instance = createServer(handler);
  await new Promise((done) => instance.listen(0, "127.0.0.1", done));
  return { origin: `http://127.0.0.1:${instance.address().port}`, close: () => new Promise((done) => instance.close(done)) };
}

test("completed-import proof is persisted before checkpoint and is absent after a partial import failure", async (t) => {
  let imports = 0, checkpointSeen = false, proof = null;
  const remote = await server((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/admin/import") {
      imports += 1;
      if (imports === 2) { response.statusCode = 500; response.end("{}"); return; }
      response.end('{"imported":3}'); return;
    }
    checkpointSeen = true;
    response.statusCode = 500;
    response.end("{}");
  });
  t.after(remote.close);
  const args = { origin: remote.origin, token: "secret", report: reportWithPages(4), reportSha256: "a".repeat(64), checkpoint: true, allowLoopbackHttp: true, now: () => new Date("2026-10-09T10:01:00.000Z"), onImportsComplete: (value) => { proof = value; } };
  await assert.rejects(publish(args), /Import returned HTTP 500/);
  assert.equal(proof, null);
  assert.equal(checkpointSeen, false);

  imports = 0;
  const checkpointRemote = await server((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/admin/import") { imports += 1; response.end('{"imported":2}'); return; }
    checkpointSeen = true;
    response.statusCode = 500;
    response.end("{}");
  });
  t.after(checkpointRemote.close);
  proof = null;
  checkpointSeen = false;
  await assert.rejects(publish({ ...args, origin: checkpointRemote.origin }), /Checkpoint save returned HTTP 500/);
  assert.equal(checkpointSeen, true);
  assert.equal(proof.proofKind, "imports_complete");
  assert.equal(proof.sentBatches, 2);
  assert.equal(proof.importsComplete, true);
});
