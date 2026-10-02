import { Pool, type PoolConfig } from 'pg';

type Environment = Record<string, string | undefined>;
const integer = (value: string | undefined, fallback: number, maximum: number) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) throw new Error('Invalid PostgreSQL connection limit');
  return parsed;
};

/** Explicit opt-in configuration; it never falls back to a machine's default DB. */
export function postgresPoolConfig(env: Environment): PoolConfig {
  const host = env.BIPLAN_PG_HOST?.trim(), database = env.BIPLAN_PG_DATABASE?.trim(), user = env.BIPLAN_PG_USER?.trim();
  if (!host || !database || !user || !env.BIPLAN_PG_PASSWORD) throw new Error('Incomplete PostgreSQL configuration');
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const socket = /^\/cloudsql\/[a-z0-9-]+:[a-z0-9-]+:[a-z0-9-]+$/.test(host);
  if (!local && !socket && env.BIPLAN_PG_TLS !== 'require') throw new Error('Remote PostgreSQL requires verified TLS');
  const statementTimeout = integer(env.BIPLAN_PG_STATEMENT_TIMEOUT_MS, 5000, 30000);
  return {
    host, database, user, password: env.BIPLAN_PG_PASSWORD,
    port: integer(env.BIPLAN_PG_PORT, 5432, 65535),
    max: integer(env.BIPLAN_PG_POOL_MAX, 2, 10),
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000,
    statement_timeout: statementTimeout, query_timeout: statementTimeout + 5000,
    idle_in_transaction_session_timeout: 10000,
    ssl: !local && !socket ? { rejectUnauthorized: true, ...(env.BIPLAN_PG_CA ? { ca: env.BIPLAN_PG_CA } : {}) } : false,
    application_name: 'biplan',
  };
}

export function createPostgresClient(env: Environment) {
  const pool = new Pool(postgresPoolConfig(env));
  // Pool errors otherwise become uncaught events. Never log credentials or SQL.
  pool.on('error', () => console.error('PostgreSQL idle connection became unavailable'));
  return {
    pool,
    queryText: async (statement: string): Promise<string> => {
      const response = await pool.query(statement);
      const last = Array.isArray(response) ? response.at(-1) : response;
      if (!last?.rows.length) return '';
      const value: unknown = Object.values(last.rows[0])[0];
      return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    },
    close: () => pool.end(),
  };
}
