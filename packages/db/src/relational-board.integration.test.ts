import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { Pool } from "pg";

import { BoardAdmissionConflictError, RelationalBoardRepository } from "./board/repository.js";
import { JINA_RUNTIME_SCHEMA_SQL } from "./postgres-json-state-store.js";
import { applyRuntimeMigrations } from "./runtime-migrations.js";

// This test drops and recreates jina_runtime. Never fall back to DATABASE_URL.
const databaseUrl = process.env.TEST_DATABASE_URL;

test("relational Board migration and admission are durable and replay-safe", { skip: !databaseUrl }, async () => {
  const pool = new Pool({ connectionString: databaseUrl, application_name: "jina-relational-board-test", max: 2 });
  const repository = new RelationalBoardRepository();
  const workflowId = randomUUID();
  const prepareTaskId = randomUUID();
  const runtimeTaskId = randomUUID();
  try {
    await pool.query("drop schema if exists jina_runtime cascade");
    await pool.query(JINA_RUNTIME_SCHEMA_SQL);
    await applyRuntimeMigrations(pool);
    await applyRuntimeMigrations(pool);

    const first = await inTransaction(pool, (client) =>
      repository.admitWorkflow(client, {
        workflowId,
        tenantId: "tenant-relational-board",
        workflowType: "pr_review",
        pipelineVersion: "pr_review.v1",
        subjectType: "github_pull_request",
        subjectId: "123:42:head-sha",
        dedupeKey: "review:123:42:head-sha",
        concurrencyKey: "review:123:42",
        triggerType: "webhook",
        tasks: [
          {
            id: prepareTaskId,
            taskType: "prepare-review",
            topic: "prepare-review",
            status: "queued",
            maxAttempts: 3
          },
          {
            id: runtimeTaskId,
            parentTaskId: prepareTaskId,
            taskType: "runtime-review",
            topic: "runtime-review",
            status: "blocked",
            maxAttempts: 3
          }
        ],
        dependencies: [
          {
            taskId: runtimeTaskId,
            dependsOnTaskId: prepareTaskId,
            condition: "success",
            relationship: "prepared-input"
          }
        ]
      })
    );
    assert.equal(first.workflowId, workflowId);
    assert.equal(first.replayed, false);
    assert.deepEqual(first.taskIds, [prepareTaskId, runtimeTaskId]);

    const replay = await inTransaction(pool, (client) =>
      repository.admitWorkflow(client, {
        tenantId: "tenant-relational-board",
        workflowType: "pr_review",
        pipelineVersion: "pr_review.v1",
        subjectType: "github_pull_request",
        subjectId: "123:42:head-sha",
        dedupeKey: "review:123:42:head-sha",
        concurrencyKey: "review:123:42",
        triggerType: "webhook",
        tasks: []
      })
    );
    assert.equal(replay.workflowId, workflowId);
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.taskIds, [prepareTaskId, runtimeTaskId]);

    await assert.rejects(
      inTransaction(pool, (client) =>
        repository.admitWorkflow(client, {
          tenantId: "tenant-relational-board",
          workflowType: "different_workflow",
          pipelineVersion: "pr_review.v1",
          subjectType: "github_pull_request",
          subjectId: "123:42:head-sha",
          dedupeKey: "review:123:42:head-sha",
          concurrencyKey: "review:123:42",
          triggerType: "webhook",
          tasks: []
        })
      ),
      BoardAdmissionConflictError
    );

    const counts = await pool.query<{ workflows: string; tasks: string; dependencies: string; events: string }>(`
      select
        (select count(*)::text from jina_runtime.board_workflows) workflows,
        (select count(*)::text from jina_runtime.board_tasks) tasks,
        (select count(*)::text from jina_runtime.board_dependencies) dependencies,
        (select count(*)::text from jina_runtime.board_events) events
    `);
    assert.deepEqual(counts.rows[0], { workflows: "1", tasks: "2", dependencies: "1", events: "5" });
  } finally {
    await pool.query("drop schema if exists jina_runtime cascade").catch(() => undefined);
    await pool.end();
  }
});

async function inTransaction<T>(pool: Pool, operation: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
