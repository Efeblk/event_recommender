import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqlPublicationRepository } from '../lib/publication-repository.ts';

void test('publication reader uses sealed immutable terms directly for projection publications', async () => {
  let statement = '';
  const repository = createSqlPublicationRepository(async sql => {
    statement = sql;
    return sql.includes('FROM biplan.publications p JOIN pin')
      ? JSON.stringify({ publicationId: 'publication-v2', offerProjectionVersion: 1, embeddingProfile: null, sessionCount: 0, requiredSessionCount: 0, requiredOfferCount: 0 })
      : JSON.stringify({ publicationPresent: true, sessions: [] });
  });
  const result = await repository.readPublication('publication-v2');
  assert.equal(result.offerProjectionVersion, 1);
  assert.match(statement, /THEN COALESCE\(s\.eligibility_snapshot->'offerTerms','\[\]'::jsonb\)/);
  assert.match(statement, /legacy_terms AS MATERIALIZED/);
  assert.match(statement, /WHERE p\.manifest->>'offerProjectionVersion' IS DISTINCT FROM '1'/);
  assert.match(statement, /s\.session_id COLLATE "C">E'' COLLATE "C" ORDER BY s\.session_id COLLATE "C" LIMIT 1000/);
  assert.doesNotMatch(statement, /publication_offer_term|LATERAL/);
});

void test('an explicit unknown projection version cannot fall through to legacy raw terms', async () => {
  const repository = createSqlPublicationRepository(async () => JSON.stringify({ publicationId: 'future', offerProjectionVersion: 2, embeddingProfile: null, sessionCount: 0, requiredSessionCount: 0, requiredOfferCount: null }));
  await assert.rejects(repository.readPublication('future'), /Unsupported publication offer projection version/);
});

void test('publication reader rejects a generation already missing required sessions', async () => {
  let calls = 0;
  const repository = createSqlPublicationRepository(async () => { calls++;
    return JSON.stringify({ publicationId: 'p', offerProjectionVersion: 1, embeddingProfile: null,
      sessionCount: 1, requiredSessionCount: 2, requiredOfferCount: 1 });
  });
  await assert.rejects(repository.readPublication('p'), /session manifest is incomplete/);
  assert.equal(calls, 1);
});

void test('publication reader rejects publication disappearance between pages', async () => {
  let calls = 0;
  const repository = createSqlPublicationRepository(async () => ++calls === 1
    ? JSON.stringify({ publicationId: 'p', offerProjectionVersion: 1, embeddingProfile: null, sessionCount: 1, requiredSessionCount: 1, requiredOfferCount: 1 })
    : JSON.stringify({ publicationPresent: false, sessions: [] }));
  await assert.rejects(repository.readPublication('p'), /disappeared during read/);
});

void test('publication reader rejects a truncated immutable page sequence', async () => {
  let calls = 0;
  const repository = createSqlPublicationRepository(async () => ++calls === 1
    ? JSON.stringify({ publicationId: 'p', offerProjectionVersion: 1, embeddingProfile: null, sessionCount: 1, requiredSessionCount: 1, requiredOfferCount: 1 })
    : JSON.stringify({ publicationPresent: true, sessions: [] }));
  await assert.rejects(repository.readPublication('p'), /page set is incomplete/);
});

void test('revalidation preserves revision, page and dependency status fields from SQL', async () => {
  const expected = [{ publicationId: 'p', sessionId: 's', availabilityUsable: true, verifiedTotalEligible: true,
    canonicalSessionUsable: true, reasons: [], offers: [{ offerId: 'o', pinnedRevisionId: 'r', currentRevisionId: 'r',
      pinnedPageObservationId: 'page', currentPageObservationId: 'page', evidenceDependencyHash: 'a'.repeat(64), status: 'usable', reasons: [] }] }];
  const repository = createSqlPublicationRepository(async () => JSON.stringify(expected));
  assert.deepEqual(await repository.revalidatePublication('p', ['s'], '2026-09-30T12:00:00.000Z', 3600000), expected);
});
