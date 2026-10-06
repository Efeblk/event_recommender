/** Standalone benchmark wrapper around the field reader. */
import type { ParserInput } from './contract.ts';
import { buildFieldRequest, composeFields } from './fields.ts';
import { ask } from './jev.ts';
import type { ParseResult } from './parse-core.ts';

export async function parseFields(input: ParserInput, options: { offline?: boolean } = {}): Promise<ParseResult> {
  const built = buildFieldRequest(input);
  const response = await ask(built.state, built.questions, options);
  return composeFields(input, built, response);
}
