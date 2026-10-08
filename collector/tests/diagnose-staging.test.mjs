import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { collectDiagnostic, validateDiagnostics } from "../diagnose-staging.mjs";

test("plain platform failures preserve status and digest without preserving response text", async () => {
  const bytes = Buffer.from("Rate exceeded");
  const result = await collectDiagnostic({
    kind: "ready",
    endpoint: new URL("https://service.run.app/api/ready"),
    fetcher: async () => new Response(bytes, { status: 429, headers: { "content-type": "text/plain; charset=utf-8" } }),
  });
  assert.deepEqual(result, {
    schemaVersion: 1,
    kind: "ready",
    httpStatus: 429,
    contentType: "text/plain",
    bytes: bytes.length,
    bodySha256: createHash("sha256").update(bytes).digest("hex"),
    validJson: false,
    value: null,
  });
  assert.doesNotMatch(JSON.stringify(result), /Rate exceeded/);
});

test("invalid readiness reasons cannot be sanitized into an empty success", async () => {
  const result = await collectDiagnostic({
    kind: "ready",
    endpoint: new URL("https://service.run.app/api/ready"),
    fetcher: async () => new Response(JSON.stringify({ ready: true, reasons: ["unexpected reason"] }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.deepEqual(result.value.reasons, ["invalid_reason"]);
});

test("diagnostic validation binds health to the expected runtime and requires canonical proof", () => {
  const revision = "a".repeat(40);
  const results = {
    health: { httpStatus: 200, validJson: true, value: { status: "ok", deployment: { environment: "staging", revision } } },
    ready: { httpStatus: 200, validJson: true, value: { ready: false } },
    canonical: { httpStatus: 200, validJson: true, value: { validSnapshot: true, schemaVersion: 1, savedAt: "2026-10-09T10:00:00.000Z", reportFinishedAt: "2026-10-09T09:00:00.000Z", events: 10, eventsSha256: "b".repeat(64) } },
    publication: { httpStatus: 200, validJson: true, value: { schemaVersion: 1, reportFinishedAt: "2026-10-09T09:00:00.000Z", startedAt: "2026-10-09T09:01:00.000Z", phase: "complete", outcome: "succeeded" } },
  };
  assert.deepEqual(validateDiagnostics(results, revision).problems, []);
  results.canonical.value.eventsSha256 = null;
  assert.deepEqual(validateDiagnostics(results, revision).problems, ["canonical"]);
});
