import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const MAX_COLLECTION_GAP_MS = 15 * 60 * 60 * 1000;
const MAX_MONITOR_GAP_MS = 90 * 60 * 1000;
const EXPECTED_SOURCES = ["biletinial", "bubilet", "biletix"];

function isoTime(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function streamSummary(records, timestamp) {
  const times = records.map(timestamp).map(isoTime).filter((time) => time !== null).sort((a, b) => a - b);
  const gaps = times.slice(1).map((time, index) => time - times[index]);
  return {
    records: records.length,
    first: times.length ? new Date(times[0]).toISOString() : null,
    last: times.length ? new Date(times.at(-1)).toISOString() : null,
    spanHours: times.length > 1 ? (times.at(-1) - times[0]) / 3_600_000 : 0,
    maxGapHours: gaps.length ? Math.max(...gaps) / 3_600_000 : null,
  };
}

function validProvenance(record) {
  return (
    typeof record.provenance?.githubRunId === "string" &&
    /^\d+$/.test(record.provenance.githubRunId) &&
    typeof record.provenance?.githubRunAttempt === "string" &&
    /^\d+$/.test(record.provenance.githubRunAttempt)
  );
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

export function verifySoakEvidence({ collections, monitors, environment, revision }) {
  const reasons = [];
  if (!['staging', 'production'].includes(environment)) reasons.push("invalid_environment");
  if (!/^[0-9a-f]{40}$/.test(revision)) reasons.push("invalid_revision");
  if (!collections.length) reasons.push("collections_missing");
  if (!monitors.length) reasons.push("monitors_missing");
  for (const [name, records] of [["collection", collections], ["monitor", monitors]]) {
    const ids = records.map((record) => record.provenance?.githubRunId ?? "");
    if (new Set(ids).size !== ids.length) reasons.push(`${name}_run_provenance_reused`);
  }

  for (const [index, record] of collections.entries()) {
    const label = `collection[${index}]`;
    if (record.schemaVersion !== 2 || record.kind !== "collection-run") reasons.push(`${label}:invalid_schema`);
    if (record.environment !== environment) reasons.push(`${label}:wrong_environment`);
    if (record.revision !== revision) reasons.push(`${label}:wrong_revision`);
    if (!validProvenance(record)) reasons.push(`${label}:missing_github_provenance`);
    if (record.provenance?.githubEventName !== "schedule") reasons.push(`${label}:not_scheduled`);
    if (isoTime(record.run?.finishedAt) === null) reasons.push(`${label}:invalid_finished_at`);
    if (record.publication?.artifactOnly !== false) reasons.push(`${label}:artifact_only_or_unknown`);
    if (record.publication?.canonicalReadback !== true) reasons.push(`${label}:canonical_readback_missing`);
    const missing = new Set(record.sourceHealth?.missingSources ?? []);
    for (const source of EXPECTED_SOURCES) {
      if (!Object.hasOwn(record.sourceHealth?.refreshedPages ?? {}, source)) reasons.push(`${label}:source_unreported:${source}`);
      else if (!positiveInteger(record.sourceHealth.refreshedPages[source]) || missing.has(source)) reasons.push(`${label}:source_unhealthy:${source}`);
    }
  }

  for (const [index, record] of monitors.entries()) {
    const label = `monitor[${index}]`;
    if (record.schemaVersion !== 1 || record.kind !== "readiness-monitor") reasons.push(`${label}:invalid_schema`);
    if (record.environment !== environment) reasons.push(`${label}:wrong_environment`);
    if (record.revision !== revision) reasons.push(`${label}:wrong_revision`);
    if (!validProvenance(record)) reasons.push(`${label}:missing_github_provenance`);
    if (record.provenance?.githubEventName !== "schedule") reasons.push(`${label}:not_scheduled`);
    if (isoTime(record.recordedAt) === null) reasons.push(`${label}:invalid_recorded_at`);
    if (record.ready !== true) reasons.push(`${label}:not_ready${Array.isArray(record.reasons) && record.reasons.length ? `:${record.reasons.join('|')}` : ''}`);
  }

  const collection = streamSummary(collections, (record) => record.run?.finishedAt);
  const collectionTimes = collections.map((record) => isoTime(record.run?.finishedAt)).filter((time) => time !== null).sort((a, b) => a - b);
  const collectionGaps = collectionTimes.slice(1).map((time, index) => time - collectionTimes[index]);
  const monitoring = streamSummary(monitors, (record) => record.recordedAt);
  const overlapStart = Math.max(collectionTimes[0] ?? Infinity, isoTime(monitoring.first) ?? Infinity);
  const overlapEnd = Math.min(collectionTimes.at(-1) ?? -Infinity, isoTime(monitoring.last) ?? -Infinity);
  const overlapHours = Number.isFinite(overlapStart) && Number.isFinite(overlapEnd) ? Math.max(0, overlapEnd - overlapStart) / 3_600_000 : 0;
  if (overlapHours < 48) reasons.push("healthy_overlap_under_48h");
  if (collectionGaps.some((gap) => gap > MAX_COLLECTION_GAP_MS)) reasons.push("collection_interval_missed");
  const monitorTimes = monitors.map((record) => isoTime(record.recordedAt)).filter((time) => time !== null).sort((a, b) => a - b);
  if (monitorTimes.slice(1).some((time, index) => time - monitorTimes[index] > MAX_MONITOR_GAP_MS)) reasons.push("monitor_interval_missed");

  return {
    schemaVersion: 1,
    status: reasons.length ? "fail" : "pass",
    environment,
    revision,
    thresholds: { minimumSpanHours: 48, maximumCollectionGapHours: 15, maximumMonitorGapMinutes: 90 },
    collection,
    monitoring,
    overlap: { first: overlapHours ? new Date(overlapStart).toISOString() : null, last: overlapHours ? new Date(overlapEnd).toISOString() : null, spanHours: overlapHours },
    reasons: [...new Set(reasons)],
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    environment: { type: "string" }, revision: { type: "string" },
    collection: { type: "string", multiple: true, default: [] },
    monitor: { type: "string", multiple: true, default: [] },
  } });
  if (!values.environment || !values.revision) throw new Error("Usage: soak-verify --environment <staging|production> --revision <40hex> --collection <file>... --monitor <file>...");
  const collections = await Promise.all(values.collection.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const monitors = await Promise.all(values.monitor.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const result = verifySoakEvidence({ collections, monitors, environment: values.environment, revision: values.revision });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "pass") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
