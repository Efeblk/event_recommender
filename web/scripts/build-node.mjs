import { execFile } from 'node:child_process';
import { cp, mkdtemp, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(root, 'dist-node');
if (relative(root, destination) !== 'dist-node')
  throw new Error('Refusing to write outside the web project.');

const includedDirectories = new Set(['app', 'components', 'data', 'lib', 'public']);
const includedFiles = new Set([
  'next.config.ts',
  'package-lock.json',
  'package.json',
  'postcss.config.mjs',
  'tsconfig.json',
  'vite.config.ts',
]);
function safeSource(source) {
  const name = basename(source);
  return (
    !name.startsWith('.env') &&
    !name.startsWith('.dev.vars') &&
    name !== '.npmrc' &&
    !name.endsWith('.pem')
  );
}

const temporary = await mkdtemp(join(tmpdir(), 'biplan-node-build-'));
try {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const source = join(root, entry.name);
    if (
      !(entry.isDirectory()
        ? includedDirectories.has(entry.name)
        : includedFiles.has(entry.name))
    )
      continue;
    await cp(source, join(temporary, entry.name), {
      recursive: true,
      filter: safeSource,
    });
  }
  await symlink(
    join(root, 'node_modules'),
    join(temporary, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  const vinextCli = join(temporary, 'node_modules', 'vinext', 'dist', 'cli.js');
  const nestedDependencies = join(
    temporary,
    'node_modules',
    'vinext',
    'node_modules',
  );
  const child = await exec(process.execPath, [vinextCli, 'build'], {
    cwd: temporary,
    env: {
      ...process.env,
      BIPLAN_RUNTIME: 'node',
      NODE_PATH: nestedDependencies,
    },
    maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(child.stdout);
  process.stderr.write(child.stderr);
  const standalone = join(temporary, 'dist', 'standalone');
  await readFile(join(standalone, 'server.js'));
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(standalone, destination, { recursive: true });
  console.log(`Node standalone output: ${relative(root, destination)}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
