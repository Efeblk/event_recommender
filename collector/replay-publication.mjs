import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { validateImport } from "../web/lib/catalog.ts";
import { collectDiagnostic } from "./diagnose-staging.mjs";
import { planImportBatches } from "./publish.mjs";
import { atomicJson, endpointFor, requestJson, validateCollection } from "./remote.mjs";

const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const LEGACY_CHECKPOINT_REPLAY_SHA = "fedb97fbe9075f698d702ae7e6e464338669eb71";

function canonicalTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value ? value : null;
}

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateReplayProvenance({
  runId,
  repository,
  repositoryId,
  defaultBranch,
  workflowPath,
  run,
  workflow,
  artifacts,
}) {
  requireValue(/^[1-9][0-9]*$/.test(runId), "Invalid source workflow run id.");
  requireValue(run && String(run.id) === runId, "Source workflow run id does not match.");
  requireValue(run.repository?.full_name === repository && String(run.repository?.id) === repositoryId,
    "Source workflow repository does not match.");
  requireValue(String(run.head_repository?.id) === repositoryId, "Source workflow head repository does not match.");
  requireValue(run.path === workflowPath && workflow?.path === workflowPath && run.workflow_id === workflow?.id,
    "Source workflow identity does not match.");
  requireValue(run.head_branch === defaultBranch && shaPattern.test(run.head_sha),
    "Source workflow revision is invalid.");
  requireValue(["workflow_dispatch", "schedule"].includes(run.event), "Source workflow event is invalid.");
  requireValue(run.status === "completed" && run.conclusion === "failure",
    "Only a completed failed collection run can be replayed.");
  const expectedArtifact = `gcp-event-data-staging-${runId}`;
  requireValue(Number.isSafeInteger(artifacts?.total_count) && artifacts.total_count === artifacts.artifacts?.length,
    "Source workflow artifact inventory is incomplete.");
  const matches = Array.isArray(artifacts?.artifacts)
    ? artifacts.artifacts.filter((artifact) => artifact?.name === expectedArtifact && artifact.expired === false)
    : [];
  requireValue(matches.length === 1, "Expected one unexpired normalized collection artifact.");
  requireValue(Number.isSafeInteger(matches[0].id) && matches[0].id > 0,
    "Normalized collection artifact identity is invalid.");
  return {
    schemaVersion: 1,
    sourceRunId: runId,
    sourceHeadSha: run.head_sha,
    sourceEvent: run.event,
    sourceConclusion: run.conclusion,
    workflowId: run.workflow_id,
    artifact: { id: matches[0].id, name: expectedArtifact },
  };
}

export function validateReplayArtifact({ source, reportBytes, rawManifest, expectedReportSha256, now = new Date() }) {
  requireValue(source?.schemaVersion === 1 && shaPattern.test(source.sourceHeadSha),
    "Source provenance summary is invalid.");
  requireValue(digestPattern.test(expectedReportSha256), "Invalid expected report SHA-256.");
  const actualReportSha256 = sha256(reportBytes);
  requireValue(actualReportSha256 === expectedReportSha256, "Collection report SHA-256 does not match.");
  let report;
  try { report = JSON.parse(reportBytes); }
  catch { throw new Error("Collection report is not valid JSON."); }
  requireValue(report?.schemaVersion === 1 && !report.summary?.blocked && Array.isArray(report.pages) && report.pages.length > 0,
    "Collection report is not publishable.");
  const startedAt = canonicalTimestamp(report.startedAt), finishedAt = canonicalTimestamp(report.finishedAt);
  requireValue(startedAt && finishedAt && Date.parse(startedAt) <= Date.parse(finishedAt),
    "Collection report timestamps are invalid.");
  requireValue(rawManifest?.collectorRevision === source.sourceHeadSha,
    "Collection artifact revision does not match its source workflow run.");
  const plan = planImportBatches(report, now);
  for (const pages of plan.batches) validateImport({ schemaVersion: 1, pages }, now);
  return {
    schemaVersion: 1,
    sourceRunId: source.sourceRunId,
    sourceHeadSha: source.sourceHeadSha,
    artifact: source.artifact,
    reportSha256: actualReportSha256,
    report: {
      startedAt,
      finishedAt,
      pages: report.pages.length,
      preparedBatches: plan.batches.length,
      preparedPages: plan.batches.reduce((sum, pages) => sum + pages.length, 0),
      preparedEvents: plan.batches.reduce((sum, pages) => sum + pages.reduce((count, page) => count + page.events.length, 0), 0),
    },
  };
}

export function validateLegacyCheckpointProof({
  failedRunId, repository, repositoryId, defaultBranch, workflowPath, run, workflow, artifacts, jobs,
  originalPlan, failedSource, failedPlan, failedPreflight, failedPublication,
  failedStatus, logsArchiveBytes, logsText, expectedLogsSha256, publishSource,
}) {
  requireValue(/^[1-9][0-9]*$/.test(failedRunId) && String(run?.id) === failedRunId,
    "Failed replay run identity is invalid.");
  requireValue(run?.repository?.full_name === repository && String(run?.repository?.id) === repositoryId &&
    String(run?.head_repository?.id) === repositoryId, "Failed replay repository does not match.");
  requireValue(run?.path === workflowPath && workflow?.path === workflowPath && run.workflow_id === workflow?.id,
    "Failed replay workflow identity does not match.");
  requireValue(run?.event === "workflow_dispatch" && run?.status === "completed" && run?.conclusion === "failure" &&
    run?.head_branch === defaultBranch && run?.head_sha === LEGACY_CHECKPOINT_REPLAY_SHA,
    "Failed replay run is not the pinned completed trusted manual run.");
  const artifactName = `gcp-publication-replay-staging-${failedRunId}-${run.run_attempt}`;
  const matches = artifacts?.artifacts?.filter((artifact) => artifact?.name === artifactName && artifact.expired === false) ?? [];
  requireValue(Number.isSafeInteger(artifacts?.total_count) && artifacts.total_count === artifacts.artifacts?.length &&
    matches.length === 1, "Failed replay evidence artifact is missing or ambiguous.");
  const matchingJobs = jobs?.jobs?.filter((job) => job?.run_id === run.id && job?.name === "replay_publication" &&
    job?.head_sha === run.head_sha && job?.status === "completed" && job?.conclusion === "failure") ?? [];
  requireValue(Number.isSafeInteger(jobs?.total_count) && jobs.total_count === jobs.jobs?.length && matchingJobs.length === 1,
    "Failed replay job identity is missing or ambiguous.");
  requireValue(originalPlan?.schemaVersion === 1 && digestPattern.test(originalPlan.reportSha256) &&
    canonicalTimestamp(originalPlan.report?.finishedAt), "Original replay plan is invalid.");
  requireValue(failedSource?.sourceRunId === originalPlan.sourceRunId && failedSource?.sourceHeadSha === originalPlan.sourceHeadSha,
    "Failed replay source evidence does not match the original report.");
  requireValue(failedPlan?.sourceRunId === originalPlan.sourceRunId && failedPlan?.sourceHeadSha === originalPlan.sourceHeadSha &&
    failedPlan?.reportSha256 === originalPlan.reportSha256 && failedPlan?.report?.finishedAt === originalPlan.report.finishedAt,
    "Failed replay plan does not match the original report.");
  requireValue(failedPreflight?.deploymentRevision === run.head_sha &&
    failedPreflight?.targetFinishedAt === originalPlan.report.finishedAt && failedPreflight?.publishRequired === true,
    "Failed replay did not require publication of this report.");
  requireValue(failedStatus.trim() === "failed" && failedPublication?.checkpointed !== true,
    "Failed replay status cannot prove an interrupted checkpoint request.");
  requireValue(digestPattern.test(expectedLogsSha256) && sha256(logsArchiveBytes) === expectedLogsSha256,
    "Failed replay log archive SHA-256 does not match.");
  const callSite = publishSource.split(/\r?\n/)[145] ?? "";
  requireValue(callSite.includes("await requestJson(collectionEndpoint") && /publish\.mjs:146:\d+/.test(logsText),
    "Failed replay logs do not contain the exact checkpoint call-site stack.");
  return {
    schemaVersion: 1,
    proofKind: "legacy_checkpoint_call_site",
    importsComplete: true,
    reportSha256: originalPlan.reportSha256,
    reportFinishedAt: originalPlan.report.finishedAt,
    sourceRunId: originalPlan.sourceRunId,
    failedReplayRunId: failedRunId,
    failedReplayHeadSha: run.head_sha,
    failedReplayArtifact: artifactName,
    failedReplayJobId: matchingJobs[0].id,
    logsSha256: expectedLogsSha256,
    checkpointCallSite: "collector/publish.mjs:146",
    imported: null,
    omissions: null,
  };
}

export async function preflightReplay({ origin, token, expectedRevision, targetFinishedAt, allowLoopbackHttp = false }) {
  requireValue(shaPattern.test(expectedRevision), "Expected deployment revision is invalid.");
  requireValue(canonicalTimestamp(targetFinishedAt), "Target collection timestamp is invalid.");
  const health = await requestJson(endpointFor(origin, "/api/health", allowLoopbackHttp), { timeout: 15_000 });
  requireValue(health.response.ok && health.result?.status === "ok" && health.result?.deployment?.environment === "staging" &&
    health.result?.deployment?.revision === expectedRevision, "Target staging deployment revision does not match the source run.");
  const active = await requestJson(endpointFor(origin, "/api/admin/collection", allowLoopbackHttp), { token, timeout: 30_000 });
  let activeFinishedAt = null;
  if (active.response.status === 200) activeFinishedAt = validateCollection(active.result).report.finishedAt;
  else requireValue(active.response.status === 404, `Checkpoint preflight returned HTTP ${active.response.status}.`);
  requireValue(!activeFinishedAt || Date.parse(activeFinishedAt) <= Date.parse(targetFinishedAt),
    "The active checkpoint is newer than the replay target.");
  return {
    schemaVersion: 1,
    deploymentRevision: expectedRevision,
    targetFinishedAt,
    activeFinishedAt,
    publishRequired: activeFinishedAt !== targetFinishedAt,
  };
}

export async function verifyReplay({ origin, token, plan, preflight, publication, allowLoopbackHttp = false }) {
  requireValue(plan?.schemaVersion === 1 && canonicalTimestamp(plan.report?.finishedAt), "Replay plan is invalid.");
  requireValue(preflight?.schemaVersion === 1 && shaPattern.test(preflight.deploymentRevision) &&
    preflight.targetFinishedAt === plan.report.finishedAt,
    "Replay preflight does not match the plan.");
  const problems = [];
  if (preflight.publishRequired) {
    if (!(publication?.checkpointed === true && publication.canonicalReadback === true &&
      publication.artifactOnly === false && publication.reportFinishedAt === plan.report.finishedAt &&
      canonicalTimestamp(publication.savedAt) && Number.isSafeInteger(publication.events) && publication.events >= 0 &&
      digestPattern.test(publication.eventsSha256) && publication.environment === "staging" &&
      publication.revision === preflight.deploymentRevision))
      problems.push("publication_receipt");
  }
  async function diagnostic(kind, pathname, applicationToken) {
    try {
      return await collectDiagnostic({ kind, endpoint: endpointFor(origin, pathname, allowLoopbackHttp), token: applicationToken, serverlessToken: process.env.SERVERLESS_ID_TOKEN });
    } catch (error) {
      return { schemaVersion: 1, kind, httpStatus: null, contentType: null, bytes: null, bodySha256: null, validJson: false, value: null,
        error: error?.name === "TimeoutError" ? "timeout" : "request_failed" };
    }
  }
  const [checkpoint, ready] = await Promise.all([
    diagnostic("canonical", "/api/admin/collection", token),
    diagnostic("ready", "/api/ready"),
  ]);
  let canonical = null;
  if (checkpoint.httpStatus !== 200) problems.push("checkpoint_http");
  else if (checkpoint.value?.validSnapshot !== true) problems.push("checkpoint_invalid");
  else canonical = checkpoint.value;
  if (canonical && canonical.reportFinishedAt !== plan.report.finishedAt)
    problems.push("checkpoint_mismatch");
  const checkpointEventsSha256 = canonical?.eventsSha256 ?? null;
  if (preflight.publishRequired && canonical &&
    (canonical.savedAt !== publication?.savedAt || canonical.events !== publication?.events ||
      checkpointEventsSha256 !== publication?.eventsSha256))
    problems.push("publication_readback_mismatch");
  const body = ready.value;
  if (ready.httpStatus !== 200) problems.push("ready_http");
  if (!(body?.ready === true && Array.isArray(body.reasons) && body.reasons.length === 0))
    problems.push("ready_state");
  if (!(body?.search?.pending === false && body.search?.latestCollectedAt === plan.report.finishedAt &&
    body.search?.activeCollectedAt === plan.report.finishedAt && body.checkpoint?.finishedAt === plan.report.finishedAt))
    problems.push("ready_publication_mismatch");
  return {
    summary: {
      schemaVersion: 1,
      completed: true,
      sourceRunId: plan.sourceRunId,
      sourceHeadSha: plan.sourceHeadSha,
      reportSha256: plan.reportSha256,
      reportFinishedAt: plan.report.finishedAt,
      checkpointSavedAt: canonical?.savedAt ?? null,
      checkpointEvents: canonical?.events ?? null,
      checkpointEventsSha256,
      publication: preflight.publishRequired ? "published" : "already_active",
      readyHttpStatus: ready.httpStatus,
      ready: body?.ready === true,
      reasons: Array.isArray(body?.reasons) && body.reasons.every(reason => typeof reason === "string")
        ? body.reasons.map(reason => /^[a-z0-9_:-]{1,80}$/.test(reason) ? reason : "invalid_reason").slice(0, 20) : null,
      problems,
    },
    ready,
    readyStatus: String(ready.httpStatus),
  };
}

async function json(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function output(name, value, path) {
  if (path) await appendFile(resolve(path), `${name}=${value}\n`);
}

async function main() {
  const { values } = parseArgs({ options: {
    mode: { type: "string" }, "run-id": { type: "string" }, "report-sha256": { type: "string" },
    repository: { type: "string" }, "repository-id": { type: "string" }, "default-branch": { type: "string" },
    "workflow-path": { type: "string" }, run: { type: "string" }, workflow: { type: "string" },
    artifacts: { type: "string" }, jobs: { type: "string" }, source: { type: "string" }, report: { type: "string" },
    manifest: { type: "string" }, plan: { type: "string" }, preflight: { type: "string" },
    publication: { type: "string" }, output: { type: "string" }, "github-output": { type: "string" },
    "expected-revision": { type: "string" },
    status: { type: "string" }, "failed-run-id": { type: "string" }, "failed-source": { type: "string" },
    "failed-plan": { type: "string" }, "failed-preflight": { type: "string" }, "failed-publication": { type: "string" },
    "failed-status": { type: "string" }, "logs-archive": { type: "string" }, "logs-text": { type: "string" },
    "logs-sha256": { type: "string" }, "publish-source": { type: "string" },
    "allow-loopback-http": { type: "boolean", default: false },
  } });
  if (values.mode === "metadata") {
    const result = validateReplayProvenance({ runId: values["run-id"], repository: values.repository,
      repositoryId: values["repository-id"], defaultBranch: values["default-branch"], workflowPath: values["workflow-path"],
      run: await json(values.run), workflow: await json(values.workflow), artifacts: await json(values.artifacts) });
    await atomicJson(resolve(values.output), result);
    await output("source_sha", result.sourceHeadSha, values["github-output"]);
    await output("artifact_name", result.artifact.name, values["github-output"]);
    return;
  }
  if (values.mode === "artifact") {
    const result = validateReplayArtifact({ source: await json(values.source), reportBytes: await readFile(resolve(values.report)),
      rawManifest: await json(values.manifest), expectedReportSha256: values["report-sha256"] });
    await atomicJson(resolve(values.output), result);
    await output("report_finished_at", result.report.finishedAt, values["github-output"]);
    return;
  }
  if (values.mode === "legacy-proof") {
    const result = validateLegacyCheckpointProof({
      failedRunId: values["failed-run-id"], repository: values.repository, repositoryId: values["repository-id"], defaultBranch: values["default-branch"],
      workflowPath: values["workflow-path"], run: await json(values.run), workflow: await json(values.workflow),
      artifacts: await json(values.artifacts), jobs: await json(values.jobs), originalPlan: await json(values.plan), failedSource: await json(values["failed-source"]),
      failedPlan: await json(values["failed-plan"]), failedPreflight: await json(values["failed-preflight"]),
      failedPublication: await json(values["failed-publication"]), failedStatus: await readFile(resolve(values["failed-status"]), "utf8"),
      logsArchiveBytes: await readFile(resolve(values["logs-archive"])), logsText: await readFile(resolve(values["logs-text"]), "utf8"),
      expectedLogsSha256: values["logs-sha256"], publishSource: await readFile(resolve(values["publish-source"]), "utf8"),
    });
    await atomicJson(resolve(values.output), result);
    return;
  }
  const { BIPLAN_URL: origin, SYNC_TOKEN: token } = process.env;
  requireValue(origin && token, "Set BIPLAN_URL and SYNC_TOKEN in the runner secret store.");
  if (values.mode === "preflight") {
    const plan = await json(values.plan);
    const result = await preflightReplay({ origin, token, expectedRevision: values["expected-revision"],
      targetFinishedAt: plan.report.finishedAt, allowLoopbackHttp: values["allow-loopback-http"] });
    await atomicJson(resolve(values.output), result);
    await output("publish_required", String(result.publishRequired), values["github-output"]);
    return;
  }
  if (values.mode === "verify") {
    const plan = await json(values.plan), preflight = await json(values.preflight);
    const publication = values.publication ? await json(values.publication) : null;
    const result = await verifyReplay({ origin, token, plan, preflight, publication,
      allowLoopbackHttp: values["allow-loopback-http"] });
    await atomicJson(resolve(values.output), result.summary);
    await writeFile(resolve(values.source), `${JSON.stringify(result.ready, null, 2)}\n`);
    await writeFile(resolve(values.status), `${result.readyStatus}\n`);
    if (result.summary.problems.length) throw new Error(`Replay verification failed: ${result.summary.problems.join(",")}`);
    return;
  }
  throw new Error("Unknown replay publication mode.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
