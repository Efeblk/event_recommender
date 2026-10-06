import assert from 'node:assert/strict';
import test from 'node:test';
import { requestLogEnabled, requestLogEntry, requestLogKey } from '../lib/request-log.ts';
import { validateInput } from '../lib/recommend.ts';
import { emptyFilters, type SearchResult } from '../lib/types.ts';

void test('the request log records only during an approved staging test', () => {
  assert.equal(requestLogEnabled({ DEPLOYMENT_ENV: 'staging', BIPLAN_PREVIEW_TESTING: 'true' }), true);
  assert.equal(requestLogEnabled({ DEPLOYMENT_ENV: 'staging', BIPLAN_PREVIEW_TESTING: 'false' }), false);
  assert.equal(requestLogEnabled({ DEPLOYMENT_ENV: 'production', BIPLAN_PREVIEW_TESTING: 'true' }), false);
  assert.equal(requestLogEnabled({}), false);
});

void test('an entry keeps the request, its context, the parser judgments and the result ids', () => {
  const input = validateInput({ message: 'yarın konser', history: [], intentVersion: 2, filters: emptyFilters });
  const result: SearchResult = {
    recommendations: [{ event: { id: 'e1' } } as SearchResult['recommendations'][number]],
    filters: emptyFilters, mode: 'jev', status: 'results', notice: null, totalCandidates: 1,
    planState: { version: 2, revision: 1, plan: { hard: { type: 'all', children: [] }, preferences: [], order: 'none' }, requests: ['yarın konser'] },
  };
  const entry = requestLogEntry({
    id: '123e4567-e89b-42d3-a456-426614174000', at: new Date('2026-10-06T17:00:00.000Z'), deploymentSha: 'abc',
    input, parse: { status: 'accepted', debug: { answers: { date: 'tomorrow:1.00' } } }, result,
  });
  assert.deepEqual(entry, {
    version: 'request-log.v1', id: '123e4567-e89b-42d3-a456-426614174000', at: '2026-10-06T17:00:00.000Z', deploymentSha: 'abc',
    message: 'yarın konser', previousRequests: [], previousPlan: null, pendingReason: null,
    parse: { status: 'accepted', reason: null, answers: { date: 'tomorrow:1.00' } },
    status: 'results', notice: null, plan: result.planState!.plan, recommendationIds: ['e1'],
  });
  assert.equal(requestLogKey('staging', entry), 'biplan/staging/requestLog/2026-10-06/2026-10-06T17-00-00-000Z-123e4567-e89b-42d3-a456-426614174000.json');
  assert.throws(() => requestLogKey('../x', entry));
});
