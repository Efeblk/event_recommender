// Server-side provider settings. No credentials or endpoints come from requests.
export interface ProviderEnv {
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;
  AI_PROTOCOL?: string;
  AI_OUTPUT_FORMAT?: string;
  AI_MAX_OUTPUT_TOKENS?: string;
  AI_TOKEN_PARAMETER?: string;
  EMBEDDING_ENABLED?: string;
  EMBEDDING_API_KEY?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_DIMENSIONS?: string;
  EMBEDDING_SEND_DIMENSIONS?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
}
interface Connection {
  key: string;
  baseUrl: string;
  model: string;
}
export interface AIConfig extends Connection {
  protocol: 'responses' | 'chat-completions';
  outputFormat: 'json_schema' | 'json_object';
  maxTokens: number;
  tokenParameter: 'max_tokens' | 'max_completion_tokens';
}
export interface EmbeddingConfig extends Connection {
  dimensions: number;
  sendDimensions: boolean;
}
const openaiUrl = 'https://api.openai.com/v1';
function baseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid provider base URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Provider base URL must be HTTPS without credentials, query or fragment',
    );
  return url.toString().replace(/\/+$/, '');
}
function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
) {
  const result = value?.trim() ? Number(value) : fallback;
  if (!Number.isInteger(result) || result < min || result > max)
    throw new Error('Invalid provider numeric setting');
  return result;
}
function choice<T extends string>(
  value: string | undefined,
  fallback: T,
  choices: readonly T[],
): T {
  const result = value?.trim() || fallback;
  if (!choices.includes(result as T))
    throw new Error('Invalid provider setting');
  return result as T;
}
function customChat(env: ProviderEnv) {
  return Boolean(env.AI_API_KEY?.trim() || env.AI_BASE_URL?.trim());
}
export function configFrom(env: ProviderEnv): AIConfig | null {
  // Never forward a legacy OpenAI key to a separately configured third party.
  const custom = customChat(env);
  const key = (custom ? env.AI_API_KEY : env.OPENAI_API_KEY)?.trim();
  if (!key) return null;
  const url = baseUrl(env.AI_BASE_URL?.trim() || openaiUrl);
  const model = (
    env.AI_MODEL || (!custom ? env.OPENAI_MODEL || 'gpt-4.1-mini' : '')
  )?.trim();
  if (!model) throw new Error('AI_MODEL is required with AI_API_KEY');
  return {
    key,
    baseUrl: url,
    model,
    protocol: choice(
      env.AI_PROTOCOL,
      url === openaiUrl ? 'responses' : 'chat-completions',
      ['responses', 'chat-completions'],
    ),
    outputFormat: choice(env.AI_OUTPUT_FORMAT, 'json_schema', [
      'json_schema',
      'json_object',
    ]),
    maxTokens: integer(env.AI_MAX_OUTPUT_TOKENS, 1800, 256, 8192),
    tokenParameter: choice(env.AI_TOKEN_PARAMETER, 'max_tokens', [
      'max_tokens',
      'max_completion_tokens',
    ]),
  };
}
export function embeddingConfigFrom(env: ProviderEnv): EmbeddingConfig | null {
  if (choice(env.EMBEDDING_ENABLED, 'true', ['true', 'false']) === 'false')
    return null;
  const explicit = Boolean(
    env.EMBEDDING_API_KEY?.trim() || env.EMBEDDING_BASE_URL?.trim(),
  );
  const key = (
    explicit
      ? env.EMBEDDING_API_KEY
      : !customChat(env)
        ? env.OPENAI_API_KEY
        : undefined
  )?.trim();
  if (!key) return null;
  const url = baseUrl(env.EMBEDDING_BASE_URL?.trim() || openaiUrl);
  const model = (
    env.EMBEDDING_MODEL || (url === openaiUrl ? 'text-embedding-3-small' : '')
  )?.trim();
  if (!model)
    throw new Error('EMBEDDING_MODEL is required for a third-party endpoint');
  return {
    key,
    baseUrl: url,
    model,
    dimensions: integer(env.EMBEDDING_DIMENSIONS, 512, 1, 4096),
    sendDimensions:
      choice(
        env.EMBEDDING_SEND_DIMENSIONS,
        url === openaiUrl ? 'true' : 'false',
        ['true', 'false'],
      ) === 'true',
  };
}
export function embeddingCacheKey(config: EmbeddingConfig) {
  // API key rotation preserves the index; endpoint/model/vector changes invalidate it.
  return JSON.stringify([
    'embedding-v2',
    config.baseUrl,
    config.model,
    config.dimensions,
    config.sendDimensions,
  ]);
}
export function validVector(
  value: unknown,
  dimensions: number,
): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === dimensions &&
    value.every((n: unknown) => typeof n === 'number' && Number.isFinite(n)) &&
    value.some((n: number) => n !== 0)
  );
}

export type Fetcher = typeof fetch;
async function post(
  config: Connection,
  path: string,
  body: object,
  fetcher: Fetcher,
  limit: number,
) {
  const response = await fetcher(`${config.baseUrl}/${path}`, {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(25000),
    headers: {
      Authorization: `Bearer ${config.key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    await response.body?.cancel();
    // Do not expose upstream error bodies, which can contain prompts or credentials.
    throw new Error(`AI provider returned ${response.status}`);
  }
  if (!response.body) throw new Error('Empty provider response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Provider response too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

// The deliberately small schema vocabulary used by this application's two outputs.
export interface OutputSchema {
  type: string | string[];
  enum?: unknown[];
  properties?: Record<string, OutputSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: OutputSchema;
}
function matches(value: unknown, schema: OutputSchema): boolean {
  const type =
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (
    ![schema.type].flat().includes(type) ||
    (schema.enum && !schema.enum.includes(value))
  )
    return false;
  if (type === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return (
      Boolean(schema.items) &&
      value.every((item) => matches(item, schema.items!))
    );
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>,
      properties = schema.properties ?? {};
    return (
      (schema.required ?? []).every((key) => Object.hasOwn(record, key)) &&
      Object.entries(record).every(([key, item]) =>
        Object.hasOwn(properties, key)
          ? matches(item, properties[key])
          : schema.additionalProperties !== false,
      )
    );
  }
  return true;
}
export async function structured<T>(
  config: AIConfig,
  name: string,
  schema: OutputSchema,
  instructions: string,
  input: unknown,
  fetcher: Fetcher = fetch,
): Promise<T> {
  const system = `${instructions}\nReturn only a JSON object matching this schema: ${JSON.stringify(schema)}`;
  const format = { type: 'json_schema', name, strict: true, schema };
  const jsonMode = config.outputFormat === 'json_object';
  const responses = config.protocol === 'responses';
  const body = responses
    ? {
        model: config.model,
        store: false,
        max_output_tokens: config.maxTokens,
        instructions: system,
        input: JSON.stringify(input),
        text: { format: jsonMode ? { type: 'json_object' } : format },
      }
    : {
        model: config.model,
        [config.tokenParameter]: config.maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: JSON.stringify(input) },
        ],
        response_format: jsonMode
          ? { type: 'json_object' }
          : {
              type: 'json_schema',
              json_schema: { name, strict: true, schema },
            },
      };
  const data = (await post(
    config,
    responses ? 'responses' : 'chat/completions',
    body,
    fetcher,
    256000,
  )) as {
    status?: string;
    output?: { content?: { type: string; text?: string }[] }[];
    choices?: {
      finish_reason?: string;
      message?: { content?: string; refusal?: string | null };
    }[];
  };
  let text: string | undefined;
  if (responses) {
    if (data.status !== 'completed') throw new Error('Incomplete AI response');
    const content = data.output?.flatMap((o) => o.content ?? []) ?? [];
    if (content.some((c) => c.type === 'refusal'))
      throw new Error('AI refused response');
    text = content
      .filter((c) => c.type === 'output_text')
      .map((c) => c.text ?? '')
      .join('');
  } else {
    const first = data.choices?.[0];
    if (first?.finish_reason !== 'stop' || first.message?.refusal)
      throw new Error('Incomplete AI response');
    text = first.message?.content;
  }
  if (typeof text !== 'string' || !text) throw new Error('Empty AI response');
  const result: unknown = JSON.parse(text);
  if (!matches(result, schema)) throw new Error('Invalid AI output');
  return result as T;
}
export async function embed(
  config: EmbeddingConfig,
  texts: string[],
  fetcher: Fetcher = fetch,
): Promise<number[][]> {
  if (!texts.length) return [];
  if (texts.length > 32) throw new Error('Embedding batch too large');
  const body = (await post(
    config,
    'embeddings',
    {
      model: config.model,
      input: texts.map((t) => t.slice(0, 10000)),
      encoding_format: 'float',
      ...(config.sendDimensions ? { dimensions: config.dimensions } : {}),
    },
    fetcher,
    8000000,
  )) as { data?: { index: number; embedding: unknown }[] };
  if (!Array.isArray(body.data)) throw new Error('Invalid embeddings');
  const rows = body.data.sort((a, b) => a.index - b.index);
  if (
    rows.length !== texts.length ||
    rows.some(
      (r, i) => r.index !== i || !validVector(r.embedding, config.dimensions),
    )
  )
    throw new Error('Invalid embeddings');
  return rows.map((r) => r.embedding as number[]);
}
