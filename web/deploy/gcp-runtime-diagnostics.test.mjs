import assert from "node:assert/strict";
import test from "node:test";

import { summarizeRuntime } from "../scripts/summarize-gcp-runtime.mjs";

void test("runtime diagnostics expose an allowlist and omit environment and secret data", () => {
  const revision = "biplan-staging-00042-abc";
  const service = {
    metadata: { name: "biplan-staging", generation: 42, annotations: { secret: "omit" } },
    spec: { template: { spec: { containers: [{ env: [{ name: "SYNC_TOKEN", value: "secret" }] }] } } },
    status: { url: "https://biplan-staging-x.run.app", observedGeneration: 42, latestCreatedRevisionName: revision, latestReadyRevisionName: revision, conditions: [{ type: "Ready", status: "True", message: "omit" }], traffic: [{ revisionName: revision, percent: 100 }] },
  };
  const revisions = [{
    metadata: { name: revision, generation: 1, annotations: { secret: "omit" } },
    spec: { timeoutSeconds: 300, containerConcurrency: 32, containers: [{ image: "private-image", env: [{ name: "SYNC_TOKEN", value: "secret" }], resources: { limits: { cpu: "1", memory: "2Gi" } } }] },
    status: { conditions: [{ type: "Ready", status: "True", reason: "Ready", message: "omit" }] },
  }];
  const result = summarizeRuntime(service, revisions, "a".repeat(40));
  assert.equal(result.service.traffic[0].percent, 100);
  assert.equal(result.revisions[0].resources.limits.memory, "2Gi");
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /SYNC_TOKEN|secret|private-image|message/);
});
