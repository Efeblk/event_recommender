import type { EventRecord } from './types.ts';
import {
  activateSearchCatalog,
  digest,
  embeddingCandidates,
  voyageVectorsByHash,
  saveVoyageVectors,
} from './store.ts';
import {
  embedWithVoyageDetailed,
  voyageCacheKey,
  voyageDocumentText,
  type VoyageConfig,
} from './voyage.ts';
import type { Lease } from './storage-contract.ts';

export { voyageDocumentText } from './voyage.ts';

async function hashesFor(events: EventRecord[]) {
  return Promise.all(
    events.map(async (event) => {
      const prepared = event.preparedSearch;
      if (
        prepared?.version === 1 &&
        prepared.documentText.length <= 10000 &&
        /^[a-f0-9]{64}$/.test(prepared.documentHash)
      )
        return {
          event,
          text: prepared.documentText,
          hash: prepared.documentHash,
        };
      const text = voyageDocumentText(event);
      return { event, text, hash: await digest(text) };
    }),
  );
}

async function vectorsByHash(hashes: string[], config: VoyageConfig) {
  return voyageVectorsByHash(voyageCacheKey(config), hashes, config.dimensions);
}

export async function voyageVectorsFor(
  events: EventRecord[],
  config: VoyageConfig,
): Promise<Map<EventRecord['id'], number[]>> {
  const documents = await hashesFor(events);
  const cached = await vectorsByHash(
    [...new Set(documents.map((document) => document.hash))],
    config,
  );
  const result = new Map<EventRecord['id'], number[]>();
  for (const document of documents) {
    const vector = cached.get(document.hash);
    if (vector) result.set(document.event.id, vector);
  }
  return result;
}

export interface VoyageIndexStatus {
  eligible: number;
  documents: number;
  indexed: number;
  pending: number;
}

async function currentDocuments(now = new Date()) {
  const events = await embeddingCandidates(now);
  const documents = await hashesFor(events);
  const unique = new Map<string, { hash: string; text: string }>();
  for (const document of documents)
    if (!unique.has(document.hash))
      unique.set(document.hash, { hash: document.hash, text: document.text });
  return { eligible: events.length, documents: [...unique.values()] };
}

export async function voyageDocumentCoverage(now = new Date()) {
  const current = await currentDocuments(now);
  return { eligible: current.eligible, documents: current.documents.length };
}

export async function voyageIndexStatus(
  config: VoyageConfig,
  now = new Date(),
): Promise<VoyageIndexStatus> {
  const current = await currentDocuments(now);
  const cached = await vectorsByHash(
    current.documents.map((document) => document.hash),
    config,
  );
  return {
    eligible: current.eligible,
    documents: current.documents.length,
    indexed: cached.size,
    pending: current.documents.length - cached.size,
  };
}

export async function indexVoyageBatch(
  config: VoyageConfig,
  lease: Lease,
  limit = 32,
  now = new Date(),
) {
  const batchSize = Math.max(1, Math.min(32, Math.trunc(limit)));
  const current = await currentDocuments(now);
  const cached = await vectorsByHash(
    current.documents.map((document) => document.hash),
    config,
  );
  const pending = current.documents.filter(
    (document) => !cached.has(document.hash),
  );
  const batch = pending.slice(0, batchSize);
  const profile = voyageCacheKey(config);
  let usage = { totalTokens: 0 };
  if (batch.length) {
    const result = await embedWithVoyageDetailed(
      config,
      batch.map((document) => document.text),
      'document',
    );
    usage = result.usage;
    await saveVoyageVectors(
      profile,
      batch.map((document, index) => ({
        hash: document.hash,
        vector: result.vectors[index],
      })),
      lease,
    );
  }
  const publication = await activateSearchCatalog(profile, lease);
  return {
    eligible: current.eligible,
    documents: current.documents.length,
    indexed: cached.size + batch.length,
    pending: pending.length - batch.length,
    embedded: batch.length,
    profile,
    hashes: batch.map((document) => document.hash),
    usage,
    publication,
  };
}
