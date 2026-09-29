import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sql } from './db.mjs';

export async function migrate() {
  const directory = resolve(import.meta.dirname, 'migrations');
  for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort())
    await sql(await readFile(resolve(directory, name), 'utf8'));
}
