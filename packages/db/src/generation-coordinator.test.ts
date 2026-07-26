import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { ContextDatabase } from "./context/database.js";
import { PostgresGenerationCoordinator } from "./context/generation-coordinator.js";

const tenantId = "tenant-a";
const repository = "example/repository";
const ref = "main";
const checkpointId = "ec_current";

test("checkpoint publication preflight refreshes a bounded stale read", async () => {
  let transactions = 0;
  const database = fakeDatabase((client) => {
    transactions += 1;
    return installCheckpointQueries(client, transactions < 3 ? "ec_previous" : checkpointId);
  });

  await new PostgresGenerationCoordinator(database, [0, 0]).assertCurrentCheckpoint(
    tenantId,
    repository,
    ref,
    checkpointId
  );

  assert.equal(transactions, 3);
});

test("checkpoint publication preflight still fails a persistently superseded write", async () => {
  let transactions = 0;
  const database = fakeDatabase((client) => {
    transactions += 1;
    return installCheckpointQueries(client, "ec_newer");
  });

  await assert.rejects(
    new PostgresGenerationCoordinator(database, [0]).assertCurrentCheckpoint(tenantId, repository, ref, checkpointId),
    /observed latest ec_newer at sequence 1/
  );
  assert.equal(transactions, 2);
});

function fakeDatabase(install: (client: Pick<PoolClient, "query">) => void): ContextDatabase {
  return {
    transactionAs: async (_role: string, _scope: unknown, operation: (client: PoolClient) => Promise<unknown>) => {
      const client = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as PoolClient;
      install(client);
      return operation(client);
    }
  } as unknown as ContextDatabase;
}

function installCheckpointQueries(client: Pick<PoolClient, "query">, latestCheckpointId: string): void {
  client.query = (async (query: string) => {
    if (query.includes("from jina_context.evidence_checkpoints")) {
      return { rows: [{ id: latestCheckpointId, ref_sequence: "1" }], rowCount: 1 };
    }
    if (query.includes("from jina_context.pipeline_builds")) {
      return { rows: [{ ref_sequence: "1" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }) as PoolClient["query"];
}
