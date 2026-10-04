import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { requestJson } from "../remote.mjs";
import { collectionGate } from "../schedule-gate.mjs";

void test("Cloud Run IAM identity does not replace application authorization", async (t) => {
  let received;
  const server = createServer((request, response) => {
    received = request.headers;
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const endpoint = new URL(`http://127.0.0.1:${server.address().port}/api/admin/collection`);
  const { response, result } = await requestJson(endpoint, {
    token: "sync-secret",
    serverlessToken: "iam-identity",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(result, { ok: true });
  assert.equal(received.authorization, "Bearer sync-secret");
  assert.equal(received["x-serverless-authorization"], "Bearer iam-identity");
});

void test("the Cloud Run identity header remains optional", async (t) => {
  let received;
  const server = createServer((request, response) => {
    received = request.headers;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const endpoint = new URL(`http://127.0.0.1:${server.address().port}/`);
  await requestJson(endpoint, { token: "sync-secret", serverlessToken: "" });
  assert.equal(received.authorization, "Bearer sync-secret");
  assert.equal(received["x-serverless-authorization"], undefined);
});

void test("the GCP collector schedule is opt-in and uses a dedicated identity", async () => {
  const workflow = await readFile(
    resolve(import.meta.dirname, "../../.github/workflows/gcp-collector.yml"),
    "utf8",
  );
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.match(workflow, /^\s*schedule:\s*$/m);
  // Cloud Scheduler dispatches collection (mode=collect); GitHub never schedules it.
  assert.doesNotMatch(workflow, /cron: '17 /);
  assert.match(workflow, /options: \[collect, index\]/);
  assert.match(workflow, /if: github\.event_name == 'workflow_dispatch' && inputs\.mode != 'index'/);
  // The hourly schedule and mode=index only index; they never start collection.
  assert.match(workflow, /cron: '47 \* \* \* \*'/);
  assert.match(workflow, /if: \(github\.event\.schedule == '47 \* \* \* \*' \|\| \(github\.event_name == 'workflow_dispatch' && inputs\.mode == 'index'\)\) && vars\.GCP_STAGING_INDEXING_ENABLED == 'true'/);
  assert.match(workflow, /GCP_STAGING_COLLECTION_UNTIL/);
  assert.match(workflow, /needs\.schedule_gate\.outputs\.run == 'true'/);
  assert.match(workflow, /environment: gcp-staging-collector/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /--max-details 2000 --max-http 6000 --max-minutes 40 --discovery-pages 20/);
  assert.match(workflow, /actions\/cache\/restore@v4/);
  assert.match(workflow, /collector\/state\/coverage\.json/);
  assert.match(workflow, /GCP_COLLECTOR_SERVICE_ACCOUNT/);
  assert.match(workflow, /GCP_COLLECTOR_WORKLOAD_IDENTITY_PROVIDER/);
  assert.match(workflow, /token_format: id_token/);
  assert.match(workflow, /id_token_audience: \$\{\{ vars\.BIPLAN_URL \}\}/);
  assert.match(workflow, /SERVERLESS_ID_TOKEN: \$\{\{ steps\.auth_restore\.outputs\.id_token \}\}/);
  assert.match(workflow, /SERVERLESS_ID_TOKEN: \$\{\{ steps\.auth_publish\.outputs\.id_token \}\}/);
  assert.doesNotMatch(workflow, /INDEX_EMBEDDINGS|index-embeddings/);
});

void test("the scheduled GCP collector deadline fails closed", () => {
  const now = Date.parse("2026-09-27T10:00:00.000Z");
  const gate = (values = {}) =>
    collectionGate({ eventName: "schedule", enabled: "true", until: "", now, ...values });

  assert.deepEqual(
    collectionGate({ eventName: "workflow_dispatch", enabled: "", until: "", now }),
    { run: true, reason: "manual" },
  );
  assert.deepEqual(gate({ enabled: "false" }), { run: false, reason: "disabled" });
  assert.deepEqual(gate(), { run: false, reason: "invalid_deadline" });
  assert.deepEqual(gate({ until: "2026-09-30" }), {
    run: false,
    reason: "invalid_deadline",
  });
  assert.deepEqual(gate({ until: "2026-09-31T10:00:00.000Z" }), {
    run: false,
    reason: "invalid_deadline",
  });
  assert.deepEqual(gate({ until: "2026-09-27T10:00:00.000Z" }), {
    run: false,
    reason: "expired",
  });
  assert.deepEqual(gate({ until: "2026-09-30T10:00:00.001Z" }), {
    run: false,
    reason: "window_exceeds_60h",
  });
  assert.deepEqual(gate({ until: "2026-09-29T22:00:00.000Z" }), {
    run: true,
    reason: "scheduled_window",
  });
  assert.deepEqual(gate({ until: "open" }), { run: true, reason: "open_schedule" });
  assert.deepEqual(gate({ enabled: "false", until: "open" }), { run: false, reason: "disabled" });
  assert.deepEqual(gate({ until: "Open" }), { run: false, reason: "invalid_deadline" });
});
