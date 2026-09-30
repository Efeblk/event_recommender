import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresPublicationClient } from '../scripts/postgres-publication-client.mjs';

const statement = "SELECT biplan.publish_preparation_batch('batch','job','worker',1,NULL)::text;";

function harness({ resetError, operationError } = {}) {
  const calls = [], releases = [], environments = []; let closed = 0;
  const connection = {
    query: async config => {
      calls.push(config);
      if (calls.length === 2 && operationError) throw operationError;
      if (calls.length === 3 && resetError) throw resetError;
      return calls.length === 2 ? { rows: [{ result: '{"status":"published"}' }] } : { rows: [] };
    },
    release: destroy => releases.push(destroy),
  };
  const createClient = env => {
    environments.push(env);
    return { pool: { connect: async () => connection }, queryText: async () => '', close: async () => { closed++; } };
  };
  return { calls, releases, environments, closed: () => closed, createClient };
}

await test('publication uses one connection with fixed long SQL bounds and restores the short session profile', async () => {
  const fixture = harness(), times = [10, 61010.126], phases = [], timings = [];
  const client = createPostgresPublicationClient({ BIPLAN_PG_STATEMENT_TIMEOUT_MS: '29999' }, {
    createClient: fixture.createClient, now: () => times.shift(),
  });
  const result = await client.publishQuery(statement, { afterSetup: async () => phases.push('after_setup'), onTiming: value => timings.push(value) });
  assert.equal(fixture.environments[0].BIPLAN_PG_STATEMENT_TIMEOUT_MS, '5000');
  assert.deepEqual(fixture.calls.map(call => [call.text, call.query_timeout]), [
    ['SET SESSION statement_timeout = 60000', 10000], [statement, 65000], ['SET SESSION statement_timeout = 5000', 10000],
  ]);
  assert.deepEqual(phases, ['after_setup']); assert.deepEqual(timings, [61000.13]);
  assert.equal(result, '{"status":"published"}'); assert.deepEqual(fixture.releases, [false]);
  await client.close(); assert.equal(fixture.closed(), 1);
});

await test('failed timeout reset destroys the checked-out connection', async () => {
  const fixture = harness({ resetError: new Error('reset unavailable') }), times = [0, 1];
  const client = createPostgresPublicationClient({}, { createClient: fixture.createClient, now: () => times.shift() });
  await assert.rejects(client.publishQuery(statement), error => {
    assert.match(error.message, /reset unavailable/); assert.equal(error.publicationResetFailed, true); return true;
  });
  assert.deepEqual(fixture.releases, [true]);
});

await test('SQLSTATE 57014 is preserved and marked as a retryable publication timeout signal', async () => {
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
  const fixture = harness({ operationError: timeout }), times = [0, 60000], timings = [];
  const client = createPostgresPublicationClient({}, { createClient: fixture.createClient, now: () => times.shift() });
  await assert.rejects(client.publishQuery(statement, { onTiming: value => timings.push(value) }), error => {
    assert.equal(error, timeout); assert.equal(error.code, '57014'); assert.equal(error.publicationTimeout, true); return true;
  });
  assert.deepEqual(timings, [60000]); assert.deepEqual(fixture.releases, [false]);
});

await test('interruption detected after setup restores the session without issuing publication SQL', async () => {
  const fixture = harness(), interrupted = Object.assign(new Error('interrupted'), { code: 'worker_interrupted' });
  const client = createPostgresPublicationClient({}, { createClient: fixture.createClient });
  await assert.rejects(client.publishQuery(statement, { afterSetup: async () => { throw interrupted; } }), error => error === interrupted);
  assert.deepEqual(fixture.calls.map(call => call.text), [
    'SET SESSION statement_timeout = 60000', 'SET SESSION statement_timeout = 5000',
  ]);
  assert.deepEqual(fixture.releases, [false]);
});
