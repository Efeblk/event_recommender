import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function rollbackDeploymentMatches(deployment, versionId) {
  if (!deployment || !Array.isArray(deployment.versions)) return false;
  return (
    deployment.versions.length === 1 &&
    deployment.versions[0]?.version_id?.toLowerCase() ===
      versionId.toLowerCase() &&
    Number(deployment.versions[0]?.percentage) === 100
  );
}

async function main() {
  const [deploymentPath, versionId] = process.argv.slice(2);
  if (!deploymentPath || !versionId)
    throw new Error(
      'Usage: verify-rollback.mjs <deployment-status.json> <version-id>',
    );
  const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'));
  if (!rollbackDeploymentMatches(deployment, versionId))
    throw new Error(
      'Cloudflare has not routed 100% of active traffic to the requested rollback version.',
    );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
