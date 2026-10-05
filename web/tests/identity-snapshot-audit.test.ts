import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compactIdentityKey, resolveEventRecordIdentity } from '../../collector/identity/index.ts';
import { auditIdentitySnapshot } from '../scripts/audit-identity-snapshot.ts';
import type { EventRecord } from '../lib/types.ts';

const events = JSON.parse(
  await readFile(new URL('../data/events.json', import.meta.url), 'utf8'),
) as EventRecord[];

void test('identity module keeps every legacy merge and never joins one provider twice', () => {
  const report = auditIdentitySnapshot(events);
  assert.deepEqual(report.unreviewedSplits, []);
  assert.deepEqual(report.sameProviderSessions, []);
  assert.ok(
    report.sessions < report.legacyCards,
    `expected fewer cards than the legacy merge: ${report.sessions} >= ${report.legacyCards}`,
  );
});

void test('identical venue names resolve to one venue in this snapshot', () => {
  // No two listings here state conflicting locations for the same written
  // name, so missing or side-only districts must not split a venue.
  const { listingVenueIds } = resolveEventRecordIdentity(events);
  const byName = new Map<string, Set<string>>();
  for (const event of events) {
    const name = compactIdentityKey(event.venue);
    byName.set(name, (byName.get(name) ?? new Set()).add(listingVenueIds[event.id]));
  }
  assert.deepEqual(
    [...byName].filter(([, venues]) => venues.size > 1).map(([name]) => name),
    [],
  );
});

void test('unresolved same-session pairs are listed by title pair for review', () => {
  const base = events.find((event) => event.venue && event.startsAt)!;
  const pair = [
    { ...base, id: 'review-a', source: 'biletix', title: 'Ortak Gece A', mergedIds: undefined },
    { ...base, id: 'review-b', source: 'bubilet', title: 'Başka Ad B', mergedIds: undefined },
  ] as EventRecord[];
  const report = auditIdentitySnapshot(pair);
  assert.equal(report.unresolvedPairs, 1);
  assert.deepEqual(report.unresolvedTitlePairs, [{
    venue: base.venue,
    titles: [`biletix: Ortak Gece A @ ${base.venue}`, `bubilet: Başka Ad B @ ${base.venue}`],
    sessions: 1,
    firstStartsAt: base.startsAt,
  }]);
});
