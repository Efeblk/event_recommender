import assert from 'node:assert/strict';
import test from 'node:test';
import { filterRevalidatedPublicationEvents, postgresPublicationAvailabilitySql } from '../lib/postgres-catalog.node.ts';
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

void test('cheap pinned availability uses every current eligibility predicate at one request instant', () => {
  const instant = new Date('2026-09-30T12:34:56.000Z');
  const sql = postgresPublicationAvailabilitySql("publication'one", instant);
  for (const expected of [
    "ps.publication_id=E'publication''one'", "c.status='scheduled'", 'c.starts_at>=',
    'i.current_revision_id=r.id', "r.availability IN ('available','limited')",
    'r.observed_at<=', "r.observed_at>=E'2026-09-30T12:34:56.000Z'::timestamptz-interval '72 hours'",
    'r.valid_from IS NULL OR r.valid_from<=', 'r.valid_until IS NULL OR r.valid_until>=',
  ]) assert.match(sql, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(sql.match(/2026-09-30T12:34:56\.000Z/g)?.length, 5);
});
