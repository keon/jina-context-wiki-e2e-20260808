import pg from "pg";

const { Pool } = pg;

// GitHub repo ids, PR numbers, and installation ids are bigint columns. They fit
// within JS safe-integer range, so parse int8 (OID 20) as a number instead of the
// string pg returns by default — keeps the dashboard JSON numeric.
pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

let pool: pg.Pool | undefined;

export function productDatabaseConnectionString(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const productUrl = environment.JINA_PRODUCT_DATABASE_URL?.trim();
  if (productUrl) {
    return productUrl;
  }
  const legacyUrl = environment.DATABASE_URL?.trim();
  return legacyUrl || undefined;
}

export function databaseConfigured(): boolean {
  return productDatabaseConnectionString() !== undefined;
}

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = productDatabaseConnectionString();
    if (!connectionString) {
      throw new Error("JINA_PRODUCT_DATABASE_URL or DATABASE_URL is not set");
    }
    pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
  }

  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params as unknown[]);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(text, params);
  return rows[0];
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    client.release();
    return result;
  } catch (error) {
    // A failed rollback must not mask the original error. Log it and destroy the
    // connection (release(err)) so a poisoned/aborted-transaction client is not reused.
    try {
      await client.query("rollback");
      client.release();
    } catch (rollbackError) {
      console.error("transaction_rollback_failed", {
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
      client.release(rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError)));
    }
    throw error;
  }
}
