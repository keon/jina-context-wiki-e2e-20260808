import assert from "node:assert/strict";
import test from "node:test";
import type { IndexGeneration, QueryPlan } from "@jina/context-engine";
import { ContextDatabase } from "./context/database.js";
import { PostgresKnowledgeRepository } from "./context/knowledge-repository.js";
import { PostgresProjectionRepository } from "./context/projection-repository.js";
import { PostgresContextQueryRepository } from "./context/query-repository.js";
import { PostgresContextEngineStore } from "./context/store.js";

test("latest published generation and projector statuses use one database round trip", async () => {
  const calls: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
  const database = {
    initialize: async () => undefined,
    queryAs: async (_role: string, _scope: unknown, sql: string, values: readonly unknown[]) => {
      calls.push({ sql, values });
      return {
        rows: [
          {
            id: "generation-1",
            tenant_id: "tenant-1",
            repository: "acme/widgets",
            ref_name: "main",
            commit_sha: "a".repeat(40),
            checkpoint_id: "checkpoint-1",
            projector_versions: { lexical: "v1" },
            projector_statuses: { lexical: "ready", hierarchy: "ready" },
            capabilities: { lexical: "available" },
            required_fingerprint: "required-1",
            acl_fingerprint: "b".repeat(64),
            projection_input_fingerprint: "c".repeat(64),
            created_at: new Date("2026-08-01T00:00:00.000Z"),
            published_at: new Date("2026-08-01T00:01:00.000Z")
          }
        ]
      };
    }
  };
  const repository = new PostgresContextQueryRepository(database as unknown as ContextDatabase);

  const generation = await repository.latestPublished("tenant-1", "acme/widgets", "main", "user:reader");

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /jsonb_object_agg/);
  assert.deepEqual(generation?.projectorStatuses, { lexical: "ready", hierarchy: "ready" });
});

test("exact retrieval batches all requested terms into one indexed query", async () => {
  const calls: { readonly sql: string; readonly values: readonly unknown[] }[] = [];
  const database = {
    initialize: async () => undefined,
    queryAs: async (_role: string, _scope: unknown, sql: string, values: readonly unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] };
    }
  };
  const repository = new PostgresContextQueryRepository(database as unknown as ContextDatabase);

  await repository.exactLookup({
    tenantId: "tenant-1",
    repository: "acme/widgets",
    principalId: "user:reader",
    generationId: "generation-1",
    terms: ["src/cache.ts", "CacheStore", "#42"],
    limit: 12
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /unnest\(\$5::text\[\]\) with ordinality/);
  assert.match(calls[0]!.sql, /exact\.generation_id=\$4 and exact\.term=requested\.term/);
  assert.match(calls[0]!.sql, /count\(\*\)::double precision as exact_score/);
  assert.match(calls[0]!.sql, /partition by matched\.term/);
  assert.match(calls[0]!.sql, /order by coverage_round,term_ordinal,exact_score desc,document_id/);
  assert.deepEqual(calls[0]!.values[4], ["src/cache.ts", "CacheStore", "#42"]);
});

test("store does not fan exact terms out across the connection pool", async () => {
  const store = new PostgresContextEngineStore({ manageSchema: false, connectionString: "postgresql://unused" });
  const calls: { readonly terms: readonly string[] }[] = [];
  Object.defineProperty(store, "query", {
    value: {
      exactLookup: async (input: { readonly terms: readonly string[] }) => {
        calls.push({ terms: input.terms });
        return [];
      }
    }
  });
  const targets = Array.from({ length: 50 }, (_, index) => `src/module-${index}.ts`);
  const plan = {
    normalizedQuestion: "Find the requested paths",
    taskKind: "lookup",
    routes: [],
    targets: { paths: targets, symbols: [], pullRequests: [], issues: [] },
    plannerVersion: "test"
  } satisfies QueryPlan;

  try {
    const result = await store.retrieveIndexed({
      tenantId: "tenant-1",
      repository: "acme/widgets",
      principalId: "user:reader",
      generation: { id: "generation-1" } as IndexGeneration,
      plan,
      route: "exact",
      limit: 12,
      allowedAclFingerprints: new Set(["acl-1"])
    });

    assert.deepEqual(result, []);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.terms, targets);
  } finally {
    await store.close();
  }
});

test("projection hydration reuses one tenant-scoped transaction without saturating the pool", async () => {
  const operations: string[] = [];
  const statements: string[] = [];
  let hydrationTransactions = 0;
  const generation = {
    id: "generation-1",
    tenant_id: "tenant-1",
    repository: "acme/widgets",
    ref_name: "main",
    commit_sha: "a".repeat(40),
    checkpoint_id: "checkpoint-1",
    status: "published",
    projector_versions: {},
    capabilities: {},
    required_fingerprint: "required-1",
    acl_fingerprint: "b".repeat(64),
    projection_input_fingerprint: "c".repeat(64),
    created_at: new Date("2026-08-01T00:00:00.000Z"),
    published_at: new Date("2026-08-01T00:01:00.000Z")
  };
  const client = {
    async query(sql: string) {
      statements.push(sql);
      return sql.includes("generation_projectors")
        ? { rows: [{ consumer: "lexical", status: "ready" }] }
        : { rows: [] };
    }
  };
  const database = {
    initialize: async () => undefined,
    queryAs: async () => ({ rows: [generation] }),
    transactionAs: async (
      _role: string,
      _scope: unknown,
      operation: (value: typeof client) => Promise<unknown>,
      databaseOperation: string
    ) => {
      hydrationTransactions += 1;
      assert.equal(databaseOperation, "projection.hydrate");
      return operation(client);
    },
    observeOperation: async (_role: string, databaseOperation: string, operation: () => Promise<unknown>) => {
      operations.push(databaseOperation);
      return operation();
    }
  };
  const repository = new PostgresProjectionRepository(database as unknown as ContextDatabase);

  const projection = await repository.getGeneration("generation-1");

  assert.equal(hydrationTransactions, 1);
  assert.equal(statements.length, 7);
  assert.deepEqual(operations, [
    "projection.hydrate.statuses",
    "projection.hydrate.manifest",
    "projection.hydrate.current-knowledge",
    "projection.hydrate.documents",
    "projection.hydrate.fragments",
    "projection.hydrate.hierarchy",
    "projection.hydrate.relations"
  ]);
  assert.equal(projection?.generation.id, "generation-1");
});

test("citation hydration batches revision ids into one database query", async () => {
  const calls: { readonly sql: string; readonly values: readonly unknown[]; readonly operation: string }[] = [];
  const database = {
    initialize: async () => undefined,
    queryAs: async (_role: string, _scope: unknown, sql: string, values: readonly unknown[], operation: string) => {
      calls.push({ sql, values, operation });
      return { rows: [] };
    }
  };
  const repository = new PostgresKnowledgeRepository(database as unknown as ContextDatabase);

  const result = await repository.listCitationsForRevisions(["revision-a", "revision-b", "revision-a"]);

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /revision_id=any\(\$1::text\[\]\)/);
  assert.deepEqual(calls[0]!.values, [["revision-a", "revision-b"]]);
  assert.equal(calls[0]!.operation, "knowledge.list-citations-batch");
  assert.deepEqual([...result.keys()], ["revision-a", "revision-b"]);
});
