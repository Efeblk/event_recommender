import { performance } from 'node:perf_hooks';
import { createPostgresClient } from '../lib/postgres-client.node.ts';

export const PUBLICATION_SERVER_TIMEOUT_MS = 60000;
export const PUBLICATION_DRIVER_TIMEOUT_MS = 65000;
export const PUBLICATION_CONTROL_TIMEOUT_MS = 5000;
export const PUBLICATION_CLOSE_TIMEOUT_MS = 5000;

const text = response => {
  const last = Array.isArray(response) ? response.at(-1) : response;
  if (!last?.rows.length) return '';
  const value = Object.values(last.rows[0])[0];
  return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
};
const timing = value => Math.round(Math.max(0, value) * 100) / 100;
const boundedQuery = (connection, statement, timeoutMs) => Promise.resolve(connection.query({ text: statement, query_timeout: timeoutMs }));
const publicationTimeout = error => {
  if (error && typeof error === 'object' && (error.code === '57014' || /statement timeout|query read timeout/i.test(String(error.message))))
    error.publicationTimeout = true;
  return error;
};

/** Worker-only client: short controls plus one explicitly routed publication call. */
export function createPostgresPublicationClient(env, { createClient = createPostgresClient, now = () => performance.now() } = {}) {
  const client = createClient({ ...env, BIPLAN_PG_STATEMENT_TIMEOUT_MS: String(PUBLICATION_CONTROL_TIMEOUT_MS) });
  return {
    ...client,
    publishQuery: async (statement, { afterSetup, onTiming } = {}) => {
      const connection = await client.pool.connect();
      let response, operationError, resetError;
      try {
        await boundedQuery(connection, `SET SESSION statement_timeout = ${PUBLICATION_SERVER_TIMEOUT_MS}`, 10000);
        await afterSetup?.();
        const started = now();
        try {
          response = await boundedQuery(connection, statement, PUBLICATION_DRIVER_TIMEOUT_MS);
        } catch (error) {
          operationError = publicationTimeout(error);
        } finally {
          onTiming?.(timing(now() - started));
        }
      } catch (error) {
        operationError = error;
      } finally {
        try {
          await boundedQuery(connection, `SET SESSION statement_timeout = ${PUBLICATION_CONTROL_TIMEOUT_MS}`, 10000);
        } catch (error) {
          resetError = error;
          if (resetError && typeof resetError === 'object') resetError.publicationResetFailed = true;
        }
        connection.release(resetError !== undefined);
      }
      if (operationError) throw operationError;
      if (resetError) throw resetError;
      return text(response);
    },
    close: async () => {
      let timeout;
      try {
        await Promise.race([
          client.close(),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('PostgreSQL publication client close timed out')), PUBLICATION_CLOSE_TIMEOUT_MS); }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
