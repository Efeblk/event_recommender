import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { endpointFor, requestJson } from "./remote.mjs";

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
  const { values } = parseArgs({ options: { "allow-loopback-http": { type: "boolean", default: false } } });
  if (!process.env.BIPLAN_URL) throw new Error("Set BIPLAN_URL to monitor readiness.");
  console.log(JSON.stringify(await checkReady({ origin: process.env.BIPLAN_URL, allowLoopbackHttp: values["allow-loopback-http"] })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
