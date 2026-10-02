// Offline: reports how precisely each catalog session's venue location resolves.
// Usage: node --experimental-strip-types scripts/audit-location-precision.ts [events.json]
import { readFileSync } from 'node:fs';
import { resolveEventLocation } from '../lib/istanbul-location.ts';
import type { EventRecord } from '../lib/types.ts';

const path = process.argv[2] ?? 'data/events.json';
const data = JSON.parse(readFileSync(path, 'utf8'));
const events: EventRecord[] = Array.isArray(data) ? data : data.events;
const counts: Record<string, number> = {};
const unresolved: Record<string, number> = {};
for (const event of events) {
  const location = resolveEventLocation(event);
  const key = `${location.precision}:${location.side ?? '-'}`;
  counts[key] = (counts[key] ?? 0) + 1;
  if (location.precision === 'unknown') {
    const sample = `${event.district || '(empty)'} | ${event.address}`;
    unresolved[sample] = (unresolved[sample] ?? 0) + 1;
  }
}
console.log(
  JSON.stringify(
    {
      path,
      sessions: events.length,
      counts,
      unresolved: Object.entries(unresolved)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20),
    },
    null,
    2,
  ),
);
