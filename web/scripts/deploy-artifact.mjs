import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const evidence = join(root, 'deploy-provenance');
const manifestPath = join(evidence, 'compiled-sha256.json');
const ignoredConfig = /^server\/wrangler\.(staging|production)\.json$/;

async function files(directory, base = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in deployment artifact: ${path}`);
    if (entry.isDirectory()) result.push(...(await files(path, base)));
    else if (entry.isFile()) result.push(relative(base, path).replaceAll('\\', '/'));
  }
  return result.sort(codeUnitCompare);
}

function codeUnitCompare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function digest(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

export async function compiledManifest() {
  const names = (await files(dist)).filter((name) => !ignoredConfig.test(name));
  return Object.fromEntries(
    await Promise.all(names.map(async (name) => [name, await digest(join(dist, name))])),
  );
}

function safeManifest(manifest) {
  if (!manifest || Array.isArray(manifest) || typeof manifest !== 'object') return false;
  const names = Object.keys(manifest);
  return names.length > 0 && names.every(
    (name) =>
      name &&
      !name.startsWith('/') &&
      !name.includes('\\') &&
      !name.split('/').includes('..') &&
      /^[0-9a-f]{64}$/.test(manifest[name]),
  );
}

export function verifyManifestEntries(expected, actual) {
  if (!safeManifest(expected)) throw new Error('Deployment manifest contains an unsafe or invalid entry.');
  const expectedNames = Object.keys(expected).sort(codeUnitCompare);
  const actualNames = Object.keys(actual).sort(codeUnitCompare);
  if (
    expectedNames.length !== actualNames.length ||
    expectedNames.some(
      (name, index) =>
        name !== actualNames[index] || expected[name] !== actual[name],
    )
  )
    throw new Error('Compiled deployment artifact does not match its SHA-256 manifest.');
}

export async function createDeploymentEvidence() {
  const revision = process.env.DEPLOYMENT_SHA;
  if (!/^[0-9a-f]{40}$/.test(revision ?? ''))
    throw new Error('DEPLOYMENT_SHA must be a lowercase 40-character commit SHA.');
  await mkdir(evidence, { recursive: true });
  if ((await files(dist)).some((name) => ignoredConfig.test(name)))
    throw new Error('Prepared artifact must not contain an environment-specific Wrangler config.');
  const manifest = await compiledManifest();
  if (!Object.keys(manifest).length) throw new Error('Compiled deployment artifact is empty.');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const lockfiles = {};
  for (const name of ['package-lock.json', '../collector/package-lock.json'])
    lockfiles[name] = await digest(resolve(root, name));
  const npm = (
    process.platform === 'win32'
      ? execFileSync(process.env.ComSpec || 'cmd.exe', [
          '/d',
          '/s',
          '/c',
          'npm --version',
        ], { encoding: 'utf8' })
      : execFileSync('npm', ['--version'], { encoding: 'utf8' })
  ).trim();
  const packageLock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const wrangler = packageLock.packages?.['node_modules/wrangler']?.version;
  await writeFile(
    join(evidence, 'provenance.json'),
    `${JSON.stringify({ revision, node: process.version, npm, wrangler, lockfiles, compiledManifest: 'compiled-sha256.json', generatedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

export async function verifyDeploymentEvidence({ allowGeneratedConfig = false, markerPath } = {}) {
  const configs = (await files(dist)).filter((name) => ignoredConfig.test(name));
  if (
    (!allowGeneratedConfig && configs.length) ||
    configs.some((name) => name !== `server/wrangler.${process.env.DEPLOY_TARGET}.json`)
  )
    throw new Error('Deployment artifact contains an unexpected environment-specific Wrangler config.');
  const expected = JSON.parse(await readFile(manifestPath, 'utf8'));
  const actual = await compiledManifest();
  verifyManifestEntries(expected, actual);
  const provenance = JSON.parse(await readFile(join(evidence, 'provenance.json'), 'utf8'));
  if (provenance.revision !== process.env.DEPLOYMENT_SHA)
    throw new Error('Deployment artifact revision does not match DEPLOYMENT_SHA.');
  if (markerPath) {
    const marker = JSON.parse(await readFile(markerPath, 'utf8'));
    const manifestHash = await digest(manifestPath);
    if (marker.manifestSha256 !== manifestHash)
      throw new Error('Promoted artifact does not match the staging deployment evidence.');
  }
}

export async function assertSecretsAbsent(secretValues) {
  const secrets = secretValues.filter((value) => value?.trim()).map((value) => Buffer.from(value));
  if (!secrets.length) return;
  for (const name of await files(dist)) {
    const content = await readFile(join(dist, name));
    if (secrets.some((secret) => content.indexOf(secret) >= 0))
      throw new Error(`Deployment artifact contains a configured secret: ${name}`);
  }
}

async function main() {
  const command = process.argv[2];
  if (command === 'create') await createDeploymentEvidence();
  else if (command === 'verify')
    await verifyDeploymentEvidence({ markerPath: process.argv[3] });
  else throw new Error('Usage: deploy-artifact.mjs <create|verify>');
  console.log(`Deployment artifact ${command} completed.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
