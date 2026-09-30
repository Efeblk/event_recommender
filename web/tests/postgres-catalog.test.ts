import assert from 'node:assert/strict';
import test from 'node:test';
import { filterRevalidatedPublicationEvents } from '../lib/postgres-catalog.node.ts';
import type { PreparedSelectedOffer, PublicationSessionStatus } from '../lib/prepared-publication-search.ts';
import type { EventRecord } from '../lib/types.ts';

const event = { id: 'session', title: 'Program' } as EventRecord;
const selected: PreparedSelectedOffer = { offerId: 'offer', revisionId: 'revision', pageObservationId: 'page',
  evidenceDependencyHash: 'a'.repeat(64), projected: true };
const status = (patch = {}): PublicationSessionStatus => ({ publicationId: 'publication', sessionId: 'session', availabilityUsable: true,
  verifiedTotalEligible: true, canonicalSessionUsable: true, reasons: [], offers: [{ offerId: 'offer', pinnedRevisionId: 'revision',
    currentRevisionId: 'revision', pinnedPageObservationId: 'page', currentPageObservationId: 'page', evidenceDependencyHash: 'a'.repeat(64),
    status: 'usable', reasons: [], ...patch }] });

void test('HTTP PostgreSQL finalization binds the selected revision, page and evidence dependency', () => {
  const chosen = new Map([['session', selected]]);
  assert.deepEqual(filterRevalidatedPublicationEvents([event], [status()], chosen, 'publication'), [event]);
  for (const patch of [{ currentRevisionId: 'other' }, { currentPageObservationId: 'other' }, { evidenceDependencyHash: 'b'.repeat(64) }])
    assert.deepEqual(filterRevalidatedPublicationEvents([event], [status(patch)], chosen, 'publication'), []);
  assert.deepEqual(filterRevalidatedPublicationEvents([event], [{ ...status(), publicationId: 'other' }], chosen, 'publication'), []);
});
