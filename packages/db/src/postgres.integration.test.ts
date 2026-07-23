import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONTEXT_GRAPH_GENERATOR_VERSION,
  CONTEXT_GRAPH_PARSER_VERSION,
  CONTEXT_GRAPH_REGISTRY_VERSION,
  RepositoryContextOrchestrator,
  type CausalTraceProjection,
  createContextGraph,
  derivedIssueNaturalKey,
  featureNaturalKey,
  parseIncidentDocumentObservations,
  predicateRegistry,
  stableId
} from "@jina/context-graph";
import { PostgresJsonStateStore } from "./postgres-json-state-store.js";
import { CONTEXT_GRAPH_SCHEMA_SQL, PostgresContextGraphStore } from "./postgres-context-graph-store.js";
import { CONTEXT_GRAPH_ROLES_SQL } from "./context-graph-roles.js";
import { PostgresContextGraphPipelineCoordinator } from "./postgres-context-graph-pipeline-coordinator.js";
import { Pool } from "pg";

const connectionString = process.env.TEST_DATABASE_URL;

test("Postgres schema backstops every cardinality-one predicate from the registry", () => {
  const expected = Object.values(predicateRegistry)
    .filter((definition) => definition.cardinality === "one")
    .map((definition) => definition.name)
    .sort();
  assert.ok(expected.length >= 5);
  const index =
    /create unique index if not exists context_graph_assertions_one_active_\w+[\s\S]+?where status='active' and predicate in \(([^)]+)\)/.exec(
      CONTEXT_GRAPH_SCHEMA_SQL
    );
  assert.ok(index, "cardinality-one backstop index is missing");
  assert.deepEqual(
    index[1]!.split(",").map((name) => name.trim().replace(/^'|'$/g, "")),
    expected
  );
});

test(
  "Postgres schema reconciles legacy cardinality-one duplicates before widening the backstop index",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const pool = new Pool({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `legacy-${suffix}`;
    const repository = `omxyz/legacy-${suffix}`;
    try {
      await pool.query(CONTEXT_GRAPH_SCHEMA_SQL);
      // Simulate the pre-widening state: no backstop index, and two active
      // DEPLOYS rows for one subject — legal under the old three-predicate index.
      await pool.query(`
        do $$ declare stale record; begin
          for stale in select indexname from pg_indexes
            where schemaname='jina_context_graph' and indexname like 'context_graph_assertions_one_active%'
          loop execute format('drop index jina_context_graph.%I', stale.indexname); end loop;
        end $$`);
      const entity = (kind: string, key: string) => stableId("entity", `${tenantId}:${kind}:${key}`);
      const deployment = entity("Deployment", "deployment:test:legacy");
      const commitA = entity("Commit", "sha:a");
      const commitB = entity("Commit", "sha:b");
      await pool.query(
        `insert into jina_context_graph.entities (id,tenant_id,kind,natural_key,display_name,created_at)
         values ($1,$2,'Deployment','deployment:test:legacy','legacy deploy',now()),
                ($3,$2,'Commit','sha:a','commit a',now()),
                ($4,$2,'Commit','sha:b','commit b',now())`,
        [deployment, tenantId, commitA, commitB]
      );
      const assertionRow = (id: string, objectId: string, recordedAt: string) =>
        pool.query(
          `insert into jina_context_graph.assertions
            (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,
             predicate,object_id,object_kind,object_natural_key,object_label,status,evidence,explanation,
             asserted_by,generator_version,registry_version,recorded_at,last_confirmed_at)
           values ($1,$2,$3,'command',$4,'Deployment','deployment:test:legacy','legacy deploy',
                   'DEPLOYS',$5,'Commit','sha','sha','active','[]'::jsonb,'legacy duplicate for migration test',
                   'test:legacy','test','test',$6,$6)`,
          [id, tenantId, repository, deployment, objectId, recordedAt]
        );
      await assertionRow("assertion_legacy_older", commitA, "2026-01-01T00:00:00Z");
      await assertionRow("assertion_legacy_newer", commitB, "2026-02-01T00:00:00Z");

      // Re-applying the schema must reconcile the duplicates, then create the
      // widened index — instead of failing every boot with 23505.
      await pool.query(CONTEXT_GRAPH_SCHEMA_SQL);
      const rows = await pool.query<{
        id: string;
        status: string;
        superseded_by: string | null;
        audit_id: string | null;
      }>(
        `select id,status,superseded_by,audit_id from jina_context_graph.assertions
         where tenant_id=$1 order by id`,
        [tenantId]
      );
      assert.deepEqual(
        rows.rows.map((row) => [row.id, row.status, row.superseded_by]),
        [
          ["assertion_legacy_newer", "active", null],
          ["assertion_legacy_older", "superseded", "assertion_legacy_newer"]
        ]
      );
      const audit = await pool.query<{ actor_id: string }>(
        `select actor_id from jina_context_graph.audit_log where tenant_id=$1 and id=$2`,
        [tenantId, rows.rows[1]!.audit_id]
      );
      assert.equal(audit.rows[0]?.actor_id, "svc:schema-migration");
      const indexes = await pool.query(
        `select indexname from pg_indexes
         where schemaname='jina_context_graph' and indexname like 'context_graph_assertions_one_active%'`
      );
      assert.equal(indexes.rows.length, 1);
      // Idempotent: a further apply changes nothing.
      await pool.query(CONTEXT_GRAPH_SCHEMA_SQL);
      const unchanged = await pool.query<{ active: number }>(
        `select count(*)::int as active from jina_context_graph.assertions where tenant_id=$1 and status='active'`,
        [tenantId]
      );
      assert.equal(unchanged.rows[0]?.active, 1);
    } finally {
      await pool.end();
    }
  }
);

test(
  "Postgres ingestion reuses a canonical observation id after a tenant-id remap",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const suffix = Date.now().toString(36);
    const tenantId = `remapped-${suffix}`;
    const repository = `omxyz/remapped-${suffix}`;
    const commitSha = "a".repeat(40);
    const legacyObservationId = `observation_legacy_${suffix}`;
    const store = new PostgresContextGraphStore({ connectionString });
    const pool = new Pool({ connectionString });
    try {
      await store.list(tenantId);
      await pool.query(
        `insert into jina_context_graph.observations
          (id,tenant_id,source,type,external_id,repository,recorded_at,payload,payload_sha)
         values ($1,$2,'git','source_snapshot',$3,$4,'2026-07-21T00:00:00.000Z','{}'::jsonb,'legacy')`,
        [legacyObservationId, tenantId, `${repository}:${commitSha}`, repository]
      );

      const plan = await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        treeSha: "b".repeat(40),
        parents: [],
        recordedAt: "2026-07-21T00:01:00.000Z",
        taskId: `task-remapped-${suffix}`,
        files: []
      });

      assert.equal(plan.observationId, legacyObservationId);
      const observations = await pool.query<{ id: string }>(
        `select id from jina_context_graph.observations
         where tenant_id=$1 and source='git' and external_id=$2`,
        [tenantId, `${repository}:${commitSha}`]
      );
      assert.deepEqual(
        observations.rows.map((row) => row.id),
        [legacyObservationId]
      );
    } finally {
      await Promise.all([store.close(), pool.end()]);
    }
  }
);

test(
  "Postgres context graph pipeline claims once and fences superseded leases",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const suffix = Date.now().toString(36);
    const tenantId = `pipeline-${suffix}`;
    const repository = `omxyz/pipeline-${suffix}`;
    const first = new PostgresContextGraphPipelineCoordinator({ connectionString });
    const second = new PostgresContextGraphPipelineCoordinator({ connectionString });
    const graphStore = new PostgresContextGraphStore({ connectionString });
    const cleanup = new Pool({ connectionString });
    try {
      await first.createBuild({
        tenantId,
        repository,
        ref: "main",
        requestKey: "old",
        snapshotFirst: true,
        createdAt: "2026-07-21T00:00:00.000Z"
      });
      const claims = await Promise.all(
        [first, second].map((coordinator, index) =>
          coordinator.claim({
            tenantId,
            workerId: `worker-${index}`,
            topics: ["run-context-graph-ingest"],
            now: "2026-07-21T00:01:00.000Z",
            leaseExpiresAt: "2026-07-21T01:00:00.000Z"
          })
        )
      );
      assert.equal(claims.filter(Boolean).length, 1);
      const claimed = claims.find(Boolean)!;
      assert.equal(
        await first.checkpoint({
          tenantId,
          stageId: claimed.task.id,
          leaseId: claimed.message.leaseId,
          name: "blob-batch",
          value: { offset: 50 },
          now: "2026-07-21T00:02:00.000Z"
        }),
        true
      );
      await second.createBuild({
        tenantId,
        repository,
        ref: "main",
        requestKey: "new",
        snapshotFirst: false,
        createdAt: "2026-07-21T00:03:00.000Z"
      });
      assert.equal(
        await first.renew({
          tenantId,
          stageId: claimed.task.id,
          leaseId: claimed.message.leaseId,
          now: "2026-07-21T00:04:00.000Z",
          leaseExpiresAt: "2026-07-21T01:04:00.000Z"
        }),
        false
      );
      await assert.rejects(
        graphStore.planIngestion(
          {
            tenantId,
            repository,
            ref: "main",
            commitSha: "a".repeat(40),
            treeSha: "b".repeat(40),
            parents: [],
            recordedAt: "2026-07-21T00:04:00.000Z",
            taskId: claimed.task.id,
            files: []
          },
          { stageId: claimed.task.id, leaseId: claimed.message.leaseId }
        ),
        /stale contextGraph worker lease/
      );
    } finally {
      await cleanup.query("delete from jina_board.workflows where tenant_id=$1", [tenantId]);
      await cleanup.end();
      await Promise.all([first.close(), second.close(), graphStore.close()]);
    }
  }
);

test(
  "Postgres atomically replaces a tenant principal's repository access",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const suffix = Date.now().toString(36);
    const tenantId = `acl-replace-${suffix}`;
    const principalId = "tenant:11111111-1111-4111-8111-111111111111";
    const store = new PostgresContextGraphStore({ connectionString });
    const cleanup = new Pool({ connectionString });
    try {
      await store.replaceRepositoryAccess(tenantId, principalId, ["omxyz/a", "omxyz/b"]);
      assert.deepEqual(await store.repositoriesForPrincipal(tenantId, principalId), ["omxyz/a", "omxyz/b"]);

      await store.replaceRepositoryAccess(tenantId, principalId, ["omxyz/b"]);
      assert.deepEqual(await store.repositoriesForPrincipal(tenantId, principalId), ["omxyz/b"]);

      await store.replaceRepositoryAccess(tenantId, principalId, []);
      assert.deepEqual(await store.repositoriesForPrincipal(tenantId, principalId), []);
    } finally {
      await cleanup.query(`delete from jina_context_graph.repository_acl where tenant_id=$1 and principal_id=$2`, [
        tenantId,
        principalId
      ]);
      await cleanup.end();
      await store.close();
    }
  }
);

test(
  "Postgres serializes snapshot updates across store instances",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const stateStore = new PostgresJsonStateStore<{ readonly counter: number }>({ connectionString });
    const competingStore = new PostgresJsonStateStore<{ readonly counter: number }>({ connectionString });
    const priorState = await stateStore.load();

    try {
      await stateStore.save({ counter: 0 });
      await Promise.all([
        stateStore.update(async (state) => ({ state: { counter: (state?.counter ?? 0) + 1 }, result: undefined })),
        competingStore.update(async (state) => ({ state: { counter: (state?.counter ?? 0) + 1 }, result: undefined }))
      ]);
      assert.deepEqual(await stateStore.load(), { counter: 2 });
    } finally {
      if (priorState === undefined) {
        const cleanup = new Pool({ connectionString });
        await cleanup.query("delete from jina_runtime.api_state where id=1");
        await cleanup.end();
      } else {
        await stateStore.save(priorState);
      }
      await stateStore.close();
      await competingStore.close();
    }
  }
);

test(
  "Postgres versioned snapshot loads skip the blob when nothing changed",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const stateStore = new PostgresJsonStateStore<{ readonly counter: number }>({ connectionString });
    const priorState = await stateStore.load();

    try {
      await stateStore.save({ counter: 1 });
      const first = await stateStore.loadNewer(0);
      assert.ok(first !== "unchanged" && first !== undefined);
      assert.deepEqual(first.snapshot, { counter: 1 });
      assert.equal(await stateStore.loadNewer(first.version), "unchanged");
      await stateStore.save({ counter: 2 });
      const second = await stateStore.loadNewer(first.version);
      assert.ok(second !== "unchanged" && second !== undefined);
      assert.deepEqual(second.snapshot, { counter: 2 });
      assert.ok(second.version > first.version);
    } finally {
      if (priorState === undefined) {
        const cleanup = new Pool({ connectionString });
        await cleanup.query("delete from jina_runtime.api_state where id=1");
        await cleanup.end();
      } else {
        await stateStore.save(priorState);
      }
      await stateStore.close();
    }
  }
);

test(
  "Postgres causal retrieval follows the current graph head and migrations backfill missing heads",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const suffix = Date.now().toString(36);
    const tenantId = `graph-head-${suffix}`;
    const repository = `omlabs/graph-head-${suffix}`;
    const commitSha = "a".repeat(40);
    const store = new PostgresContextGraphStore({ connectionString });
    const graph = (deploymentId: string, deploymentLabel: string, generatedAt: string) =>
      createContextGraph({
        request: { tenantId, repository, ref: "main", taskId: `project-${deploymentId}` },
        commitSha,
        generatedAt,
        executor: "projection",
        model: "current-graph-v1",
        contentAddressed: true,
        generated: {
          summary: `${deploymentLabel} caused the outage`,
          nodes: [
            { id: "repo", kind: "Repository", label: repository, description: "Repository", evidence: ["README.md:1"] },
            {
              id: "incident",
              kind: "Incident",
              label: "Checkout outage",
              description: "Checkout failed",
              evidence: ["README.md:2"]
            },
            {
              id: deploymentId,
              kind: "Deployment",
              label: deploymentLabel,
              description: "Production deployment",
              evidence: ["README.md:3"]
            }
          ],
          edges: [
            {
              source: "incident",
              target: deploymentId,
              predicate: "INTRODUCED_BY",
              plane: "knowledge",
              why: `${deploymentLabel} introduced the outage.`,
              evidence: ["README.md:3"]
            }
          ]
        }
      });
    const first = graph("deployment-a", "Deployment A", "2026-07-21T01:00:00.000Z");
    const second = graph("deployment-b", "Deployment B", "2026-07-21T01:01:00.000Z");
    const request = {
      tenantId,
      allowedRepositories: [repository],
      repository,
      ref: "main",
      template: "causal_trace" as const,
      rootText: "Checkout outage"
    };
    try {
      await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        treeSha: "b".repeat(40),
        parents: [],
        recordedAt: "2026-07-21T00:59:00.000Z",
        updateRef: true,
        taskId: `ingest-${suffix}`,
        files: []
      });
      await store.save(first);
      await store.save(second);
      await store.save(first);
      const current = await store.retrieve(request);
      const currentTrace = current.items[0]?.data as { causes?: readonly { nodes: readonly { label: string }[] }[] };
      assert.equal(
        currentTrace.causes?.[0]?.nodes[1]?.label,
        "Deployment A",
        "retrieval follows graph_heads when an immutable graph is reused"
      );

      const pool = new Pool({ connectionString });
      try {
        await pool.query(
          "delete from jina_context_graph.graph_heads where tenant_id=$1 and repository=$2 and ref_name='main'",
          [tenantId, repository]
        );
      } finally {
        await pool.end();
      }
      const migratedStore = new PostgresContextGraphStore({ connectionString });
      try {
        const migrated = await migratedStore.retrieve(request);
        assert.equal(migrated.items.length, 1, "schema initialization backfills a missing legacy graph head");
      } finally {
        await migratedStore.close();
      }
    } finally {
      await store.close();
    }
  }
);

test(
  "Postgres feature retrieval filters the complete canonical assertion set",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const suffix = Date.now().toString(36);
    const tenantId = `feature-limit-${suffix}`;
    const repository = `omlabs/feature-limit-${suffix}`;
    const commitSha = "c".repeat(40);
    const now = "2026-07-21T02:00:00.000Z";
    const store = new PostgresContextGraphStore({ connectionString });
    try {
      await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        treeSha: "d".repeat(40),
        parents: [],
        recordedAt: now,
        updateRef: true,
        taskId: `ingest-${suffix}`,
        files: []
      });
      await store.save(
        createContextGraph({
          request: { tenantId, repository, ref: "main", taskId: `project-${suffix}` },
          commitSha,
          generatedAt: now,
          executor: "projection",
          model: "current-graph-v1",
          contentAddressed: true,
          generated: {
            summary: "Repository projection",
            nodes: [
              {
                id: "repo",
                kind: "Repository",
                label: repository,
                description: "Repository",
                evidence: ["README.md:1"]
              },
              {
                id: "file",
                kind: "File",
                label: "src/index.ts",
                description: "Source",
                path: "src/index.ts",
                evidence: ["src/index.ts:1"]
              }
            ],
            edges: [
              { source: "repo", target: "file", predicate: "CONTAINS", plane: "code", evidence: ["src/index.ts:1"] }
            ]
          }
        })
      );
      const pool = new Pool({ connectionString });
      try {
        const observation = await pool.query<{ id: string }>(
          "select id from jina_context_graph.observations where tenant_id=$1 and repository=$2 limit 1",
          [tenantId, repository]
        );
        assert.ok(observation.rows[0]);
        const fileId = `feature-limit-file-${suffix}`;
        await pool.query(
          `insert into jina_context_graph.entities (id,tenant_id,kind,natural_key,display_name)
         values ($1,$2,'File',$3,'src/index.ts')`,
          [fileId, tenantId, `repo:${repository}:path:src/index.ts`]
        );
        await pool.query(
          `insert into jina_context_graph.entities (id,tenant_id,kind,natural_key,display_name)
         select $1 || candidate.index,$2,'Feature',$3 || candidate.index,
                case when candidate.index=1600 then 'Needle capability' else 'Unrelated capability ' || candidate.index end
         from generate_series(0,1600) candidate(index)`,
          [`feature-limit-entity-${suffix}-`, tenantId, `feature:${repository}:`]
        );
        await pool.query(
          `insert into jina_context_graph.assertions
          (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,predicate,
           object_id,object_kind,object_natural_key,object_label,status,confidence,explanation,evidence,source_observation_id,
           generator_version,registry_version,recorded_at)
         select case when candidate.index=1600 then $1 else $2 || lpad(candidate.index::text,4,'0') end,
                $3,$4,'source',$5,'File',$6,'src/index.ts','IMPLEMENTS',
                $7 || candidate.index,'Feature',$8 || candidate.index,
                case when candidate.index=1600 then 'Needle capability' else 'Unrelated capability ' || candidate.index end,
                'active',0.9,'The source file implements this capability.','[]'::jsonb,$9,$10,$11,$12
         from generate_series(0,1600) candidate(index)`,
          [
            `z-feature-limit-target-${suffix}`,
            `a-feature-limit-${suffix}-`,
            tenantId,
            repository,
            fileId,
            `repo:${repository}:path:src/index.ts`,
            `feature-limit-entity-${suffix}-`,
            `feature:${repository}:`,
            observation.rows[0].id,
            CONTEXT_GRAPH_GENERATOR_VERSION,
            CONTEXT_GRAPH_REGISTRY_VERSION,
            now
          ]
        );
      } finally {
        await pool.end();
      }
      const result = await store.retrieve({
        tenantId,
        allowedRepositories: [repository],
        repository,
        ref: "main",
        template: "feature_trace",
        featureText: "Needle capability"
      });
      assert.equal(
        result.items[0]?.title,
        "src/index.ts implements Needle capability",
        "matching happens before the result limit can discard a valid feature"
      );
    } finally {
      await store.close();
    }
  }
);

test(
  "Postgres context graph roles separate reads and runtime writes from schema ownership",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const pool = new Pool({ connectionString, max: 1 });
    try {
      await store.list("role-fixture");
      await pool.query(CONTEXT_GRAPH_ROLES_SQL);

      const privileges = await pool.query<{
        manifest_writes_manifest: boolean;
        manifest_writes_blobs: boolean;
        graph_writes_graphs: boolean;
        graph_writes_assertions: boolean;
        query_writes_metrics: boolean;
        query_writes_assertions: boolean;
        knowledge_writes_assertion_relations: boolean;
      }>(`select
      has_table_privilege('jina_context_graph_manifest','jina_context_graph.ref_manifest','INSERT') as manifest_writes_manifest,
      has_table_privilege('jina_context_graph_manifest','jina_context_graph.blobs','INSERT') as manifest_writes_blobs,
      has_table_privilege('jina_context_graph_projection','jina_context_graph.graphs','INSERT') as graph_writes_graphs,
      has_table_privilege('jina_context_graph_projection','jina_context_graph.assertions','INSERT') as graph_writes_assertions,
      has_table_privilege('jina_context_graph_query','jina_context_graph.retrieval_metrics','INSERT') as query_writes_metrics,
      has_table_privilege('jina_context_graph_query','jina_context_graph.assertions','INSERT') as query_writes_assertions,
      has_table_privilege('jina_context_graph_knowledge','jina_context_graph.assertion_relations','INSERT') as knowledge_writes_assertion_relations`);
      assert.deepEqual(privileges.rows[0], {
        manifest_writes_manifest: true,
        manifest_writes_blobs: false,
        graph_writes_graphs: true,
        graph_writes_assertions: false,
        query_writes_metrics: true,
        query_writes_assertions: false,
        knowledge_writes_assertion_relations: true
      });

      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role jina_context_graph_reader");
        await client.query("select count(*) from jina_context_graph.graphs");
        await assert.rejects(
          client.query(
            "insert into jina_context_graph.blobs (tenant_id,blob_sha,byte_size) values ('role-fixture','reader-write',1)"
          ),
          /permission denied/
        );
        await client.query("rollback");

        await client.query("begin");
        await client.query("set local role jina_context_graph_query");
        await client.query(
          `insert into jina_context_graph.retrieval_metrics (tenant_id,repository,template,duration_ms,truncated,recorded_at)
         values ('role-fixture','omlabs/role-fixture','structure',1,false,now())`
        );
        await assert.rejects(
          client.query(`insert into jina_context_graph.assertions
          (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,predicate,
           object_id,object_kind,object_natural_key,object_label,status,confidence,explanation,evidence,generator_version,registry_version,recorded_at)
          values ('denied','role-fixture','omlabs/role-fixture','source','none','File','none','none','REFERENCES',
                  'none','File','none','none','active',1,'denied','[]','none','none',now())`),
          /permission denied/
        );
        await client.query("rollback");

        await client.query("begin");
        await client.query("set local role jina_context_graph_writer");
        await client.query(
          "insert into jina_context_graph.blobs (tenant_id,blob_sha,byte_size) values ('role-fixture','writer-write',1)"
        );
        await assert.rejects(
          client.query("create table jina_context_graph.writer_must_not_migrate (id integer)"),
          /permission denied/
        );
        await client.query("rollback");
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
      await store.close();
    }
  }
);

test(
  "Postgres projections retain reviewed RESOLVED_BY relationships after an upgrade",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const pool = new Pool({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `legacy-inverse-${suffix}`;
    const repository = `omlabs/legacy-inverse-${suffix}`;
    const commitSha = "7".repeat(40);
    const issueId = stableId("entity", `${tenantId}:Issue:github:issue:${repository}#1`);
    const pullRequestId = stableId("entity", `${tenantId}:PullRequest:github:pr:${repository}#2`);
    try {
      await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        treeSha: "8".repeat(40),
        parents: [],
        committedAt: "2026-07-21T00:00:00.000Z",
        recordedAt: "2026-07-21T00:00:00.000Z",
        isDefaultRef: true,
        updateRef: true,
        taskId: `legacy-${suffix}`,
        files: [{ path: "README.md", blobSha: "9".repeat(40), size: 1 }]
      });
      await pool.query(
        `insert into jina_context_graph.entities (id,tenant_id,kind,natural_key,display_name)
       values ($1,$3,'Issue',$4,'Legacy issue'),($2,$3,'PullRequest',$5,'PR #2')`,
        [issueId, pullRequestId, tenantId, `github:issue:${repository}#1`, `github:pr:${repository}#2`]
      );
      await pool.query(
        `insert into jina_context_graph.assertions
        (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,
         predicate,object_id,object_kind,object_natural_key,object_label,status,confidence,evidence,
         explanation,source_observation_id,asserted_by,generator_version,registry_version,recorded_at)
       values ($1,$2,$3,$4,$5,'Issue',$6,'Legacy issue','RESOLVED_BY',$7,'PullRequest',$8,'PR #2',
               'active',1,'[]'::jsonb,'Legacy inverse assertion retained for migration compatibility.',null,'legacy:migration','legacy','repository-context-v5.4',$9)`,
        [
          stableId("assertion", `${tenantId}:legacy-resolved-by`),
          tenantId,
          repository,
          commitSha,
          issueId,
          `github:issue:${repository}#1`,
          pullRequestId,
          `github:pr:${repository}#2`,
          "2026-07-21T00:00:00.000Z"
        ]
      );

      const projected = await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-21T00:01:00.000Z");
      assert.equal(projected.rebuilt, true);
      const listed = await store.listAssertions(tenantId, repository);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.predicate, "RESOLVED_BY");
      const legacy = await pool.query<{ status: string }>(
        `select status from jina_context_graph.assertions where tenant_id=$1 and predicate='RESOLVED_BY'`,
        [tenantId]
      );
      assert.equal(legacy.rows[0]?.status, "active", "reviewed inverse relationships remain current causal knowledge");
    } finally {
      await pool.end();
      await store.close();
    }
  }
);

test(
  "Postgres delta snapshots reconstruct the parent tree and share content-addressed trees",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const pool = new Pool({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `delta-${suffix}`;
    const repository = `omlabs/db-delta-fixture-${suffix}`;
    const base = {
      tenantId,
      repository,
      ref: "main",
      parents: [] as readonly string[],
      recordedAt: "2026-07-19T12:00:00.000Z",
      isDefaultRef: true,
      updateRef: true
    };
    try {
      const root = await store.planIngestion({
        ...base,
        commitSha: "a".repeat(40),
        treeSha: "b".repeat(40),
        taskId: `root-${suffix}`,
        files: [
          { path: "README.md", blobSha: "1".repeat(40), size: 10 },
          { path: "src/app.ts", blobSha: "2".repeat(40), size: 20 }
        ]
      });
      assert.equal(root.fileCount, 2);
      const delta = await store.planIngestion({
        ...base,
        commitSha: "c".repeat(40),
        treeSha: "d".repeat(40),
        parents: ["a".repeat(40)],
        taskId: `delta-${suffix}`,
        mode: "delta",
        files: [],
        updateRef: false,
        deltas: [
          { path: "src/app.ts", blobSha: "3".repeat(40), size: 21 },
          { path: "src/new.ts", blobSha: "4".repeat(40), size: 5 },
          { path: "README.md", blobSha: null, size: 0 }
        ]
      });
      assert.equal(delta.fileCount, 2, "delta reconstructs the full tree (modify + add - delete)");
      assert.deepEqual([...delta.changedPaths].sort(), ["src/app.ts", "src/new.ts"]);
      assert.deepEqual(
        delta.missingBlobs.map((blob) => blob.blobSha).sort(),
        ["3".repeat(40), "4".repeat(40)],
        "only changed blobs are parse candidates in delta mode"
      );
      const manifest = await pool.query<{ path: string; blob_sha: string }>(
        `select path,blob_sha from jina_context_graph.commit_manifest($1,$2,$3) order by path`,
        [tenantId, repository, "c".repeat(40)]
      );
      assert.deepEqual(
        manifest.rows,
        [
          { path: "src/app.ts", blob_sha: "3".repeat(40) },
          { path: "src/new.ts", blob_sha: "4".repeat(40) }
        ],
        "the recorded manifest matches the reconstructed tree"
      );
      const trees = await pool.query<{ tree_sha: string }>(
        `select tree_sha from jina_context_graph.trees where tenant_id=$1 order by tree_sha`,
        [tenantId]
      );
      assert.deepEqual(
        trees.rows.map((row) => row.tree_sha),
        ["b".repeat(40), "d".repeat(40)],
        "each distinct tree is stored once, content-addressed"
      );
      await assert.rejects(
        store.planIngestion({
          ...base,
          commitSha: "e".repeat(40),
          treeSha: "f".repeat(40),
          parents: ["9".repeat(40)],
          taskId: `orphan-${suffix}`,
          mode: "delta",
          files: [],
          updateRef: false,
          deltas: [{ path: "src/app.ts", blobSha: "5".repeat(40), size: 1 }]
        }),
        /delta snapshot parent tree is not recorded/,
        "a delta against an unrecorded parent is rejected so the worker can fall back to tree mode"
      );
      await assert.rejects(
        store.planIngestion({
          ...base,
          commitSha: "e".repeat(40),
          treeSha: "f".repeat(40),
          parents: ["c".repeat(40)],
          taskId: `head-${suffix}`,
          mode: "delta",
          files: [],
          deltas: [{ path: "src/app.ts", blobSha: "5".repeat(40), size: 1 }]
        }),
        /delta snapshot cannot move the live ref/,
        "a ref head must ship a full tree so retained unparsed blobs are re-discovered"
      );
    } finally {
      await pool.end();
      await store.close();
    }
  }
);

test(
  "Postgres batched blob analyses keep first-write-wins dedupe and reject unknown blobs",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const pool = new Pool({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `blob-batch-${suffix}`;
    const snapshot = {
      tenantId,
      repository: "omlabs/db-blob-batch-fixture",
      ref: "main",
      commitSha: "1".repeat(40),
      treeSha: "2".repeat(40),
      parents: [],
      recordedAt: "2026-07-19T12:00:00.000Z",
      taskId: `ingest-${suffix}`,
      files: [{ path: "src/util.ts", blobSha: "3".repeat(40), size: 30 }]
    };
    const analysisFor = (moniker: string) => ({
      blobSha: "3".repeat(40),
      parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
      language: "typescript",
      symbols: [{ moniker, name: moniker, kind: "function", signatureHash: "f".repeat(64), startLine: 1, endLine: 2 }],
      imports: [],
      edges: []
    });
    try {
      await store.planIngestion(snapshot);
      await store.applyBlobAnalyses(snapshot, [analysisFor("first"), analysisFor("second")]);
      const symbols = await pool.query<{ moniker: string }>(
        `select moniker from jina_context_graph.blob_symbols where tenant_id=$1 and blob_sha=$2`,
        [tenantId, "3".repeat(40)]
      );
      assert.deepEqual(
        symbols.rows.map((row) => row.moniker),
        ["first"],
        "a duplicate blob/parser pair in one batch keeps only the first analysis's rows"
      );
      await assert.rejects(
        store.applyBlobAnalyses(snapshot, [analysisFor("third"), { ...analysisFor("stray"), blobSha: "4".repeat(40) }]),
        /blob 4{40} is not in the recorded snapshot/,
        "an analysis outside the recorded snapshot rejects the batch before writing"
      );
      const afterRejection = await pool.query<{ moniker: string }>(
        `select moniker from jina_context_graph.blob_symbols where tenant_id=$1`,
        [tenantId]
      );
      assert.deepEqual(
        afterRejection.rows.map((row) => row.moniker),
        ["first"],
        "a rejected batch writes nothing"
      );
    } finally {
      await pool.end();
      await store.close();
    }
  }
);

test(
  "Postgres reuses content-addressed blobs and projects canonical assertions",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const suffix = Date.now().toString(36);
    const snapshot = {
      tenantId: `pipeline-${suffix}`,
      repository: "omlabs/db-pipeline-fixture",
      ref: "main",
      commitSha: "a".repeat(40),
      treeSha: "b".repeat(40),
      parents: [],
      recordedAt: "2026-07-19T12:00:00.000Z",
      taskId: `ingest-${suffix}`,
      files: [
        { path: "README.md", blobSha: "c".repeat(40), size: 20 },
        { path: "src/index.ts", blobSha: "d".repeat(40), size: 40 }
      ]
    };
    try {
      const first = await store.planIngestion(snapshot);
      assert.equal(first.missingBlobs.length, 2);
      assert.deepEqual(first.changedPaths, ["README.md", "src/index.ts"]);
      await store.applyBlobAnalyses(snapshot, [
        {
          blobSha: "c".repeat(40),
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          language: "markdown",
          symbols: [],
          imports: [],
          edges: []
        },
        {
          blobSha: "d".repeat(40),
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          language: "typescript",
          symbols: [
            { moniker: "main", name: "main", kind: "function", signatureHash: "f".repeat(64), startLine: 1, endLine: 1 }
          ],
          imports: [],
          edges: []
        }
      ]);
      assert.equal((await store.planIngestion({ ...snapshot, taskId: `retry-${suffix}` })).reusedBlobCount, 2);
      const asserted = await store.saveAssertionBatch({
        tenantId: snapshot.tenantId,
        repository: snapshot.repository,
        ref: snapshot.ref,
        commitSha: snapshot.commitSha,
        taskId: `assert-${suffix}`,
        generatedAt: "2026-07-19T12:01:00.000Z",
        generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
        registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
        evidenceFingerprint: "evidence-fixture",
        evidenceObservationIds: [],
        model: "fixture",
        summary: "README documents the repository",
        rawOutput: {
          summary: "README documents the repository",
          nodes: [
            { id: "repo", kind: "Repository", label: "fixture", description: "repo", evidence: ["README.md:1"] },
            {
              id: "readme",
              kind: "Document",
              label: "README",
              description: "docs",
              path: "README.md",
              evidence: ["README.md:1"]
            }
          ],
          edges: [
            {
              source: "repo",
              target: "readme",
              predicate: "DOCUMENTED_BY",
              plane: "knowledge",
              confidence: 0.95,
              evidence: ["README.md:1"]
            }
          ]
        },
        assertions: [
          {
            subject: { kind: "Repository", naturalKey: `github:repo:${snapshot.repository}`, label: "fixture" },
            predicate: "DOCUMENTED_BY",
            object: { kind: "Document", naturalKey: `repo:${snapshot.repository}:path:README.md`, label: "README" },
            confidence: 0.95,
            explanation: "The README explicitly documents this repository.",
            evidence: ["README.md:1"]
          }
        ]
      });
      assert.equal(asserted.activeCount, 0);
      assert.equal(asserted.proposedCount, 1);
      assert.equal(
        (
          await store.hasAssertionGeneration(
            snapshot.tenantId,
            snapshot.repository,
            snapshot.commitSha,
            CONTEXT_GRAPH_GENERATOR_VERSION,
            CONTEXT_GRAPH_REGISTRY_VERSION,
            "evidence-fixture"
          )
        )?.cached,
        true
      );
      const graph = await store.project({
        tenantId: snapshot.tenantId,
        repository: snapshot.repository,
        ref: snapshot.ref,
        commitSha: snapshot.commitSha,
        taskId: `project-${suffix}`,
        generatedAt: "2026-07-19T12:02:00.000Z"
      });
      assert.equal(graph.generator.executor, "projection");
      const reviewableEdge = graph.edges.find((edge) => edge.predicate === "DOCUMENTED_BY");
      assert.ok(reviewableEdge);
      assert.equal(reviewableEdge.qualifiers?.assertionStatus, "proposed");
      assert.equal(
        graph.nodes.some((node) => node.kind === "Symbol"),
        true
      );
    } finally {
      await store.close();
    }
  }
);

test(
  "Postgres materializes source-backed services, packages, deployments, incidents, and causal counterfactuals",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `causal-v56-${suffix}`;
    const repository = `omlabs/causal-v56-${suffix}`;
    const commitSha = "c".repeat(40);
    const now = "2026-07-21T01:00:00.000Z";
    try {
      await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        treeSha: "d".repeat(40),
        parents: [],
        committedAt: now,
        recordedAt: now,
        isDefaultRef: true,
        updateRef: true,
        taskId: `ingest-${suffix}`,
        files: [{ path: "README.md", blobSha: "e".repeat(40), size: 1 }]
      });
      const sourceResult = await store.applyGitHubObservations([
        {
          tenantId,
          repository,
          kind: "package_manifest",
          commitSha,
          path: "package.json",
          ecosystem: "npm",
          dependencies: [{ name: "pg", version: "8" }],
          recordedAt: now
        },
        {
          tenantId,
          repository,
          kind: "service_definition",
          commitSha,
          path: "compose.yaml",
          source: "compose",
          externalId: `${repository}:api`,
          name: "api",
          recordedAt: now
        },
        {
          tenantId,
          repository,
          kind: "deployment",
          source: "github",
          externalId: `${repository}:deployment-17`,
          commitSha,
          environment: "production",
          status: "success",
          service: { source: "compose", externalId: `${repository}:api`, name: "api" },
          recordedAt: now
        },
        {
          tenantId,
          repository,
          kind: "incident",
          source: "github",
          externalId: `${repository}#99`,
          title: "Deletion outage",
          issueNumber: 99,
          recordedAt: now
        }
      ]);
      const relationships = [
        {
          predicate: "INCIDENT_IMPACTS",
          object: { kind: "Service" as const, key: `service:compose:${repository}:api`, displayName: "api" },
          qualifiers: undefined,
          reason: "The incident record identifies the API service as impacted."
        },
        {
          predicate: "INTRODUCED_BY",
          object: {
            kind: "Deployment" as const,
            key: `deployment:github:${repository}:deployment-17`,
            displayName: "production deployment 17"
          },
          qualifiers: { reason: "the deployment removed the administrator deletion guard" },
          reason: "The deployment removed the administrator deletion guard and introduced the incident."
        }
      ];
      for (const [index, relationship] of relationships.entries()) {
        await store.executeCommand(
          tenantId,
          "svc:test",
          {
            type: "assign_relationship",
            repository,
            subject: { kind: "Incident", key: `incident:github:${repository}#99`, displayName: "Deletion outage" },
            predicate: relationship.predicate,
            object: relationship.object,
            ...(relationship.qualifiers ? { qualifiers: relationship.qualifiers } : {}),
            reason: relationship.reason
          },
          `2026-07-21T01:00:0${index + 1}.000Z`
        );
      }
      for (const assertion of await store.listAssertions(tenantId, repository, { status: "proposed" })) {
        await store.executeCommand(
          tenantId,
          "svc:test",
          {
            type: "review_assertion",
            assertionId: assertion.id,
            decision: "accept"
          },
          "2026-07-21T01:00:10.000Z"
        );
      }
      const reviewed = (await store.listAssertions(tenantId, repository, { status: "active" })).filter(
        (assertion) => assertion.predicate === "INTRODUCED_BY" || assertion.predicate === "INCIDENT_IMPACTS"
      );
      assert.equal(reviewed.length, 2);
      await store.executeCommand(
        tenantId,
        "svc:test",
        {
          type: "relate_assertions",
          sourceAssertionId: reviewed[0]!.id,
          relation: "supports",
          targetAssertionId: reviewed[1]!.id,
          evidenceObservationId: sourceResult.observationIds[0]!
        },
        "2026-07-21T01:00:15.000Z"
      );
      const relationTarget = (await store.listAssertions(tenantId, repository)).find(
        (assertion) => assertion.id === reviewed[1]!.id
      );
      assert.deepEqual(relationTarget?.supportingAssertionIds, [reviewed[0]!.id]);
      const graph = await store.project({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        taskId: `project-${suffix}`,
        generatedAt: "2026-07-21T01:00:20.000Z"
      });
      for (const kind of ["Package", "Service", "Deployment", "Incident"] as const) {
        assert.equal(
          graph.nodes.some((node) => node.kind === kind),
          true,
          `${kind} is projected`
        );
      }
      const context = await new RepositoryContextOrchestrator(store).answer({
        tenantId,
        allowedRepositories: [repository],
        repository,
        ref: "main",
        operation: "counterfactual",
        question: `If deployment ${repository}:deployment-17 were removed, would incident "Deletion outage" remain?`
      });
      assert.equal(context.counterfactual?.basis, "graph-derived");
      assert.equal(
        (context.counterfactual?.removedPaths.length ?? 0) > 0,
        true,
        JSON.stringify(context.counterfactual)
      );
      assert.match(context.answer, /eliminates every currently known reviewed path/);
      await store.applyGitHubObservations([
        {
          tenantId,
          repository,
          kind: "package_manifest",
          commitSha: "f".repeat(40),
          path: "package.json",
          ecosystem: "npm",
          dependencies: [],
          removed: true,
          recordedAt: "2026-07-21T01:01:00.000Z"
        }
      ]);
      const livePackages = (
        await store.listAssertions(tenantId, repository, { status: "active", predicate: "DEPENDS_ON" })
      ).filter((assertion) => assertion.objectKind === "Package");
      assert.equal(livePackages.length, 0, "a deleted manifest retracts its direct package facts");
    } finally {
      await store.close();
    }
  }
);

test(
  "Postgres projects complete postmortem deployment history as source-owned incident causality",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `incident-history-${suffix}`;
    const repository = `omlabs/incident-history-${suffix}`;
    const commitSha = "a".repeat(40);
    const now = "2026-07-22T00:00:00.000Z";
    const postmortemPath = "docs/postmortems/INC-2026-42.md";
    const observations = parseIncidentDocumentObservations({
      tenantId,
      repository,
      path: postmortemPath,
      content: [
        "---",
        "incident_id: INC-2026-42",
        "issue: #14",
        "---",
        "# Administrator deletion outage",
        `Incident INC-2026-42 was introduced by Deployment deployment:github:former/repo:5535506368, which deployed commit ${"b".repeat(40)}.`,
        ...Array.from({ length: 80 }, (_, index) => `Timeline entry ${index + 1}: investigation continued.`),
        `Incident INC-2026-42 was resolved by Deployment deployment:github:former/repo:5535522601, which shipped commit ${"c".repeat(40)}.`
      ].join("\n"),
      recordedAt: now
    });
    try {
      await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        treeSha: "d".repeat(40),
        parents: [],
        committedAt: now,
        recordedAt: now,
        isDefaultRef: true,
        updateRef: true,
        taskId: `ingest-${suffix}`,
        files: [{ path: postmortemPath, blobSha: "e".repeat(40), size: 4_000 }]
      });
      await store.applyGitHubObservations(observations);
      const relations = (await store.listAssertions(tenantId, repository, { status: "active" })).filter(
        (assertion) => assertion.subjectKind === "Incident" && assertion.objectKind === "Deployment"
      );
      assert.deepEqual(
        relations
          .map((assertion) => [assertion.predicate, assertion.objectNaturalKey])
          .sort(([left], [right]) => left!.localeCompare(right!)),
        [
          ["INTRODUCED_BY", "deployment:github:former/repo:5535506368"],
          ["RESOLVED_BY", "deployment:github:former/repo:5535522601"]
        ]
      );
      const graph = await store.project({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        taskId: `project-${suffix}`,
        generatedAt: "2026-07-22T00:01:00.000Z"
      });
      assert.equal(
        graph.edges.some((edge) => edge.predicate === "RESOLVED_BY"),
        true
      );
      const answer = await new RepositoryContextOrchestrator(store).answer({
        tenantId,
        allowedRepositories: [repository],
        repository,
        ref: "main",
        question: "Which later deployment resolved incident INC-2026-42?"
      });
      const trace = answer.calls.find((call) => call.template === "causal_trace")?.items[0]
        ?.data as unknown as CausalTraceProjection;
      assert.equal(trace.root.kind, "Incident");
      assert.equal(
        trace.resolutions.some((path) =>
          path.nodes.some((node) => node.kind === "Deployment" && node.label.includes("former/repo:5535522601"))
        ),
        true
      );
    } finally {
      await store.close();
    }
  }
);

test(
  "Postgres scopes live assertions by repository and preserves qualifier-distinct projection edges",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `assertion-scope-${suffix}`;
    const firstRepository = `omlabs/assertion-one-${suffix}`;
    const secondRepository = `omlabs/assertion-two-${suffix}`;
    const commitSha = "6".repeat(40);
    const secondCommitSha = "8".repeat(40);
    const batch = (repository: string, batchCommitSha: string, fingerprint: string, reasons: readonly string[]) => ({
      tenantId,
      repository,
      ref: "main",
      commitSha: batchCommitSha,
      taskId: `assert-${repository}`,
      generatedAt: "2026-07-21T00:01:00.000Z",
      generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
      registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
      evidenceFingerprint: fingerprint,
      evidenceObservationIds: [],
      model: "fixture",
      summary: "Qualified causes",
      rawOutput: { summary: "fixture", nodes: [], edges: [] },
      assertions: reasons.map((reason) => ({
        subject: { kind: "Issue" as const, naturalKey: "external:issue:1", label: "Issue" },
        predicate: "INTRODUCED_BY",
        object: { kind: "Commit" as const, naturalKey: `repo:shared:sha:${commitSha}`, label: commitSha.slice(0, 12) },
        confidence: 0.9,
        explanation: reason,
        evidence: ["docs/root-cause.md:1"],
        qualifiers: { reason }
      }))
    });
    try {
      for (const [repository, repositoryCommitSha] of [
        [firstRepository, commitSha],
        [secondRepository, secondCommitSha]
      ] as const) {
        await store.planIngestion({
          tenantId,
          repository,
          ref: "main",
          commitSha: repositoryCommitSha,
          treeSha: stableId("tree", repository).slice(0, 40),
          parents: [],
          updateRef: true,
          recordedAt: "2026-07-21T00:00:00.000Z",
          taskId: `ingest-${repository}`,
          files: [{ path: "docs/root-cause.md", blobSha: "7".repeat(40), size: 20 }]
        });
      }
      await store.saveAssertionBatch(batch(firstRepository, commitSha, "first", ["Shared mechanism"]));
      await store.saveAssertionBatch(
        batch(secondRepository, secondCommitSha, "second", ["First mechanism", "Second mechanism"])
      );
      assert.equal((await store.listAssertions(tenantId, firstRepository)).length, 1);
      const secondAssertions = await store.listAssertions(tenantId, secondRepository, { status: "proposed" });
      assert.equal(secondAssertions.length, 2, "a live assertion in another repository is not reused");
      for (const assertion of secondAssertions) {
        await store.executeCommand(
          tenantId,
          "svc:test",
          {
            type: "review_assertion",
            assertionId: assertion.id,
            decision: "accept"
          },
          "2026-07-21T00:02:00.000Z"
        );
      }
      const graph = await store.project({
        tenantId,
        repository: secondRepository,
        ref: "main",
        commitSha: secondCommitSha,
        taskId: `project-${suffix}`,
        generatedAt: "2026-07-21T00:03:00.000Z"
      });
      const causes = graph.edges.filter((edge) => edge.predicate === "INTRODUCED_BY");
      assert.equal(causes.length, 2);
      assert.deepEqual(causes.map((edge) => edge.qualifiers?.reason).sort(), ["First mechanism", "Second mechanism"]);
      const hydrated = await store.get(graph.id, tenantId);
      assert.deepEqual(
        hydrated?.edges
          .filter((edge) => edge.predicate === "INTRODUCED_BY")
          .map((edge) => edge.qualifiers?.reason)
          .sort(),
        ["First mechanism", "Second mechanism"]
      );
    } finally {
      await store.close();
    }
  }
);

test(
  "Postgres stores commit churn while manifests come directly from recorded trees",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const pool = new Pool({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `churn-${suffix}`;
    const repository = `omlabs/churn-${suffix}`;
    const rootSha = "1".repeat(40);
    const childSha = "2".repeat(40);
    const headSha = "3".repeat(40);
    const readmeBlob = "a".repeat(40);
    const sourceBlob = "b".repeat(40);
    const oldAppBlob = "c".repeat(40);
    const newAppBlob = "d".repeat(40);
    try {
      const root = await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha: rootSha,
        treeSha: "4".repeat(40),
        parents: [],
        updateRef: false,
        recordedAt: "2026-07-21T00:00:00.000Z",
        taskId: `root-${suffix}`,
        files: [
          { path: "README.md", blobSha: readmeBlob, size: 10 },
          { path: "src/old.ts", blobSha: sourceBlob, size: 20 },
          { path: "src/app.ts", blobSha: oldAppBlob, size: 30 }
        ]
      });
      assert.equal(root.changes.length, 3);
      const child = await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha: childSha,
        treeSha: "5".repeat(40),
        parents: [rootSha],
        updateRef: false,
        recordedAt: "2026-07-21T00:01:00.000Z",
        taskId: `child-${suffix}`,
        files: [
          { path: "README.md", blobSha: readmeBlob, size: 10 },
          { path: "src/new.ts", blobSha: sourceBlob, size: 20 },
          { path: "src/app.ts", blobSha: newAppBlob, size: 40 }
        ]
      });
      assert.deepEqual(
        child.changes.map((change) => [change.change, change.path, change.oldPath]),
        [
          ["modify", "src/app.ts", undefined],
          ["rename", "src/new.ts", "src/old.ts"]
        ]
      );
      const head = await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha: headSha,
        treeSha: "6".repeat(40),
        parents: [childSha],
        updateRef: true,
        recordedAt: "2026-07-21T00:02:00.000Z",
        taskId: `head-${suffix}`,
        files: [
          { path: "README.md", blobSha: readmeBlob, size: 10 },
          { path: "src/app.ts", blobSha: newAppBlob, size: 40 }
        ]
      });
      assert.deepEqual(
        head.changes.map((change) => [change.change, change.path]),
        [["delete", "src/new.ts"]]
      );

      const churn = await pool.query<{ count: string }>(
        `select count(*) from jina_context_graph.commit_changes where tenant_id=$1 and repository=$2`,
        [tenantId, repository]
      );
      assert.equal(
        Number(churn.rows[0]?.count),
        6,
        "three commits persist six changes instead of eight full-tree rows"
      );
      const manifest = async (sha: string) =>
        (
          await pool.query<{ path: string; blob_sha: string }>(
            `select path,blob_sha from jina_context_graph.commit_manifest($1,$2,$3)`,
            [tenantId, repository, sha]
          )
        ).rows.map((row) => [row.path, row.blob_sha]);
      assert.deepEqual(await manifest(rootSha), [
        ["README.md", readmeBlob],
        ["src/app.ts", oldAppBlob],
        ["src/old.ts", sourceBlob]
      ]);
      assert.deepEqual(await manifest(childSha), [
        ["README.md", readmeBlob],
        ["src/app.ts", newAppBlob],
        ["src/new.ts", sourceBlob]
      ]);
      assert.deepEqual(await manifest(headSha), [
        ["README.md", readmeBlob],
        ["src/app.ts", newAppBlob]
      ]);
      await pool.query(
        `delete from jina_context_graph.commit_changes where tenant_id=$1 and repository=$2 and commit_sha=$3`,
        [tenantId, repository, childSha]
      );
      assert.deepEqual(
        await manifest(childSha),
        [
          ["README.md", readmeBlob],
          ["src/app.ts", newAppBlob],
          ["src/new.ts", sourceBlob]
        ],
        "tree state remains correct even when delta rows are unavailable"
      );
    } finally {
      await pool.end();
      await store.close();
    }
  }
);

test(
  "Postgres preserves review and provenance when a new model contract confirms a fact",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `generation-${suffix}`;
    const repository = "omlabs/db-generation-fixture";
    const common = {
      tenantId,
      repository,
      ref: "main",
      commitSha: "e".repeat(40),
      registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
      evidenceFingerprint: "same-input",
      evidenceObservationIds: [],
      model: "fixture",
      summary: "README documents the repository",
      rawOutput: { summary: "fixture", nodes: [], edges: [] },
      assertions: [
        {
          subject: { kind: "Repository" as const, naturalKey: `github:repo:${repository}`, label: repository },
          predicate: "DOCUMENTED_BY",
          object: { kind: "Document" as const, naturalKey: `repo:${repository}:path:README.md`, label: "README" },
          confidence: 0.95,
          explanation: "The README explicitly documents this repository.",
          evidence: ["README.md:1"]
        }
      ]
    };
    try {
      await store.saveAssertionBatch({
        ...common,
        taskId: `v1-${suffix}`,
        generatedAt: "2026-07-20T00:00:00Z",
        generatorVersion: "model-v1"
      });
      const [proposal] = await store.listAssertions(tenantId, repository);
      assert.ok(proposal);
      await assert.rejects(
        store.executeCommand(
          tenantId,
          "svc:reviewer",
          {
            type: "review_assertion",
            assertionId: proposal.id,
            decision: "reject",
            reason: "not supported"
          },
          "2026-07-20T00:00:20Z"
        ),
        /rejection.*code/
      );
      await store.executeCommand(
        tenantId,
        "svc:reviewer",
        {
          type: "review_assertion",
          assertionId: proposal.id,
          decision: "accept"
        },
        "2026-07-20T00:00:30Z"
      );
      await store.saveAssertionBatch({
        ...common,
        taskId: `v2-${suffix}`,
        generatedAt: "2026-07-20T00:01:00Z",
        generatorVersion: "model-v2",
        evidenceFingerprint: "updated-input"
      });
      const assertions = await store.listAssertions(tenantId, repository);
      assert.equal(assertions.length, 1);
      assert.equal(assertions[0]?.generator, "model:model-v1");
      assert.equal(assertions[0]?.status, "active");
      const guardPool = new Pool({ connectionString });
      await assert.rejects(
        guardPool.query(
          `update jina_context_graph.assertions set explanation='rewritten' where tenant_id=$1 and id=$2`,
          [tenantId, proposal.id]
        ),
        /explanation is immutable/
      );
      await guardPool.end();

      const concurrentRepository = `${repository}-concurrent`;
      const concurrent = {
        ...common,
        repository: concurrentRepository,
        assertions: [
          {
            ...common.assertions[0]!,
            subject: { ...common.assertions[0]!.subject, naturalKey: `github:repo:${concurrentRepository}` },
            object: { ...common.assertions[0]!.object, naturalKey: `repo:${concurrentRepository}:path:README.md` }
          }
        ]
      };
      await Promise.all([
        store.saveAssertionBatch({
          ...concurrent,
          taskId: `concurrent-a-${suffix}`,
          generatedAt: "2026-07-20T00:02:00Z",
          generatorVersion: "model-v1",
          evidenceFingerprint: "concurrent-a"
        }),
        store.saveAssertionBatch({
          ...concurrent,
          taskId: `concurrent-b-${suffix}`,
          generatedAt: "2026-07-20T00:02:01Z",
          generatorVersion: "model-v1",
          evidenceFingerprint: "concurrent-b"
        })
      ]);
      assert.equal(
        (await store.listAssertions(tenantId, concurrentRepository)).length,
        1,
        "the natural-key lock prevents duplicate live proposals from concurrent generators"
      );
      assert.ok(
        await store.hasAssertionGeneration(
          tenantId,
          concurrentRepository,
          concurrent.commitSha,
          "model-v1",
          concurrent.registryVersion,
          "concurrent-a"
        )
      );
      assert.ok(
        await store.hasAssertionGeneration(
          tenantId,
          concurrentRepository,
          concurrent.commitSha,
          "model-v1",
          concurrent.registryVersion,
          "concurrent-b"
        ),
        "distinct evidence generations under one model contract remain independently cacheable"
      );

      const ownershipRepository = `${repository}-ownership`;
      const ownershipBatch = {
        ...common,
        repository: ownershipRepository,
        taskId: `ownership-model-${suffix}`,
        generatedAt: "2026-07-20T00:03:00Z",
        generatorVersion: "ownership-model-v1",
        evidenceFingerprint: "ownership-race",
        assertions: [
          {
            subject: {
              kind: "Repository" as const,
              naturalKey: `github:repo:${ownershipRepository}`,
              label: ownershipRepository
            },
            predicate: "OWNED_BY",
            object: { kind: "Team" as const, naturalKey: "github:team:omlabs/platform", label: "@omlabs/platform" },
            confidence: 0.9,
            explanation: "The CODEOWNERS rule assigns src paths to the platform team.",
            evidence: ["CODEOWNERS:1"],
            qualifiers: { pattern: "src/**" }
          }
        ]
      };
      await Promise.all([
        store.saveAssertionBatch(ownershipBatch),
        store.applyGitHubObservations([
          {
            tenantId,
            repository: ownershipRepository,
            kind: "codeowners" as const,
            commitSha: ownershipBatch.commitSha,
            path: "CODEOWNERS",
            entries: [{ pattern: "src/**", owners: ["@omlabs/platform"] }],
            recordedAt: "2026-07-20T00:03:01Z"
          }
        ])
      ]);
      const liveOwnership = (
        await store.listAssertions(tenantId, ownershipRepository, { predicate: "OWNED_BY" })
      ).filter((assertion) => assertion.status === "active" || assertion.status === "proposed");
      assert.equal(liveOwnership.length, 1, "source and model writers share the same natural-key serialization");

      const commandRepository = `${repository}-command`;
      const commandBatch = {
        ...common,
        repository: commandRepository,
        taskId: `command-model-${suffix}`,
        generatedAt: "2026-07-20T00:04:00Z",
        generatorVersion: "docs-model-v1",
        evidenceFingerprint: "command-race",
        assertions: [
          {
            ...common.assertions[0]!,
            subject: {
              kind: "Repository" as const,
              naturalKey: `github:repo:${commandRepository}`,
              label: commandRepository
            },
            object: {
              kind: "Document" as const,
              naturalKey: `repo:${commandRepository}:path:README.md`,
              label: "README"
            }
          }
        ]
      };
      await Promise.all([
        store.saveAssertionBatch(commandBatch),
        store.executeCommand(
          tenantId,
          "svc:curator",
          {
            type: "assign_relationship",
            repository: commandRepository,
            subject: { kind: "Repository", key: `github:repo:${commandRepository}`, displayName: commandRepository },
            predicate: "DOCUMENTED_BY",
            object: { kind: "Document", key: `repo:${commandRepository}:path:README.md`, displayName: "README" },
            reason: "The README explicitly documents this repository."
          },
          "2026-07-20T00:04:01Z"
        )
      ]);
      const liveDocumentation = (
        await store.listAssertions(tenantId, commandRepository, { predicate: "DOCUMENTED_BY" })
      ).filter((assertion) => assertion.status === "active" || assertion.status === "proposed");
      assert.equal(liveDocumentation.length, 1, "command and model writers share the same natural-key serialization");
      assert.equal(liveDocumentation[0]?.status, "active");

      const cardinalityRepository = `${repository}-cardinality`;
      const assignOwner = (team: string, now: string) =>
        store.executeCommand(
          tenantId,
          "svc:curator",
          {
            type: "assign_relationship" as const,
            repository: cardinalityRepository,
            subject: {
              kind: "Repository" as const,
              key: `github:repo:${cardinalityRepository}`,
              displayName: cardinalityRepository
            },
            predicate: "OWNED_BY",
            object: { kind: "Team" as const, key: `github:team:omlabs/${team}`, displayName: `@omlabs/${team}` },
            qualifiers: { pattern: "src/**" },
            reason: `The src CODEOWNERS rule assigns paths to the ${team} team.`
          },
          now
        );
      await Promise.all([
        assignOwner("platform", "2026-07-20T00:05:00Z"),
        assignOwner("security", "2026-07-20T00:05:01Z")
      ]);
      const activeOwners = (
        await store.listAssertions(tenantId, cardinalityRepository, { predicate: "OWNED_BY" })
      ).filter((assertion) => assertion.status === "active");
      assert.equal(
        activeOwners.length,
        1,
        "the cardinality-context lock serializes concurrent writes with different objects"
      );

      const constraintPool = new Pool({ connectionString });
      try {
        const active = await constraintPool.query<{ id: string; object_id: string }>(
          `select id,object_id from jina_context_graph.assertions
         where tenant_id=$1 and repository=$2 and predicate='OWNED_BY' and status='active'`,
          [tenantId, cardinalityRepository]
        );
        await assert.rejects(
          constraintPool.query(
            `insert into jina_context_graph.assertions
            (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,
             predicate,object_id,object_kind,object_natural_key,object_label,status,confidence,evidence,
             explanation,asserted_by,generator_version,registry_version,recorded_at,qualifiers,qualifiers_hash,last_confirmed_at)
           select $1,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,
                  predicate,object_id,object_kind,object_natural_key,object_label,status,confidence,evidence,
                  explanation,asserted_by,generator_version,registry_version,recorded_at,qualifiers,qualifiers_hash,last_confirmed_at
           from jina_context_graph.assertions where tenant_id=$2 and id=$3`,
            [stableId("assertion", `${tenantId}:duplicate-active`), tenantId, active.rows[0]?.id]
          ),
          /context_graph_assertions_one_(?:active|live_candidate)/
        );
        const foreignTenant = `${tenantId}-foreign`;
        const foreignEntityId = stableId("entity", `${foreignTenant}:Team:foreign`);
        await constraintPool.query(
          `insert into jina_context_graph.entities (id,tenant_id,kind,natural_key,display_name)
         values ($1,$2,'Team','team:foreign','Foreign')`,
          [foreignEntityId, foreignTenant]
        );
        await assert.rejects(
          constraintPool.query(
            `insert into jina_context_graph.identities
            (id,tenant_id,source,external_id,entity_id,status,created_at)
           values ($1,$2,'test','foreign',$3,'proposed',now())`,
            [stableId("identity", `${tenantId}:foreign`), tenantId, foreignEntityId]
          ),
          /identities_entity_same_tenant/
        );
      } finally {
        await constraintPool.end();
      }
    } finally {
      await store.close();
    }
  }
);

test(
  "Postgres projects an accepted derived issue by entity identity",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `virtual-${suffix}`;
    const repository = `omlabs/virtual-${suffix}`;
    const commitSha = "7".repeat(40);
    try {
      await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        treeSha: "8".repeat(40),
        parents: [],
        isDefaultRef: true,
        updateRef: true,
        recordedAt: "2026-07-20T00:00:00.000Z",
        taskId: `ingest-${suffix}`,
        files: [{ path: "src/auth.ts", blobSha: "9".repeat(40), size: 10 }]
      });
      const source = await store.applyGitHubObservations(
        [42, 43].map((number) => ({
          tenantId,
          repository,
          kind: "pull_request" as const,
          number,
          title: number === 42 ? "Restore administrator deletion" : "Restore administrator audit export",
          body: `Administrators are incorrectly denied in workflow ${number}.`,
          state: "closed",
          url: `https://github.com/${repository}/pull/${number}`,
          occurredAt: "2026-07-20T00:00:00.000Z",
          recordedAt: "2026-07-20T00:00:00.000Z",
          commitShas: [commitSha],
          resolvesIssueNumbers: [],
          referencesIssueNumbers: []
        }))
      );
      assert.equal((await store.loadAssertionEvidence(tenantId, repository, source.observationIds)).length, 2);
      const issueKey = derivedIssueNaturalKey(repository, 42);
      await store.saveAssertionBatch({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        taskId: `assert-${suffix}`,
        generatedAt: "2026-07-20T00:01:00.000Z",
        generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
        registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
        evidenceFingerprint: `evidence-${suffix}`,
        evidenceObservationIds: source.observationIds,
        model: "fixture",
        summary: "PR 42 fixes an authorization regression",
        rawOutput: {
          summary: "PR 42 fixes an authorization regression",
          nodes: [
            { id: "repo", kind: "Repository", label: repository, description: "repo", evidence: ["src/auth.ts:1"] },
            { id: "42", kind: "PullRequest", label: "PR #42", description: "fix", evidence: ["src/auth.ts:1"] },
            { id: "43", kind: "PullRequest", label: "PR #43", description: "fix", evidence: ["src/auth.ts:1"] },
            {
              id: "derived:pr:42",
              kind: "Issue",
              label: "Administrators encounter an authorization error",
              description: "Administrator deletion is incorrectly denied.",
              evidence: ["src/auth.ts:1"]
            },
            {
              id: "derived:pr:43",
              kind: "Issue",
              label: "Administrators encounter an authorization error",
              description: "Administrator audit export is incorrectly denied.",
              evidence: ["src/auth.ts:1"]
            }
          ],
          edges: [42, 43].map((number) => ({
            source: String(number),
            target: `derived:pr:${number}`,
            predicate: "RESOLVES",
            plane: "knowledge" as const,
            confidence: 0.95,
            evidence: ["src/auth.ts:1"]
          }))
        },
        assertions: [
          {
            subject: { kind: "PullRequest", naturalKey: `github:pr:${repository}#42`, label: "PR #42" },
            predicate: "RESOLVES",
            object: { kind: "Issue", naturalKey: issueKey, label: "Administrators encounter an authorization error" },
            confidence: 0.95,
            explanation: "The pull request fixes the authorization error represented by this derived issue.",
            evidence: ["src/auth.ts:1"]
          },
          {
            subject: { kind: "PullRequest", naturalKey: `github:pr:${repository}#43`, label: "PR #43" },
            predicate: "RESOLVES",
            object: {
              kind: "Issue",
              naturalKey: derivedIssueNaturalKey(repository, 43),
              label: "Administrators encounter an authorization error"
            },
            confidence: 0.95,
            explanation: "The pull request fixes the authorization error represented by this derived issue.",
            evidence: ["src/auth.ts:1"]
          }
        ]
      });
      const proposals = await store.listAssertions(tenantId, repository, { status: "proposed", predicate: "RESOLVES" });
      assert.equal(proposals.length, 2);
      for (const [index, proposal] of proposals.entries()) {
        await store.executeCommand(
          tenantId,
          "svc:test",
          {
            type: "review_assertion",
            assertionId: proposal.id,
            decision: "accept"
          },
          `2026-07-20T00:02:0${index}.000Z`
        );
      }
      await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:03:00.000Z");
      assert.equal(
        (
          await store.retrieve({
            tenantId,
            allowedRepositories: [repository],
            repository,
            ref: "main",
            template: "issue_trace",
            issueText: "deletion is incorrectly denied"
          })
        ).items.length,
        0,
        "issue traces do not materialize outside context_graph_project"
      );
      await store.project({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        taskId: `virtual-project-${suffix}`,
        generatedAt: "2026-07-20T00:03:01.000Z"
      });

      const byText = await store.retrieve({
        tenantId,
        allowedRepositories: [repository],
        repository,
        ref: "main",
        template: "issue_trace",
        issueText: "deletion is incorrectly denied"
      });
      assert.equal(byText.items.length, 1);
      const payload = byText.items[0]?.data as unknown as {
        issue: { entityId: string; origin: string; number?: number; description?: string };
        resolutions: { pullRequestNumber: number }[];
      };
      assert.equal(payload.issue.origin, "derived");
      assert.equal(payload.issue.number, undefined);
      assert.equal(payload.issue.description, "Administrator deletion is incorrectly denied.");
      assert.equal(payload.resolutions[0]?.pullRequestNumber, 42);
      const collidingTitle = await store.retrieve({
        tenantId,
        allowedRepositories: [repository],
        repository,
        ref: "main",
        template: "issue_trace",
        issueText: "audit export"
      });
      const collidingPayload = collidingTitle.items[0]?.data as unknown as {
        issue: { description?: string };
        resolutions: { pullRequestNumber: number }[];
      };
      assert.equal(collidingPayload.issue.description, "Administrator audit export is incorrectly denied.");
      assert.equal(collidingPayload.resolutions[0]?.pullRequestNumber, 43);
      assert.equal(
        (
          await store.retrieve({
            tenantId,
            allowedRepositories: [repository],
            repository,
            ref: "main",
            template: "issue_trace",
            issueEntityId: payload.issue.entityId
          })
        ).items.length,
        1
      );
      await store.executeCommand(
        tenantId,
        "svc:test",
        {
          type: "assign_relationship",
          repository,
          subject: {
            kind: "Issue",
            key: derivedIssueNaturalKey(repository, 44),
            displayName: "Unresolved derived issue"
          },
          predicate: "LIKELY_AFFECTS",
          object: { kind: "File", key: `repo:${repository}:path:src/auth.ts`, displayName: "src/auth.ts" },
          reason: "exercise non-trace Issue projection completeness"
        },
        "2026-07-20T00:04:00.000Z"
      );
      await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:05:00.000Z");
      const confirmed = await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:06:00.000Z");
      assert.equal(confirmed.rebuilt, false, "active non-trace Issue assertions do not force perpetual rebuilds");
    } finally {
      await store.close();
    }
  }
);

test(
  "Postgres projects and retrieves a reviewed Feature",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `feature-${suffix}`;
    const repository = `omlabs/feature-${suffix}`;
    const commitSha = "6".repeat(40);
    const featureKey = featureNaturalKey(repository, "feature:administrator-deletion");
    try {
      await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        treeSha: "5".repeat(40),
        parents: [],
        isDefaultRef: true,
        updateRef: true,
        recordedAt: "2026-07-20T00:00:00.000Z",
        taskId: `feature-ingest-${suffix}`,
        files: [
          { path: "README.md", blobSha: "4".repeat(40), size: 20 },
          { path: "src/auth.ts", blobSha: "3".repeat(40), size: 40 }
        ]
      });
      await store.saveAssertionBatch({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        taskId: `feature-assert-${suffix}`,
        generatedAt: "2026-07-20T00:01:00.000Z",
        generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
        registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
        evidenceFingerprint: `feature-evidence-${suffix}`,
        evidenceObservationIds: [],
        model: "fixture",
        summary: "Administrator deletion is a named product capability",
        rawOutput: {
          summary: "Administrator deletion is a named product capability",
          nodes: [
            { id: "repo", kind: "Repository", label: repository, description: "repo", evidence: ["README.md:1"] },
            {
              id: "feature:administrator-deletion",
              kind: "Feature",
              label: "Administrator deletion",
              description: "Administrators can delete resources.",
              evidence: ["README.md:2"]
            },
            {
              id: "auth-file",
              kind: "File",
              label: "src/auth.ts",
              description: "authorization",
              path: "src/auth.ts",
              evidence: ["src/auth.ts:1"]
            }
          ],
          edges: [
            {
              source: "auth-file",
              target: "feature:administrator-deletion",
              predicate: "IMPLEMENTS",
              plane: "knowledge",
              confidence: 0.96,
              evidence: ["src/auth.ts:1"]
            }
          ]
        },
        assertions: [
          {
            subject: { kind: "File", naturalKey: `repo:${repository}:path:src/auth.ts`, label: "src/auth.ts" },
            predicate: "IMPLEMENTS",
            object: { kind: "Feature", naturalKey: featureKey, label: "Administrator deletion" },
            confidence: 0.96,
            explanation: "The authorization file implements administrator deletion behavior.",
            evidence: ["src/auth.ts:1"]
          }
        ]
      });
      const proposal = (
        await store.listAssertions(tenantId, repository, { status: "proposed", predicate: "IMPLEMENTS" })
      )[0];
      assert.ok(proposal);
      await store.executeCommand(
        tenantId,
        "svc:test",
        {
          type: "review_assertion",
          assertionId: proposal.id,
          decision: "accept"
        },
        "2026-07-20T00:02:00.000Z"
      );
      await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:02:30.000Z");
      const graph = await store.project({
        tenantId,
        repository,
        ref: "main",
        commitSha,
        taskId: `feature-project-${suffix}`,
        generatedAt: "2026-07-20T00:03:00.000Z"
      });
      assert.equal(
        graph.nodes.some((node) => node.kind === "Feature" && node.label === "Administrator deletion"),
        true
      );
      assert.equal(
        graph.edges.some((edge) => edge.predicate === "IMPLEMENTS"),
        true
      );

      const result = await store.retrieve({
        tenantId,
        allowedRepositories: [repository],
        repository,
        ref: "main",
        template: "feature_trace",
        featureText: "administrator deletion"
      });
      assert.equal(result.items[0]?.title, "src/auth.ts implements Administrator deletion");
      assert.equal(
        result.items[0]?.citations.some((citation) => citation.kind === "code" && citation.path === "src/auth.ts"),
        true
      );
      const answer = await new RepositoryContextOrchestrator(store).answer({
        tenantId,
        allowedRepositories: [repository],
        repository,
        ref: "main",
        question: 'Which files implement "administrator deletion"?'
      });
      assert.match(answer.answer, /src\/auth\.ts implements Administrator deletion/);

      const oldCommitSha = "7".repeat(40);
      await store.planIngestion({
        tenantId,
        repository,
        ref: "old",
        commitSha: oldCommitSha,
        treeSha: "8".repeat(40),
        parents: [],
        updateRef: true,
        recordedAt: "2026-07-20T00:04:00.000Z",
        taskId: `feature-old-ingest-${suffix}`,
        files: [{ path: "src/auth.ts", blobSha: "9".repeat(40), size: 40 }]
      });
      await store.rebuildDerivedProjections(tenantId, repository, "old", "2026-07-20T00:04:10.000Z");
      await store.project({
        tenantId,
        repository,
        ref: "old",
        commitSha: oldCommitSha,
        taskId: `feature-old-project-${suffix}`,
        generatedAt: "2026-07-20T00:04:20.000Z"
      });
      const oldResult = await store.retrieve({
        tenantId,
        allowedRepositories: [repository],
        repository,
        ref: "old",
        template: "feature_trace",
        featureText: "administrator deletion"
      });
      assert.equal(
        oldResult.items.length,
        0,
        "feature retrieval does not leak assertions whose evidence is stale on the requested ref"
      );
    } finally {
      await store.close();
    }
  }
);

test(
  "Postgres repository context runs intake, knowledge, outbox projections, ACLs, and cited retrieval end to end",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `v51-${suffix}`;
    const repository = `omlabs/v51-${suffix}`;
    const parentSha = "1".repeat(40);
    const headSha = "2".repeat(40);
    const readmeBlob = "a".repeat(40);
    const movedBlob = "b".repeat(40);
    const oldAppBlob = "c".repeat(40);
    const newAppBlob = "d".repeat(40);
    const deletedBlob = "e".repeat(40);
    const addedBlob = "f".repeat(40);
    const projectCurrentGraph = (generatedAt: string) =>
      store.project({
        tenantId,
        repository,
        ref: "main",
        commitSha: headSha,
        taskId: `project-${suffix}-${generatedAt}`,
        generatedAt
      });
    const parent = {
      tenantId,
      repository,
      ref: "main",
      commitSha: parentSha,
      treeSha: "3".repeat(40),
      parents: [],
      authorExternalId: "alice@example.com",
      authorGitHubLogin: "alice",
      authorName: "Alice",
      committedAt: "2026-07-18T00:00:00.000Z",
      message: "initial implementation",
      isDefaultRef: true,
      updateRef: false,
      recordedAt: "2026-07-20T00:00:00.000Z",
      taskId: `ingest-${suffix}`,
      files: [
        { path: "README.md", blobSha: readmeBlob, size: 20 },
        { path: "src/old.ts", blobSha: movedBlob, size: 20 },
        { path: "src/app.ts", blobSha: oldAppBlob, size: 30 },
        { path: "src/deleted.ts", blobSha: deletedBlob, size: 10 }
      ]
    } as const;
    const head = {
      ...parent,
      commitSha: headSha,
      treeSha: "4".repeat(40),
      parents: [parentSha],
      committedAt: "2026-07-19T00:00:00.000Z",
      message: "fixes #7 and updates app",
      updateRef: true,
      recordedAt: "2026-07-20T00:01:00.000Z",
      files: [
        { path: "README.md", blobSha: readmeBlob, size: 20 },
        { path: "src/new.ts", blobSha: movedBlob, size: 20 },
        { path: "src/app.ts", blobSha: newAppBlob, size: 40 },
        { path: "src/added.ts", blobSha: addedBlob, size: 10 }
      ]
    } as const;
    try {
      await store.planIngestion(parent);
      await store.applyBlobAnalyses(parent, [
        {
          blobSha: readmeBlob,
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          language: "markdown",
          symbols: [],
          imports: [],
          edges: []
        },
        {
          blobSha: movedBlob,
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          language: "typescript",
          symbols: [],
          imports: [],
          edges: []
        },
        {
          blobSha: oldAppBlob,
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          language: "typescript",
          symbols: [],
          imports: [],
          edges: []
        },
        {
          blobSha: deletedBlob,
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          language: "typescript",
          symbols: [],
          imports: [],
          edges: []
        }
      ]);
      const plan = await store.planIngestion(head);
      assert.deepEqual(plan.changes, [
        { path: "src/added.ts", change: "add", newBlobSha: addedBlob },
        { path: "src/app.ts", change: "modify", oldBlobSha: oldAppBlob, newBlobSha: newAppBlob },
        { path: "src/deleted.ts", change: "delete", oldBlobSha: deletedBlob },
        { path: "src/new.ts", change: "rename", oldPath: "src/old.ts", oldBlobSha: movedBlob, newBlobSha: movedBlob }
      ]);
      await store.applyBlobAnalyses(head, [
        {
          blobSha: newAppBlob,
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          language: "typescript",
          symbols: [
            {
              moniker: "typescript:main#1",
              name: "main",
              kind: "function",
              signatureHash: "1".repeat(64),
              startLine: 1,
              endLine: 3
            },
            {
              moniker: "typescript:helper#2",
              name: "helper",
              kind: "function",
              signatureHash: "2".repeat(64),
              startLine: 5,
              endLine: 5
            }
          ],
          imports: [],
          edges: [{ fromMoniker: "main", kind: "calls", toMoniker: "helper", startLine: 2, endLine: 2 }]
        },
        {
          blobSha: addedBlob,
          parserVersion: CONTEXT_GRAPH_PARSER_VERSION,
          language: "typescript",
          symbols: [],
          imports: [],
          edges: []
        }
      ]);

      const source = await store.applyGitHubObservations([
        {
          tenantId,
          repository,
          kind: "pull_request",
          number: 3,
          title: "Update app",
          body: "Fixes #7",
          state: "closed",
          url: `https://github.com/${repository}/pull/3`,
          authorLogin: "alice",
          occurredAt: "2026-07-19T00:00:00.000Z",
          recordedAt: "2026-07-20T00:02:00.000Z",
          mergedAt: "2026-07-19T00:00:00.000Z",
          mergeCommitSha: headSha,
          commitShas: [headSha],
          resolvesIssueNumbers: [7],
          referencesIssueNumbers: []
        },
        {
          tenantId,
          repository,
          kind: "issue",
          number: 7,
          title: "App is outdated",
          body: "The outdated access policy bypasses the application guard.",
          state: "closed",
          url: `https://github.com/${repository}/issues/7`,
          authorLogin: "alice",
          occurredAt: "2026-07-19T00:00:00.000Z",
          recordedAt: "2026-07-20T00:02:00.000Z"
        },
        {
          tenantId,
          repository,
          kind: "codeowners",
          commitSha: headSha,
          path: ".github/CODEOWNERS",
          entries: [{ pattern: "/src/**", owners: ["@omlabs/owners"] }],
          recordedAt: "2026-07-20T00:02:00.000Z"
        }
      ]);
      assert.equal(source.observationCount, 3);
      assert.equal(source.assertionCount >= 4, true);

      const batch = {
        tenantId,
        repository,
        ref: "main",
        commitSha: headSha,
        taskId: `assert-${suffix}`,
        generatedAt: "2026-07-20T00:03:00.000Z",
        generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
        registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
        evidenceFingerprint: "evidence-causal-fixture",
        evidenceObservationIds: [],
        model: "fixture",
        summary: "README documents the repository and records a root cause",
        rawOutput: {
          summary: "README documents the repository and records a root cause",
          nodes: [
            {
              id: "repo",
              kind: "Repository" as const,
              label: repository,
              description: "repo",
              evidence: ["README.md:1"]
            },
            {
              id: "readme",
              kind: "Document" as const,
              label: "README",
              description: "docs",
              path: "README.md",
              evidence: ["README.md:1"]
            },
            {
              id: "7",
              kind: "Issue" as const,
              label: "Issue #7",
              description: "app regression",
              evidence: ["src/app.ts:1"]
            },
            {
              id: headSha,
              kind: "Commit" as const,
              label: headSha.slice(0, 12),
              description: "introduced the regression",
              evidence: ["src/app.ts:1"]
            }
          ],
          edges: [
            {
              source: "repo",
              target: "readme",
              predicate: "DOCUMENTED_BY",
              plane: "knowledge" as const,
              confidence: 0.99,
              evidence: ["README.md:1"]
            },
            {
              source: "7",
              target: headSha,
              predicate: "INTRODUCED_BY",
              plane: "knowledge" as const,
              confidence: 0.99,
              why: "The commit bypassed the app guard.",
              evidence: ["src/app.ts:1"]
            }
          ]
        },
        assertions: [
          {
            subject: { kind: "Repository" as const, naturalKey: `github:repo:${repository}`, label: repository },
            predicate: "DOCUMENTED_BY",
            object: { kind: "Document" as const, naturalKey: `repo:${repository}:path:README.md`, label: "README" },
            confidence: 0.99,
            explanation: "The README explicitly documents this repository.",
            evidence: ["README.md:1"]
          },
          {
            subject: { kind: "Issue" as const, naturalKey: `github:issue:${repository}#7`, label: "Issue #7" },
            predicate: "INTRODUCED_BY",
            object: {
              kind: "Commit" as const,
              naturalKey: `repo:${repository}:sha:${headSha}`,
              label: headSha.slice(0, 12)
            },
            confidence: 0.99,
            explanation: "The commit bypassed the app guard.",
            evidence: ["src/app.ts:1"],
            qualifiers: { reason: "The commit bypassed the app guard." }
          }
        ]
      };
      const proposed = await store.saveAssertionBatch(batch);
      assert.equal(proposed.proposedCount, 2);
      const assertionId = stableId(
        "assertion",
        `${tenantId}:${repository}:${headSha}:${CONTEXT_GRAPH_REGISTRY_VERSION}:evidence-causal-fixture:Repository:github:repo:${repository}:DOCUMENTED_BY:Document:repo:${repository}:path:README.md:{}`
      );
      const causalAssertionId = stableId(
        "assertion",
        `${tenantId}:${repository}:${headSha}:${CONTEXT_GRAPH_REGISTRY_VERSION}:evidence-causal-fixture:Issue:github:issue:${repository}#7:INTRODUCED_BY:Commit:repo:${repository}:sha:${headSha}:{"reason":"The commit bypassed the app guard."}`
      );
      await store.executeCommand(
        tenantId,
        "svc:api",
        {
          type: "grant_repository_access",
          repository,
          principalId: "user:curator",
          role: "writer"
        },
        "2026-07-20T00:03:30.000Z"
      );
      await store.executeCommand(
        tenantId,
        "user:curator",
        {
          type: "review_assertion",
          assertionId,
          decision: "accept",
          reason: "verified against README"
        },
        "2026-07-20T00:04:00.000Z"
      );
      await store.executeCommand(
        tenantId,
        "user:curator",
        {
          type: "review_assertion",
          assertionId: causalAssertionId,
          decision: "accept",
          reason: "verified against root-cause evidence"
        },
        "2026-07-20T00:04:10.000Z"
      );
      await store.executeCommand(
        tenantId,
        "user:curator",
        {
          type: "assign_relationship",
          repository,
          subject: { kind: "File", key: `repo:${repository}:path:src/app.ts`, displayName: "src/app.ts" },
          predicate: "OWNED_BY",
          object: { kind: "Team", key: "team:platform", displayName: "Platform" },
          qualifiers: { pattern: "src/**" },
          reason: "curated ownership"
        },
        "2026-07-20T00:05:00.000Z"
      );
      await store.executeCommand(
        tenantId,
        "svc:api",
        {
          type: "grant_repository_access",
          repository,
          principalId: "user:reader",
          role: "reader"
        },
        "2026-07-20T00:05:30.000Z"
      );
      assert.deepEqual(await store.repositoriesForPrincipal(tenantId, "user:reader"), [repository]);
      await store.planIngestion({
        ...head,
        ref: "release",
        isDefaultRef: false,
        taskId: `release-${suffix}`,
        recordedAt: "2026-07-20T00:05:40.000Z"
      });

      const fanoutPool = new Pool({ connectionString });
      const repositoryWideEvents = await fanoutPool.query<{ id: string }>(
        `select id from jina_context_graph.outbox
       where tenant_id=$1 and processed_at is null
         and coalesce(payload->>'repoId',payload#>>'{scope,repository}')=$2
         and payload->>'refName' is null`,
        [tenantId, repository]
      );
      assert.equal(repositoryWideEvents.rows.length > 0, true);
      const rebuilt = await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:06:00.000Z");
      assert.equal(rebuilt.manifestFileCount, 4);
      assert.equal(rebuilt.searchDocumentCount > 0, true);
      const prematurelyAcknowledged = await fanoutPool.query<{ count: string }>(
        `select count(*) from jina_context_graph.outbox where id=any($1::text[]) and processed_at is not null`,
        [repositoryWideEvents.rows.map((row) => row.id)]
      );
      assert.equal(
        Number(prematurelyAcknowledged.rows[0]?.count ?? 0),
        0,
        "a single-ref rebuild never acknowledges repository-wide events"
      );
      const initialFanout = await store.drainDerivedProjectionEvents(tenantId, "2026-07-20T00:06:00.500Z");
      assert.equal(initialFanout.rebuiltRepositories.includes(repository), true);
      const projectedRefs = await fanoutPool.query<{ ref_name: string }>(
        `select distinct ref_name from jina_context_graph.ref_manifest
       where tenant_id=$1 and repository=$2 order by ref_name`,
        [tenantId, repository]
      );
      assert.deepEqual(
        projectedRefs.rows.map((row) => row.ref_name),
        ["main", "release"]
      );
      await fanoutPool.end();
      await projectCurrentGraph("2026-07-20T00:06:01.000Z");
      const allowedRepositories = [repository];
      const structure = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "main",
        template: "structure",
        symbol: "main"
      });
      assert.equal(
        structure.items.some((item) => item.kind === "calls" && item.citations[0]?.path === "src/app.ts"),
        true
      );
      const change = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        template: "change",
        pullRequestNumber: 3
      });
      assert.equal(
        change.items.some((item) => item.title === "modify src/app.ts"),
        true
      );
      const intent = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        template: "intent",
        path: "src/app.ts",
        query: "fixes app"
      });
      assert.equal(
        intent.items.some((item) => item.citations[0]?.kind === "commit_change"),
        true
      );
      assert.equal(
        intent.items.some((item) => item.kind === "work_intent" && item.title.includes("Issue #7")),
        true
      );
      const issueTrace = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "main",
        template: "issue_trace",
        issueNumber: 7
      });
      assert.equal(issueTrace.items.length, 1);
      const trace = issueTrace.items[0]?.data as {
        resolutions?: readonly {
          pullRequestNumber: number;
          commits: readonly { sha: string; role: string; changes: readonly { path: string }[] }[];
        }[];
      };
      assert.equal(trace.resolutions?.[0]?.pullRequestNumber, 3);
      assert.equal(trace.resolutions?.[0]?.commits[0]?.sha, headSha);
      assert.equal(trace.resolutions?.[0]?.commits[0]?.role, "merge");
      assert.equal(
        trace.resolutions?.[0]?.commits[0]?.changes.some((change) => change.path === "src/app.ts"),
        true
      );
      const causal = issueTrace.items[0]?.data as {
        introducedBy?: readonly {
          sha: string;
          why?: string;
          evidence?: readonly string[];
          evidenceCommitSha?: string;
          pullRequests?: readonly { number: number }[];
        }[];
      };
      assert.equal(causal.introducedBy?.[0]?.sha, headSha);
      assert.match(causal.introducedBy?.[0]?.why ?? "", /bypassed the app guard/);
      assert.equal(causal.introducedBy?.[0]?.evidence?.includes("src/app.ts:1"), true);
      assert.equal(
        causal.introducedBy?.[0]?.evidence?.some((value) => value.startsWith("assertion:")),
        true
      );
      assert.equal(causal.introducedBy?.[0]?.evidenceCommitSha, headSha);
      assert.equal(
        causal.introducedBy?.[0]?.pullRequests?.some((pullRequest) => pullRequest.number === 3),
        true
      );
      const titleTrace = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "main",
        template: "issue_trace",
        issueText: "App is outdated",
        query: 'What caused "App is outdated"?'
      });
      assert.equal((titleTrace.items[0]?.data as { issue?: { number: number } }).issue?.number, 7);
      const bodyTrace = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "main",
        template: "issue_trace",
        issueText: "bypasses the application guard",
        query: 'What caused "bypasses the application guard"?'
      });
      assert.equal((bodyTrace.items[0]?.data as { issue?: { number: number } }).issue?.number, 7);
      const reverseCommitTrace = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "main",
        template: "issue_trace",
        commitSha: headSha,
        query: `Which issue did commit ${headSha} cause, and why?`
      });
      assert.equal((reverseCommitTrace.items[0]?.data as { issue?: { number: number } }).issue?.number, 7);
      const reversePullRequestTrace = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "main",
        template: "issue_trace",
        pullRequestNumber: 3,
        query: "Which issue did PR #3 cause, and why?"
      });
      assert.equal((reversePullRequestTrace.items[0]?.data as { issue?: { number: number } }).issue?.number, 7);
      const releaseTrace = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "release",
        template: "issue_trace",
        issueNumber: 7
      });
      assert.equal(
        (releaseTrace.items[0]?.data as { introducedBy?: readonly unknown[] }).introducedBy?.length,
        1,
        "refs at the same commit reuse the same immutable graph generation"
      );
      const ownership = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        template: "ownership",
        path: "src/app.ts"
      });
      assert.equal(
        ownership.items.some((item) => item.title.includes("Platform")),
        true
      );
      assert.equal(
        ownership.items.some((item) => item.title.includes("@omlabs/owners") && item.data.authority === "codeowners"),
        true
      );
      await assert.rejects(
        store.retrieve({ tenantId, allowedRepositories: [], repository, template: "structure" }),
        /access denied/
      );
      const metrics = await store.operationalMetrics(tenantId, "2026-07-20T00:07:00.000Z");
      assert.equal(metrics.unparsedBlobCount, 0);
      assert.equal(
        metrics.acceptanceRates.some((item) => item.predicate === "DOCUMENTED_BY" && item.accepted === 1),
        true
      );

      const legacyLabelPool = new Pool({ connectionString });
      try {
        await legacyLabelPool.query(
          `update jina_context_graph.entities set display_name='Model paraphrase'
         where tenant_id=$1 and kind='Issue' and natural_key=$2`,
          [tenantId, `github:issue:${repository}#7`]
        );
      } finally {
        await legacyLabelPool.end();
      }
      const graph = await store.project({
        tenantId,
        repository,
        ref: "main",
        commitSha: headSha,
        taskId: `project-${suffix}`,
        generatedAt: "2026-07-20T00:08:00.000Z"
      });
      assert.equal(
        graph.nodes.some((node) => node.kind === "Issue" && node.label === "#7 App is outdated"),
        true,
        "projection restores the latest source title after upgrading a model-overwritten entity"
      );
      assert.equal(
        graph.edges.some((edge) => edge.predicate === "CALLS"),
        true
      );
      assert.equal(
        graph.edges.some((edge) => edge.predicate === "DOCUMENTED_BY"),
        true
      );
      assert.equal(
        graph.edges.some(
          (edge) =>
            edge.predicate === "INTRODUCED_BY" &&
            edge.evidence.includes("src/app.ts:1") &&
            edge.why === "The commit bypassed the app guard."
        ),
        true
      );
      assert.equal(
        (await store.get(graph.id, tenantId))?.edges.some(
          (edge) => edge.predicate === "INTRODUCED_BY" && edge.why === "The commit bypassed the app guard."
        ),
        true,
        "the persisted graph retains the causal reason"
      );
      const sourceOwnership = graph.edges.find((edge) => edge.predicate === "OWNED_BY");
      assert.equal(
        sourceOwnership?.evidence.some((value) => value.startsWith("observation:")),
        true
      );
      assert.equal(
        [...graph.nodes, ...graph.edges].every((item) => item.evidence.length > 0),
        true
      );

      const platformId = stableId("entity", `${tenantId}:Team:team:platform`);
      const ownersId = stableId("entity", `${tenantId}:Team:github:team:omlabs/owners`);
      await store.executeCommand(
        tenantId,
        "svc:identity",
        {
          type: "merge_entities",
          fromEntityId: platformId,
          toEntityId: ownersId,
          reason: "The curated and GitHub teams are the same team."
        },
        "2026-07-20T00:08:10.000Z"
      );
      const mergedOwnership = (await store.listAssertions(tenantId, repository, { predicate: "OWNED_BY" })).find(
        (assertion) => assertion.subjectNaturalKey.endsWith("path:src/app.ts")
      );
      assert.equal(
        mergedOwnership?.objectNaturalKey,
        "github:team:omlabs/owners",
        "assertion reads follow redirects without rewriting provenance"
      );
      await store.executeCommand(
        tenantId,
        "svc:identity",
        {
          type: "unmerge_entities",
          fromEntityId: platformId,
          toEntityId: ownersId,
          reason: "Undo the fixture identity merge."
        },
        "2026-07-20T00:08:20.000Z"
      );
      const unmergedOwnership = (await store.listAssertions(tenantId, repository, { predicate: "OWNED_BY" })).find(
        (assertion) => assertion.subjectNaturalKey.endsWith("path:src/app.ts")
      );
      assert.equal(unmergedOwnership?.objectNaturalKey, "team:platform");

      const otherRepository = `${repository}-other`;
      const unparsedOtherBlob = "1234567890".repeat(4);
      await store.planIngestion({
        tenantId,
        repository: otherRepository,
        ref: "main",
        commitSha: "9".repeat(40),
        treeSha: "8".repeat(40),
        parents: [],
        committedAt: "2026-07-20T00:08:30.000Z",
        isDefaultRef: true,
        updateRef: true,
        recordedAt: "2026-07-20T00:08:30.000Z",
        taskId: `other-${suffix}`,
        files: [{ path: "README.md", blobSha: unparsedOtherBlob, size: 20 }]
      });
      const scopedRepositoryMetrics = await store.operationalMetrics(tenantId, "2026-07-20T00:08:35.000Z", {
        repository,
        ref: "main"
      });
      const scopedOtherMetrics = await store.operationalMetrics(tenantId, "2026-07-20T00:08:35.000Z", {
        repository: otherRepository,
        ref: "main"
      });
      const scopedMissingRefMetrics = await store.operationalMetrics(tenantId, "2026-07-20T00:08:35.000Z", {
        repository,
        ref: "missing"
      });
      assert.equal(scopedRepositoryMetrics.unparsedBlobCount, 0);
      assert.equal(scopedOtherMetrics.unparsedBlobCount, 1);
      assert.equal(scopedMissingRefMetrics.unparsedBlobCount, 0);
      assert.equal(
        Object.values(scopedRepositoryMetrics.outboxDepth).reduce((sum, count) => sum + count, 0) >
          Object.values(scopedMissingRefMetrics.outboxDepth).reduce((sum, count) => sum + count, 0),
        true,
        "ref-scoped metrics include repository-wide events but exclude events explicitly tied to another ref"
      );
      await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:08:40.000Z");
      const beforeDrain = await store.operationalMetrics(tenantId, "2026-07-20T00:08:45.000Z");
      assert.equal(beforeDrain.unparsedBlobCount, 1);
      assert.equal(Object.values(beforeDrain.outboxDepth).reduce((sum, count) => sum + count, 0) > 0, true);
      assert.equal((beforeDrain.outboxDepthByConsumer.graph ?? 0) > 0, true);
      assert.equal(beforeDrain.parsedBlobCountLastHour > 0, true);
      assert.equal(
        beforeDrain.retrievalTemplates.some((metric) => metric.template === "structure" && metric.requests > 0),
        true
      );
      const drained = await store.drainDerivedProjectionEvents(tenantId, "2026-07-20T00:08:50.000Z");
      assert.equal(drained.processedEventCount > 0, true);
      assert.equal(drained.rebuiltRepositories.includes(otherRepository), true);
      await store.applyGitHubObservations([
        {
          tenantId,
          repository,
          kind: "codeowners",
          commitSha: headSha,
          path: ".github/CODEOWNERS",
          entries: [{ pattern: "/src/**", owners: ["@omlabs/owners"] }],
          recordedAt: "2026-07-20T00:02:00.000Z"
        }
      ]);
      const afterSourceReplay = await store.operationalMetrics(tenantId, "2026-07-20T00:08:52.000Z");
      assert.equal(
        Object.values(afterSourceReplay.outboxDepth).reduce((sum, count) => sum + count, 0),
        0
      );
      const noOpProjection = await store.rebuildDerivedProjections(
        tenantId,
        repository,
        "main",
        "2026-07-20T00:08:55.000Z"
      );
      assert.equal(noOpProjection.rebuilt, false);
      assert.equal(noOpProjection.processedEventCount, 0);
      const otherStructure = await store.retrieve({
        tenantId,
        allowedRepositories: [otherRepository],
        repository: otherRepository,
        ref: "main",
        template: "structure"
      });
      assert.equal(otherStructure.repository, otherRepository);

      const updatedPullRequest = (occurredAt: string, resolvesIssueNumbers: readonly number[]) => ({
        tenantId,
        repository,
        kind: "pull_request" as const,
        number: 3,
        title: "Update app",
        body: resolvesIssueNumbers.length ? "Fixes #7" : "No longer closes the issue",
        state: "closed",
        url: `https://github.com/${repository}/pull/3`,
        authorLogin: "alice",
        occurredAt,
        recordedAt: occurredAt,
        mergedAt: "2026-07-19T00:00:00.000Z",
        mergeCommitSha: headSha,
        commitShas: [headSha],
        resolvesIssueNumbers,
        referencesIssueNumbers: []
      });
      await store.applyGitHubObservations([updatedPullRequest("2026-07-20T00:09:00.000Z", [])]);
      await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:05.000Z");
      await projectCurrentGraph("2026-07-20T00:09:06.000Z");
      const removedTrace = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "main",
        template: "issue_trace",
        issueNumber: 7
      });
      assert.equal(
        (removedTrace.items[0]?.data as { resolutions?: readonly unknown[] }).resolutions?.length,
        0,
        "a newer GitHub snapshot retracts source relationships it no longer contains"
      );
      const removedReleaseTrace = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "release",
        template: "issue_trace",
        issueNumber: 7
      });
      assert.equal(
        (removedReleaseTrace.items[0]?.data as { resolutions?: readonly unknown[] }).resolutions?.length,
        0,
        "secondary refs at the same commit use the updated graph generation"
      );

      const restoredAt = "2026-07-20T00:09:10.000Z";
      await store.applyGitHubObservations([updatedPullRequest(restoredAt, [7])]);
      await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:15.000Z");
      await projectCurrentGraph("2026-07-20T00:09:16.000Z");
      const restoredTrace = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "main",
        template: "issue_trace",
        issueNumber: 7
      });
      assert.equal((restoredTrace.items[0]?.data as { resolutions?: readonly unknown[] }).resolutions?.length, 1);

      await store.applyGitHubObservations([
        {
          ...updatedPullRequest("2026-07-20T00:09:05.000Z", []),
          recordedAt: "2026-07-20T00:09:16.000Z"
        }
      ]);
      await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:17.000Z");
      await projectCurrentGraph("2026-07-20T00:09:18.000Z");
      const afterDelayedSnapshot = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "main",
        template: "issue_trace",
        issueNumber: 7
      });
      assert.equal(
        (afterDelayedSnapshot.items[0]?.data as { resolutions?: readonly unknown[] }).resolutions?.length,
        1,
        "a delayed older GitHub snapshot cannot retract or replace newer source facts"
      );

      const githubObservationId = stableId(
        "observation",
        `${tenantId}:github:${repository}:pull_request:3:${restoredAt}`
      );
      const redaction = await store.executeCommand(
        tenantId,
        "user:privacy",
        {
          type: "redact_observation",
          observationId: githubObservationId,
          reason: "fixture redaction",
          commitShas: [headSha]
        },
        "2026-07-20T00:09:20.000Z",
        true
      );
      assert.equal(redaction.affectedIds.includes(githubObservationId), true);
      await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:25.000Z");
      await projectCurrentGraph("2026-07-20T00:09:26.000Z");
      const redactedTrace = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "main",
        template: "issue_trace",
        issueNumber: 7
      });
      const redactedTraceData = redactedTrace.items[0]?.data as { resolutions?: readonly unknown[] };
      assert.equal(
        redactedTraceData.resolutions?.length,
        0,
        "redacted source assertions leave no stale resolution projection"
      );

      await store.applyGitHubObservations([updatedPullRequest("2026-07-20T00:09:30.000Z", [7])]);
      await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:35.000Z");
      await projectCurrentGraph("2026-07-20T00:09:36.000Z");
      const engineerId = stableId("entity", `${tenantId}:Engineer:github:user:alice`);
      const erased = await store.executeCommand(
        tenantId,
        "user:privacy",
        {
          type: "erase_person",
          entityId: engineerId,
          reason: "fixture erasure"
        },
        "2026-07-20T00:09:40.000Z",
        true
      );
      assert.equal(erased.affectedIds.includes(engineerId), true);
      await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:45.000Z");
      await projectCurrentGraph("2026-07-20T00:09:46.000Z");
      const erasedTrace = await store.retrieve({
        tenantId,
        allowedRepositories,
        repository,
        ref: "main",
        template: "issue_trace",
        issueNumber: 7
      });
      assert.equal(
        (erasedTrace.items[0]?.data as { resolutions?: readonly unknown[] }).resolutions?.length,
        0,
        "person erasure retracts assertions sourced from every destroyed personal observation"
      );
    } finally {
      await store.close();
    }
  }
);

test(
  "Postgres applies two versions of one pull request in a single batch with sequential semantics",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const pool = new Pool({ connectionString });
    const suffix = Date.now().toString(36);
    const repository = `omlabs/obs-batch-pair-${suffix}`;
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const version = (
      tenantId: string,
      occurredAt: string,
      title: string,
      sha: string,
      resolves: readonly number[]
    ) => ({
      tenantId,
      repository,
      kind: "pull_request" as const,
      number: 3,
      title,
      body: resolves.length ? "Fixes #7" : "No longer fixes the issue",
      state: "closed",
      url: `https://github.com/${repository}/pull/3`,
      authorLogin: "alice",
      occurredAt,
      recordedAt: occurredAt,
      mergedAt: occurredAt,
      mergeCommitSha: sha,
      commitShas: [sha],
      resolvesIssueNumbers: resolves,
      referencesIssueNumbers: []
    });
    try {
      // Forward order: the second batch member is a NEWER snapshot of the same work
      // item. Sequentially the first member sees no prior version (new) and the second
      // sees the row the first just inserted (updated); the second member's snapshot
      // wins the entity label and supersedes/retracts the first member's facts.
      const forwardTenant = `obs-batch-fwd-${suffix}`;
      const v1 = version(forwardTenant, "2026-07-21T00:00:00.000Z", "Add guard", shaA, [7]);
      const v2 = version(forwardTenant, "2026-07-21T01:00:00.000Z", "Add stronger guard", shaB, []);
      const forward = await store.applyGitHubObservations([v1, v2]);
      assert.equal(forward.newObservationCount, 1);
      assert.equal(forward.updatedObservationCount, 1);
      assert.equal(forward.confirmedObservationCount, 0);
      assert.equal(forward.observationCount, 2);
      assert.equal(forward.observationIds.length, 2);
      const forwardLabel = await pool.query<{ display_name: string }>(
        `select display_name from jina_context_graph.entities where tenant_id=$1 and kind='PullRequest' and natural_key=$2`,
        [forwardTenant, `github:pr:${repository}#3`]
      );
      assert.equal(
        forwardLabel.rows[0]?.display_name,
        "#3 Add stronger guard",
        "the latest snapshot titles the entity"
      );
      const byFact = async (tenantId: string) => {
        const rows = await pool.query<{
          predicate: string;
          object_natural_key: string;
          status: string;
          superseded_by: string | null;
        }>(
          `select predicate,object_natural_key,status,superseded_by from jina_context_graph.assertions
           where tenant_id=$1 and repository=$2 order by predicate,object_natural_key,recorded_at`,
          [tenantId, repository]
        );
        return rows.rows;
      };
      const forwardFacts = await byFact(forwardTenant);
      const fact = (facts: typeof forwardFacts, predicate: string, objectKey: string) =>
        facts.filter((row) => row.predicate === predicate && row.object_natural_key === objectKey);
      // The confirmed author fact stays live under the first observation's assertion.
      assert.deepEqual(
        fact(forwardFacts, "AUTHORED_BY", "github:user:alice").map((row) => row.status),
        ["active"]
      );
      // The newer snapshot's commit is active; the older snapshot's commit is retracted.
      assert.deepEqual(
        fact(forwardFacts, "INCLUDES", `repo:${repository}:sha:${shaB}`).map((row) => row.status),
        ["active"]
      );
      assert.deepEqual(
        fact(forwardFacts, "INCLUDES", `repo:${repository}:sha:${shaA}`).map((row) => row.status),
        ["retracted"]
      );
      // MERGED_AS has cardinality one: the newer merge commit supersedes the older.
      assert.deepEqual(
        fact(forwardFacts, "MERGED_AS", `repo:${repository}:sha:${shaB}`).map((row) => row.status),
        ["active"]
      );
      const supersededMerge = fact(forwardFacts, "MERGED_AS", `repo:${repository}:sha:${shaA}`);
      assert.deepEqual(
        supersededMerge.map((row) => row.status),
        ["superseded"]
      );
      assert.equal(typeof supersededMerge[0]?.superseded_by, "string");
      // The dropped issue linkage is retracted by the newer snapshot's sweep.
      assert.deepEqual(
        fact(forwardFacts, "RESOLVES", `github:issue:${repository}#7`).map((row) => row.status),
        ["retracted"]
      );

      // Reverse order: the OLDER snapshot arrives second in the same batch. It still
      // counts as updated (the newer member inserted first), but it is not the latest
      // snapshot, so it cannot touch the entity label and its unshared facts land
      // retracted, exactly as a delayed sequential call would.
      const reverseTenant = `obs-batch-rev-${suffix}`;
      const reverse = await store.applyGitHubObservations([
        version(reverseTenant, "2026-07-21T01:00:00.000Z", "Add stronger guard", shaB, []),
        version(reverseTenant, "2026-07-21T00:00:00.000Z", "Add guard", shaA, [7])
      ]);
      assert.equal(reverse.newObservationCount, 1);
      assert.equal(reverse.updatedObservationCount, 1);
      assert.equal(reverse.confirmedObservationCount, 0);
      const reverseLabel = await pool.query<{ display_name: string }>(
        `select display_name from jina_context_graph.entities where tenant_id=$1 and kind='PullRequest' and natural_key=$2`,
        [reverseTenant, `github:pr:${repository}#3`]
      );
      assert.equal(reverseLabel.rows[0]?.display_name, "#3 Add stronger guard", "a stale batch member cannot relabel");
      const reverseFacts = await byFact(reverseTenant);
      assert.deepEqual(
        fact(reverseFacts, "AUTHORED_BY", "github:user:alice").map((row) => row.status),
        ["active"]
      );
      assert.deepEqual(
        fact(reverseFacts, "INCLUDES", `repo:${repository}:sha:${shaB}`).map((row) => row.status),
        ["active"]
      );
      assert.deepEqual(
        fact(reverseFacts, "INCLUDES", `repo:${repository}:sha:${shaA}`).map((row) => row.status),
        ["retracted"]
      );
      assert.deepEqual(
        fact(reverseFacts, "MERGED_AS", `repo:${repository}:sha:${shaB}`).map((row) => row.status),
        ["active"]
      );
      assert.deepEqual(
        fact(reverseFacts, "MERGED_AS", `repo:${repository}:sha:${shaA}`).map((row) => row.status),
        ["retracted"]
      );
      assert.deepEqual(
        fact(reverseFacts, "RESOLVES", `github:issue:${repository}#7`).map((row) => row.status),
        ["retracted"]
      );
    } finally {
      await pool.end();
      await store.close();
    }
  }
);

test(
  "Postgres batched GitHub observation ingestion equals sequential single-observation calls",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const batchStore = new PostgresContextGraphStore({ connectionString });
    const sequentialStore = new PostgresContextGraphStore({ connectionString });
    const pool = new Pool({ connectionString });
    const suffix = Date.now().toString(36);
    const repository = `omlabs/obs-batch-eq-${suffix}`;
    const batchTenant = `obs-eq-batch-${suffix}`;
    const sequentialTenant = `obs-eq-seq-${suffix}`;
    const shaA = "a".repeat(40);
    const shaB = "b".repeat(40);
    const observationsFor = (tenantId: string) => {
      const pullRequest = (occurredAt: string, title: string, sha: string, resolves: readonly number[]) => ({
        tenantId,
        repository,
        kind: "pull_request" as const,
        number: 3,
        title,
        body: "Fixes #7",
        state: "closed",
        url: `https://github.com/${repository}/pull/3`,
        authorLogin: "alice",
        occurredAt,
        recordedAt: occurredAt,
        mergedAt: occurredAt,
        mergeCommitSha: sha,
        commitShas: [sha],
        resolvesIssueNumbers: resolves,
        referencesIssueNumbers: []
      });
      const issue = {
        tenantId,
        repository,
        kind: "issue" as const,
        number: 7,
        title: "Guard broken",
        body: "The guard rejects valid requests.",
        state: "open",
        url: `https://github.com/${repository}/issues/7`,
        authorLogin: "bob",
        occurredAt: "2026-07-21T00:10:00.000Z",
        recordedAt: "2026-07-21T00:10:00.000Z"
      };
      return [
        pullRequest("2026-07-21T00:00:00.000Z", "Add guard", shaA, [7]),
        issue,
        {
          tenantId,
          repository,
          kind: "codeowners" as const,
          commitSha: shaA,
          path: ".github/CODEOWNERS",
          entries: [{ pattern: "/src/**", owners: ["@omlabs/owners", "@alice"] }],
          recordedAt: "2026-07-21T00:20:00.000Z"
        },
        {
          tenantId,
          repository,
          kind: "package_manifest" as const,
          commitSha: shaA,
          path: "package.json",
          ecosystem: "npm",
          dependencies: [{ name: "pg", version: "8" }, { name: "express" }],
          recordedAt: "2026-07-21T00:30:00.000Z"
        },
        // A newer snapshot of the same pull request: drops the issue linkage and swaps
        // the commit set, exercising confirmation, supersession, and retraction against
        // facts written earlier in the same batch.
        pullRequest("2026-07-21T01:00:00.000Z", "Add stronger guard", shaB, []),
        // An exact duplicate of the issue snapshot: must count as confirmed.
        issue
      ];
    };
    try {
      const batchResult = await batchStore.applyGitHubObservations(observationsFor(batchTenant));
      const sequentialResults: Awaited<ReturnType<typeof sequentialStore.applyGitHubObservations>>[] = [];
      for (const observation of observationsFor(sequentialTenant)) {
        sequentialResults.push(await sequentialStore.applyGitHubObservations([observation]));
      }
      const summed = (
        key: "newObservationCount" | "updatedObservationCount" | "confirmedObservationCount" | "assertionCount"
      ) => sequentialResults.reduce((sum, result) => sum + result[key], 0);
      assert.equal(batchResult.newObservationCount, summed("newObservationCount"));
      assert.equal(batchResult.updatedObservationCount, summed("updatedObservationCount"));
      assert.equal(batchResult.confirmedObservationCount, summed("confirmedObservationCount"));
      assert.equal(batchResult.assertionCount, summed("assertionCount"));
      assert.deepEqual(batchResult.newObservationCount, 4);
      assert.deepEqual(batchResult.updatedObservationCount, 1);
      assert.deepEqual(batchResult.confirmedObservationCount, 1);

      const assertionRows = (tenantId: string) =>
        pool.query<Record<string, unknown>>(
          `select subject_kind,subject_natural_key,subject_label,predicate,object_kind,object_natural_key,object_label,
                  qualifiers::text as qualifiers,status,generator,explanation,commit_sha,
                  recorded_at,last_confirmed_at,valid_to,(superseded_by is not null) as is_superseded
           from jina_context_graph.assertions where tenant_id=$1 and repository=$2
           order by subject_natural_key,predicate,object_natural_key,qualifiers::text,recorded_at,status`,
          [tenantId, repository]
        );
      const [batchAssertions, sequentialAssertions] = await Promise.all([
        assertionRows(batchTenant),
        assertionRows(sequentialTenant)
      ]);
      assert.deepEqual(batchAssertions.rows, sequentialAssertions.rows, "assertion sets and statuses match");

      const entityRows = (tenantId: string) =>
        pool.query<Record<string, unknown>>(
          `select kind,natural_key,display_name from jina_context_graph.entities
           where tenant_id=$1 order by kind,natural_key`,
          [tenantId]
        );
      const [batchEntities, sequentialEntities] = await Promise.all([
        entityRows(batchTenant),
        entityRows(sequentialTenant)
      ]);
      assert.deepEqual(batchEntities.rows, sequentialEntities.rows, "entity labels match");

      const identityRows = (tenantId: string) =>
        pool.query<Record<string, unknown>>(
          `select i.source,i.external_id,e.natural_key,i.status,i.confidence,i.created_at
           from jina_context_graph.identities i
           join jina_context_graph.entities e on e.id=i.entity_id
           where i.tenant_id=$1 order by i.source,i.external_id,e.natural_key`,
          [tenantId]
        );
      const [batchIdentities, sequentialIdentities] = await Promise.all([
        identityRows(batchTenant),
        identityRows(sequentialTenant)
      ]);
      assert.deepEqual(batchIdentities.rows, sequentialIdentities.rows, "identity sets match");

      const outboxRows = (tenantId: string) =>
        pool.query<Record<string, unknown>>(
          `select event_type,consumer,count(*)::int as events from jina_context_graph.outbox
           where tenant_id=$1 group by event_type,consumer order by event_type,consumer`,
          [tenantId]
        );
      const [batchOutbox, sequentialOutbox] = await Promise.all([
        outboxRows(batchTenant),
        outboxRows(sequentialTenant)
      ]);
      assert.deepEqual(batchOutbox.rows, sequentialOutbox.rows, "outbox event volumes match per type and consumer");
    } finally {
      await pool.end();
      await Promise.all([batchStore.close(), sequentialStore.close()]);
    }
  }
);

test(
  "Postgres retracts a previously asserted fact dropped by a newer GitHub snapshot",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const store = new PostgresContextGraphStore({ connectionString });
    const pool = new Pool({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `obs-retract-${suffix}`;
    const repository = `omlabs/obs-retract-${suffix}`;
    const sha = "c".repeat(40);
    const snapshot = (occurredAt: string, resolves: readonly number[]) => ({
      tenantId,
      repository,
      kind: "pull_request" as const,
      number: 9,
      title: "Fix pagination",
      body: resolves.length ? "Fixes #11" : "Standalone fix",
      state: "closed",
      url: `https://github.com/${repository}/pull/9`,
      authorLogin: "carol",
      occurredAt,
      recordedAt: occurredAt,
      commitShas: [sha],
      resolvesIssueNumbers: resolves,
      referencesIssueNumbers: []
    });
    try {
      const first = await store.applyGitHubObservations([snapshot("2026-07-21T00:00:00.000Z", [11])]);
      assert.equal(first.newObservationCount, 1);
      const before = await store.listAssertions(tenantId, repository, { predicate: "RESOLVES" });
      assert.deepEqual(
        before.map((assertion) => assertion.status),
        ["active"]
      );
      const droppedAt = "2026-07-21T01:00:00.000Z";
      const second = await store.applyGitHubObservations([snapshot(droppedAt, [])]);
      assert.equal(second.updatedObservationCount, 1);
      const resolves = await pool.query<{ status: string; valid_to: Date | null }>(
        `select status,valid_to from jina_context_graph.assertions
         where tenant_id=$1 and repository=$2 and predicate='RESOLVES'`,
        [tenantId, repository]
      );
      assert.deepEqual(
        resolves.rows.map((row) => row.status),
        ["retracted"]
      );
      assert.equal(
        resolves.rows[0]?.valid_to?.toISOString(),
        droppedAt,
        "the retraction is stamped at the new snapshot"
      );
      const survivors = await store.listAssertions(tenantId, repository, { status: "active" });
      assert.deepEqual(
        survivors.map((assertion) => assertion.predicate).sort(),
        ["AUTHORED_BY", "INCLUDES"],
        "facts the newer snapshot still contains stay active"
      );
      const retractedEvent = await pool.query<{ count: string }>(
        `select count(distinct aggregate_id) as count from jina_context_graph.outbox
         where tenant_id=$1 and event_type='assertion_changed' and payload->>'status'='retracted'`,
        [tenantId]
      );
      assert.equal(Number(retractedEvent.rows[0]?.count), 1, "the retraction emits its outbox event");
    } finally {
      await pool.end();
      await store.close();
    }
  }
);

test(
  "Postgres batches assertion writes while matching sequential per-assertion semantics",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const suffix = Date.now().toString(36);
    const batchedTenantId = `assert-batched-${suffix}`;
    const sequentialTenantId = `assert-sequential-${suffix}`;
    const repository = `omxyz/assert-batch-${suffix}`;
    const commitSha = "a".repeat(40);
    const seededAt = "2026-07-22T01:00:00.000Z";
    const mixedAt = "2026-07-22T02:00:00.000Z";
    const rerunAt = "2026-07-22T03:00:00.000Z";
    const store = new PostgresContextGraphStore({ connectionString });
    const admin = new Pool({ connectionString });
    // Subjects repeat every 25 assertions so a 50-assertion batch carries duplicate
    // endpoints, and subject labels embed the assertion index so first-occurrence
    // label semantics stay observable.
    const assertionInput = (index: number, labelPrefix: string) => ({
      subject: {
        kind: "File" as const,
        naturalKey: `repo:${repository}:path:src/file${index % 25}.ts`,
        label: `${labelPrefix}${index}:file${index % 25}.ts`
      },
      predicate: "IMPLEMENTS",
      object: {
        kind: "Feature" as const,
        naturalKey: `repo:${repository}:feature:feature-${index}`,
        label: `Feature ${index}`
      },
      confidence: 0.9,
      explanation: `src/file${index % 25}.ts implements feature ${index}.`,
      evidence: [`src/file${index % 25}.ts:1`]
    });
    const batchInput = (
      tenantId: string,
      fingerprint: string,
      generatedAt: string,
      labelPrefix: string,
      indexes: readonly number[]
    ) => ({
      tenantId,
      repository,
      ref: "main",
      commitSha,
      taskId: `assert-${fingerprint}`,
      generatedAt,
      generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
      registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
      evidenceFingerprint: fingerprint,
      evidenceObservationIds: [],
      model: "fixture",
      summary: "batched assertions",
      rawOutput: { summary: "batched assertions", nodes: [], edges: [] },
      assertions: indexes.map((index) => assertionInput(index, labelPrefix))
    });
    const tenantState = async (tenantId: string) => {
      const assertions = await admin.query(
        `select subject_natural_key,predicate,object_natural_key,subject_label,object_label,status,
           count(*)::int as row_count,max(last_confirmed_at)::text as last_confirmed_at
         from jina_context_graph.assertions where tenant_id=$1
         group by 1,2,3,4,5,6 order by 1,2,3,4,5,6`,
        [tenantId]
      );
      const entities = await admin.query(
        `select kind,natural_key,display_name from jina_context_graph.entities
         where tenant_id=$1 order by kind,natural_key`,
        [tenantId]
      );
      return { assertions: assertions.rows, entities: entities.rows };
    };
    try {
      const seedIndexes = Array.from({ length: 20 }, (_, index) => index);
      const allIndexes = Array.from({ length: 50 }, (_, index) => index);
      const seeded = await store.saveAssertionBatch(batchInput(batchedTenantId, "seed", seededAt, "v1-", seedIndexes));
      assert.equal(seeded.proposedCount, 20);
      // A 50-assertion batch where 20 assertions are already live and 30 are new.
      const mixed = await store.saveAssertionBatch(batchInput(batchedTenantId, "mixed", mixedAt, "v2-", allIndexes));
      assert.equal(mixed.cached, false);
      assert.deepEqual(mixed.warnings, []);
      assert.equal(mixed.assertionCount, 50);
      assert.equal(mixed.proposedCount, 50);
      assert.equal(mixed.activeCount, 0);
      // The sequential comparison tenant runs the same workload one assertion per call.
      for (const index of seedIndexes) {
        await store.saveAssertionBatch(batchInput(sequentialTenantId, `seed-${index}`, seededAt, "v1-", [index]));
      }
      for (const index of allIndexes) {
        const single = await store.saveAssertionBatch(
          batchInput(sequentialTenantId, `mixed-${index}`, mixedAt, "v2-", [index])
        );
        assert.equal(single.proposedCount, 1);
        assert.equal(single.activeCount, 0);
      }
      const batchedState = await tenantState(batchedTenantId);
      const sequentialState = await tenantState(sequentialTenantId);
      assert.equal(batchedState.assertions.length, 50);
      assert.deepEqual(batchedState.assertions, sequentialState.assertions);
      assert.deepEqual(batchedState.entities, sequentialState.entities);
      // Duplicate endpoints resolve to one entity each: 25 files + 50 features.
      assert.equal(batchedState.entities.length, 75);
      const fileLabels = batchedState.entities
        .filter((entity: { kind: string }) => entity.kind === "File")
        .map((entity: { display_name: string }) => entity.display_name);
      // Entities created by the seed batch keep their original labels; entities first
      // seen in the mixed batch take the label of their first occurrence there.
      assert.equal(fileLabels.includes("v1-0:file0.ts"), true);
      assert.equal(fileLabels.includes("v2-20:file20.ts"), true);
      assert.equal(
        fileLabels.some((label: string) => label.startsWith("v2-45:")),
        false
      );
      // Every live row carries the mixed batch's confirmation timestamp.
      const confirmedAt = await admin.query<{ count: number }>(
        `select count(*)::int as count from jina_context_graph.assertions
         where tenant_id=$1 and last_confirmed_at=$2::timestamptz`,
        [batchedTenantId, mixedAt]
      );
      assert.equal(confirmedAt.rows[0]?.count, 50);
      const outbox = await admin.query<{ event_type: string; count: number }>(
        `select event_type,count(distinct aggregate_id)::int as count from jina_context_graph.outbox
         where tenant_id=$1 group by event_type order by event_type`,
        [batchedTenantId]
      );
      const outboxCounts = new Map(outbox.rows.map((row) => [row.event_type, row.count]));
      assert.equal(outboxCounts.get("entity_changed"), 75);
      assert.equal(outboxCounts.get("assertion_changed"), 50);
      // A re-run of the same logical batch confirms every assertion in place.
      const rerun = await store.saveAssertionBatch(batchInput(batchedTenantId, "rerun", rerunAt, "v2-", allIndexes));
      assert.equal(rerun.cached, false);
      assert.equal(rerun.assertionCount, 50);
      assert.equal(rerun.proposedCount, 50);
      assert.equal(rerun.activeCount, 0);
      const afterRerun = await admin.query<{ count: number; confirmed: number }>(
        `select count(*)::int as count,
           (count(*) filter (where last_confirmed_at=$2::timestamptz))::int as confirmed
         from jina_context_graph.assertions where tenant_id=$1`,
        [batchedTenantId, rerunAt]
      );
      assert.equal(afterRerun.rows[0]?.count, 50);
      assert.equal(afterRerun.rows[0]?.confirmed, 50);
      // Submitting the identical batch again takes the cached observation path.
      const cachedRun = await store.saveAssertionBatch(
        batchInput(batchedTenantId, "mixed", mixedAt, "v2-", allIndexes)
      );
      assert.equal(cachedRun.cached, true);
      assert.equal(cachedRun.proposedCount, 50);
    } finally {
      await admin.end();
      await store.close();
    }
  }
);

test(
  "Postgres plane locks let planes interleave while lifecycle operations exclude all planes",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const suffix = Date.now().toString(36);
    const tenantId = `planes-${suffix}`;
    const repository = `omlabs/planes-${suffix}`;
    const store = new PostgresContextGraphStore({ connectionString });
    const secondStore = new PostgresContextGraphStore({ connectionString });
    const raw = new Pool({ connectionString, max: 4 });
    const planeKey = (plane: string) => `${tenantId}:${plane}`;
    const waitUntil = async (probe: () => Promise<boolean>, label: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await probe()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail(`timed out waiting for ${label}`);
    };
    const advisoryWaiterExists = async (plane: string) => {
      const waiting = await raw.query<{ count: string }>(
        `select count(*) from pg_locks
         where locktype='advisory' and granted=false
           and classid=hashtext($1)::oid and objid=hashtext($2)::oid`,
        [planeKey(plane), repository]
      );
      return Number(waiting.rows[0]?.count ?? 0) > 0;
    };
    const codeHolder = await raw.connect();
    const knowledgeHolder = await raw.connect();
    try {
      await store.planIngestion({
        tenantId,
        repository,
        ref: "main",
        commitSha: "1".repeat(40),
        treeSha: "2".repeat(40),
        parents: [],
        recordedAt: "2026-07-21T00:00:00.000Z",
        taskId: `planes-${suffix}`,
        files: [{ path: "README.md", blobSha: "a".repeat(40), size: 5 }]
      });

      // Structural: each plane hashes to its own advisory keyspace.
      const keys = await raw.query<{ code: number; knowledge: number; projection: number }>(
        "select hashtext($1) as code,hashtext($2) as knowledge,hashtext($3) as projection",
        [planeKey("code"), planeKey("knowledge"), planeKey("projection")]
      );
      const { code, knowledge, projection } = keys.rows[0]!;
      assert.equal(new Set([code, knowledge, projection]).size, 3, "plane lock keyspaces must be distinct");

      // A code-plane transaction held open (an applyBlobAnalyses mid-flight)...
      await codeHolder.query("begin");
      await codeHolder.query("select pg_advisory_xact_lock(hashtext($1),hashtext($2))", [planeKey("code"), repository]);
      // ...must not block a knowledge-plane write on the same repository.
      const knowledgeWrite = secondStore.applyGitHubObservations([
        {
          tenantId,
          repository,
          kind: "issue",
          number: 7,
          title: "Interleaved issue",
          body: "written while the code plane is locked",
          state: "open",
          url: `https://github.com/${repository}/issues/7`,
          authorLogin: "alice",
          occurredAt: "2026-07-21T00:01:00.000Z",
          recordedAt: "2026-07-21T00:01:00.000Z"
        }
      ]);
      const raced = await Promise.race([
        knowledgeWrite.then(() => "completed" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 10_000))
      ]);
      assert.equal(raced, "completed", "knowledge-plane write must not queue behind a code-plane transaction");

      // A lifecycle tombstone needs every plane: it queues behind the open
      // code-plane transaction and a concurrent knowledge-plane transaction.
      await knowledgeHolder.query("begin");
      await knowledgeHolder.query("select pg_advisory_xact_lock(hashtext($1),hashtext($2))", [
        planeKey("knowledge"),
        repository
      ]);
      let tombstoneSettled = false;
      const tombstone = store
        .executeCommand(
          tenantId,
          "svc:test",
          { type: "tombstone_repository", repository, reason: "plane lock test" },
          "2026-07-21T00:02:00.000Z",
          true
        )
        .finally(() => {
          tombstoneSettled = true;
        });
      await waitUntil(() => advisoryWaiterExists("code"), "tombstone to queue on the code plane");
      assert.equal(tombstoneSettled, false, "tombstone must wait for the code-plane transaction");
      await codeHolder.query("commit");
      await waitUntil(() => advisoryWaiterExists("knowledge"), "tombstone to queue on the knowledge plane");
      assert.equal(tombstoneSettled, false, "tombstone must also wait for the knowledge-plane transaction");
      await knowledgeHolder.query("commit");
      await tombstone;
      assert.equal(tombstoneSettled, true);
      await assert.rejects(
        secondStore.saveAssertionBatch({
          tenantId,
          repository,
          ref: "main",
          commitSha: "1".repeat(40),
          taskId: `planes-batch-${suffix}`,
          generatedAt: "2026-07-21T00:03:00.000Z",
          generatorVersion: CONTEXT_GRAPH_GENERATOR_VERSION,
          registryVersion: CONTEXT_GRAPH_REGISTRY_VERSION,
          evidenceFingerprint: "planes",
          evidenceObservationIds: [],
          model: "fixture",
          summary: "plane lock fixture",
          rawOutput: { summary: "fixture", nodes: [], edges: [] },
          assertions: []
        }),
        /tombstoned/,
        "every plane variant keeps the tombstone check"
      );
    } finally {
      codeHolder.release();
      knowledgeHolder.release();
      await raw.end();
      await Promise.all([store.close(), secondStore.close()]);
    }
  }
);

test(
  "Postgres context graph store adopts a legacy pre-rename schema in place",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const admin = new Pool({ connectionString });
    try {
      // Simulate a database bootstrapped before the context-graph rename:
      // all data lives in the old jina_ontology schema and the new schema
      // does not exist yet. The marker table stands in for production data
      // that the rename must carry over instead of orphaning.
      await admin.query("drop schema if exists jina_context_graph cascade");
      await admin.query("drop schema if exists jina_ontology cascade");
      await admin.query("create schema jina_ontology");
      await admin.query("create table jina_ontology.legacy_marker (id text primary key)");
      await admin.query("insert into jina_ontology.legacy_marker (id) values ('pre-rename-row')");

      const store = new PostgresContextGraphStore({ connectionString });
      try {
        // Any read triggers the lazy schema bootstrap, which must adopt the
        // legacy schema via rename before applying the current DDL.
        assert.equal(await store.latest("adoption-tenant"), undefined);
      } finally {
        await store.close();
      }

      const adopted = await admin.query<{ id: string }>("select id from jina_context_graph.legacy_marker");
      assert.deepEqual(adopted.rows, [{ id: "pre-rename-row" }]);
      const legacy = await admin.query<{ present: boolean }>(
        "select exists (select 1 from pg_namespace where nspname = 'jina_ontology') as present"
      );
      assert.equal(legacy.rows[0]?.present, false, "the legacy schema is renamed, not left behind");
    } finally {
      await admin.end();
    }
  }
);

// The task-board schema exactly as the pipeline coordinator created it before
// the context-graph rename: topic is pinned to the run-ontology-* vocabulary,
// while the timing columns, the named duration_ms constraint, and the
// task_checkpoints table are all present — the shape production is in, where
// the pre-fix readiness probe reported the schema current and skipped the DDL
// (and with it any topic migration) entirely.
const LEGACY_PIPELINE_SCHEMA_SQL = `
  create schema if not exists jina_board;
  create table if not exists jina_board.workflows (
    id text primary key,
    tenant_id text not null,
    repository text not null,
    ref_name text not null,
    request_key text not null,
    status text not null check (status in ('queued','in_progress','enriching','done','failed','superseded')),
    snapshot_first boolean not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    unique (tenant_id,repository,ref_name,request_key)
  );
  create index if not exists task_board_workflows_repository_idx
    on jina_board.workflows (tenant_id,repository,ref_name,created_at desc);
  create table if not exists jina_board.tasks (
    id text primary key,
    build_id text not null references jina_board.workflows(id) on delete cascade,
    tenant_id text not null,
    repository text not null,
    ref_name text not null,
    request_key text not null,
    phase text not null check (phase in ('snapshot','history')),
    stage text not null check (stage in ('ingest','assert','project')),
    topic text not null check (topic in ('run-ontology-ingest','run-ontology-assert','run-ontology-project')),
    status text not null check (status in ('triage','queued','in_progress','done','failed','canceled','superseded')),
    priority integer not null,
    ordinal integer not null,
    metadata jsonb not null default '{}'::jsonb,
    attempt integer not null default 0,
    lease_id text,
    worker_id text,
    lease_expires_at timestamptz,
    started_at timestamptz,
    completed_at timestamptz,
    duration_ms bigint check (duration_ms is null or duration_ms>=0),
    created_at timestamptz not null,
    updated_at timestamptz not null,
    unique (build_id,phase,stage)
  );
  do $$
  begin
    if not exists (
      select 1 from pg_constraint
      where conrelid='jina_board.tasks'::regclass and contype='c'
        and pg_get_constraintdef(oid) like '%duration_ms%'
        and conname='task_board_tasks_duration_ms_check'
    ) then
      alter table jina_board.tasks
        add constraint task_board_tasks_duration_ms_check check (duration_ms is null or duration_ms>=0);
    end if;
  end $$;
  create index if not exists task_board_tasks_claim_idx
    on jina_board.tasks (tenant_id,status,topic,priority desc,created_at);
  create index if not exists task_board_tasks_lease_idx
    on jina_board.tasks (tenant_id,id,lease_id,lease_expires_at) where status='in_progress';
  create table if not exists jina_board.dependencies (
    workflow_id text not null references jina_board.workflows(id) on delete cascade,
    task_id text not null,
    depends_on_task_id text not null,
    relationship text not null,
    required boolean not null,
    blocks_parent_completion boolean not null,
    created_at timestamptz not null,
    primary key (workflow_id,task_id,depends_on_task_id,relationship)
  );
  create table if not exists jina_board.events (
    id bigint generated always as identity primary key,
    tenant_id text not null,
    task_id text not null,
    type text not null,
    at timestamptz not null,
    payload jsonb not null default '{}'::jsonb
  );
  create index if not exists task_board_events_task_idx
    on jina_board.events (tenant_id,task_id,id);
  create table if not exists jina_board.task_checkpoints (
    stage_id text not null references jina_board.tasks(id) on delete cascade,
    name text not null,
    value jsonb not null,
    updated_at timestamptz not null,
    primary key (stage_id,name)
  );
`;

test(
  "Postgres contextGraph pipeline migrates a pre-rename task board topic constraint in place",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const admin = new Pool({ connectionString });
    const suffix = Date.now().toString(36);
    const tenantId = `board-migration-${suffix}`;
    const repository = `omxyz/board-migration-${suffix}`;
    const legacyBuildId = `legacy-build-${suffix}`;
    const legacyTaskId = `legacy-task-${suffix}`;
    const legacyLeasedId = `legacy-leased-${suffix}`;
    const legacyDoneId = `legacy-done-${suffix}`;
    const seededAt = "2026-07-20T00:00:00.000Z";
    try {
      await admin.query("drop schema if exists jina_board cascade");
      await admin.query(LEGACY_PIPELINE_SCHEMA_SQL);
      // Production still holds queued/leased/terminal rows carrying legacy
      // topics; the migration must validate its replacement constraint
      // against them and drain the non-terminal ones to the new vocabulary.
      await admin.query(
        `insert into jina_board.workflows (id,tenant_id,repository,ref_name,request_key,status,snapshot_first,metadata,created_at,updated_at)
         values ($1,$2,$3,'main','pre-rename','queued',true,'{}'::jsonb,$4,$4)`,
        [legacyBuildId, tenantId, repository, seededAt]
      );
      await admin.query(
        `insert into jina_board.tasks (id,build_id,tenant_id,repository,ref_name,request_key,phase,stage,topic,status,priority,ordinal,metadata,created_at,updated_at)
         values ($1,$2,$3,$4,'main','pre-rename','snapshot','ingest','run-ontology-ingest','queued',100,0,'{}'::jsonb,$5,$5)`,
        [legacyTaskId, legacyBuildId, tenantId, repository, seededAt]
      );
      await admin.query(
        `insert into jina_board.tasks (id,build_id,tenant_id,repository,ref_name,request_key,phase,stage,topic,status,priority,ordinal,metadata,attempt,lease_id,worker_id,lease_expires_at,started_at,created_at,updated_at)
         values ($1,$2,$3,$4,'main','pre-rename','snapshot','assert','run-ontology-assert','in_progress',100,1,'{}'::jsonb,1,'legacy-lease','legacy-worker','2026-07-22T00:00:00.000Z',$5,$5,$5)`,
        [legacyLeasedId, legacyBuildId, tenantId, repository, seededAt]
      );
      await admin.query(
        `insert into jina_board.tasks (id,build_id,tenant_id,repository,ref_name,request_key,phase,stage,topic,status,priority,ordinal,metadata,attempt,started_at,completed_at,duration_ms,created_at,updated_at)
         values ($1,$2,$3,$4,'main','pre-rename','snapshot','project','run-ontology-project','done',100,2,'{}'::jsonb,1,$5,$5,0,$5,$5)`,
        [legacyDoneId, legacyBuildId, tenantId, repository, seededAt]
      );

      const coordinator = new PostgresContextGraphPipelineCoordinator({ connectionString });
      try {
        // Bootstrap alone must swap the constraint and drain the stranded
        // rows: non-terminal rows move to the new vocabulary (keeping any
        // lease so the retired worker's renew/complete still key on task id +
        // lease id), while terminal rows keep their historical topics.
        await coordinator.ping();
        const drained = await admin.query<{ id: string; topic: string; status: string; lease_id: string | null }>(
          "select id,topic,status,lease_id from jina_board.tasks where build_id=$1 order by ordinal",
          [legacyBuildId]
        );
        assert.deepEqual(drained.rows, [
          { id: legacyTaskId, topic: "run-context-graph-ingest", status: "queued", lease_id: null },
          { id: legacyLeasedId, topic: "run-context-graph-assert", status: "in_progress", lease_id: "legacy-lease" },
          { id: legacyDoneId, topic: "run-ontology-project", status: "done", lease_id: null }
        ]);

        // The drained queued row is immediately claimable on the new topics.
        const drainedClaim = await coordinator.claim({
          tenantId,
          workerId: "worker-drained",
          topics: ["run-context-graph-ingest"],
          now: "2026-07-20T01:00:00.000Z",
          leaseExpiresAt: "2026-07-20T02:00:00.000Z"
        });
        assert.equal(drainedClaim?.task.id, legacyTaskId, "a migrated legacy row is claimable on the new topics");

        // Superseding the legacy build rewrites the status of its legacy-era
        // tasks, and Postgres re-evaluates the topic check on that update; the
        // subsequent stage inserts carry the new vocabulary. Both only pass
        // once the migration has replaced the legacy-only constraint.
        const build = await coordinator.createBuild({
          tenantId,
          repository,
          ref: "main",
          requestKey: "post-rename",
          snapshotFirst: true,
          createdAt: "2026-07-21T00:00:00.000Z"
        });
        assert.equal(build.status, "queued");
        const claim = await coordinator.claim({
          tenantId,
          workerId: "worker-migration",
          topics: ["run-context-graph-ingest"],
          now: "2026-07-21T00:01:00.000Z",
          leaseExpiresAt: "2026-07-21T01:00:00.000Z"
        });
        assert.ok(claim, "a build submitted after the rename is claimable on the new topics");
        assert.equal(claim.message.topic, "run-context-graph-ingest");
        assert.notEqual(claim.task.id, legacyTaskId);

        const legacyTask = await admin.query<{ status: string; topic: string }>(
          "select status,topic from jina_board.tasks where id=$1",
          [legacyTaskId]
        );
        assert.equal(legacyTask.rows[0]?.status, "superseded", "the migrated row accepts status updates");
        assert.equal(legacyTask.rows[0]?.topic, "run-context-graph-ingest");
        const doneTask = await admin.query<{ topic: string }>("select topic from jina_board.tasks where id=$1", [
          legacyDoneId
        ]);
        assert.equal(doneTask.rows[0]?.topic, "run-ontology-project", "terminal rows keep their historical topics");

        // Legacy-topic rows must stay both insertable and updatable: the
        // replacement constraint allows both vocabularies.
        await admin.query(
          `insert into jina_board.tasks (id,build_id,tenant_id,repository,ref_name,request_key,phase,stage,topic,status,priority,ordinal,metadata,created_at,updated_at)
           values ($1,$2,$3,$4,'main','pre-rename','history','assert','run-ontology-assert','queued',10,4,'{}'::jsonb,$5,$5)`,
          [`legacy-extra-${suffix}`, legacyBuildId, tenantId, repository, seededAt]
        );
        await admin.query("update jina_board.tasks set status='canceled',updated_at=now() where id=$1", [
          `legacy-extra-${suffix}`
        ]);

        const checks = await admin.query<{ conname: string; definition: string }>(
          `select conname,pg_get_constraintdef(oid) as definition from pg_constraint
           where conrelid='jina_board.tasks'::regclass and contype='c'
             and pg_get_constraintdef(oid) like '%topic%'`
        );
        assert.deepEqual(
          checks.rows.map((row) => row.conname),
          ["task_board_tasks_topic_check"],
          "exactly one named topic constraint remains"
        );
        assert.ok(checks.rows[0]?.definition.includes("run-context-graph-ingest"));
        assert.ok(checks.rows[0]?.definition.includes("run-ontology-ingest"));
      } finally {
        await coordinator.close();
      }

      // A database that raced past the constraint fix (both-vocabulary check
      // already in place, rows not yet drained) must still migrate: the
      // readiness probe's lock-free row read detects the stranded row and
      // sends the next coordinator down the DDL path, and re-running the
      // whole apply on the migrated schema is idempotent.
      await admin.query(
        `insert into jina_board.tasks (id,build_id,tenant_id,repository,ref_name,request_key,phase,stage,topic,status,priority,ordinal,metadata,created_at,updated_at)
         values ($1,$2,$3,$4,'main','pre-rename','history','ingest','run-ontology-ingest','queued',10,3,'{}'::jsonb,$5,$5)`,
        [`legacy-straggler-${suffix}`, legacyBuildId, tenantId, repository, seededAt]
      );
      const second = new PostgresContextGraphPipelineCoordinator({ connectionString });
      try {
        await second.ping();
        const straggler = await admin.query<{ topic: string }>("select topic from jina_board.tasks where id=$1", [
          `legacy-straggler-${suffix}`
        ]);
        assert.equal(straggler.rows[0]?.topic, "run-context-graph-ingest", "a repeat apply drains stragglers");
        const repeatChecks = await admin.query<{ conname: string }>(
          `select conname from pg_constraint
           where conrelid='jina_board.tasks'::regclass and contype='c'
             and pg_get_constraintdef(oid) like '%topic%'`
        );
        assert.deepEqual(
          repeatChecks.rows.map((row) => row.conname),
          ["task_board_tasks_topic_check"],
          "repeated applies leave the constraint set unchanged"
        );
      } finally {
        await second.close();
      }

      // With nothing left to migrate, a later coordinator takes the lock-free
      // fast path: the migrated schema counts as ready even though the
      // replacement constraint's definition mentions the legacy vocabulary it
      // still allows, and the terminal rows keep their legacy topics.
      const third = new PostgresContextGraphPipelineCoordinator({ connectionString });
      try {
        await third.ping();
      } finally {
        await third.close();
      }
    } finally {
      await admin.query("delete from jina_board.workflows where tenant_id=$1", [tenantId]).catch(() => undefined);
      await admin.end();
    }
  }
);

test(
  "Postgres contextGraph sweep records the interrupted attempt when a lease expires",
  {
    skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
  },
  async () => {
    assert.ok(connectionString);
    const suffix = Date.now().toString(36);
    const tenantId = `sweep-expiry-${suffix}`;
    const repository = `omxyz/sweep-expiry-${suffix}`;
    const coordinator = new PostgresContextGraphPipelineCoordinator({ connectionString });
    const cleanup = new Pool({ connectionString });
    try {
      await coordinator.createBuild({
        tenantId,
        repository,
        ref: "main",
        requestKey: "expiry",
        snapshotFirst: true,
        createdAt: "2026-07-21T00:00:00.000Z"
      });
      const first = await coordinator.claim({
        tenantId,
        workerId: "worker-1",
        topics: ["run-context-graph-ingest"],
        now: "2026-07-21T00:01:00.000Z",
        leaseExpiresAt: "2026-07-21T00:05:00.000Z"
      });
      assert.ok(first);
      // A claim for an unrelated topic after the lease deadline sweeps the
      // expired lease back to queued without immediately re-leasing the stage.
      assert.equal(
        await coordinator.claim({
          tenantId,
          workerId: "worker-2",
          topics: ["run-context-graph-assert"],
          now: "2026-07-21T00:06:00.000Z",
          leaseExpiresAt: "2026-07-21T01:06:00.000Z"
        }),
        undefined
      );
      const requeued = (await coordinator.list(tenantId))[0]!.stages.find((stage) => stage.id === first.task.id);
      assert.equal(requeued?.status, "queued");
      assert.deepEqual(
        { startedAt: requeued?.startedAt, completedAt: requeued?.completedAt, durationMs: requeued?.durationMs },
        { startedAt: undefined, completedAt: undefined, durationMs: undefined },
        "an expiry-requeued stage carries no stale timing while queued"
      );
      // The interrupted attempt's timing is not discarded: the sweep records
      // it in a task.lease_expired board event before clearing the stage row.
      const expiryEvents = (await coordinator.listEvents(tenantId, { taskIds: [first.task.id] })).filter(
        (event) => event.type === "task.lease_expired"
      );
      assert.equal(expiryEvents.length, 1);
      assert.equal(expiryEvents[0]?.at, "2026-07-21T00:06:00.000Z");
      assert.deepEqual(expiryEvents[0]?.payload, {
        fromStatus: "in_progress",
        toStatus: "queued",
        attempt: 1,
        workerId: "worker-1",
        startedAt: "2026-07-21T00:01:00.000Z",
        endedAt: "2026-07-21T00:06:00.000Z",
        durationMs: 300_000
      });
      const second = await coordinator.claim({
        tenantId,
        workerId: "worker-2",
        topics: ["run-context-graph-ingest"],
        now: "2026-07-21T00:07:00.000Z",
        leaseExpiresAt: "2026-07-21T01:07:00.000Z"
      });
      assert.ok(second);
      assert.equal(second.task.id, first.task.id);
      assert.equal(second.task.metadata.pipelinePhase, "snapshot");
    } finally {
      await cleanup.query("delete from jina_board.events where tenant_id=$1", [tenantId]).catch(() => undefined);
      await cleanup.query("delete from jina_board.workflows where tenant_id=$1", [tenantId]).catch(() => undefined);
      await cleanup.end();
      await coordinator.close();
    }
  }
);
