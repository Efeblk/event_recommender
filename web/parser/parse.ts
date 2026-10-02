/** Standalone benchmark wrapper around the pure span-parser core. */
import type { ParserInput } from './contract.ts';
import { propose } from './gliner.ts';
import { ask } from './jev.ts';
import { buildRequest, compose, type ParseResult } from './parse-core.ts';

export * from './parse-core.ts';

export async function parse(input: ParserInput, options: { offline?: boolean } = {}): Promise<ParseResult> {
  let built = buildRequest(input);
  if (built.invalidSpans.length) {
    return {
      status: 'unsupported',
      reason: 'invalid calendar date',
      unresolvedSpans: built.invalidSpans,
      debug: { mentions: built.mentions, answers: {} },
    };
  }
  const proposals = await propose(input.utterance, options);
  if (proposals.length) built = buildRequest(input, proposals);
  const response = await ask(built.state, built.questions, options);
  return compose(input, built, response);
}
