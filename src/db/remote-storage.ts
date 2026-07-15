import pg from "pg";
import type { Pool, PoolClient } from "pg";

function translatePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeParams(params: unknown[]): unknown[] {
  const flat = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map((value) => value === undefined ? null : value);
}

function sslConfigFor(connectionString: string): { rejectUnauthorized: boolean } | undefined {
  return connectionString.includes("sslmode=require") || connectionString.includes("ssl=true")
    ? { rejectUnauthorized: false }
    : undefined;
}

export class PgAdapterAsync {
  private readonly pool: Pool;
  private readonly client: PoolClient | null;

  constructor(connectionString: string, pool?: Pool, client?: PoolClient) {
    this.pool = pool ?? new pg.Pool({ connectionString, ssl: sslConfigFor(connectionString) });
    this.client = client ?? null;
  }

  private query(sql: string, params: unknown[]) {
    return (this.client ?? this.pool).query(translatePlaceholders(sql), normalizeParams(params));
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.query(sql, params);
    return { changes: result.rowCount ?? 0 };
  }

  async get(sql: string, ...params: unknown[]): Promise<unknown> {
    const result = await this.query(sql, params);
    return result.rows[0] ?? null;
  }

  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    const result = await this.query(sql, params);
    return result.rows;
  }

  async exec(sql: string): Promise<void> {
    await (this.client ?? this.pool).query(sql);
  }

  async transaction<T>(operation: (transaction: PgAdapterAsync) => Promise<T>): Promise<T> {
    if (this.client) return operation(this);
    const client = await this.pool.connect();
    const transaction = new PgAdapterAsync("", this.pool, client);
    try {
      await client.query("BEGIN");
      const result = await operation(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
