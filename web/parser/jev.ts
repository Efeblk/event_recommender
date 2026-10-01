/** Minimal TypeSafe System One client with a content-addressed response cache. */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ChoiceQuestion = { type: 'choice'; instructions: unknown; criteria: Record<string, unknown> };
export type NoulQuestion = { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } };
export type Question = ChoiceQuestion | NoulQuestion;
export type ChoiceAnswer = { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number };
export type NoulAnswer = { type: 'noul'; noul: number };
export type Answer = ChoiceAnswer | NoulAnswer;
export interface JevResponse { model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number } }

const here = dirname(fileURLToPath(import.meta.url));
const runtimeDir = resolve(here, '.runtime');
const cacheDir = resolve(runtimeDir, 'jev-cache');
const ledger = resolve(runtimeDir, 'jev-ledger.jsonl');
export const MODEL = 'jev-1.13.0';
const PRICE_PER_TOKEN = 0.042 / 1e6;

function apiKey(): string {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const vars = resolve(here, '../.dev.vars');
  if (existsSync(vars)) {
    const line = readFileSync(vars, 'utf8').split(/\r?\n/u).find((l) => l.startsWith('TYPESAFE_API_KEY='));
    if (line) return line.slice('TYPESAFE_API_KEY='.length).trim();
  }
  throw new Error('TYPESAFE_API_KEY is not configured.');
}

export function spentUsd(): number {
  if (!existsSync(ledger)) return 0;
  return readFileSync(ledger, 'utf8').split('\n').filter(Boolean)
    .reduce((sum, line) => sum + JSON.parse(line).usd, 0);
}

/** Hard ceiling for this task's cumulative live spend; cached replays are free. */
export const SPEND_CAP_USD = 3;

export async function ask(state: unknown, questions: Record<string, Question>, options: { offline?: boolean } = {}): Promise<JevResponse> {
  const body = JSON.stringify({ model: MODEL, state, questions });
  const key = createHash('sha256').update(body).digest('hex');
  const file = resolve(cacheDir, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  if (options.offline) throw new Error('Jev cache miss in offline mode.');
  if (spentUsd() >= SPEND_CAP_USD) throw new Error('Jev spend cap reached.');
  const started = performance.now();
  const response = await fetch('https://api.typesafe.ai/v1/systemone', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body,
  });
  const elapsedMs = performance.now() - started;
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2000);
    throw new Error(`Jev HTTP ${response.status}: ${detail}`);
  }
  const json = (await response.json()) as JevResponse;
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, JSON.stringify(json));
  const usd = json.usage.input_tokens * PRICE_PER_TOKEN;
  appendFileSync(ledger, `${JSON.stringify({ at: new Date().toISOString(), key, inputTokens: json.usage.input_tokens, questions: Object.keys(questions).length, elapsedMs: Math.round(elapsedMs), usd })}\n`);
  return json;
}
