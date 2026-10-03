// The browser suite uses mocked API responses. This process has no cloud or AI credentials.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { webRoot, requireNode22 } from './local-config.mjs';

requireNode22();
let stopping = false;
const child = spawn(process.execPath, ['server.js'], {
  cwd: join(webRoot, 'dist-node'),
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    HOSTNAME: '127.0.0.1',
    PORT: '4173',
    DEPLOYMENT_ENV: 'staging',
    DEPLOYMENT_SHA: 'isolated-browser',
    BIPLAN_CLIENT_IP_MODE: 'shared',
  },
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    if (child.exitCode === null) child.kill(signal);
  });
}
process.exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => resolveExit(signal && stopping ? 0 : (code ?? 1)));
});
