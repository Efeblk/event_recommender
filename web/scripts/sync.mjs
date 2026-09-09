// Run from a scheduler with BIPLAN_URL and SYNC_TOKEN set in its secret store.
const origin = process.env.BIPLAN_URL;
const token = process.env.SYNC_TOKEN;
if (!origin || !token) throw new Error('Set BIPLAN_URL and SYNC_TOKEN.');
const url = new URL('/api/admin/sync', origin);
if (
  url.protocol !== 'https:' &&
  url.hostname !== 'localhost' &&
  url.hostname !== '127.0.0.1'
)
  throw new Error('Remote synchronization requires HTTPS.');
const response = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  signal: AbortSignal.timeout(240000),
  redirect: 'error',
});
if (!response.ok) throw new Error(`Sync returned HTTP ${response.status}.`);
const data = await response.json();
console.log(JSON.stringify(data));
if (data.failures?.length || data.embeddingError) process.exitCode = 1;
