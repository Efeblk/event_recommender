import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPostgresClient,
  postgresPoolConfig,
} from '../lib/postgres-client.node.ts';

const required = {
  BIPLAN_PG_HOST: 'localhost',
  BIPLAN_PG_DATABASE: 'biplan',
  BIPLAN_PG_USER: 'app',
  BIPLAN_PG_PASSWORD: 'secret-password',
};

void test('PostgreSQL configuration is explicit and bounded', () => {
  assert.throws(() => postgresPoolConfig({}), /Incomplete PostgreSQL configuration/);
  assert.throws(
    () => postgresPoolConfig({ ...required, BIPLAN_PG_POOL_MAX: '11' }),
    /Invalid PostgreSQL connection limit/,
  );
  assert.throws(
    () => postgresPoolConfig({ ...required, BIPLAN_PG_PORT: '0' }),
    /Invalid PostgreSQL connection limit/,
  );

  const config = postgresPoolConfig({
    ...required,
    BIPLAN_PG_PORT: '5544',
    BIPLAN_PG_POOL_MAX: '7',
    BIPLAN_PG_STATEMENT_TIMEOUT_MS: '12000',
  });
  assert.deepEqual(config, {
    host: 'localhost',
    database: 'biplan',
    user: 'app',
    password: 'secret-password',
    port: 5544,
    max: 7,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 12000,
    query_timeout: 17000,
    idle_in_transaction_session_timeout: 10000,
    ssl: false,
    application_name: 'biplan',
  });
  assert.throws(
    () => postgresPoolConfig({ ...required, BIPLAN_PG_STATEMENT_TIMEOUT_MS: '30001' }),
    /Invalid PostgreSQL connection limit/,
  );
});

void test('remote PostgreSQL requires certificate verification', () => {
  const remote = { ...required, BIPLAN_PG_HOST: 'db.example.test' };
  assert.throws(
    () => postgresPoolConfig(remote),
    /Remote PostgreSQL requires verified TLS/,
  );
  assert.throws(
    () => postgresPoolConfig({ ...remote, BIPLAN_PG_TLS: 'prefer' }),
    /Remote PostgreSQL requires verified TLS/,
  );
  assert.deepEqual(
    postgresPoolConfig({
      ...remote,
      BIPLAN_PG_TLS: 'require',
      BIPLAN_PG_CA: 'test-ca',
    }).ssl,
    { rejectUnauthorized: true, ca: 'test-ca' },
  );
  assert.equal(
    postgresPoolConfig({
      ...required,
      BIPLAN_PG_HOST: '/cloudsql/project-1:region-1:instance-1',
    }).ssl,
    false,
  );
});

void test('configuration and idle-pool errors do not expose credentials', async () => {
  const password = 'do-not-print-this-password';
  for (const makeError of [
    () => postgresPoolConfig({ BIPLAN_PG_PASSWORD: password }),
    () =>
      postgresPoolConfig({
        ...required,
        BIPLAN_PG_PASSWORD: password,
        BIPLAN_PG_HOST: 'db.example.test',
      }),
  ]) {
    assert.throws(makeError, (error: unknown) => {
      assert.equal(String(error).includes(password), false);
      return true;
    });
  }

  const client = createPostgresClient({
    ...required,
    BIPLAN_PG_PASSWORD: password,
  });
  const messages: string[] = [];
  const original = console.error;
  console.error = (...values: unknown[]) => messages.push(values.join(' '));
  try {
    client.pool.emit('error', new Error(`connection failed: ${password}`), {} as never);
  } finally {
    console.error = original;
    await client.close();
  }
  assert.deepEqual(messages, ['PostgreSQL idle connection became unavailable']);
  assert.equal(messages.join(' ').includes(password), false);
});
