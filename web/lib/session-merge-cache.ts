import { mergeEventSessions } from './event-merge.ts';
import type { EventRecord } from './types.ts';

/** Bounded structural reuse for the legacy Worker store. The caller still
 * reads the database and applies current eligibility before and after this.
 * An exact source-content match, not publication ID or elapsed time, is needed.
 * JSON strings keep returned objects independent of the retained entry. */
export class SessionMergeCache {
  private entry: { input: string; output: string } | null = null;
  private readonly maxRetainedBytes: number;
  private readonly merge: typeof mergeEventSessions;
  constructor(
    maxRetainedBytes = 24 * 1024 * 1024,
    merge = mergeEventSessions,
  ) {
    this.maxRetainedBytes = maxRetainedBytes;
    this.merge = merge;
  }

  read(events: EventRecord[]): EventRecord[] {
    const input = JSON.stringify(events);
    if (this.entry?.input === input) return JSON.parse(this.entry.output) as EventRecord[];
    this.entry = null;
    const merged = this.merge(events);
    // UTF-16 code units give a conservative string-storage bound without
    // another catalog-sized allocation; retain at most one complete entry.
    if (input.length * 2 > this.maxRetainedBytes) return merged;
    const output = JSON.stringify(merged);
    if ((input.length + output.length) * 2 <= this.maxRetainedBytes)
      this.entry = { input, output };
    return merged;
  }
}
