import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";

import {
  preflightReplay,
  validateReplayArtifact,
  validateReplayProvenance,
  verifyReplay,
} from "../replay-publication.mjs";

const sourceSha = "a".repeat(40);
const runId = "37846165394";
const workflowId = 1234;

function provenance(overrides = {}) {
  const artifact = { id: 88, name: `gcp-event-data-staging-${runId}`, expired: false };
  return {
    runId,
    repository: "owner/repository",
    repositoryId: "42",
    defaultBranch: "master",
    workflowPath: ".github/workflows/gcp-collector.yml",
    run: {
      id: Number(runId),
      repository: { id: 42, full_name: "owner/repository" },
      head_repository: { id: 42 },
      path: ".github/workflows/gcp-collector.yml",
      workflow_id: workflowId,
      head_branch: "master",
      head_sha: sourceSha,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
      ...overrides.run,
    },
    workflow: { id: workflowId, path: ".github/workflows/gcp-collector.yml", ...overrides.workflow },
    artifacts: { total_count: (overrides.artifacts ?? [artifact]).length, artifacts: overrides.artifacts ?? [artifact] },
  };
}

function reportFixture(now = new Date("2026-10-09T10:00:00.000Z")) {
  const finishedAt = new Date(now.getTime() - 60_000).toISOString();
  return {
    now,
    report: {
      schemaVersion: 1,
      startedAt: new Date(now.getTime() - 120_000).toISOString(),
      finishedAt,
      pages: [{ source: "bubilet", url: "https://www.bubilet.com.tr/istanbul/etkinlik/one", events: [], retiredAt: finishedAt }],
      summary: { blocked: null, sources: { bubilet: 0 } },
    },
  };
}

test("replay provenance accepts one failed master run and rejects foreign or ambiguous artifacts", () => {
  const valid = validateReplayProvenance(provenance());
  assert.equal(valid.sourceHeadSha, sourceSha);
  assert.equal(valid.artifact.name, `gcp-event-data-staging-${runId}`);
  assert.throws(() => validateReplayProvenance(provenance({ run: { head_repository: { id: 9 } } })), /repository/);
  assert.throws(() => validateReplayProvenance(provenance({ run: { path: ".github/workflows/other.yml" } })), /workflow identity/);
  assert.throws(() => validateReplayProvenance(provenance({ run: { conclusion: "success" } })), /failed collection/);
  const duplicate = { id: 89, name: `gcp-event-data-staging-${runId}`, expired: false };
  assert.throws(() => validateReplayProvenance(provenance({ artifacts: [provenance().artifacts.artifacts[0], duplicate] })), /Expected one/);
});

test("replay artifact pins exact bytes, source revision and production import validation", () => {
  const source = validateReplayProvenance(provenance());
  const { report, now } = reportFixture();
  const bytes = Buffer.from(JSON.stringify(report));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const result = validateReplayArtifact({ source, reportBytes: bytes, rawManifest: { collectorRevision: sourceSha }, expectedReportSha256: digest, now });
  assert.equal(result.report.pages, 1);
  assert.equal(result.report.preparedBatches, 1);
  assert.throws(() => validateReplayArtifact({ source, reportBytes: bytes, rawManifest: { collectorRevision: "b".repeat(40) }, expectedReportSha256: digest, now }), /revision/);
  assert.throws(() => validateReplayArtifact({ source, reportBytes: bytes, rawManifest: { collectorRevision: sourceSha }, expectedReportSha256: "b".repeat(64), now }), /SHA-256/);
  const blocked = Buffer.from(JSON.stringify({ ...report, summary: { ...report.summary, blocked: "crawl_failed" } }));
  assert.throws(() => validateReplayArtifact({ source, reportBytes: blocked, rawManifest: { collectorRevision: sourceSha }, expectedReportSha256: createHash("sha256").update(blocked).digest("hex"), now }), /not publishable/);
  const invalid = Buffer.from(JSON.stringify({ ...report, pages: [{ ...report.pages[0], url: "https://example.com/not-a-provider" }] }));
  assert.throws(() => validateReplayArtifact({ source, reportBytes: invalid, rawManifest: { collectorRevision: sourceSha }, expectedReportSha256: createHash("sha256").update(invalid).digest("hex"), now }), /Invalid source page/);
});

async function fixture(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("replay preflight rejects a wrong runtime and any newer active checkpoint", async (t) => {
  let revision = sourceSha;
  let activeFinishedAt = "2026-10-09T09:00:00.000Z";
  const remote = await fixture((request, response) => {
    if (request.url === "/api/health") return send(response, 200, { status: "ok", deployment: { environment: "staging", revision } });
    return send(response, 200, { schemaVersion: 1, savedAt: "2026-10-09T09:01:00.000Z", events: [], report: { finishedAt: activeFinishedAt, summary: {} } });
  });
  t.after(remote.close);
  const targetFinishedAt = "2026-10-09T10:00:00.000Z";
  assert.equal((await preflightReplay({ origin: remote.origin, token: "secret", expectedRevision: sourceSha, targetFinishedAt, allowLoopbackHttp: true })).publishRequired, true);
  revision = "b".repeat(40);
  await assert.rejects(preflightReplay({ origin: remote.origin, token: "secret", expectedRevision: sourceSha, targetFinishedAt, allowLoopbackHttp: true }), /revision/);
  revision = sourceSha;
  activeFinishedAt = "2026-10-09T11:00:00.000Z";
  await assert.rejects(preflightReplay({ origin: remote.origin, token: "secret", expectedRevision: sourceSha, targetFinishedAt, allowLoopbackHttp: true }), /newer/);
});

test("replay verification requires exact checkpoint and readiness timestamps", async (t) => {
  const finishedAt = "2026-10-09T10:00:00.000Z";
  const deploymentRevision = "d".repeat(40);
  let readyFinishedAt = finishedAt;
  let readyStatus = 200, readyReasons = [];
  const remote = await fixture((request, response) => {
    if (request.url === "/api/admin/collection") return send(response, 200, {
      schemaVersion: 1, savedAt: "2026-10-09T10:01:00.000Z", events: [{ id: "one" }], report: { finishedAt, summary: {} },
    });
    return send(response, readyStatus, { ready: readyStatus === 200, reasons: readyReasons, search: { pending: false, latestCollectedAt: readyFinishedAt, activeCollectedAt: readyFinishedAt }, checkpoint: { finishedAt: readyFinishedAt } });
  });
  t.after(remote.close);
  const plan = { schemaVersion: 1, sourceRunId: runId, sourceHeadSha: sourceSha, reportSha256: "c".repeat(64), report: { finishedAt } };
  const preflight = { schemaVersion: 1, deploymentRevision, targetFinishedAt: finishedAt, publishRequired: true };
  const eventsSha256 = createHash("sha256").update(JSON.stringify([{ id: "one" }])).digest("hex");
  const publication = { checkpointed: true, canonicalReadback: true, artifactOnly: false, savedAt: "2026-10-09T10:01:00.000Z", reportFinishedAt: finishedAt, events: 1, eventsSha256, environment: "staging", revision: deploymentRevision };
  const result = await verifyReplay({ origin: remote.origin, token: "secret", plan, preflight, publication, allowLoopbackHttp: true });
  assert.equal(result.summary.completed, true);
  assert.deepEqual(result.summary.problems, []);
  assert.equal(result.readyStatus, "200");
  assert.equal(result.summary.checkpointEventsSha256, eventsSha256);
  const wrongReceipt = { ...publication, eventsSha256: "e".repeat(64) };
  const receiptMismatch = await verifyReplay({ origin: remote.origin, token: "secret", plan, preflight, publication: wrongReceipt, allowLoopbackHttp: true });
  assert.deepEqual(receiptMismatch.summary.problems, ["publication_readback_mismatch"]);
  readyFinishedAt = "2026-10-09T09:00:00.000Z";
  const mismatch = await verifyReplay({ origin: remote.origin, token: "secret", plan, preflight, publication, allowLoopbackHttp: true });
  assert.deepEqual(mismatch.summary.problems, ["ready_publication_mismatch"]);
  readyFinishedAt = finishedAt;
  readyStatus = 503;
  readyReasons = ["catalog_not_ready"];
  const unavailable = await verifyReplay({ origin: remote.origin, token: "secret", plan, preflight, publication, allowLoopbackHttp: true });
  assert.equal(unavailable.readyStatus, "503");
  assert.deepEqual(unavailable.ready.reasons, ["catalog_not_ready"]);
  assert.deepEqual(unavailable.summary.problems, ["ready_http", "ready_state"]);
});
