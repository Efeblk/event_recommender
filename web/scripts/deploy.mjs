import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import {
  deploymentEnvironment,
  deploymentMatches,
  deploymentSecrets,
  generateDeploymentConfig,
  validateDeploymentConfig,
} from './deploy-config.mjs';

const args = process.argv.slice(2);
const command = args[0];
const environment = deploymentEnvironment(args);
const dryRun = command === 'dry-run';
if (!['prepare', 'dry-run', 'deploy'].includes(command))
  throw new Error(
    'Usage: deploy.mjs <prepare|dry-run|deploy> --env <staging|production>',
  );

validateDeploymentConfig({
  requireSecrets: command === 'deploy',
  requireRevision: command === 'deploy',
});
const config = await generateDeploymentConfig(environment);
await run('wrangler', ['deploy', '--config', config, '--dry-run']);
if (command === 'prepare' || dryRun) process.exit(0);

const secretDir = await mkdtemp(join(tmpdir(), 'biplan-deploy-'));
const secretFile = join(secretDir, 'secrets.env');
try {
  await writeFile(
    secretFile,
    JSON.stringify(deploymentSecrets()),
    {
      mode: 0o600,
    },
  );
  await run('wrangler', [
    'd1',
    'migrations',
    'apply',
    'DB',
    '--remote',
    '--config',
    config,
  ]);
  await run('wrangler', [
    'deploy',
    '--config',
    config,
    '--strict',
    '--secrets-file',
    secretFile,
    '--message',
    `${environment} ${process.env.DEPLOYMENT_SHA}`,
  ]);
  const health = new URL('/api/health', process.env.CF_PUBLIC_URL);
  await waitForLiveness(health, environment, process.env.DEPLOYMENT_SHA);
  console.log(`Deployment is live at ${health.origin}.`);
  const readiness = new URL('/api/ready', process.env.CF_PUBLIC_URL);
  const response = await fetch(readiness, {
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => ({}));
  if (response.ok && body.ready === true)
    console.log(`Release readiness confirmed at ${readiness}.`);
  else
    console.warn(
      `Deployment is live but not release-ready (HTTP ${response.status}; reasons: ${JSON.stringify(body.reasons ?? ['unknown'])}). Bootstrap the collection checkpoint, then recheck /api/ready before public release.`,
    );
} finally {
  await rm(secretDir, { recursive: true, force: true });
}

async function waitForLiveness(
  url,
  environment,
  revision,
  timeoutMs = 120_000,
) {
  const deadline = Date.now() + timeoutMs;
  let detail = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && deploymentMatches(body, environment, revision)) return;
      detail = `HTTP ${response.status}; deployment identity did not match`;
    } catch (error) {
      detail = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`Liveness check timed out at ${url} (${detail}).`);
}

function run(bin, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, commandArgs, {
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, WRANGLER_WRITE_LOGS: 'false' },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${bin} exited with ${code ?? signal}.`));
    });
  });
}
