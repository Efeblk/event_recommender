import {
  MAX_CHECKPOINT_BYTES,
  MAX_CHECKPOINT_EVENTS,
  parseCollectionReport,
  type CollectionCheckpoint,
} from './operations.ts';
import type { SourcePage, VectorEntry } from './storage-contract.ts';
import type { EventRecord } from './types.ts';

const encoder = new TextEncoder();
const hashPattern = /^[a-f0-9]{64}$/;
const voyageProfilePattern =
  /^voyage-embedding-v1\|endpoint=https:\/\/api\.voyageai\.com\/v1\/embeddings\|model=(?:voyage-4-large|voyage-4|voyage-4-lite)\|dimensions=1024\|input_type=document\|text_profile=event-title-category-venue-description-v1$/;
const MAX_VECTOR_EXPORT_BYTES = 128 * 1024 * 1024;
const MAX_VECTOR_ENTRIES = 20_000;
const availability = new Set(['available', 'sold_out', 'cancelled', 'unknown']);
const requiredStrings = [
  'id',
  'title',
  'description',
  'startsAt',
  'venue',
  'city',
  'district',
  'address',
  'currency',
  'imageUrl',
  'category',
  'checkedAt',
] as const;

async function sha256(value: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', encoder.encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}
function iso(value: unknown) {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}
function eventShape(value: unknown): value is EventRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    requiredStrings.every((key) => typeof event[key] === 'string') &&
    iso(event.startsAt) &&
    iso(event.checkedAt) &&
    (event.price === null ||
      (typeof event.price === 'number' &&
        Number.isFinite(event.price) &&
        event.price >= 0)) &&
    typeof event.url === 'string' &&
    availability.has(String(event.availability))
  );
}
function supportedUrl(value: string) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface BootstrapPlan {
  checkpoint: CollectionCheckpoint;
  rawCheckpoint: string;
  checkpointSha256: string;
  pages: SourcePage[];
  eventCount: number;
  unsupportedUrlCount: number;
  sourceCheckedAt: { earliest: string; latest: string };
  vectors: {
    profile: string;
    dimensions: 1024;
    entries: VectorEntry[];
    sha256: string;
    raw: string;
  } | null;
}

export async function planGcpBootstrap(
  rawCheckpoint: string,
  rawVectors?: string,
): Promise<BootstrapPlan> {
  if (encoder.encode(rawCheckpoint).byteLength > MAX_CHECKPOINT_BYTES)
    throw new Error('Checkpoint exceeds size limit.');
  let value: unknown;
  try {
    value = JSON.parse(rawCheckpoint);
  } catch {
    throw new Error('Checkpoint is not valid JSON.');
  }
  const checkpoint = value as CollectionCheckpoint;
  if (
    checkpoint?.schemaVersion !== 1 ||
    !iso(checkpoint.savedAt) ||
    !Array.isArray(checkpoint.events) ||
    checkpoint.events.length > MAX_CHECKPOINT_EVENTS
  )
    throw new Error('Invalid collection checkpoint.');
  const report = parseCollectionReport({
    schemaVersion: 1,
    report: checkpoint.report,
  });
  const ids = new Set<string>(),
    grouped = new Map<string, EventRecord[]>();
  let unsupportedUrlCount = 0,
    earliest = '',
    latest = '';
  for (const rawEvent of checkpoint.events) {
    if (!eventShape(rawEvent))
      throw new Error('Checkpoint contains an invalid event.');
    if (ids.has(rawEvent.id))
      throw new Error('Checkpoint contains duplicate event IDs.');
    ids.add(rawEvent.id);
    earliest =
      !earliest || rawEvent.checkedAt < earliest
        ? rawEvent.checkedAt
        : earliest;
    latest = rawEvent.checkedAt > latest ? rawEvent.checkedAt : latest;
    if (!supportedUrl(rawEvent.url)) {
      unsupportedUrlCount++;
      continue;
    }
    const events = grouped.get(rawEvent.url) ?? [];
    events.push(rawEvent);
    grouped.set(rawEvent.url, events);
  }
  const pages = [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([url, events]) => ({ url, events }));
  let vectors: BootstrapPlan['vectors'] = null;
  if (rawVectors !== undefined) {
    if (encoder.encode(rawVectors).byteLength > MAX_VECTOR_EXPORT_BYTES)
      throw new Error('Voyage cache export exceeds size limit.');
    const parsed = JSON.parse(rawVectors) as {
      schemaVersion?: unknown;
      profile?: unknown;
      dimensions?: unknown;
      entries?: unknown;
    };
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.profile !== 'string' ||
      !voyageProfilePattern.test(parsed.profile) ||
      parsed.dimensions !== 1024 ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.length > MAX_VECTOR_ENTRIES
    )
      throw new Error('Invalid Voyage cache export.');
    const entries: VectorEntry[] = [],
      hashes = new Set<string>();
    for (const rawEntry of parsed.entries) {
      const entry = rawEntry as VectorEntry;
      if (
        !entry ||
        !hashPattern.test(entry.hash) ||
        hashes.has(entry.hash) ||
        !Array.isArray(entry.vector) ||
        entry.vector.length !== 1024 ||
        !entry.vector.every(
          (component) =>
            typeof component === 'number' && Number.isFinite(component),
        ) ||
        !entry.vector.some((component) => component !== 0)
      )
        throw new Error('Invalid Voyage cache entry.');
      hashes.add(entry.hash);
      entries.push({ hash: entry.hash, vector: [...entry.vector] });
    }
    vectors = {
      profile: parsed.profile,
      dimensions: 1024,
      entries,
      sha256: await sha256(rawVectors),
      raw: rawVectors,
    };
  }
  return {
    checkpoint: { ...checkpoint, report },
    rawCheckpoint,
    checkpointSha256: await sha256(rawCheckpoint),
    pages,
    eventCount: checkpoint.events.length,
    unsupportedUrlCount,
    sourceCheckedAt: { earliest, latest },
    vectors,
  };
}

export function bootstrapSummary(plan: BootstrapPlan) {
  return {
    checkpointSha256: plan.checkpointSha256,
    finishedAt: plan.checkpoint.report.finishedAt,
    originalSavedAt: plan.checkpoint.savedAt,
    events: plan.eventCount,
    importableEvents: plan.pages.reduce(
      (total, page) => total + page.events.length,
      0,
    ),
    sourcePages: plan.pages.length,
    unsupportedUrlEvents: plan.unsupportedUrlCount,
    sourceCheckedAt: plan.sourceCheckedAt,
    vectors: plan.vectors
      ? {
          profile: plan.vectors.profile,
          dimensions: 1024,
          entries: plan.vectors.entries.length,
          sha256: plan.vectors.sha256,
        }
      : null,
  };
}
