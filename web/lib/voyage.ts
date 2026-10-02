import { withDeadline } from './deadline.ts';
export { voyageDocumentText } from '../../contracts/search.ts';

export interface VoyageEnv {
  VOYAGE_API_KEY?: string;
  VOYAGE_MODEL?: string;
  VOYAGE_DIMENSIONS?: string;
}

export interface VoyageConfig {
  apiKey: string;
  model: string;
  dimensions: 256 | 512 | 1024 | 2048;
}

export interface VoyageEmbeddingResult {
  vectors: number[][];
  usage: { totalTokens: number };
  rawResponse: string;
  rawResponseSha256: string;
}

const endpoint = 'https://api.voyageai.com/v1/embeddings';
const supportedModels = new Set([
  'voyage-4-large',
  'voyage-4',
  'voyage-4-lite',
]);
const supportedDimensions = new Set([256, 512, 1024, 2048]);
const maxResponseBytes = 4 * 1024 * 1024;

export function voyageConfigFrom(env: VoyageEnv): VoyageConfig | null {
  const apiKey = env.VOYAGE_API_KEY?.trim();
  if (!apiKey) return null;
  const model = env.VOYAGE_MODEL?.trim() || 'voyage-4-large';
  if (!supportedModels.has(model)) throw new Error('Invalid Voyage model.');
  const rawDimensions = env.VOYAGE_DIMENSIONS?.trim() || '1024';
  if (!/^\d+$/.test(rawDimensions))
    throw new Error('Invalid Voyage dimensions.');
  const dimensions = Number(rawDimensions);
  if (!supportedDimensions.has(dimensions))
    throw new Error('Invalid Voyage dimensions.');
  return {
    apiKey,
    model,
    dimensions: dimensions as VoyageConfig['dimensions'],
  };
}

export function voyageCacheKey(config: VoyageConfig): string {
  return [
    'voyage-embedding-v1',
    `endpoint=${endpoint}`,
    `model=${config.model}`,
    `dimensions=${config.dimensions}`,
    'input_type=document',
    'text_profile=event-title-category-venue-description-v1',
  ].join('|');
}

function parseEmbeddings(
  value: unknown,
  count: number,
  dimensions: number,
): number[][] {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Voyage response.');
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length !== count)
    throw new Error('Invalid Voyage response row count.');
  const result: (number[] | undefined)[] = Array(count);
  for (const item of data) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Error('Invalid Voyage response row.');
    const row = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.index) ||
      (row.index as number) < 0 ||
      (row.index as number) >= count ||
      result[row.index as number]
    )
      throw new Error('Invalid Voyage response index.');
    if (!Array.isArray(row.embedding) || row.embedding.length !== dimensions)
      throw new Error('Invalid Voyage embedding dimensions.');
    if (
      !row.embedding.every(
        (number) => typeof number === 'number' && Number.isFinite(number),
      )
    )
      throw new Error('Invalid Voyage embedding values.');
    if (!row.embedding.some((number) => number !== 0))
      throw new Error('Invalid zero Voyage embedding.');
    result[row.index as number] = row.embedding as number[];
  }
  if (result.some((row) => !row))
    throw new Error('Invalid Voyage response indexes.');
  return result as number[][];
}

function parseUsage(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Voyage token usage.');
  const usage = (value as Record<string, unknown>).usage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage))
    throw new Error('Invalid Voyage token usage.');
  const totalTokens = (usage as Record<string, unknown>).total_tokens;
  if (!Number.isSafeInteger(totalTokens) || (totalTokens as number) < 0)
    throw new Error('Invalid Voyage token usage.');
  return { totalTokens: totalTokens as number };
}

async function readBoundedJson(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing Voyage response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxResponseBytes)
        throw new Error('Voyage response is too large.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const rawResponse = new TextDecoder().decode(buffer);
  let value: unknown;
  try {
    value = JSON.parse(rawResponse);
  } catch {
    throw new Error('Invalid Voyage JSON response.');
  }
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  const rawResponseSha256 = Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return { rawResponse, rawResponseSha256, value };
}

export async function embedWithVoyageDetailed(
  config: VoyageConfig,
  texts: string[],
  inputType: 'query' | 'document',
  fetcher: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<VoyageEmbeddingResult> {
  if (!config.apiKey.trim()) throw new Error('VOYAGE_API_KEY is required.');
  if (!supportedModels.has(config.model))
    throw new Error('Invalid Voyage model.');
  if (!supportedDimensions.has(config.dimensions))
    throw new Error('Invalid Voyage dimensions.');
  if (texts.length < 1 || texts.length > 32)
    throw new Error('Voyage requires 1–32 texts.');
  if (texts.some((text) => !text.trim() || text.length > 10000))
    throw new Error('Voyage texts must contain 1–10,000 characters each.');

  return withDeadline(
    timeoutMs,
    'Voyage request timed out.',
    async (signal) => {
      let response: Response;
      try {
        response = await fetcher(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            input: texts,
            model: config.model,
            input_type: inputType,
            truncation: false,
            output_dimension: config.dimensions,
            output_dtype: 'float',
          }),
          redirect: 'manual',
          signal,
        });
      } catch {
        throw new Error('Voyage request failed.');
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Voyage request failed (HTTP ${response.status}).`);
      }
      const parsed = await readBoundedJson(response);
      return {
        vectors: parseEmbeddings(parsed.value, texts.length, config.dimensions),
        usage: parseUsage(parsed.value),
        rawResponse: parsed.rawResponse,
        rawResponseSha256: parsed.rawResponseSha256,
      };
    },
  );
}

export async function embedWithVoyage(
  config: VoyageConfig,
  texts: string[],
  inputType: 'query' | 'document',
  fetcher: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<number[][]> {
  return (
    await embedWithVoyageDetailed(config, texts, inputType, fetcher, timeoutMs)
  ).vectors;
}
