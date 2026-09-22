import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const projectRoot = resolve(webRoot, '..');
export const devVarsPath = join(webRoot, '.dev.vars');
export const localOrigin = 'http://127.0.0.1:3001';

export function requireNode22() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13))
    throw new Error(
      `Node 22.13+ is required; current version is ${process.versions.node}.`,
    );
}

export async function ensureLocalToken() {
  let source = '';
  try {
    source = await readFile(devVarsPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const matches = [...source.matchAll(/^\s*SYNC_TOKEN\s*=\s*(.*?)\s*$/gm)];
  if (matches.length > 1)
    throw new Error(
      'web/.dev.vars contains more than one SYNC_TOKEN; keep exactly one.',
    );
  if (matches.length === 1) {
    const token = unquote(matches[0][1]);
    if (!token)
      throw new Error(
        'SYNC_TOKEN exists but is blank in web/.dev.vars; set it or remove that line so local:setup can generate one.',
      );
    await chmod(devVarsPath, 0o600);
    return token;
  }
  const token = randomBytes(32).toString('base64url');
  const prefix = source && !source.endsWith('\n') ? '\n' : '';
  await writeFile(devVarsPath, `${source}${prefix}SYNC_TOKEN=${token}\n`, {
    mode: 0o600,
  });
  await chmod(devVarsPath, 0o600);
  return token;
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  )
    return value.slice(1, -1);
  return value;
}

export async function waitForHealth(origin, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let detail = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/api/health', origin), {
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok && (await response.json()).status === 'ok') return;
      detail = `HTTP ${response.status}`;
    } catch (error) {
      detail = error.message;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(
    `Local server is not ready at ${origin} (${detail}). Run npm run local:start in another terminal.`,
  );
}
