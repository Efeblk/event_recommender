import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { atomicJson, endpointFor, requestJson, validateCollection, validateEventArray } from "./remote.mjs";

export async function restoreCheckpoint({ origin, token, output, fallback, allowLoopbackHttp = false }) {
  const endpoint = endpointFor(origin, "/api/admin/collection", allowLoopbackHttp);
  const { response, result } = await requestJson(endpoint, { token, timeout: 30_000 });
  if (response.status === 404) {
    if (!fallback) throw new Error("No durable checkpoint exists and no bootstrap snapshot was supplied.");
    const contents = await readFile(fallback);
    if (contents.byteLength > 20_000_000) throw new Error("Bootstrap snapshot exceeds the 20 MB limit.");
    await atomicJson(output, validateEventArray(JSON.parse(contents.toString("utf8")), "Bootstrap snapshot"));
    return { status: "bootstrap", events: null };
  }
  if (!response.ok) throw new Error(`Checkpoint restore returned HTTP ${response.status}; refusing repository fallback.`);
  const snapshot = validateCollection(result);
  await atomicJson(output, snapshot.events);
  return { status: "restored", events: snapshot.events.length, savedAt: snapshot.savedAt };
}

async function main() {
  const { values } = parseArgs({ options: { output: { type: "string", default: "state/events.json" }, fallback: { type: "string" }, "allow-loopback-http": { type: "boolean", default: false } } });
  const { BIPLAN_URL: origin, SYNC_TOKEN: token } = process.env;
  if (!origin || !token) throw new Error("Set BIPLAN_URL and SYNC_TOKEN to restore a checkpoint.");
  console.log(JSON.stringify(await restoreCheckpoint({ origin, token, output: resolve(values.output), fallback: values.fallback ? resolve(values.fallback) : undefined, allowLoopbackHttp: values["allow-loopback-http"] })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
