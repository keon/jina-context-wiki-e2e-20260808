import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { hardenContextRuntimeRole, PostgresLegacyContextCutoverAuditor } from "./legacy-context-cutover.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

test(
  "legacy SQL cutover audit reads authoritative graph pipeline and projection tables",
  { skip: !databaseUrl },
  async () => {
    const bootstrap = new Pool({ connectionString: databaseUrl });
    await bootstrap.query("drop schema if exists jina_board cascade");
    await bootstrap.query("drop schema if exists jina_context_graph cascade");
    await bootstrap.query(`
      create schema jina_board;
      create table jina_board.workflows (
        id text primary key,
        tenant_id text not null,
        status text not null
      );
      create table jina_board.tasks (
        id text primary key,
        tenant_id text not null,
        status text not null,
        lease_id text,
        worker_id text,
        lease_expires_at timestamptz
      );
      create schema jina_context_graph;
      create table jina_context_graph.outbox (
        id text primary key,
        tenant_id text not null,
        processed_at timestamptz
      );
    `);
    await bootstrap.query(
      `insert into jina_board.workflows (id,tenant_id,status)
       values ('workflow-done','tenant-a','done'),('workflow-failed','tenant-b','failed');
       insert into jina_board.tasks (id,tenant_id,status)
       values ('task-done','tenant-a','done'),('task-canceled','tenant-b','canceled');
       insert into jina_context_graph.outbox (id,tenant_id,processed_at)
       values ('outbox-done','tenant-a',now());`
    );

    const auditor = new PostgresLegacyContextCutoverAuditor({ connectionString: databaseUrl });
    try {
      assert.deepEqual(await auditor.audit(["tenant-b", "tenant-a"]), [
        {
          tenantId: "tenant-a",
          workflowCount: 1,
          terminalWorkflowCount: 1,
          taskCount: 1,
          terminalTaskCount: 1,
          outboxCount: 1,
          processedOutboxCount: 1
        },
        {
          tenantId: "tenant-b",
          workflowCount: 1,
          terminalWorkflowCount: 1,
          taskCount: 1,
          terminalTaskCount: 1,
          outboxCount: 0,
          processedOutboxCount: 0
        }
      ]);

      await bootstrap.query(
        "insert into jina_board.workflows (id,tenant_id,status) values ('workflow-active','tenant-a','queued')"
      );
      await assert.rejects(auditor.audit(["tenant-a", "tenant-b"]), /workflow-active\/queued/);
      await bootstrap.query("delete from jina_board.workflows where id='workflow-active'");

      await bootstrap.query(
        `insert into jina_board.tasks (id,tenant_id,status,lease_id,worker_id,lease_expires_at)
         values ('task-leased','tenant-a','done','lease-1','worker-1',now())`
      );
      await assert.rejects(auditor.audit(["tenant-a", "tenant-b"]), /task-leased\/done/);
      await bootstrap.query("delete from jina_board.tasks where id='task-leased'");

      await bootstrap.query(
        "insert into jina_context_graph.outbox (id,tenant_id) values ('outbox-pending','tenant-a')"
      );
      await assert.rejects(auditor.audit(["tenant-a", "tenant-b"]), /tenant-a\/outbox-pending/);
      await bootstrap.query("delete from jina_context_graph.outbox where id='outbox-pending'");

      await bootstrap.query(
        "insert into jina_board.workflows (id,tenant_id,status) values ('workflow-uninventoried','tenant-c','done')"
      );
      await assert.rejects(auditor.audit(["tenant-a", "tenant-b"]), /inventory is incomplete: tenant-c/);
      await bootstrap.query("delete from jina_board.workflows where id='workflow-uninventoried'");

      await bootstrap.query("drop table jina_context_graph.outbox");
      await assert.rejects(auditor.audit(["tenant-a", "tenant-b"]), /relation is missing: jina_context_graph.outbox/);
    } finally {
      await auditor.close();
      await bootstrap.end();
    }
  }
);

test("legacy schema hardening archives runtime-owned identity sequences", { skip: !databaseUrl }, async () => {
  const bootstrap = new Pool({ connectionString: databaseUrl });
  const runtimeRole = "jina_context_cutover_test_runtime";
  try {
    await bootstrap.query("drop schema if exists jina_context_graph cascade");
    await bootstrap.query("drop schema if exists jina_runtime cascade");
    await bootstrap.query("drop role if exists jina_legacy_archive");
    await bootstrap.query(`drop role if exists ${runtimeRole}`);
    await bootstrap.query(`create role ${runtimeRole} login inherit`);
    await bootstrap.query(`create schema jina_context_graph authorization ${runtimeRole}`);
    await bootstrap.query(`create schema jina_runtime`);
    await bootstrap.query(
      `create table jina_runtime.api_state (
         id smallint primary key,
         snapshot jsonb not null
       );
       create table jina_runtime.github_deliveries (
         delivery_id text primary key
       )`
    );
    await bootstrap.query(`set role ${runtimeRole}`);
    await bootstrap.query(
      `create table jina_context_graph.retrieval_metrics (
         id bigint generated always as identity primary key,
         query text not null
       )`
    );
    await bootstrap.query("reset role");

    await hardenContextRuntimeRole(bootstrap, runtimeRole);

    const owners = await bootstrap.query<{ relkind: string; owner: string }>(
      `select c.relkind,pg_get_userbyid(c.relowner) as owner
       from pg_class c
       join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='jina_context_graph'
         and c.relname in ('retrieval_metrics','retrieval_metrics_id_seq')
       order by c.relkind`
    );
    assert.deepEqual(owners.rows, [
      { relkind: "S", owner: "jina_legacy_archive" },
      { relkind: "r", owner: "jina_legacy_archive" }
    ]);

    const runtime = await bootstrap.query<{
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
    }>(
      `select rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,rolreplication
       from pg_roles
       where rolname=$1`,
      [runtimeRole]
    );
    assert.deepEqual(runtime.rows, [
      {
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false
      }
    ]);
    const migrationMembership = await bootstrap.query<{ is_member: boolean }>(
      `select exists (
         select 1
         from pg_auth_members membership
         join pg_roles granted_role on granted_role.oid=membership.roleid
         join pg_roles member_role on member_role.oid=membership.member
         where granted_role.rolname='jina_legacy_archive'
           and member_role.rolname=current_user
       ) as is_member`
    );
    assert.equal(migrationMembership.rows[0]?.is_member, false);
    const supportPrivileges = await bootstrap.query<{
      api_delete: boolean;
      api_insert: boolean;
      api_select: boolean;
      api_update: boolean;
      delivery_delete: boolean;
      delivery_insert: boolean;
      delivery_select: boolean;
      runtime_create: boolean;
      runtime_usage: boolean;
    }>(
      `select
         has_schema_privilege($1,'jina_runtime','USAGE') as runtime_usage,
         has_schema_privilege($1,'jina_runtime','CREATE') as runtime_create,
         has_table_privilege($1,'jina_runtime.api_state','SELECT') as api_select,
         has_table_privilege($1,'jina_runtime.api_state','INSERT') as api_insert,
         has_table_privilege($1,'jina_runtime.api_state','UPDATE') as api_update,
         has_table_privilege($1,'jina_runtime.api_state','DELETE') as api_delete,
         has_table_privilege($1,'jina_runtime.github_deliveries','SELECT') as delivery_select,
         has_table_privilege($1,'jina_runtime.github_deliveries','INSERT') as delivery_insert,
         has_table_privilege($1,'jina_runtime.github_deliveries','DELETE') as delivery_delete`,
      [runtimeRole]
    );
    assert.deepEqual(supportPrivileges.rows, [
      {
        runtime_usage: true,
        runtime_create: false,
        api_select: true,
        api_insert: true,
        api_update: true,
        api_delete: false,
        delivery_select: true,
        delivery_insert: true,
        delivery_delete: false
      }
    ]);
  } finally {
    await bootstrap.query("reset role");
    await bootstrap.query("drop schema if exists jina_context_graph cascade");
    await bootstrap.query("drop schema if exists jina_runtime cascade");
    await bootstrap.query("drop role if exists jina_legacy_archive");
    await bootstrap.query(`drop role if exists ${runtimeRole}`);
    await bootstrap.end();
  }
});

test("documented CREATEROLE migration login can harden an ordinary runtime login", { skip: !databaseUrl }, async () => {
  const bootstrap = new Pool({ connectionString: databaseUrl });
  const migrationRole = "jina_context_cutover_test_migration";
  const runtimeRole = "jina_context_cutover_test_ordinary";
  const password = "context-cutover-migration-password";
  try {
    await bootstrap.query(`drop role if exists ${runtimeRole}`);
    await bootstrap.query(`drop role if exists ${migrationRole}`);
    await bootstrap.query(`create role ${migrationRole} login createrole password '${password}'`);
    await bootstrap.query(`set role ${migrationRole}`);
    await bootstrap.query(`create role ${runtimeRole} login inherit`);
    await bootstrap.query("reset role");

    const migrationUrl = new URL(databaseUrl!);
    migrationUrl.username = migrationRole;
    migrationUrl.password = password;
    const migration = new Pool({ connectionString: migrationUrl.toString(), max: 1 });
    try {
      await hardenContextRuntimeRole(migration, runtimeRole);
    } finally {
      await migration.end();
    }

    const runtime = await bootstrap.query<{
      rolbypassrls: boolean;
      rolcreatedb: boolean;
      rolcreaterole: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
      rolsuper: boolean;
    }>(
      `select rolbypassrls,rolcreatedb,rolcreaterole,rolinherit,rolreplication,rolsuper
       from pg_roles
       where rolname=$1`,
      [runtimeRole]
    );
    assert.deepEqual(runtime.rows, [
      {
        rolbypassrls: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolsuper: false
      }
    ]);
  } finally {
    await bootstrap.query("reset role");
    await bootstrap.query(`drop role if exists ${runtimeRole}`);
    await bootstrap.query(`drop role if exists ${migrationRole}`);
    await bootstrap.end();
  }
});
