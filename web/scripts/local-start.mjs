import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';
import {
  ensureLocalToken,
  localOrigin,
  requireNode22,
  webRoot,
  devVarsPath,
} from './local-config.mjs';

requireNode22();
const token = await ensureLocalToken();
const { values } = parseArgs({
  options: { dev: { type: 'boolean', default: false } },
});

async function run(command, args, env = process.env) {
  const child = spawn(command, args, { cwd: webRoot, env, stdio: 'inherit' });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) =>
      resolveExit(signal ? 1 : (exitCode ?? 1)),
    );
  });
  if (code !== 0) throw new Error(`${command} exited with status ${code}.`);
}

if (values.dev) {
  console.log(`Starting the HMR development server at ${localOrigin}`);
  await run(
    process.execPath,
    [
      join(webRoot, 'node_modules/vinext/dist/cli.js'),
      'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      '3001',
    ],
    { ...process.env, SYNC_TOKEN: token },
  );
} else {
  console.log('Building the local preview…');
  await run(process.execPath, [
    join(webRoot, 'node_modules/vinext/dist/cli.js'),
    'build',
  ]);
  const build = join(webRoot, 'dist/server');
  const config = JSON.parse(
    await readFile(join(build, 'wrangler.json'), 'utf8'),
  );
  config.main = resolve(build, config.main);
  config.assets.directory = resolve(build, config.assets.directory);
  for (const db of config.d1_databases ?? []) {
    if (db.migrations_dir)
      db.migrations_dir = resolve(build, db.migrations_dir);
  }
  const local = join(webRoot, '.wrangler/local');
  await mkdir(local, { recursive: true });
  let settings = {};
  try {
    settings = parseEnv(await readFile(join(webRoot, '.env'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  settings = {
    ...settings,
    ...parseEnv(await readFile(devVarsPath, 'utf8')),
    SYNC_TOKEN: token,
  };
  // Wrangler loads runtime secrets beside its config. Keep the built artifact
  // secret-free; this separate local configuration is ignored by Git.
  const secretsPath = join(local, '.dev.vars');
  await writeFile(
    secretsPath,
    Object.entries(settings)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  await chmod(secretsPath, 0o600);
  await writeFile(join(local, 'wrangler.json'), JSON.stringify(config));
  console.log(
    `Starting the local preview with persistent D1 at ${localOrigin}`,
  );
  await run(
    process.execPath,
    [
      join(webRoot, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--config',
      join(local, 'wrangler.json'),
      '--ip',
      '127.0.0.1',
      '--port',
      '3001',
      '--persist-to',
      '.wrangler/state',
      '--local',
      '--log-level',
      'warn',
    ],
    { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  );
}
