import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqlPublicationRepository } from '../lib/publication-repository.ts';

void test('publication reader uses the immutable projection helper only for projection publications', async () => {
  let statement = '';
  const repository = createSqlPublicationRepository(async sql => {
    statement = sql;
    return JSON.stringify({ publicationId: 'publication-v2', offerProjectionVersion: 1, sessions: [] });
  });
  const result = await repository.readPublication('publication-v2');
  assert.equal(result.offerProjectionVersion, 1);
  assert.match(statement, /biplan\.publication_offer_term\(p\.id,r\.offer_id\)/);
  assert.match(statement, /manifest->>'offerProjectionVersion'='1' THEN projected\.record ELSE jsonb_build_object/);
  assert.match(statement, /projected\.record IS NOT NULL/);
  assert.match(statement, /NOT \(p\.manifest \? 'offerProjectionVersion'\) OR p\.manifest->>'offerProjectionVersion'='1'/);
  assert.match(statement, /publication_offer_term\(p\.id,r\.offer_id\) AS record\s+WHERE p\.manifest->>'offerProjectionVersion'='1'/);
  assert.doesNotMatch(statement, /COALESCE\(projected\.record,jsonb_build_object/);
});

void test('an explicit unknown projection version cannot fall through to legacy raw terms', async () => {
  const repository = createSqlPublicationRepository(async () => JSON.stringify({ publicationId: 'future', offerProjectionVersion: 2, sessions: [] }));
  await assert.rejects(repository.readPublication('future'), /Unsupported publication offer projection version/);
});

void test('revalidation preserves revision, page and dependency status fields from SQL', async () => {
  const expected = [{ publicationId: 'p', sessionId: 's', availabilityUsable: true, verifiedTotalEligible: true,
    canonicalSessionUsable: true, reasons: [], offers: [{ offerId: 'o', pinnedRevisionId: 'r', currentRevisionId: 'r',
      pinnedPageObservationId: 'page', currentPageObservationId: 'page', evidenceDependencyHash: 'a'.repeat(64), status: 'usable', reasons: [] }] }];
  const repository = createSqlPublicationRepository(async () => JSON.stringify(expected));
  assert.deepEqual(await repository.revalidatePublication('p', ['s'], '2026-09-30T12:00:00.000Z', 3600000), expected);
});
