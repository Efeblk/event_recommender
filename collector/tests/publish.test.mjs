import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { prepareImportPages } from '../publish.mjs';

test('publication preserves quarantine watermarks and rejects conflicting empty states', () => {
  const page = { url: 'https://biletinial.com/tr-tr/tiyatro/example', events: [], quarantinedAt: '2026-09-28T01:00:00.000Z', quarantineReason: 'session_time_conflict' };
  const now = new Date('2026-09-28T02:00:00.000Z');
  assert.deepEqual(prepareImportPages([page], now).pages, [page]);
  assert.deepEqual(prepareImportPages(prepareImportPages([page], now).pages, now).pages, [page]);
  assert.throws(() => prepareImportPages([{ ...page, retiredAt: page.quarantinedAt }], now), /Invalid empty source state/);
  assert.throws(() => prepareImportPages([{ ...page, quarantineReason: 'http_503' }], now), /Invalid empty source state/);
  assert.throws(() => prepareImportPages([{ ...page, quarantinedAt: undefined }], now), /Invalid empty source state/);
});

const publish = resolve(import.meta.dirname, "../publish.mjs");

function invoke(origin, extra = []) {
  return spawnSync(
    process.execPath,
    [publish, "--report", "/definitely/missing-report.json", ...extra],
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
