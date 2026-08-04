import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { BOARD_RUNTIME_MIGRATION_0001_SQL } from "./board/schema.js";

interface RuntimeMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const RUNTIME_MIGRATIONS: readonly RuntimeMigration[] = [
  {
    version: 1,
    name: "relational_board",
    sql: BOARD_RUNTIME_MIGRATION_0001_SQL
  }
];

export async function applyRuntimeMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('jina_runtime.schema_migrations'))");
    await client.query(`
      create table if not exists jina_runtime.schema_migrations (
        version integer primary key check (version > 0),
        name text not null unique,
        checksum char(64) not null,
        applied_at timestamptz not null default clock_timestamp()
      )
    `);

    for (const migration of RUNTIME_MIGRATIONS) {
      await applyRuntimeMigration(client, migration);
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('jina_runtime.schema_migrations'))").catch(() => undefined);
    client.release();
  }
}

async function applyRuntimeMigration(client: PoolClient, migration: RuntimeMigration): Promise<void> {
  const checksum = createHash("sha256").update(migration.sql, "utf8").digest("hex");
  const applied = await client.query<{ name: string; checksum: string }>(
    "select name,checksum from jina_runtime.schema_migrations where version=$1",
    [migration.version]
  );
  const existing = applied.rows[0];
  if (existing) {
    if (existing.name !== migration.name || existing.checksum !== checksum) {
      throw new Error(
        `runtime migration ${migration.version} does not match applied ${existing.name}:${existing.checksum}`
      );
    }
    return;
  }

  try {
    await client.query("begin");
    await client.query(migration.sql);
    await client.query("insert into jina_runtime.schema_migrations(version,name,checksum) values ($1,$2,$3)", [
      migration.version,
      migration.name,
      checksum
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  }
}
