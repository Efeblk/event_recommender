import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PIPELINE_CURRENT_STATUS_SQL,
  projectPipelineSession,
} from '../lib/pipeline-catalog.node.ts';
import type { PublishedSessionV1 } from '../../contracts/publication.ts';
import { isEligible } from '../lib/search.ts';
import { emptyFilters } from '../lib/types.ts';
const now = new Date('2026-10-02T12:00:00Z');
const session: PublishedSessionV1 = {
  id: 'session-a',
  revisionId: 'revision-a',
  productionId: 'show-a',
  venueId: 'venue-a',
  title: 'Akustik',
  description: 'Canlı akustik konser.',
  category: 'Konser',
  startsAt: '2026-10-03T17:00:00Z',
  city: 'İstanbul',
  venue: { name: 'Test Sahne', district: 'Kadıköy' },
  offers: [
    {
      id: 'offer-a',
      revisionId: 'offer-revision-a',
      listingId: 'listing-a',
      listingRevisionId: 'listing-revision-a',
      provider: 'bubilet',
      url: 'https://www.bubilet.com.tr/istanbul/etkinlik/test',
      observedAt: now.toISOString(),
      availability: 'available',
      tiers: [
        {
          price: 500,
          currency: 'TRY',
          availability: 'available',
          feeMinor: null,
          priceKind: 'starting',
        },
      ],
    },
  ],
  document: {
    id: 'doc-a',
    hash: 'a'.repeat(64),
    text: 'Akustik',
    lexicalTokens: ['akustik'],
    location: null,
    embeddingProfile: null,
    vector: null,
  },
};
await test('pipeline projects prepared identity and exact selected revision but starting prices do not satisfy a hard budget', () => {
  const result = projectPipelineSession(session, now)!;
  assert.equal(result.event.canonicalShowKey, 'show-a');
  assert.equal(result.event.price, null);
  assert.deepEqual(result.event.advertisedPrice, {
    amount: 500,
    currency: 'TRY',
    kind: 'starting_at',
    feesKnown: false,
  });
  assert.equal(result.selection.offerRevisionId, 'offer-revision-a');
  assert.equal(isEligible(result.event, emptyFilters, now), true);
  assert.equal(
    isEligible(result.event, { ...emptyFilters, maxPrice: 1000 }, now),
    false,
  );
});
await test('stale, unavailable and unknown tier availability cannot supply a card or cheaper price', () => {
  assert.equal(
    projectPipelineSession(
      {
        ...session,
        offers: [{ ...session.offers[0], availability: 'cancelled' }],
      },
      now,
    ),
    null,
  );
  assert.equal(
    projectPipelineSession(
      {
        ...session,
        offers: [{ ...session.offers[0], observedAt: '2026-09-20T12:00:00Z' }],
      },
      now,
    ),
    null,
  );
  assert.equal(
    projectPipelineSession(
      {
        ...session,
        offers: [
          {
            ...session.offers[0],
            tiers: [{ ...session.offers[0].tiers[0], availability: 'unknown' }],
          },
        ],
      },
      now,
    ),
    null,
  );
});

await test('freshness SQL rejects a session when any canonical member head changed or was withheld', () => {
  assert.match(PIPELINE_CURRENT_STATUS_SQL, /session_listings sl/);
  assert.match(
    PIPELINE_CURRENT_STATUS_SQL,
    /head\.revision_id IS DISTINCT FROM member\.revision_id/,
  );
  assert.match(PIPELINE_CURRENT_STATUS_SQL, /COALESCE\(head\.withheld,true\)/);
  assert.match(PIPELINE_CURRENT_STATUS_SQL, /usable_session_ids/);
  assert.match(PIPELINE_CURRENT_STATUS_SQL, /offer_tiers tier/);
});
