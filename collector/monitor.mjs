import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { atomicJson, endpointFor, requestJson } from "./remote.mjs";

export async function checkReady({ origin, allowLoopbackHttp = false }) {
  const endpoint = endpointFor(origin, "/api/ready", allowLoopbackHttp);
  const { response, result } = await requestJson(endpoint, { timeout: 15_000 });
  const reasons = Array.isArray(result?.reasons)
    ? result.reasons
        .filter((reason) => typeof reason === "string")
        .slice(0, 10)
        .map((reason) => reason.replace(/[^a-zA-Z0-9_:., -]/g, "?").slice(0, 160))
    : [];
  const detail = reasons.length ? reasons.join(", ") : "readiness requirements were not met";
  if (!response.ok) throw new Error(`Readiness returned HTTP ${response.status}: ${detail}`);
  if (result?.ready !== true) throw new Error(`Readiness returned HTTP 200 but ready was not true: ${detail}`);
  return result;
}

async function main() {
  const { values } = parseArgs({ options: { environment: { type: "string" }, output: { type: "string" }, "allow-loopback-http": { type: "boolean", default: false } } });
  if (!values.environment || !["staging", "production"].includes(values.environment)) throw new Error("--environment must be staging or production.");
  if (!values.output) throw new Error("--output is required for durable monitoring evidence.");
  const evidence = {
    schemaVersion: 1, kind: "readiness-monitor", recordedAt: new Date().toISOString(),
    environment: values.environment, revision: null, ready: false, reasons: [],
    provenance: process.env.GITHUB_RUN_ID && process.env.GITHUB_RUN_ATTEMPT ? { githubRunId: process.env.GITHUB_RUN_ID, githubRunAttempt: process.env.GITHUB_RUN_ATTEMPT, githubEventName: process.env.GITHUB_EVENT_NAME ?? null } : null,
  };
  let failure = null;
  try {
    if (!process.env.BIPLAN_URL) throw new Error("biplan_url_missing");
    const health = await requestJson(endpointFor(process.env.BIPLAN_URL, "/api/health", values["allow-loopback-http"]), { timeout: 15_000 });
    if (!health.response.ok || health.result?.status !== "ok") throw new Error(`health_http_${health.response.status}`);
    if (health.result?.deployment?.environment !== values.environment) throw new Error("health_environment_mismatch");
    if (!/^[0-9a-f]{40}$/.test(health.result?.deployment?.revision ?? "")) throw new Error("health_revision_invalid");
    evidence.revision = health.result.deployment.revision;
    await checkReady({ origin: process.env.BIPLAN_URL, allowLoopbackHttp: values["allow-loopback-http"] });
    evidence.ready = true;
  } catch (error) {
    failure = error instanceof Error ? error.message.replace(/[^a-zA-Z0-9_:., -]/g, "?").slice(0, 160) : "monitor_failed";
    evidence.reasons = [failure];
  }
  await atomicJson(resolve(values.output), evidence);
  console.log(JSON.stringify(evidence));
  if (failure) throw new Error(failure);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
