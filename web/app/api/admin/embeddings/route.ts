import {
  digest,
  runtime,
  acquireLease,
  releaseLease,
  readCheckpoint,
  auditedVoyageIndex,
} from '@/lib/store';
import { parseAuditedIndexInput } from '@/lib/audited-index';
import {
  indexVoyageBatch,
  voyageDocumentCoverage,
  voyageIndexStatus,
} from '@/lib/voyage-index';
import { voyageCacheKey, voyageConfigFrom } from '@/lib/voyage';

async function authorized(request: Request) {
  const token = runtime().SYNC_TOKEN;
  return (
    Boolean(token) &&
    (await digest(request.headers.get('authorization') ?? '')) ===
      (await digest(`Bearer ${token}`))
  );
}

function config() {
  return voyageConfigFrom(runtime());
}

export async function GET(request: Request) {
  if (!(await authorized(request)))
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const voyage = config();
    if (!voyage) {
      const coverage = await voyageDocumentCoverage();
      return Response.json({
        configured: false,
        ...coverage,
        indexed: 0,
        pending: coverage.documents,
      });
    }
    return Response.json({
      configured: true,
      profile: voyageCacheKey(voyage),
      ...(await voyageIndexStatus(voyage)),
      ...(new URL(request.url).searchParams.get('audited') === '1'
        ? {
            checkpointSha256: await digest((await readCheckpoint()) ?? ''),
            deploymentRevision: runtime().DEPLOYMENT_SHA ?? null,
          }
        : {}),
    });
  } catch {
    return Response.json(
      { error: 'Embedding status unavailable' },
      { status: 503 },
    );
  }
}

export async function POST(request: Request) {
  if (!(await authorized(request)))
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  let voyage;
  try {
    voyage = config();
  } catch {
    return Response.json(
      { error: 'Embedding configuration is invalid' },
      { status: 503 },
    );
  }
  if (!voyage)
    return Response.json(
      { configured: false, error: 'Voyage is not configured' },
      { status: 503 },
    );

  let lease;
  try {
    lease = await acquireLease('voyage_index_lock');
    if (!lease)
      return Response.json(
        { error: 'Embedding index already running' },
        { status: 409 },
      );
    if (request.headers.get('x-biplan-audited-index') === '1') {
      const reader = request.body?.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 4096) throw new Error('Index request too large');
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
        offset += chunk.length;
      }
      const input = parseAuditedIndexInput(
        JSON.parse(new TextDecoder().decode(bytes)),
      );
      return Response.json(await auditedVoyageIndex(voyage, input, lease));
    }
    return Response.json({
      configured: true,
      ...(await indexVoyageBatch(voyage, lease, 32)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const reason =
      request.headers.get('x-biplan-audited-index') === '1'
        ? 'Audited indexing stopped; inspect private run evidence before another attempt'
        : /^Voyage request failed(?: \(HTTP \d{3}\))?\.$/.test(message)
          ? message
          : 'Embedding batch failed';
    return Response.json(
      { error: `${reason}; no retry was attempted` },
      { status: 503 },
    );
  } finally {
    try {
      if (lease) await releaseLease(lease);
    } catch {
      // The bounded lease releases itself if cleanup is unavailable.
    }
  }
}
