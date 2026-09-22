import type { EventRecord } from './types.ts';

export const CHECKPOINT_POINTER_KEY = 'collection_checkpoint';
export const MAX_REPORT_BYTES = 128 * 1024;
export const MAX_CHECKPOINT_BYTES = 20 * 1024 * 1024;
export const MAX_CHECKPOINT_EVENTS = 20_000;

export interface CollectionReport {
  finishedAt: string;
  summary: Record<string, unknown>;
}

export interface CollectionCheckpoint {
  schemaVersion: 1;
  savedAt: string;
  events: EventRecord[];
  report: CollectionReport;
}

export interface CheckpointPointer {
  schemaVersion: 1;
  key: string;
  savedAt: string;
  finishedAt: string;
  events: number;
  bytes: number;
  summary: Record<string, unknown>;
}

export function parseCollectionReport(
  value: unknown,
  now = Date.now(),
): CollectionReport {
  const envelope = value as Record<string, unknown> | null;
  const report = envelope?.report as Record<string, unknown> | null;
  if (envelope?.schemaVersion !== 1 || !report)
    throw new Error('Invalid report');
  const finishedAt = report.finishedAt;
  const summary = report.summary;
  if (
    typeof finishedAt !== 'string' ||
    !Number.isFinite(Date.parse(finishedAt)) ||
    new Date(Date.parse(finishedAt)).toISOString() !== finishedAt ||
    Date.parse(finishedAt) > now + 300000 ||
    !summary ||
    typeof summary !== 'object' ||
    Array.isArray(summary) ||
    (summary as Record<string, unknown>).blocked
  )
    throw new Error('Invalid or blocked report');
  for (const key of ['events', 'available', 'refreshedPages']) {
    const count = (summary as Record<string, unknown>)[key];
    if (!Number.isInteger(count) || Number(count) < 0)
      throw new Error('Invalid report summary');
  }
  if (
    Number((summary as Record<string, unknown>).available) >
      Number((summary as Record<string, unknown>).events) ||
    Number((summary as Record<string, unknown>).refreshedPages) < 1
  )
    throw new Error('Invalid report summary');
  return { finishedAt, summary: summary as Record<string, unknown> };
}

export function parseCheckpointPointer(
  value: string | null,
): CheckpointPointer | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as CheckpointPointer;
    const iso = (date: unknown) =>
      typeof date === 'string' &&
      Number.isFinite(Date.parse(date)) &&
      new Date(Date.parse(date)).toISOString() === date;
    return parsed?.schemaVersion === 1 &&
      /^collection\/[A-Za-z0-9-]+\.json$/.test(parsed.key) &&
      iso(parsed.savedAt) &&
      iso(parsed.finishedAt) &&
      Number.isInteger(parsed.events) &&
      parsed.events >= 0 &&
      Number.isInteger(parsed.bytes) &&
      parsed.bytes > 0 &&
      parsed.bytes <= MAX_CHECKPOINT_BYTES &&
      parsed.summary !== null &&
      typeof parsed.summary === 'object' &&
      !Array.isArray(parsed.summary)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function checkpointReadiness(
  catalog: { status: string; stored: number; eligible: number },
  pointer: CheckpointPointer | null,
  now = Date.now(),
) {
  const reasons: string[] = [];
  if (catalog.status !== 'ready' || catalog.eligible <= 0)
    reasons.push('catalog_not_ready');
  if (!pointer) reasons.push('checkpoint_missing');
  else {
    if (
      now -
        Math.min(Date.parse(pointer.savedAt), Date.parse(pointer.finishedAt)) >=
      24 * 3600000
    )
      reasons.push('checkpoint_stale');
    // A source may legitimately have no future events. Only honor an explicit
    // collector signal instead of guessing from a zero count.
    const missingSources = pointer.summary.missingSources;
    if (Array.isArray(missingSources) && missingSources.length)
      reasons.push('source_absence');
    const previousAvailable = Number(pointer.summary.available);
    if (
      (pointer.events >= 100 && catalog.stored * 2 < pointer.events) ||
      (previousAvailable >= 100 && catalog.eligible * 2 < previousAvailable)
    )
      reasons.push('major_catalog_drop');
  }
  return reasons;
}
