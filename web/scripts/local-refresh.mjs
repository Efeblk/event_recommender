import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  ensureLocalToken,
  localOrigin,
  projectRoot,
  requireNode22,
  waitForHealth,
} from './local-config.mjs';

requireNode22();
const { values } = parseArgs({
  options: {
    collect: { type: 'boolean', default: false },
    report: { type: 'string' },
    origin: { type: 'string', default: localOrigin },
  },
});
const origin = new URL(values.origin);
if (
  origin.protocol !== 'http:' ||
  !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
  origin.username ||
  origin.password ||
  origin.pathname !== '/' ||
  origin.search ||
  origin.hash
)
  throw new Error(
    '--origin must be an HTTP loopback origin without credentials, path, query, or fragment.',
  );
if (values.collect && values.report)
  throw new Error(
    'Use either --collect for the default report or --report <path> for an existing report, not both.',
  );

const collectorRoot = join(projectRoot, 'collector');
const report = resolve(
  values.report ?? join(collectorRoot, 'output/report.json'),
);
const token = await ensureLocalToken();

async function run(args, env = process.env) {
  const child = spawn(process.execPath, args, {
    cwd: collectorRoot,
    env,
    stdio: 'inherit',
  });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (exitCode, signal) =>
      resolveExit(signal ? 1 : (exitCode ?? 1)),
    );
  });
  if (code !== 0)
    throw new Error(`Local refresh step exited with status ${code}.`);
}

await waitForHealth(origin);
if (values.collect) {
  console.log('Collecting fresh event data…');
  await run([join(collectorRoot, 'run.mjs')]);
}
try {
  await access(report);
} catch {
  throw new Error(
    `Collection report not found at ${report}. Run with --collect or pass --report <path>.`,
  );
}
console.log('Importing the validated report into persistent local D1…');
await run(
  [
    join(collectorRoot, 'publish.mjs'),
    '--report',
    report,
    '--allow-loopback-http',
  ],
  { ...process.env, BIPLAN_URL: origin.origin, SYNC_TOKEN: token },
);
console.log(
  'Local D1 refresh completed. The running website now uses the imported catalog.',
);
