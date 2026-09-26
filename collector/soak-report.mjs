import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { atomicJson } from "./remote.mjs";

export function buildSoakEvidence(report, events, recordedAt = new Date(), operational = {}) {
  const started = Date.parse(report.startedAt), finished = Date.parse(report.finishedAt);
  const expectedSources = Object.keys(report.summary?.sources ?? {});
  const refreshedBySource = Object.fromEntries(expectedSources.map((source) => [source, report.pages.filter((page) => page.source === source).length]));
  const missingSources = expectedSources.filter((source) => refreshedBySource[source] === 0);
  return {
    schemaVersion: 2,
    kind: "collection-run",
    environment: operational.environment ?? null,
    revision: operational.revision ?? null,
    provenance: operational.provenance ?? null,
    publication: operational.publication ?? { artifactOnly: true, canonicalReadback: false },
    recordedAt: recordedAt.toISOString(),
    run: { startedAt: report.startedAt, finishedAt: report.finishedAt, durationSeconds: Number.isFinite(finished - started) ? Math.max(0, Math.round((finished - started) / 1000)) : null },
    checkpoint: { events: events.length, sources: Object.fromEntries([...new Set(events.map((event) => event.source))].sort().map((source) => [source, events.filter((event) => event.source === source).length])) },
    sourceHealth: { refreshedPages: refreshedBySource, missingSources },
    collectionSummary: report.summary,
    observation: "This file records one real collection run. It does not claim that a 48-hour soak has completed.",
  };
}

async function main() {
  const { values } = parseArgs({ options: { report: { type: "string", default: "output/report.json" }, output: { type: "string", default: "output/soak-evidence.json" }, checkpoint: { type: "string", default: "state/events.json" }, publication: { type: "string" } } });
  const report = JSON.parse(await readFile(resolve(values.report), "utf8"));
  const events = JSON.parse(await readFile(resolve(values.checkpoint), "utf8"));
  const publication = values.publication ? JSON.parse(await readFile(resolve(values.publication), "utf8")) : null;
  const evidence = buildSoakEvidence(report, events, new Date(), {
    environment: publication?.environment ?? process.env.COLLECTION_ENVIRONMENT ?? null,
    revision: publication?.revision ?? null,
    provenance: process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT ? { githubRunId: process.env.GITHUB_RUN_ID, githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT, githubEventName: process.env.GITHUB_EVENT_NAME ?? null, collectorRevision: process.env.COLLECTOR_REVISION ?? process.env.GITHUB_SHA ?? null } : null,
    publication: publication ? { artifactOnly: publication.artifactOnly, canonicalReadback: publication.canonicalReadback, savedAt: publication.savedAt } : { artifactOnly: true, canonicalReadback: false },
  });
  await atomicJson(resolve(values.output), evidence);
  console.log(JSON.stringify(evidence));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
