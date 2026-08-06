import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BOARD_RUNTIME_MIGRATION_0001_SQL } from "./board/schema.js";

/**
 * Runtime migrations are checksummed: applyRuntimeMigrations recomputes the
 * SHA-256 of each migration's SQL and HARD-FAILS on every already-migrated
 * database when the recorded checksum differs. That means an applied
 * migration's SQL is frozen forever — any schema change, however small, must
 * ship as a NEW migration version appended to RUNTIME_MIGRATIONS in
 * runtime-migrations.ts, never as an edit to an existing migration constant.
 *
 * This test pins the digest of every shipped migration so an accidental edit
 * fails here, in CI, instead of during a production deploy. If this test
 * fails: revert the edit to the migration SQL and add a version 000N+1
 * migration containing the change.
 */
const FROZEN_RUNTIME_MIGRATION_CHECKSUMS = [
  {
    version: 1,
    name: "relational_board",
    sql: BOARD_RUNTIME_MIGRATION_0001_SQL,
    sha256: "46509479db2d284de26a08de49ff4fef927703d8910be601c40ae80438be9919"
  }
] as const;

test("applied runtime migrations are frozen; schema changes need a new version", () => {
  for (const migration of FROZEN_RUNTIME_MIGRATION_CHECKSUMS) {
    const digest = createHash("sha256").update(migration.sql, "utf8").digest("hex");
    assert.equal(
      digest,
      migration.sha256,
      `runtime migration ${migration.version} (${migration.name}) was edited after shipping; ` +
        `revert it and add a new migration version instead`
    );
  }
});
