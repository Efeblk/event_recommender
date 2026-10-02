import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const canonical = value => JSON.stringify(sort(value));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, sort(value[key])]));
  return value;
}
export const hash = value => createHash('sha256').update(typeof value === 'string' || value instanceof Uint8Array ? value : canonical(value)).digest('hex');
export async function transaction(pool, operation) {
  const client = typeof pool.connect === 'function' ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { if (client !== pool) client.release(); }
}
export async function initializePipeline(pool) {
  const sql = await readFile(new URL('./migrations/001-pipeline.sql', import.meta.url), 'utf8');
  const digest = hash(sql);
  return transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(621057324)");
    const exists = await client.query("SELECT to_regclass('biplan_pipeline.migrations') present");
    if (exists.rows[0].present) {
      const installed = await client.query('SELECT version,sha256 FROM biplan_pipeline.migrations ORDER BY version');
      if (installed.rows.length !== 1 || installed.rows[0].version !== 1 || installed.rows[0].sha256 !== digest)
        throw new Error('Pipeline migration history does not match the installed version');
      return { applied: false, sha256: digest };
    }
    await client.query(sql);
    await client.query('INSERT INTO biplan_pipeline.migrations(version,sha256) VALUES(1,$1)', [digest]);
    return { applied: true, sha256: digest };
  });
}
