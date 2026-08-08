import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getPool } from "./db.js";

loadDotEnv(resolve(process.cwd(), "../.env"));
loadDotEnv(resolve(process.cwd(), ".env"));

const migrationsDir = fileURLToPath(new URL("../../product-migrations/", import.meta.url));
const pool = getPool();

// A session-scoped advisory lock serializes concurrent migrators (two CI deploys, or a CI deploy racing
// a manual run) so they can never apply the same DDL twice. The lock is held on ONE dedicated connection
// for the whole run and released in `finally`; other queries use the pool as before. The key is an
// arbitrary fixed bigint — any process using pg_advisory_lock with this key waits its turn.
const MIGRATION_LOCK_KEY = 8231440072025n;
const lockClient = await pool.connect();
try {
  await lockClient.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);

  await pool.query(
    `create table if not exists schema_migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );
  await pool.query(`alter table schema_migrations add column if not exists checksum char(64)`);

  const applied = new Map(
    (await pool.query<{ name: string; checksum: string | null }>("select name, checksum from schema_migrations")).rows.map(
      (row) => [row.name, row.checksum],
    ),
  );

  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  // 0001_baseline.sql squashes the legacy 0001_initial..0037_collapse chain.
  // A database that finished that chain records the baseline without running
  // it; a database stopped mid-chain has schema state the baseline can neither
  // reproduce nor skip, so it must finish the legacy chain first.
  const BASELINE = "0001_baseline.sql";
  const BASELINE_TERMINAL = "0037_collapse_context_schema.sql";

  for (const file of files) {
    const sql = readFileSync(resolve(migrationsDir, file), "utf8");
    const checksum = createHash("sha256").update(sql, "utf8").digest("hex");

    if (file === BASELINE && !applied.has(BASELINE)) {
      const legacyRows = [...applied.keys()].filter((name) => name !== BASELINE);
      if (applied.has(BASELINE_TERMINAL)) {
        await pool.query("insert into schema_migrations (name, checksum) values ($1, $2)", [file, checksum]);
        applied.set(file, checksum);
        console.log(`skip ${file} (legacy chain already applied; baseline recorded)`);
        continue;
      }
      if (legacyRows.length > 0) {
        throw new Error(
          `${file} squashes the legacy chain through ${BASELINE_TERMINAL}, but this database ` +
            `stopped mid-chain (${legacyRows.length} legacy migrations recorded without ${BASELINE_TERMINAL}). ` +
            `Apply the pre-squash migration chain to completion first, then rerun.`,
        );
      }
    }

    if (applied.has(file)) {
      const stored = applied.get(file);
      if (stored == null) {
        // Rows written before checksum tracking existed: adopt the current
        // content as authoritative so future edits are caught.
        await pool.query("update schema_migrations set checksum=$2 where name=$1", [file, checksum]);
        console.log(`skip ${file} (already applied; checksum recorded)`);
      } else if (stored !== checksum) {
        // Editing an applied migration used to be silently ignored forever.
        throw new Error(
          `migration ${file} was edited after it was applied (checksum ${checksum} != applied ${stored}); ` +
            `add a new migration file instead of editing an applied one`,
        );
      } else {
        console.log(`skip ${file} (already applied)`);
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(sql);
      await client.query("insert into schema_migrations (name, checksum) values ($1, $2)", [file, checksum]);
      await client.query("commit");
      console.log(`applied ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
} finally {
  await lockClient.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => undefined);
  lockClient.release();
}

await pool.end();
console.log("migrations complete");

function loadDotEnv(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }
    const key = line.slice(0, equalsIndex).trim();
    if (process.env[key]) {
      continue;
    }
    let value = line.slice(equalsIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
