import { readFile } from "node:fs/promises";
const origin = process.env.BIPLAN_URL,
  token = process.env.SYNC_TOKEN;
if (!origin || !token) throw new Error("Set BIPLAN_URL and SYNC_TOKEN in the runner secret store.");
const endpoint = new URL("/api/admin/import", origin);
if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
  throw new Error("Publishing requires a trusted HTTPS origin.");
const report = JSON.parse(await readFile(new URL("./output/report.json", import.meta.url), "utf8"));
if (report.schemaVersion !== 1 || report.summary?.blocked || !report.pages?.length)
  throw new Error("Only a validated, successful collection can be imported.");
const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
if (process.env.SITES_ACCESS_TOKEN)
  headers["OAI-Sites-Authorization"] = `Bearer ${process.env.SITES_ACCESS_TOKEN}`;
let batch = [],
  bytes = 0;
async function send() {
  if (!batch.length) return;
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ schemaVersion: 1, pages: batch }),
    redirect: "error",
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok)
    throw new Error(
      `Import returned HTTP ${response.status}; successful earlier batches are safe to retry.`,
    );
  const result = await response.json();
  console.log(`Imported ${result.imported} records; skipped ${result.skipped} older pages.`);
  batch = [];
  bytes = 0;
}
for (const page of report.pages) {
  const minimal = { url: page.url, events: page.events },
    size = Buffer.byteLength(JSON.stringify(minimal));
  if (size > 3500000) throw new Error("A source page exceeds the import limit.");
  if (batch.length >= 30 || bytes + size > 3500000) await send();
  batch.push(minimal);
  bytes += size;
}
await send();
