import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allowed = new Set(['staging', 'production']);
const required = [
  'CLOUDFLARE_ACCOUNT_ID',
  'CF_WORKER_NAME',
  'CF_D1_DATABASE_NAME',
  'CF_D1_DATABASE_ID',
  'CF_R2_BUCKET_NAME',
  'CF_PUBLIC_URL',
];

export function deploymentEnvironment(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--env');
  const argumentEnvironment = index >= 0 ? argv[index + 1] : undefined;
  if (
    argumentEnvironment &&
    process.env.DEPLOY_TARGET &&
    argumentEnvironment !== process.env.DEPLOY_TARGET
  )
    throw new Error('--env must match DEPLOY_TARGET when both are set.');
  const environment = argumentEnvironment ?? process.env.DEPLOY_TARGET;
  if (!allowed.has(environment))
    throw new Error('Deployment environment must be staging or production.');
  return environment;
}

export function validateDeploymentConfig({
  requireSecrets = false,
  requireRevision = false,
  environment = deploymentEnvironment(),
} = {}) {
  const missing = required.filter((name) => !process.env[name]?.trim());
  if (requireSecrets) {
    for (const name of ['CLOUDFLARE_API_TOKEN', 'SYNC_TOKEN'])
      if (!process.env[name]?.trim()) missing.push(name);
  }
  if (requireRevision && !process.env.DEPLOYMENT_SHA?.trim())
    missing.push('DEPLOYMENT_SHA');
  if (missing.length)
    throw new Error(`Missing deployment configuration: ${missing.join(', ')}`);
  const checked = [
    ...required,
    ...(requireSecrets ? ['CLOUDFLARE_API_TOKEN', 'SYNC_TOKEN'] : []),
    ...(process.env.DEPLOYMENT_SHA ? ['DEPLOYMENT_SHA'] : []),
    ...(process.env.TYPESAFE_API_KEY ? ['TYPESAFE_API_KEY'] : []),
    ...(process.env.TYPESAFE_MODEL ? ['TYPESAFE_MODEL'] : []),
    ...(process.env.VOYAGE_API_KEY ? ['VOYAGE_API_KEY'] : []),
    ...(process.env.VOYAGE_MODEL ? ['VOYAGE_MODEL'] : []),
    ...(process.env.VOYAGE_DIMENSIONS ? ['VOYAGE_DIMENSIONS'] : []),
    ...(process.env.AI_DAILY_LIMIT ? ['AI_DAILY_LIMIT'] : []),
  ];
  const multiline = checked.filter((name) => /[\r\n]/.test(process.env[name]));
  if (multiline.length)
    throw new Error(
      `Deployment values must be single-line: ${multiline.join(', ')}`,
    );
  const dailyLimit = process.env.AI_DAILY_LIMIT || '100';
  if (
    !/^\d+$/.test(dailyLimit) ||
    Number(dailyLimit) < 1 ||
    Number(dailyLimit) > 10000
  )
    throw new Error('AI_DAILY_LIMIT must be an integer from 1 to 10000.');
  const model = process.env.TYPESAFE_MODEL || 'jev-1.13.0';
  if (!/^jev-[a-z0-9.-]+$/.test(model))
    throw new Error('TYPESAFE_MODEL must be a valid Jev model name.');
  const voyageModel = process.env.VOYAGE_MODEL || 'voyage-4-large';
  if (!['voyage-4-large', 'voyage-4', 'voyage-4-lite'].includes(voyageModel))
    throw new Error(
      'VOYAGE_MODEL must be voyage-4-large, voyage-4, or voyage-4-lite.',
    );
  const voyageDimensions = process.env.VOYAGE_DIMENSIONS || '1024';
  if (!['256', '512', '1024', '2048'].includes(voyageDimensions))
    throw new Error('VOYAGE_DIMENSIONS must be 256, 512, 1024, or 2048.');
  if (!/^[0-9a-f]{32}$/i.test(process.env.CLOUDFLARE_ACCOUNT_ID))
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal ID.',
    );
  if (!isCanonicalUuid(process.env.CF_D1_DATABASE_ID))
    throw new Error('CF_D1_DATABASE_ID must be a canonical UUID.');
  if (
    process.env.DEPLOYMENT_SHA &&
    !/^[0-9a-f]{40}$/.test(process.env.DEPLOYMENT_SHA)
  )
    throw new Error(
      'DEPLOYMENT_SHA must be a lowercase 40-character commit SHA.',
    );
  const otherEnvironment = environment === 'staging' ? 'production' : 'staging';
  for (const name of [
    'CF_WORKER_NAME',
    'CF_D1_DATABASE_NAME',
    'CF_R2_BUCKET_NAME',
  ])
    if (
      !process.env[name].toLowerCase().includes(environment) ||
      process.env[name].toLowerCase().includes(otherEnvironment)
    )
      throw new Error(
        `${name} must include "${environment}" and exclude "${otherEnvironment}".`,
      );
  const url = new URL(process.env.CF_PUBLIC_URL);
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('CF_PUBLIC_URL must be an HTTPS origin without a path.');
  if (
    url.hostname.endsWith('.workers.dev') &&
    !url.hostname.startsWith(`${process.env.CF_WORKER_NAME.toLowerCase()}.`)
  )
    throw new Error(
      'A workers.dev CF_PUBLIC_URL must start with CF_WORKER_NAME.',
    );
}

export function publicDeploymentVariables(environment) {
  return {
    DEPLOYMENT_ENV: environment,
    ...(process.env.DEPLOYMENT_SHA
      ? { DEPLOYMENT_SHA: process.env.DEPLOYMENT_SHA }
      : {}),
    SITE_URL: new URL(process.env.CF_PUBLIC_URL).origin,
    TYPESAFE_MODEL: process.env.TYPESAFE_MODEL || 'jev-1.13.0',
    VOYAGE_MODEL: process.env.VOYAGE_MODEL || 'voyage-4-large',
    VOYAGE_DIMENSIONS: process.env.VOYAGE_DIMENSIONS || '1024',
    AI_DAILY_LIMIT: process.env.AI_DAILY_LIMIT || '100',
  };
}

export function deploymentSecrets() {
  return {
    SYNC_TOKEN: process.env.SYNC_TOKEN,
    ...(process.env.TYPESAFE_API_KEY?.trim()
      ? { TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY }
      : {}),
    ...(process.env.VOYAGE_API_KEY?.trim()
      ? { VOYAGE_API_KEY: process.env.VOYAGE_API_KEY }
      : {}),
  };
}

export function deploymentMatches(body, environment, revision) {
  return (
    body?.status === 'ok' &&
    body?.deployment?.environment === environment &&
    body?.deployment?.revision === revision
  );
}

function isCanonicalUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export async function generateDeploymentConfig(environment) {
  validateDeploymentConfig();
  const sourcePath = join(root, 'dist/server/wrangler.json');
  const config = JSON.parse(await readFile(sourcePath, 'utf8'));
  config.name = process.env.CF_WORKER_NAME;
  config.account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
  config.d1_databases = [
    {
      binding: 'DB',
      database_name: process.env.CF_D1_DATABASE_NAME,
      database_id: process.env.CF_D1_DATABASE_ID,
      migrations_dir: '../../drizzle',
    },
  ];
  config.r2_buckets = [
    {
      binding: 'COLLECTION_STATE',
      bucket_name: process.env.CF_R2_BUCKET_NAME,
    },
  ];
  // Only public, explicitly selected variables belong in deploy artifacts.
  config.vars = publicDeploymentVariables(environment);
  config.limits = { cpu_ms: 30_000 };
  config.observability = {
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 0.1, invocation_logs: false },
    traces: { enabled: false },
  };
  delete config.topLevelName;
  const output = join(root, 'dist/server', `wrangler.${environment}.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const environment = deploymentEnvironment();
    if (process.argv.includes('--validate-only')) {
      validateDeploymentConfig({
        requireSecrets: process.argv.includes('--require-secrets'),
      });
      console.log(`Validated ${environment} deployment configuration.`);
      process.exit(0);
    }
    const output = await generateDeploymentConfig(environment);
    console.log(`Validated and generated ${output}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
