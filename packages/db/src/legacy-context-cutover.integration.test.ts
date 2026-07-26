import assert from "node:assert/strict";
import { test } from "node:test";
import { Pool } from "pg";
import { PostgresLegacyContextCutoverAuditor } from "./legacy-context-cutover.js";

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
