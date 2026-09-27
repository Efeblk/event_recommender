import { writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export function endpointFor(origin, pathname, allowLoopbackHttp = false) {
  const endpoint = new URL(pathname, origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || (endpoint.protocol !== "https:" && !(allowLoopbackHttp && endpoint.protocol === "http:" && loopback)))
    throw new Error("Remote access requires HTTPS. For a local server only, use --allow-loopback-http with localhost, 127.0.0.1, or [::1].");
  return endpoint;
}

export async function readJson(response, limit = 20_000_000) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("Remote response exceeded the size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

export async function requestJson(endpoint, { token, serverlessToken = process.env.SERVERLESS_ID_TOKEN, method = "GET", body, timeout = 60_000 } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Cloud Run consumes this header for IAM while leaving Authorization for
  // the application's independent sync-token check.
  if (serverlessToken) headers["X-Serverless-Authorization"] = `Bearer ${serverlessToken}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (process.env.SITES_ACCESS_TOKEN) headers["OAI-Sites-Authorization"] = `Bearer ${process.env.SITES_ACCESS_TOKEN}`;
  const response = await fetch(endpoint, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(timeout) });
  return { response, result: await readJson(response) };
}

export function validateCollection(value) {
  if (
    value?.schemaVersion !== 1 ||
    !validTimestamp(value.savedAt) ||
    !Array.isArray(value.events) ||
    value.events.length > 20_000 ||
    value.events.some((event) => !event || typeof event !== "object" || Array.isArray(event)) ||
    !validTimestamp(value.report?.finishedAt) ||
    !value.report?.summary ||
    typeof value.report.summary !== "object" ||
    Array.isArray(value.report.summary)
  )
    throw new Error("Collection endpoint returned an invalid snapshot.");
  return value;
}

export function validateEventArray(value, label = "Snapshot") {
  if (!Array.isArray(value) || value.length > 20_000 || value.some((event) => !event || typeof event !== "object" || Array.isArray(event)))
    throw new Error(`${label} must be an array of at most 20,000 event objects.`);
  return value;
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}
