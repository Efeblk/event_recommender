import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildRoot = join(webRoot, 'dist/server');
const sourceConfig = join(buildRoot, 'wrangler.json');
const temporaryRoot = await mkdtemp(join(tmpdir(), 'biplan-browser-'));
const temporaryConfig = join(temporaryRoot, 'wrangler.json');

let child;
let stopping = false;

async function cleanup() {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function stop(signal) {
  if (stopping) return;
  stopping = true;
  if (child && child.exitCode === null) child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void stop(signal));
}

try {
  const config = JSON.parse(await readFile(sourceConfig, 'utf8'));
  config.main = resolve(buildRoot, config.main);
  config.assets.directory = resolve(buildRoot, config.assets.directory);
  config.vars = {
    EMBEDDING_ENABLED: 'false',
    AI_DAILY_LIMIT: '100',
  };
  config.d1_databases = (config.d1_databases ?? []).map((binding) => ({
    ...binding,
    database_name: 'biplan-isolated-browser',
    database_id: '00000000-0000-4000-8000-000000000000',
    ...(binding.migrations_dir
      ? { migrations_dir: resolve(buildRoot, binding.migrations_dir) }
      : {}),
    remote: false,
  }));
  config.r2_buckets = (config.r2_buckets ?? []).map((binding) => ({
    ...binding,
    bucket_name: 'biplan-isolated-browser-state',
    remote: false,
  }));
  config.observability = { enabled: false };

  await writeFile(temporaryConfig, JSON.stringify(config));

  const environment = { ...process.env };
  for (const name of [
    'AI_API_KEY',
    'AI_BASE_URL',
    'AI_MODEL',
    'EMBEDDING_API_KEY',
    'EMBEDDING_BASE_URL',
    'EMBEDDING_MODEL',
    'OPENAI_API_KEY',
    'OPENAI_MODEL',
    'TYPESAFE_API_KEY',
    'TYPESAFE_MODEL',
    'VOYAGE_API_KEY',
    'VOYAGE_MODEL',
    'SYNC_TOKEN',
  ]) {
    delete environment[name];
  }
  environment.WRANGLER_SEND_METRICS = 'false';
  environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = 'false';
  environment.WRANGLER_LOG_PATH = join(temporaryRoot, 'logs');

  child = spawn(
    process.execPath,
    [
      join(webRoot, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--config',
      temporaryConfig,
      '--ip',
      '127.0.0.1',
      '--port',
      '4173',
      '--local',
      '--log-level',
      'warn',
    ],
    { cwd: temporaryRoot, env: environment, stdio: 'inherit' },
  );
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolveExit(signal && stopping ? 0 : (code ?? 1)),
    );
  });
  process.exitCode = exitCode;
} finally {
  await cleanup();
}
