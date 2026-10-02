import { readFileSync } from 'node:fs';
import { prepareInput, compile } from './compiler.ts';
import { SYSTEM_PROMPT, buildPrompt, RESPONSE_SCHEMA } from './prompt.ts';
import { callModel } from './provider.mjs';

const input = JSON.parse(readFileSync(process.argv[2] ?? 0, 'utf8'));
const prepared = prepareInput(input);
if (!process.argv.includes('--call')) {
  console.log(JSON.stringify({ mode: 'offline-provider-request', system: SYSTEM_PROMPT, user: JSON.parse(buildPrompt(input, prepared)), schema: RESPONSE_SCHEMA }, null, 2));
} else {
  const id = process.argv.find(a => a.startsWith('--id='))?.slice(5);
  if (!id) throw new Error('A unique --id= value and the existing finite authorization ledger are required');
  const result = await callModel(SYSTEM_PROMPT, buildPrompt(input, prepared), RESPONSE_SCHEMA, { id, cohort: 'manual' });
  console.log(JSON.stringify({ result: compile(input, prepared, result.wire), providerMs: result.elapsedMs, listPriceUsd: result.listPriceUsd }, null, 2));
}
