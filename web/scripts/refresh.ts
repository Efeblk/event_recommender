import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The crawler runs in Node, separately from the application Worker.
const child = spawn(
  process.execPath,
  ['--experimental-strip-types', 'run.mjs', ...process.argv.slice(2)],
  {
    cwd: fileURLToPath(new URL('../../collector/', import.meta.url)),
    stdio: 'inherit',
  },
);
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
