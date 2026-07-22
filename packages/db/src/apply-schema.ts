import type { Pool } from "pg";

/**
 * Runs a multi-statement schema script while holding a cross-instance advisory
 * lock, so concurrent boots cannot deadlock inside the DDL. The DDL's table
 * locks can still deadlock against in-flight DML (e.g. a claim transaction
 * holding tasks row locks while the DDL waits between tables), so 40P01 gets
 * a bounded retry.
 */
export async function applySchema(pool: Pool, lockKey: string, schemaSql: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await applySchemaOnce(pool, lockKey, schemaSql);
    } catch (error) {
      if (attempt >= 3 || (error as { code?: string }).code !== "40P01") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

async function applySchemaOnce(pool: Pool, lockKey: string, schemaSql: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [lockKey]);
    await client.query(schemaSql);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
