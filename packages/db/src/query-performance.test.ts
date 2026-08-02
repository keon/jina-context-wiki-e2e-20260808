import assert from "node:assert/strict";
import test from "node:test";
import type { IndexGeneration, QueryPlan } from "@jina/context-engine";
import { ContextDatabase } from "./context/database.js";
import { PostgresKnowledgeRepository } from "./context/knowledge-repository.js";
import { PostgresProjectionRepository } from "./context/projection-repository.js";
import { PostgresContextQueryRepository } from "./context/query-repository.js";
import { PostgresIssueGraphRepository } from "./context/issue-graph-repository.js";
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

test("authorized current issue graph lookup is one ACL-aware metadata query", async () => {
  const calls: { readonly sql: string; readonly values: readonly unknown[]; readonly operation: string }[] = [];
  const database = {
    async queryAs(_role: string, _scope: unknown, sql: string, values: readonly unknown[], operation: string) {
      calls.push({ sql, values, operation });
      return { rows: [] };
    }
  } as unknown as ContextDatabase;

  const release = await new PostgresIssueGraphRepository(database).currentAuthorizedIssueGraphRelease(
    "tenant-1",
    "ACME/WIDGETS",
    "main",
    "user:reader@example.com"
  );

  assert.equal(release, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.operation, "issue-graph.current-authorized");
  assert.match(calls[0]!.sql, /current_issue_graph_releases/);
  assert.match(calls[0]!.sql, /exists \(\s*select 1 from jina_context\.current_repository_acl/);
  assert.doesNotMatch(calls[0]!.sql, /issues|causalities|projector|outbox/);
  assert.deepEqual(calls[0]!.values, ["tenant-1", "acme/widgets", "main", "user:reader@example.com"]);
});

test("issue graph publication has constant SQL work regardless of graph cardinality", async () => {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("where release_id=$1")) return { rows: [] };
      if (sql.includes("current_issue_graph_releases") && sql.includes("for update")) return { rows: [] };
      return { rows: [] };
    }
  };
  const database = {
    async transactionAs(
      role: string,
      scope: unknown,
      operation: (value: typeof client) => Promise<unknown>,
      databaseOperation: string
    ) {
      assert.equal(role, "jina_context_issue_publish");
      assert.deepEqual(scope, { tenantIds: ["tenant-1"] });
      assert.equal(databaseOperation, "issue-graph.publish");
      return operation(client);
    }
  } as unknown as ContextDatabase;
  const artifact = {
    uri: "gs://context/context-v2/tenants/tenant-1/repositories/acme/widgets/builds/build-1/issue-graph/release.json",
    key: "context-v2/tenants/tenant-1/repositories/acme/widgets/builds/build-1/issue-graph/release.json",
    contentType: "application/json",
    bytes: 8_000_000,
    sha256: "b".repeat(64)
  };

  await new PostgresIssueGraphRepository(database).publishIssueGraphRelease({
    id: `cir_${"a".repeat(32)}`,
    tenantId: "tenant-1",
    repository: "acme/widgets",
    ref: "main",
    refSequence: 1,
    commitSha: "c".repeat(40),
    buildId: "build-1",
    contentDigest: "d".repeat(64),
    artifact,
    issueCount: 2_000,
    causalityCount: 5_000,
    historyComplete: true,
    publishedAt: "2026-08-01T00:00:00.000Z"
  });

  assert.equal(statements.length, 6);
  assert.equal(statements.filter((sql) => sql.includes("insert into jina_context.repositories")).length, 1);
  assert.equal(statements.filter((sql) => sql.includes("insert into jina_context.issue_graph_releases")).length, 1);
  assert.equal(
    statements.filter((sql) => sql.includes("insert into jina_context.current_issue_graph_releases")).length,
    1
  );
  assert.equal(
    statements.some((sql) => /issue_rows|causality_rows|projector|outbox/.test(sql)),
    false
  );
});

test("atomic issue publication rejects a stale Board write fence before relational writes", async () => {
  const statements: string[] = [];
  const release = {
    id: `cir_${"a".repeat(32)}`,
    tenantId: "tenant-1",
    repository: "acme/widgets",
    ref: "main",
    refSequence: 1,
    commitSha: "c".repeat(40),
    buildId: "task_issue_build",
    contentDigest: "d".repeat(64),
    artifact: {
      uri: "gs://context/context-v2/tenants/tenant-1/repositories/acme/widgets/builds/task_issue_build/issue-graph/release.json",
      key: "context-v2/tenants/tenant-1/repositories/acme/widgets/builds/task_issue_build/issue-graph/release.json",
      contentType: "application/json",
      bytes: 1024,
      sha256: "b".repeat(64)
    },
    issueCount: 20,
    causalityCount: 30,
    historyComplete: true,
    publishedAt: "2026-08-01T00:00:00.000Z"
  };
  const snapshot = {
    intakeState: {
      board: {
        tasks: [
          {
            id: release.buildId,
            type: "build-causal-graph",
            kind: "aggregate",
            metadata: {
              tenantId: release.tenantId,
              repository: release.repository,
              ref: release.ref,
              refSequence: release.refSequence,
              commitSha: release.commitSha
            }
          },
          {
            id: "task_issue_publish",
            type: "publish-causal-graph",
            kind: "dispatchable",
            status: "in_progress",
            attempt: 1,
            metadata: {
              tenantId: release.tenantId,
              repository: release.repository,
              ref: release.ref,
              refSequence: release.refSequence,
              commitSha: release.commitSha,
              contextBuildId: release.buildId
            }
          }
        ],
        outbox: [
          {
            id: "message_issue_publish",
            taskId: "task_issue_publish",
            topic: "run-causal-graph-publication",
            status: "leased",
            payload: { attempt: 1 },
            leaseId: "lease-live",
            writeFenceToken: "fence-live",
            leaseExpiresAt: "2099-01-01T00:00:00.000Z"
          }
        ]
      }
    }
  };
  const client = {
    async query(sql: string) {
      statements.push(sql);
      if (sql.includes("from jina_runtime.api_state")) return { rows: [{ snapshot }] };
      if (sql.includes("clock_timestamp"))
        return { rows: [{ now_ms: String(Date.parse("2026-08-01T00:00:00.000Z")) }] };
      return { rows: [] };
    },
    release() {}
  };
  const database = {
    initialize: async () => undefined,
    pool: { connect: async () => client }
  } as unknown as ContextDatabase;

  await assert.rejects(
    () =>
      new PostgresIssueGraphRepository(database).publishIssueGraphAtomically({
        release,
        lease: {
          taskId: "task_issue_publish",
          messageId: "message_issue_publish",
          attempt: 1,
          leaseId: "lease-live",
          writeFenceToken: "fence-stale",
          leaseExpiresAt: "2099-01-01T00:00:00.000Z"
        }
      }),
    /no longer owns its durable Board lease/
  );
  assert.equal(
    statements.some((sql) => /insert into jina_context\.(?:repositories|issue_graph)/.test(sql)),
    false
  );
  assert.equal(statements.at(-1), "rollback");
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
