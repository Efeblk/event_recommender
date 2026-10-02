/** Client for the local GLiNER span proposer (gliner/server.py), with a content-addressed cache. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Proposal { label: 'topic' | 'condition'; text: string; start: number; end: number; score: number }

const cacheDir = resolve(dirname(fileURLToPath(import.meta.url)), '.runtime', 'gliner-cache');
const url = process.env.GLINER_URL ?? 'http://127.0.0.1:8765/extract';
let warned = false;

/** Proposals are optional evidence: an unavailable proposer yields none rather than failing the parse. */
export async function propose(text: string, options: { offline?: boolean } = {}): Promise<Proposal[]> {
  if (process.env.GLINER === 'off') return [];
  const file = resolve(cacheDir, `${createHash('sha256').update(text).digest('hex')}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (options.offline) return [];
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`GLiNER HTTP ${response.status}`);
    const spans = ((await response.json()) as { spans: Proposal[] }).spans
      // Keep only spans whose offsets reproduce their text in this string.
      .filter((s) => text.slice(s.start, s.end) === s.text);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify(spans));
    return spans;
  } catch (error) {
    if (!warned) { warned = true; console.error(`GLiNER unavailable (${(error as Error).message}); continuing without proposals.`); }
    return [];
  }
}
