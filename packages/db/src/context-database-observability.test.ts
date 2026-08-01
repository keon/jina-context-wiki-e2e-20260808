import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { ContextDatabase, contextTenantScope } from "./context/database.js";

test("ContextDatabase separates pool, setup, operation, commit, and total latency", async () => {
  const database = new ContextDatabase({ manageSchema: false });
  const unusedPool = database.pool;
  await unusedPool.end();

  const statements: string[] = [];
  let released = false;
  const client = {
    async query(text: string) {
      statements.push(text);
      return { rows: [], rowCount: 0 };
    },
    release() {
      released = true;
    }
  } as unknown as PoolClient;
  const pool = {
    totalCount: 1,
    idleCount: 0,
    waitingCount: 1,
    options: { max: 1 },
    async connect() {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return client;
    },
    async end() {}
  } as unknown as Pool;
  Object.defineProperty(database, "pool", { value: pool });

  const result = await database.transactionAs(
    "jina_context_admin",
    contextTenantScope("tenant-secret"),
    async () => "done",
    "projection.hydrate.documents"
  );

  assert.equal(result, "done");
  assert.equal(released, true);
  assert.deepEqual(statements, [
    "begin",
    "set local role jina_context_tenant_admin",
    "select set_config('jina.tenant_id',$1,true)",
    "commit"
  ]);

  const telemetry = database.telemetry();
  assert.deepEqual(telemetry.pool, { total: 1, idle: 0, waiting: 1, max: 1 });
  assert.deepEqual(telemetry.metrics.durations.map((metric) => metric.name).sort(), [
    "context.db.pool.checkout_wait_ms",
    "context.db.transaction.commit_ms",
    "context.db.transaction.operation_ms",
    "context.db.transaction.setup_ms",
    "context.db.transaction.total_ms"
  ]);
  assert.equal(
    telemetry.metrics.counters.find((metric) => metric.name === "context.db.pool.queued_checkouts")?.value,
    1
  );
  for (const metric of [...telemetry.metrics.counters, ...telemetry.metrics.durations]) {
    assert.equal(metric.labels.operation, "projection.hydrate.documents");
    assert.equal(metric.labels.role, "jina_context_tenant_admin");
    assert.equal(JSON.stringify(metric.labels).includes("tenant-secret"), false);
  }
});

test("ContextDatabase reports the failing phase with bounded operation labels", async () => {
  const database = new ContextDatabase({ manageSchema: false });
  const unusedPool = database.pool;
  await unusedPool.end();

  const client = {
    async query() {
      return { rows: [], rowCount: 0 };
    },
    release() {}
  } as unknown as PoolClient;
  const pool = {
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
    options: { max: 2 },
    async connect() {
      return client;
    },
    async end() {}
  } as unknown as Pool;
  Object.defineProperty(database, "pool", { value: pool });

  await assert.rejects(
    database.transactionAs(
      "jina_context_query",
      contextTenantScope("tenant-a"),
      async () => {
        throw new Error("query failed");
      },
      "unbounded operation/value"
    ),
    /query failed/
  );

  const telemetry = database.telemetry();
  const failure = telemetry.metrics.counters.find((metric) => metric.name === "context.db.transaction.errors");
  assert.deepEqual(failure?.labels, {
    operation: "other",
    role: "jina_context_query",
    phase: "operation"
  });
  assert.equal(
    telemetry.metrics.counters.find(
      (metric) => metric.name === "context.db.transactions" && metric.labels.outcome === "error"
    )?.value,
    1
  );
});
