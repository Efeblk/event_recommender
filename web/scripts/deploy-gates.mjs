import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function successfulCoreChecks(payload) {
  const required = [
    'test',
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

export function stagingPromotionReady(health, readiness, revision) {
  return health?.status === 'ok' &&
    health?.deployment?.environment === 'staging' &&
    health?.deployment?.revision === revision &&
    readiness?.ready === true;
}

export function validStagingSource(run, marker, { repository, revision, runId }) {
  return (
    /^\d+$/.test(String(runId)) &&
    run?.id === Number(runId) &&
    run?.event === 'workflow_dispatch' &&
    run?.conclusion === 'success' &&
    run?.repository?.full_name === repository &&
    (run?.path === '.github/workflows/deploy.yml' ||
      run?.path?.startsWith('.github/workflows/deploy.yml@')) &&
    marker?.environment === 'staging' &&
    marker?.revision === revision &&
    marker?.runId === Number(runId)
  );
}

async function main() {
  const [command, ...paths] = process.argv.slice(2);
  if (command === 'checks') {
    if (!successfulCoreChecks(JSON.parse(await readFile(paths[0], 'utf8'))))
      throw new Error('Exact SHA does not have all required successful CI checks.');
  } else if (command === 'staging') {
    const health = JSON.parse(await readFile(paths[0], 'utf8'));
    const readiness = JSON.parse(await readFile(paths[1], 'utf8'));
    if (!stagingPromotionReady(health, readiness, process.env.DEPLOYMENT_SHA))
      throw new Error('Staging is not ready on the exact production candidate SHA.');
  } else if (command === 'source-run') {
    const run = JSON.parse(await readFile(paths[0], 'utf8'));
    const marker = JSON.parse(await readFile(paths[1], 'utf8'));
    if (!validStagingSource(run, marker, {
      repository: process.env.GITHUB_REPOSITORY,
      revision: process.env.DEPLOYMENT_SHA,
      runId: process.env.STAGING_RUN_ID,
    })) throw new Error('The requested run is not a successful staging deployment of this exact SHA.');
  } else throw new Error('Usage: deploy-gates.mjs checks <json> | staging <health-json> <ready-json> | source-run <run-json> <marker-json>');
  console.log(`${command} release gate passed.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
