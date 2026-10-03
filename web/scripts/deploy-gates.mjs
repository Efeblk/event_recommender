import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function successfulCoreChecks(payload) {
  const required = [
    'collector (ubuntu-latest)',
    'collector (windows-latest)',
    'verify (ubuntu-latest)',
    'verify (windows-latest)',
  ];
  const checks = payload?.check_runs ?? [];
  return required.every((name) => {
    const latest = checks
      .filter(
        (check) =>
          check.name === name && check.app?.slug === 'github-actions',
      )
      .sort(compareNewestCheck)[0];
    return latest?.status === 'completed' && latest?.conclusion === 'success';
  });
}

function compareNewestCheck(a, b) {
  const aStarted = Date.parse(a.started_at ?? '') || 0;
  const bStarted = Date.parse(b.started_at ?? '') || 0;
  if (aStarted !== bStarted) return bStarted - aStarted;
  const aId = /^\d+$/.test(String(a.id ?? '')) ? BigInt(a.id) : 0n;
  const bId = /^\d+$/.test(String(b.id ?? '')) ? BigInt(b.id) : 0n;
  return aId < bId ? 1 : aId > bId ? -1 : 0;
}

async function main() {
  const [command, path] = process.argv.slice(2);
  if (command !== 'checks' || !path)
    throw new Error('Usage: deploy-gates.mjs checks <json>');
  if (!successfulCoreChecks(JSON.parse(await readFile(path, 'utf8'))))
    throw new Error('Exact SHA does not have all required successful CI checks.');
  console.log('Core CI checks passed.');
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
