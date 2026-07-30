import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_ROLES_SQL } from "./context/roles.js";
import { CONTEXT_SCHEMA_SQL } from "./context/schema.js";

test("legacy pipeline and derivation checkpoint tables are absent", () => {
  for (const table of [
    "pipeline_builds",
    "pipeline_stages",
    "derivation_progress",
    "derivation_orchestration",
    "derivation_private_checkpoints"
  ]) {
    assert.doesNotMatch(CONTEXT_SCHEMA_SQL, new RegExp(`create table if not exists jina_context\\.${table}\\b`));
    assert.doesNotMatch(CONTEXT_ROLES_SQL, new RegExp(`jina_context\\.${table}\\b`));
  }
});

test("board publication rows and current pointers enforce tenant RLS", () => {
  for (const table of ["context_board_publications", "current_context_board_releases"]) {
    assert.match(CONTEXT_ROLES_SQL, new RegExp(`alter table jina_context\\.${table} enable row level security`));
    assert.match(
      CONTEXT_ROLES_SQL,
      new RegExp(`create policy context_tenant_scope on jina_context\\.${table}\\s+using`)
    );
  }
  assert.match(
    CONTEXT_ROLES_SQL,
    /grant select on\s+[\s\S]*?jina_context\.context_board_publications,jina_context\.current_context_board_releases,[\s\S]*?\nto jina_context_query;/
  );
});

test("quota ledgers have a tenant-scoped least-privilege runtime role", () => {
  assert.match(CONTEXT_ROLES_SQL, /'jina_context_quota'/);
  assert.match(
    CONTEXT_ROLES_SQL,
    /grant select,insert,update on jina_context\.context_quota_ledgers\s+to jina_context_quota;/
  );
  assert.doesNotMatch(CONTEXT_ROLES_SQL, /grant [^;]*delete[^;]*context_quota_ledgers[^;]*jina_context_quota/i);
  assert.match(CONTEXT_ROLES_SQL, /alter table jina_context\.context_quota_ledgers enable row level security;/);
  assert.match(CONTEXT_ROLES_SQL, /create policy context_tenant_scope on jina_context\.context_quota_ledgers\s+using/);
});
