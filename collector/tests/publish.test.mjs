import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

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
