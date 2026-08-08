import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTEXT_ROLES_SQL, CONTEXT_RUNTIME_ROLES } from "./context/roles.js";
import { CONTEXT_SCHEMA_SQL } from "./context/schema.js";

const currentTables = [
  "context_board_publications",
  "context_evidence_snapshots",
  "context_phase_checkpoints",
  "context_phase_operation_leases",
  "context_quota_ledgers",
  "context_release_audit_followups",
  "context_release_audit_runs",
  "context_release_audits",
  "context_releases",
  "context_wiki_projections",
  "current_context_board_releases",
  "issue_graph_releases",
  "repositories",
  "repository_access"
] as const;

test("Context schema has only compact current-path tables", () => {
  const declared = [...CONTEXT_SCHEMA_SQL.matchAll(/create table if not exists jina_context\.([a-z_]+)/g)].map(
    (match) => match[1]
  );
  assert.deepEqual(declared.sort(), [...currentTables].sort());
});

test("every current Context table is tenant scoped", () => {
  for (const table of currentTables) {
    assert.match(CONTEXT_ROLES_SQL, new RegExp(`alter table jina_context\\.${table} enable row level security`));
    assert.match(CONTEXT_ROLES_SQL, new RegExp(`create policy context_tenant_scope on jina_context\\.${table}`));
  }
});

test("promoted api_tokens keeps its Context security model in public", () => {
  assert.match(CONTEXT_SCHEMA_SQL, /create table if not exists public\.api_tokens/);
  assert.match(CONTEXT_ROLES_SQL, /alter table public\.api_tokens enable row level security/);
  assert.match(CONTEXT_ROLES_SQL, /create policy context_api_tokens_verify on public\.api_tokens/);
  assert.match(CONTEXT_ROLES_SQL, /create policy context_tenant_scope on public\.api_tokens/);
  assert.match(CONTEXT_ROLES_SQL, /grant select,insert on public\.api_tokens to jina_context_tokens/);
});

test("release tables are immutable except the one-time Context attachment", () => {
  assert.match(CONTEXT_SCHEMA_SQL, /create trigger context_releases_immutable/);
  assert.match(CONTEXT_SCHEMA_SQL, /immutable outside its one-time attachment/);
  assert.match(CONTEXT_SCHEMA_SQL, /create trigger issue_graph_releases_immutable/);
  assert.match(CONTEXT_SCHEMA_SQL, /reject_immutable_change/);
});

test("runtime roles expose only current-path capabilities", () => {
  assert.deepEqual(CONTEXT_RUNTIME_ROLES, [
    "jina_context_query",
    "jina_context_quota",
    "jina_context_tokens",
    "jina_context_issue_publish",
    "jina_context_tenant_admin"
  ]);
  assert.match(CONTEXT_ROLES_SQL, /grant select on[\s\S]*jina_context\.context_releases/);
  assert.match(CONTEXT_ROLES_SQL, /grant select,insert,update on jina_context\.context_quota_ledgers/);
  assert.doesNotMatch(
    CONTEXT_ROLES_SQL,
    /evidence_records|evidence_checkpoints|context_documents|context_fragments|generation_projectors|exact_index/
  );
});

test("direct repository access replaces the observation and ACL projection pipeline", () => {
  assert.match(CONTEXT_SCHEMA_SQL, /create table if not exists jina_context\.repository_access/);
  assert.match(CONTEXT_SCHEMA_SQL, /permission in \('read','write','admin','denied'\)/);
  assert.doesNotMatch(CONTEXT_SCHEMA_SQL, /observations|repository_acl_observations|repository_acl_projection/);
});
