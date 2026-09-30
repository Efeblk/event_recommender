import { mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { docker, sql, container, ownership, work } from './db.mjs';
import { initializeCatalog } from './migrate.mjs';

await mkdir(work, { recursive: true });
const existing = await docker(['ps', '-a', '--filter', `name=^/${container}$`, '--format', '{{.Names}}']);
if (existing) {
  const label = await docker(['inspect', '--format', '{{index .Config.Labels "biplan.preparation"}}', container]);
  if (label !== ownership) throw new Error('Refusing an existing unowned container');
  await docker(['start', container]);
} else {
  console.log('Building local PostgreSQL with cached vectors and PostGIS support');
  await docker(['build', '-t', 'biplan-catalog-local:foundation-v1', resolve(import.meta.dirname)]);
  const envPath = resolve(work, 'postgres.env');
  await writeFile(envPath, `POSTGRES_DB=biplan_catalog\nPOSTGRES_PASSWORD=${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  await docker(['run', '-d', '--name', container, '--label', `biplan.preparation=${ownership}`, '--memory', '1536m', '--cpus', '2', '-p', '127.0.0.1:15432:5432', '--env-file', envPath, '-v', 'biplan-catalog-local-data:/var/lib/postgresql/data', 'biplan-catalog-local:foundation-v1']);
}
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try { await sql('SELECT 1;'); ready = true; break; }
  catch { await new Promise(done => setTimeout(done, 1000)); }
}
if (!ready) throw new Error('PostgreSQL did not become ready; inspect the task-owned container');
await initializeCatalog();
const versions = await sql("SELECT jsonb_object_agg(extname, extversion)::text FROM pg_extension WHERE extname IN ('vector','postgis','pg_trgm');");
await writeFile(resolve(work, 'local-receipt.json'), JSON.stringify({ at: new Date().toISOString(), container, bind: '127.0.0.1:15432', extensions: JSON.parse(versions) }, null, 2));
console.log(JSON.stringify({ container, bind: '127.0.0.1:15432', extensions: JSON.parse(versions) }));
