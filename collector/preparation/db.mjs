import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
export const container = 'biplan-catalog-local';
export const ownership = 'catalog-enrichment-v1';
export const work = resolve(import.meta.dirname, '../../web/work/catalog-foundation');

export function docker(args, input = '') {
  return new Promise((resolveResult, reject) => {
    const child = spawn('docker', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', code => code === 0 ? resolveResult(out.trim()) : reject(new Error(`Docker operation failed (${code}): ${err.slice(-1500)}`)));
    child.stdin.end(input, 'utf8');
  });
}

export async function assertOwned() {
  const label = await docker(['inspect', '--format', '{{index .Config.Labels "biplan.preparation"}}', container]);
  if (label !== ownership) throw new Error('Refusing to access a container not owned by this catalog milestone');
}

export async function sql(statement) {
  await assertOwned();
  return docker(['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'biplan_catalog'], statement);
}

export function literal(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
