import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

function condition(value) {
  return {
    type: typeof value?.type === "string" ? value.type : null,
    status: typeof value?.status === "string" ? value.status : null,
    reason: typeof value?.reason === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value.reason) ? value.reason : null,
  };
}

export function summarizeRuntime(service, revisions, expectedRevision) {
  if (!/^[0-9a-f]{40}$/.test(expectedRevision)) throw new Error("Expected revision is invalid.");
  if (!service?.metadata?.name || !Array.isArray(revisions) || revisions.length === 0)
    throw new Error("Cloud Run diagnostic input is incomplete.");
  return {
    schemaVersion: 1,
    expectedRevision,
    service: {
      name: service.metadata.name,
      url: typeof service.status?.url === "string" ? service.status.url : null,
      generation: Number.isSafeInteger(service.metadata?.generation) ? service.metadata.generation : null,
      observedGeneration: Number.isSafeInteger(service.status?.observedGeneration) ? service.status.observedGeneration : null,
      latestCreatedRevisionName: service.status?.latestCreatedRevisionName ?? null,
      latestReadyRevisionName: service.status?.latestReadyRevisionName ?? null,
      conditions: (service.status?.conditions ?? []).map(condition),
      traffic: (service.status?.traffic ?? []).map((item) => ({ revisionName: item.revisionName ?? null, percent: Number.isInteger(item.percent) ? item.percent : null, tag: item.tag ?? null, latestRevision: item.latestRevision === true })),
    },
    revisions: revisions.map((revision) => {
      const container = revision.spec?.containers?.[0] ?? {};
      return {
        name: revision.metadata?.name ?? null,
        generation: Number.isSafeInteger(revision.metadata?.generation) ? revision.metadata.generation : null,
        conditions: (revision.status?.conditions ?? []).map(condition),
        resources: {
          limits: {
            cpu: typeof container.resources?.limits?.cpu === "string" ? container.resources.limits.cpu : null,
            memory: typeof container.resources?.limits?.memory === "string" ? container.resources.limits.memory : null,
          },
        },
        timeoutSeconds: Number.isSafeInteger(revision.spec?.timeoutSeconds) ? revision.spec.timeoutSeconds : null,
        containerConcurrency: Number.isSafeInteger(revision.spec?.containerConcurrency) ? revision.spec.containerConcurrency : null,
      };
    }),
  };
}

async function main() {
  const [servicePath, outputPath, expectedRevision, ...revisionPaths] = process.argv.slice(2);
  if (!servicePath || !outputPath || !expectedRevision || !revisionPaths.length) throw new Error("Usage: summarize-gcp-runtime service.json output.json expectedRevision revision.json...");
  const service = JSON.parse(await readFile(servicePath, "utf8"));
  const revisions = await Promise.all(revisionPaths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const value = summarizeRuntime(service, revisions, expectedRevision);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(outputPath, `${JSON.stringify(value, null, 2)}\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
