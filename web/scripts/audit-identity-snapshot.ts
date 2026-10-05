import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { resolveEventRecordIdentity } from '../../collector/identity/index.ts';
import { mergeEventSessions } from '../lib/event-merge.ts';
import type { EventRecord } from '../lib/types.ts';

/**
 * Full-catalog regression gate for the identity module. The legacy merge is
 * the baseline until cutover: a session it combined must stay combined unless
 * the split is explicitly reviewed, and no session may hold two listings from
 * one provider. New merges and unresolved pairs are reported for review.
 */
export interface ReviewedSplit {
  listingIds: string[];
  reason: string;
}

export interface IdentitySnapshotReport {
  listings: number;
  legacyCards: number;
  sessions: number;
  venues: number;
  legacyMergesKept: number;
  unreviewedSplits: { listingIds: string[]; labels: string[] }[];
  reviewedSplits: number;
  newMergedSessions: number;
  sameProviderSessions: string[][];
  unresolvedPairs: number;
  /** Same venue and instant, different titles: review before adding a title seed. */
  unresolvedTitlePairs: { venue: string; titles: [string, string]; sessions: number; firstStartsAt: string }[];
  decisions: Record<string, number>;
}

const label = (event: EventRecord) => `${event.source}: ${event.title} @ ${event.venue}`;

export function auditIdentitySnapshot(
  events: EventRecord[],
  reviewed: readonly ReviewedSplit[] = [],
): IdentitySnapshotReport {
  const byId = new Map(events.map((event) => [event.id, event]));
  const resolution = resolveEventRecordIdentity(events);
  const sessionOf = new Map<string, string>();
  for (const session of resolution.sessions)
    for (const id of session.listingIds) sessionOf.set(id, session.id);
  const legacy = mergeEventSessions(events);
  const legacyOf = new Map<string, string>();
  const reviewedKeys = new Set(reviewed.map(({ listingIds }) => [...listingIds].sort().join('|')));
  const report: IdentitySnapshotReport = {
    listings: events.length,
    legacyCards: legacy.length,
    sessions: resolution.sessions.length,
    venues: resolution.venues.length,
    legacyMergesKept: 0,
    unreviewedSplits: [],
    reviewedSplits: 0,
    newMergedSessions: 0,
    sameProviderSessions: [],
    unresolvedPairs: 0,
    unresolvedTitlePairs: [],
    decisions: {},
  };
  for (const card of legacy) {
    const members = (card.mergedIds ?? [card.id]).filter((id) => byId.has(id)).sort();
    for (const id of members) legacyOf.set(id, card.id);
    if (members.length < 2) continue;
    if (new Set(members.map((id) => sessionOf.get(id))).size === 1) report.legacyMergesKept++;
    else if (reviewedKeys.has(members.join('|'))) report.reviewedSplits++;
    else
      report.unreviewedSplits.push({
        listingIds: members,
        labels: members.map((id) => label(byId.get(id)!)),
      });
  }
  for (const session of resolution.sessions) {
    const providers = session.listingIds.map((id) => byId.get(id)!.source ?? '');
    if (new Set(providers).size < providers.length) report.sameProviderSessions.push(session.listingIds);
    if (new Set(session.listingIds.map((id) => legacyOf.get(id))).size > 1) report.newMergedSessions++;
  }
  const unresolvedByTitles = new Map<string, IdentitySnapshotReport['unresolvedTitlePairs'][number]>();
  for (const decision of resolution.decisions) {
    const key = `${decision.outcome}:${decision.rule}`;
    report.decisions[key] = (report.decisions[key] ?? 0) + 1;
    if (decision.outcome !== 'unresolved') continue;
    report.unresolvedPairs++;
    const [left, right] = decision.listingIds.map((id) => byId.get(id)!);
    const titles = [label(left), label(right)].sort() as [string, string];
    const titleKey = titles.join('\u001f');
    const pair = unresolvedByTitles.get(titleKey);
    if (pair) {
      pair.sessions++;
      if (left.startsAt < pair.firstStartsAt) pair.firstStartsAt = left.startsAt;
    } else unresolvedByTitles.set(titleKey, { venue: left.venue, titles, sessions: 1, firstStartsAt: left.startsAt });
  }
  report.unresolvedTitlePairs = [...unresolvedByTitles.values()].sort(
    (a, b) => b.sessions - a.sessions || a.titles[0].localeCompare(b.titles[0]) || a.titles[1].localeCompare(b.titles[1]),
  );
  return report;
}

async function main(): Promise<void> {
  const [catalogPath = fileURLToPath(new URL('../data/events.json', import.meta.url)), reviewedPath] =
    process.argv.slice(2);
  // Accepts a plain event array or a collection checkpoint ({ events }).
  const parsed = JSON.parse(await readFile(catalogPath, 'utf8')) as EventRecord[] | { events: EventRecord[] };
  const events = Array.isArray(parsed) ? parsed : parsed.events;
  const reviewed = reviewedPath
    ? (JSON.parse(await readFile(reviewedPath, 'utf8')) as ReviewedSplit[])
    : [];
  const report = auditIdentitySnapshot(events, reviewed);
  console.log(JSON.stringify(report, null, 2));
  if (report.unreviewedSplits.length || report.sameProviderSessions.length) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
