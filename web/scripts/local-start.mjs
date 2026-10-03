import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

async function run(args, env = process.env, cwd = webRoot) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: 'inherit' });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => resolveExit(signal ? 1 : (exitCode ?? 1)));
  });
  if (code !== 0) throw new Error('Local server step failed.');
}

let settings = {};
for (const path of [join(webRoot, '.env'), devVarsPath]) {
  try {
    settings = { ...settings, ...parseEnv(await readFile(path, 'utf8')) };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const environment = {
  ...settings,
  ...process.env,
  BIPLAN_RUNTIME: 'node',
  SYNC_TOKEN: token,
  HOST: '127.0.0.1',
  HOSTNAME: '127.0.0.1',
  PORT: '3001',
};
if (values.dev) {
  console.log('Starting the Node development server at ' + localOrigin);
  await run([
    join(webRoot, 'node_modules/vinext/dist/cli.js'),
    'dev', '--hostname', '127.0.0.1', '--port', '3001',
  ], environment);
} else {
  console.log('Building the Node preview.');
  await run([join(webRoot, 'scripts/build-node.mjs')]);
  console.log('Starting the Node preview at ' + localOrigin);
  await run(['server.js'], { ...environment, NODE_ENV: 'production' }, join(webRoot, 'dist-node'));
}
