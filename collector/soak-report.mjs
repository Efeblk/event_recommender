import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { atomicJson } from "./remote.mjs";

const { values } = parseArgs({ options: { report: { type: "string", default: "output/report.json" }, output: { type: "string", default: "output/soak-evidence.json" }, checkpoint: { type: "string", default: "state/events.json" } } });
const report = JSON.parse(await readFile(resolve(values.report), "utf8"));
const events = JSON.parse(await readFile(resolve(values.checkpoint), "utf8"));
const started = Date.parse(report.startedAt), finished = Date.parse(report.finishedAt);
const expectedSources = Object.keys(report.summary?.sources ?? {});
const refreshedBySource = Object.fromEntries(expectedSources.map((source) => [source, report.pages.filter((page) => page.source === source).length]));
const missingSources = expectedSources.filter((source) => Number(report.summary.sources[source]) > 0 && refreshedBySource[source] === 0);
const evidence = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  run: { startedAt: report.startedAt, finishedAt: report.finishedAt, durationSeconds: Number.isFinite(finished - started) ? Math.max(0, Math.round((finished - started) / 1000)) : null },
  checkpoint: { events: events.length, sources: Object.fromEntries([...new Set(events.map((event) => event.source))].sort().map((source) => [source, events.filter((event) => event.source === source).length])) },
  sourceHealth: { refreshedPages: refreshedBySource, missingSources },
  collectionSummary: report.summary,
  observation: "This file records one real collection run. It does not claim that a 48-hour soak has completed.",
};
await atomicJson(resolve(values.output), evidence);
console.log(JSON.stringify(evidence));
