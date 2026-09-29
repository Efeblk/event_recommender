/** Local-only experiment client. Uses Neo4j's parameterized Query API. */
export class GraphClient {
  readonly origin: string;
  constructor(origin = 'http://127.0.0.1:17474') {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password)
      throw new Error('Graph experiment requires a loopback HTTP database.');
    this.origin = url.origin;
  }
  async query(statement: string, parameters: Record<string, unknown> = {}): Promise<Record<string, unknown>[]> {
    const response = await fetch(`${this.origin}/db/neo4j/query/v2`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ statement, parameters }), redirect: 'error', signal: AbortSignal.timeout(60000),
    });
    if (!response.ok) throw new Error(`Local graph HTTP ${response.status}`);
    const body = await response.json() as { errors?: { code?: string; message?: string }[]; data?: { fields: string[]; values: unknown[][] } };
    if (body.errors?.length) throw new Error(`Graph query failed: ${body.errors.map(error => `${error.code}: ${error.message}`).join('; ')}`);
    if (!body.data) return [];
    return body.data.values.map(values => Object.fromEntries(body.data!.fields.map((key, index) => [key, values[index]])));
  }
}
