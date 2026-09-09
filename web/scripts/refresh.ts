import { writeFile } from 'node:fs/promises';
import { collect } from '../lib/source.ts';
const report = await collect(10);
if (!report.pages || !report.events)
  throw new Error('No verified events; existing snapshot was preserved.');
if (report.failures.length)
  throw new Error(
    `Partial source failure (${report.failures.length}); existing snapshot preserved. Retry later.`,
  );
const events = [
  ...new Map(
    report.sources.flatMap((s) => s.events).map((e) => [e.id, e]),
  ).values(),
].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
await writeFile(
  new URL('../data/events.json', import.meta.url),
  JSON.stringify(events, null, 2) + '\n',
);
console.log(
  `Saved ${events.length} verified future sessions from ${report.pages} pages.`,
);
