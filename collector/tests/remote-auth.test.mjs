import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { requestJson } from "../remote.mjs";

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

void test("the GCP collector stays manual and uses a dedicated identity", async () => {
  const workflow = await readFile(
    resolve(import.meta.dirname, "../../.github/workflows/gcp-collector.yml"),
    "utf8",
  );
  assert.match(workflow, /^\s*workflow_dispatch:\s*$/m);
  assert.doesNotMatch(workflow, /^\s*schedule:\s*$/m);
  assert.match(workflow, /GCP_COLLECTOR_SERVICE_ACCOUNT/);
  assert.match(workflow, /GCP_COLLECTOR_WORKLOAD_IDENTITY_PROVIDER/);
  assert.match(workflow, /token_format: id_token/);
  assert.match(workflow, /id_token_audience: \$\{\{ vars\.BIPLAN_URL \}\}/);
  assert.match(workflow, /SERVERLESS_ID_TOKEN: \$\{\{ steps\.auth_restore\.outputs\.id_token \}\}/);
  assert.match(workflow, /SERVERLESS_ID_TOKEN: \$\{\{ steps\.auth_publish\.outputs\.id_token \}\}/);
  assert.doesNotMatch(workflow, /INDEX_EMBEDDINGS|index-embeddings/);
});
