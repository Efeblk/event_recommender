import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqlPublicationRepository } from '../lib/publication-repository.ts';

const session = (index: number) => ({
  sessionId: `session-${String(index).padStart(5, '0')}`,
  productionId: `production-${index}`,
  venueId: `venue-${index}`,
  snapshot: {},
  document: null,
  pinnedOfferTerms: [{ offerId: `offer-${index}` }],
});

const metadata = (sessionCount: number) => JSON.stringify({
  publicationId: 'p',
  offerProjectionVersion: 1,
  embeddingProfile: null,
  sessionCount,
  requiredSessionCount: sessionCount,
  requiredOfferCount: sessionCount,
});

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
  const firstPage = Array.from({ length: 1000 }, (_, index) => session(index));
  const repository = createSqlPublicationRepository(async () => {
    calls++;
    if (calls === 1) return metadata(1001);
    if (calls === 2) return JSON.stringify({ publicationPresent: true, sessions: firstPage });
    return JSON.stringify({ publicationPresent: false, sessions: [] });
  });
  await assert.rejects(repository.readPublication('p'), /disappeared during read/);
  assert.equal(calls, 3);
});

void test('publication reader rejects a truncated immutable page sequence', async () => {
  let calls = 0;
  const firstPage = Array.from({ length: 1000 }, (_, index) => session(index));
  const repository = createSqlPublicationRepository(async () => {
    calls++;
    if (calls === 1) return metadata(1001);
    return JSON.stringify({ publicationPresent: true, sessions: calls === 2 ? firstPage : [] });
  });
  await assert.rejects(repository.readPublication('p'), /page set is incomplete/);
  assert.equal(calls, 3);
});

void test('publication reader continues after a full 1000-row page and accepts a final partial page', async () => {
  const statements: string[] = [];
  const firstPage = Array.from({ length: 1000 }, (_, index) => session(index));
  const finalSession = session(1000);
  const repository = createSqlPublicationRepository(async sql => {
    statements.push(sql);
    if (statements.length === 1) return metadata(1001);
    return JSON.stringify({ publicationPresent: true, sessions: statements.length === 2 ? firstPage : [finalSession] });
  });
  const result = await repository.readPublication('p');
  assert.equal(result.sessions.length, 1001);
  assert.equal(result.sessions.at(-1)?.sessionId, finalSession.sessionId);
  assert.equal(statements.length, 3);
  assert.match(statements[2], /s\.session_id COLLATE "C">E'session-00999' COLLATE "C"/);
});

void test('publication reader rejects ordering failure after a full 1000-row page', async () => {
  let calls = 0;
  const firstPage = Array.from({ length: 1000 }, (_, index) => session(index));
  const repository = createSqlPublicationRepository(async () => {
    calls++;
    if (calls === 1) return metadata(1001);
    return JSON.stringify({ publicationPresent: true, sessions: calls === 2 ? firstPage : [session(999)] });
  });
  await assert.rejects(repository.readPublication('p'), /page is not strictly ordered/);
  assert.equal(calls, 3);
});

void test('revalidation preserves revision, page and dependency status fields from SQL', async () => {
  const expected = [{ publicationId: 'p', sessionId: 's', availabilityUsable: true, verifiedTotalEligible: true,
    canonicalSessionUsable: true, reasons: [], offers: [{ offerId: 'o', pinnedRevisionId: 'r', currentRevisionId: 'r',
      pinnedPageObservationId: 'page', currentPageObservationId: 'page', evidenceDependencyHash: 'a'.repeat(64), status: 'usable', reasons: [] }] }];
  const repository = createSqlPublicationRepository(async () => JSON.stringify(expected));
  assert.deepEqual(await repository.revalidatePublication('p', ['s'], '2026-09-30T12:00:00.000Z', 3600000), expected);
});
