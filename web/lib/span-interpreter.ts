import { withDeadline } from './deadline.ts';
import type { JevConfig } from './jev.ts';
import type { ParserInput } from '../parser/contract.ts';
import {
  buildRequest,
  compose,
  type JevResponse,
  type ParseResult,
} from '../parser/parse-core.ts';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MAX_REQUEST_BYTES = 100_000;
const MAX_RESPONSE_BYTES = 200_000;
const UNAVAILABLE = 'Span interpreter unavailable.';

function hasValidEnvelope(value: unknown): value is JevResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Partial<JevResponse>;
  const usage = response.usage;
  return (
    typeof response.model === 'string' &&
    /^jev-[a-z0-9.-]+$/u.test(response.model) &&
    Boolean(
      response.answers &&
      typeof response.answers === 'object' &&
      !Array.isArray(response.answers),
    ) &&
    Boolean(
      usage &&
      Number.isSafeInteger(usage.input_tokens) &&
      usage.input_tokens >= 0 &&
      Number.isSafeInteger(usage.output_tokens) &&
      usage.output_tokens >= 0,
    )
  );
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(UNAVAILABLE);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error(UNAVAILABLE);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function interpretSpanInput(
  input: ParserInput,
  options: {
    config: JevConfig | null;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  },
): Promise<ParseResult> {
  const built = buildRequest(input);
  if (built.invalidSpans.length) {
    return compose(input, built, {
      model: 'unused',
      answers: {},
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  }

  try {
    const config = options.config;
    if (!config?.apiKey.trim() || !/^jev-[a-z0-9.-]+$/u.test(config.model))
      throw new Error(UNAVAILABLE);
    const serialized = JSON.stringify({
      model: config.model,
      state: built.state,
      questions: built.questions,
    });
    if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES)
      throw new Error(UNAVAILABLE);

    const value = await withDeadline(
      options.timeoutMs ?? 15_000,
      UNAVAILABLE,
      async (signal) => {
        const response = await (options.fetcher ?? fetch)(ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: serialized,
          redirect: 'manual',
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(UNAVAILABLE);
        }
        return readBoundedJson(response);
      },
    );
    if (!hasValidEnvelope(value)) throw new Error(UNAVAILABLE);
    const result = compose(input, built, value);
    if (
      result.status === 'unsupported' &&
      result.reason === 'invalid or incomplete provider judgments'
    )
      throw new Error(UNAVAILABLE);
    return result;
  } catch {
    throw new Error(UNAVAILABLE);
  }
}
