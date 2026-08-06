import pg from "pg";
import type { PoolConfig } from "pg";

const { Pool } = pg;

// GitHub repo ids, PR numbers, and installation ids are bigint columns. They fit
// within JS safe-integer range, so parse int8 (OID 20) as a number instead of the
// string pg returns by default — keeps the dashboard JSON numeric.
pg.types.setTypeParser(20, (value) => (value === null ? null : Number(value)));

let pool: pg.Pool | undefined;

/**
 * Mount the product API on the listener's existing database pool. The product
 * migration CLI can still create its own pool, but the combined API process
 * must not maintain two independent pools to the same database.
 */
export function configureProductDatabasePool(sharedPool: pg.Pool): void {
  if (pool && pool !== sharedPool) {
    throw new Error("Product database pool was already initialized independently");
  }
  pool = sharedPool;
}

export function productDatabaseConnectionString(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const productUrl = environment.JINA_PRODUCT_DATABASE_URL?.trim();
  if (productUrl) {
    return productUrl;
  }
  const legacyUrl = environment.DATABASE_URL?.trim();
  return legacyUrl || undefined;
}

/**
 * Product data now shares the v2 database connection used by Context in staging.
 * `url` remains the default so production can adopt the cutover independently;
 * setting `JINA_PRODUCT_DATABASE_MODE=shared` is the explicit, fail-closed switch.
 */
export function productDatabaseConfig(environment: NodeJS.ProcessEnv = process.env): PoolConfig | undefined {
  const mode = environment.JINA_PRODUCT_DATABASE_MODE?.trim() || "url";
  if (mode === "shared") {
    const host = environment.INSTANCE_UNIX_SOCKET?.trim() || environment.DB_HOST?.trim();
    const user = environment.DB_USER?.trim();
    const password = environment.DB_PASS;
    const database = environment.DB_NAME?.trim();
    if (!host || !user || !password || !database) return undefined;
    return {
      host,
      user,
      password,
      database,
      ...(environment.DB_PORT ? { port: Number(environment.DB_PORT) } : {}),
    };
  }
  if (mode !== "url") {
    throw new Error(`Unsupported JINA_PRODUCT_DATABASE_MODE: ${mode}`);
  }
  const connectionString = productDatabaseConnectionString(environment);
  return connectionString ? { connectionString } : undefined;
}

export function databaseConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
  // Mounting a shared pool reuses connections; it does not enable product
  // persistence by itself. The explicit product database configuration remains
  // the feature boundary, which also keeps no-database app instances isolated
  // from an earlier app that warmed this module-level pool in the same process.
  return productDatabaseConfig(environment) !== undefined;
}

export function getPool(): pg.Pool {
  if (!pool) {
    const config = productDatabaseConfig();
    if (!config) {
      throw new Error(
        "Product database is not configured: set the shared DB_* values or JINA_PRODUCT_DATABASE_URL",
      );
    }
    pool = new Pool({ ...config, max: 5, idleTimeoutMillis: 30_000 });
  }

  return pool;
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
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
