import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ONTOLOGY_GENERATOR_VERSION,
  ONTOLOGY_PARSER_VERSION,
  ONTOLOGY_REGISTRY_VERSION,
  RepositoryContextOrchestrator,
  createOntologyGraph,
  derivedIssueNaturalKey,
  featureNaturalKey,
  stableId
} from "@jina/ontology";
import { PostgresJsonStateStore } from "./postgres-json-state-store.js";
import { PostgresOntologyGraphStore } from "./postgres-ontology-graph-store.js";
import { ONTOLOGY_ROLES_SQL } from "./ontology-roles.js";
import { Pool } from "pg";

const connectionString = process.env.TEST_DATABASE_URL;

test("Postgres atomically stores board completion and an immutable graph", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const stateStore = new PostgresJsonStateStore<unknown>({ connectionString });
  const graphStore = new PostgresOntologyGraphStore({ connectionString });
  const priorState = await stateStore.load();
  const graph = createOntologyGraph({
    request: { tenantId: "legacy", repository: "omlabs/db-fixture", ref: "main", taskId: "db-test-generation" },
    commitSha: "db-test-sha",
    generatedAt: "2026-07-19T12:00:00.000Z",
    executor: "fixture",
    model: "fixture",
    generated: {
      summary: "Database fixture",
      nodes: [
        { id: "repo", kind: "Repository", label: "Fixture", description: "Fixture", evidence: ["README.md:1"] },
        { id: "readme", kind: "File", label: "README", description: "Readme", path: "README.md", evidence: ["README.md:1"] }
      ],
      edges: [{ source: "repo", target: "readme", predicate: "CONTAINS", plane: "code", evidence: ["README.md:1"] }]
    }
  });

  try {
    await stateStore.saveWithOntologyGraph({ boardStatus: "done" }, graph);
    assert.deepEqual(await stateStore.load(), { boardStatus: "done" });
    await graphStore.migrateTenantAliases("omlabs", ["legacy"]);
    const summaries = await graphStore.listSummaries("omlabs");
    assert.equal(summaries.find((summary) => summary.id === graph.id)?.nodeCount, 2);
    assert.equal(summaries.find((summary) => summary.id === graph.id)?.edgeCount, 1);
    assert.equal((await graphStore.get(graph.id, "omlabs"))?.nodes.length, 2);
    assert.equal(await graphStore.get(graph.id, "legacy"), undefined);
  } finally {
    if (priorState === undefined) {
      const cleanup = new Pool({ connectionString });
      await cleanup.query("delete from jina_runtime.api_state where id=1");
      await cleanup.end();
    } else {
      await stateStore.save(priorState);
    }
    await stateStore.close();
    await graphStore.close();
  }
});

test("Postgres ontology roles separate reads and runtime writes from schema ownership", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresOntologyGraphStore({ connectionString });
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await store.list("role-fixture");
    await pool.query(ONTOLOGY_ROLES_SQL);

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("set local role jina_ontology_reader");
      await client.query("select count(*) from jina_ontology.graphs");
      await assert.rejects(
        client.query("insert into jina_ontology.blobs (tenant_id,blob_sha,byte_size) values ('role-fixture','reader-write',1)"),
        /permission denied/
      );
      await client.query("rollback");

      await client.query("begin");
      await client.query("set local role jina_ontology_writer");
      await client.query("insert into jina_ontology.blobs (tenant_id,blob_sha,byte_size) values ('role-fixture','writer-write',1)");
      await assert.rejects(
        client.query("create table jina_ontology.writer_must_not_migrate (id integer)"),
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
});

test("Postgres projections ignore deprecated inverse assertions after an upgrade", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresOntologyGraphStore({ connectionString });
  const pool = new Pool({ connectionString });
  const suffix = Date.now().toString(36);
  const tenantId = `legacy-inverse-${suffix}`;
  const repository = `omlabs/legacy-inverse-${suffix}`;
  const commitSha = "7".repeat(40);
  const issueId = stableId("entity", `${tenantId}:Issue:github:issue:${repository}#1`);
  const pullRequestId = stableId("entity", `${tenantId}:PullRequest:github:pr:${repository}#2`);
  try {
    await store.planIngestion({
      tenantId, repository, ref: "main", commitSha, treeSha: "8".repeat(40), parents: [],
      committedAt: "2026-07-21T00:00:00.000Z", recordedAt: "2026-07-21T00:00:00.000Z",
      isDefaultRef: true, updateRef: true, taskId: `legacy-${suffix}`,
      files: [{ path: "README.md", blobSha: "9".repeat(40), size: 1 }]
    });
    await pool.query(
      `insert into jina_ontology.entities (id,tenant_id,kind,natural_key,display_name)
       values ($1,$3,'Issue',$4,'Legacy issue'),($2,$3,'PullRequest',$5,'PR #2')`,
      [issueId, pullRequestId, tenantId, `github:issue:${repository}#1`, `github:pr:${repository}#2`]
    );
    await pool.query(
      `insert into jina_ontology.assertions
        (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,
         predicate,object_id,object_kind,object_natural_key,object_label,status,confidence,evidence,
         source_observation_id,asserted_by,generator_version,registry_version,recorded_at)
       values ($1,$2,$3,$4,$5,'Issue',$6,'Legacy issue','RESOLVED_BY',$7,'PullRequest',$8,'PR #2',
               'active',1,'[]'::jsonb,null,'legacy:migration','legacy','repository-context-v5.4',$9)`,
      [stableId("assertion", `${tenantId}:legacy-resolved-by`), tenantId, repository, commitSha, issueId,
        `github:issue:${repository}#1`, pullRequestId, `github:pr:${repository}#2`, "2026-07-21T00:00:00.000Z"]
    );

    const projected = await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-21T00:01:00.000Z");
    assert.equal(projected.rebuilt, true);
    assert.deepEqual(await store.listAssertions(tenantId, repository), []);
    const legacy = await pool.query<{ status: string }>(
      `select status from jina_ontology.assertions where tenant_id=$1 and predicate='RESOLVED_BY'`, [tenantId]
    );
    assert.equal(legacy.rows[0]?.status, "active", "legacy history is preserved but excluded from current reads");
  } finally {
    await pool.end();
    await store.close();
  }
});

test("Postgres reuses content-addressed blobs and projects canonical assertions", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresOntologyGraphStore({ connectionString });
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
      { blobSha: "c".repeat(40), parserVersion: ONTOLOGY_PARSER_VERSION, language: "markdown", symbols: [], imports: [], edges: [] },
      {
        blobSha: "d".repeat(40),
        parserVersion: ONTOLOGY_PARSER_VERSION,
        language: "typescript",
        symbols: [{ moniker: "main", name: "main", kind: "function", signatureHash: "f".repeat(64), startLine: 1, endLine: 1 }],
        imports: [], edges: []
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
      generatorVersion: ONTOLOGY_GENERATOR_VERSION,
      registryVersion: ONTOLOGY_REGISTRY_VERSION,
      evidenceFingerprint: "evidence-fixture",
      evidenceObservationIds: [],
      model: "fixture",
      summary: "README documents the repository",
      rawOutput: {
        summary: "README documents the repository",
        nodes: [
          { id: "repo", kind: "Repository", label: "fixture", description: "repo", evidence: ["README.md:1"] },
          { id: "readme", kind: "Document", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] }
        ],
        edges: [{ source: "repo", target: "readme", predicate: "DOCUMENTED_BY", plane: "knowledge", confidence: 0.95, evidence: ["README.md:1"] }]
      },
      assertions: [{
        subject: { kind: "Repository", naturalKey: `github:repo:${snapshot.repository}`, label: "fixture" },
        predicate: "DOCUMENTED_BY",
        object: { kind: "Document", naturalKey: `repo:${snapshot.repository}:path:README.md`, label: "README" },
        confidence: 0.95,
        evidence: ["README.md:1"]
      }]
    });
    assert.equal(asserted.activeCount, 0);
    assert.equal(asserted.proposedCount, 1);
    assert.equal((await store.hasAssertionGeneration(
      snapshot.tenantId,
      snapshot.repository,
      snapshot.commitSha,
      ONTOLOGY_GENERATOR_VERSION,
      ONTOLOGY_REGISTRY_VERSION,
      "evidence-fixture"
    ))?.cached, true);
    const graph = await store.project({
      tenantId: snapshot.tenantId,
      repository: snapshot.repository,
      ref: snapshot.ref,
      commitSha: snapshot.commitSha,
      taskId: `project-${suffix}`,
      generatedAt: "2026-07-19T12:02:00.000Z"
    });
    assert.equal(graph.generator.executor, "projection");
    assert.equal(graph.edges.some((edge) => edge.predicate === "DOCUMENTED_BY"), false);
    assert.equal(graph.nodes.some((node) => node.kind === "Symbol"), true);
  } finally {
    await store.close();
  }
});

test("Postgres scopes live assertions by repository and preserves qualifier-distinct projection edges", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresOntologyGraphStore({ connectionString });
  const suffix = Date.now().toString(36);
  const tenantId = `assertion-scope-${suffix}`;
  const firstRepository = `omlabs/assertion-one-${suffix}`;
  const secondRepository = `omlabs/assertion-two-${suffix}`;
  const commitSha = "6".repeat(40);
  const secondCommitSha = "8".repeat(40);
  const batch = (repository: string, batchCommitSha: string, fingerprint: string, reasons: readonly string[]) => ({
    tenantId, repository, ref: "main", commitSha: batchCommitSha, taskId: `assert-${repository}`,
    generatedAt: "2026-07-21T00:01:00.000Z", generatorVersion: ONTOLOGY_GENERATOR_VERSION,
    registryVersion: ONTOLOGY_REGISTRY_VERSION, evidenceFingerprint: fingerprint, evidenceObservationIds: [], model: "fixture",
    summary: "Qualified causes", rawOutput: { summary: "fixture", nodes: [], edges: [] },
    assertions: reasons.map((reason) => ({
      subject: { kind: "Issue" as const, naturalKey: "external:issue:1", label: "Issue" },
      predicate: "INTRODUCED_BY",
      object: { kind: "Commit" as const, naturalKey: `repo:shared:sha:${commitSha}`, label: commitSha.slice(0, 12) },
      confidence: 0.9, evidence: ["docs/root-cause.md:1"], qualifiers: { reason }
    }))
  });
  try {
    for (const [repository, repositoryCommitSha] of [[firstRepository, commitSha], [secondRepository, secondCommitSha]] as const) {
      await store.planIngestion({
        tenantId, repository, ref: "main", commitSha: repositoryCommitSha, treeSha: stableId("tree", repository).slice(0, 40), parents: [],
        updateRef: true, recordedAt: "2026-07-21T00:00:00.000Z", taskId: `ingest-${repository}`,
        files: [{ path: "docs/root-cause.md", blobSha: "7".repeat(40), size: 20 }]
      });
    }
    await store.saveAssertionBatch(batch(firstRepository, commitSha, "first", ["Shared mechanism"]));
    await store.saveAssertionBatch(batch(secondRepository, secondCommitSha, "second", ["First mechanism", "Second mechanism"]));
    assert.equal((await store.listAssertions(tenantId, firstRepository)).length, 1);
    const secondAssertions = await store.listAssertions(tenantId, secondRepository, { status: "proposed" });
    assert.equal(secondAssertions.length, 2, "a live assertion in another repository is not reused");
    for (const assertion of secondAssertions) {
      await store.executeCommand(tenantId, "svc:test", {
        type: "review_assertion", assertionId: assertion.id, decision: "accept"
      }, "2026-07-21T00:02:00.000Z");
    }
    const graph = await store.project({
      tenantId, repository: secondRepository, ref: "main", commitSha: secondCommitSha,
      taskId: `project-${suffix}`, generatedAt: "2026-07-21T00:03:00.000Z"
    });
    const causes = graph.edges.filter((edge) => edge.predicate === "INTRODUCED_BY");
    assert.equal(causes.length, 2);
    assert.deepEqual(causes.map((edge) => edge.qualifiers?.reason).sort(), ["First mechanism", "Second mechanism"]);
    const hydrated = await store.get(graph.id, tenantId);
    assert.deepEqual(hydrated?.edges.filter((edge) => edge.predicate === "INTRODUCED_BY")
      .map((edge) => edge.qualifiers?.reason).sort(), ["First mechanism", "Second mechanism"]);
  } finally {
    await store.close();
  }
});

test("Postgres stores commit churn and reconstructs historical manifests", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresOntologyGraphStore({ connectionString });
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
      tenantId, repository, ref: "main", commitSha: rootSha, treeSha: "4".repeat(40), parents: [],
      updateRef: false, recordedAt: "2026-07-21T00:00:00.000Z", taskId: `root-${suffix}`,
      files: [
        { path: "README.md", blobSha: readmeBlob, size: 10 },
        { path: "src/old.ts", blobSha: sourceBlob, size: 20 },
        { path: "src/app.ts", blobSha: oldAppBlob, size: 30 }
      ]
    });
    assert.equal(root.changes.length, 3);
    const child = await store.planIngestion({
      tenantId, repository, ref: "main", commitSha: childSha, treeSha: "5".repeat(40), parents: [rootSha],
      updateRef: false, recordedAt: "2026-07-21T00:01:00.000Z", taskId: `child-${suffix}`,
      files: [
        { path: "README.md", blobSha: readmeBlob, size: 10 },
        { path: "src/new.ts", blobSha: sourceBlob, size: 20 },
        { path: "src/app.ts", blobSha: newAppBlob, size: 40 }
      ]
    });
    assert.deepEqual(child.changes.map((change) => [change.change, change.path, change.oldPath]), [
      ["modify", "src/app.ts", undefined],
      ["rename", "src/new.ts", "src/old.ts"]
    ]);
    const head = await store.planIngestion({
      tenantId, repository, ref: "main", commitSha: headSha, treeSha: "6".repeat(40), parents: [childSha],
      updateRef: true, recordedAt: "2026-07-21T00:02:00.000Z", taskId: `head-${suffix}`,
      files: [
        { path: "README.md", blobSha: readmeBlob, size: 10 },
        { path: "src/app.ts", blobSha: newAppBlob, size: 40 }
      ]
    });
    assert.deepEqual(head.changes.map((change) => [change.change, change.path]), [["delete", "src/new.ts"]]);

    const churn = await pool.query<{ count: string }>(
      `select count(*) from jina_ontology.commit_changes where tenant_id=$1 and repository=$2`,
      [tenantId, repository]
    );
    assert.equal(Number(churn.rows[0]?.count), 6, "three commits persist six changes instead of eight full-tree rows");
    const manifest = async (sha: string) => (await pool.query<{ path: string; blob_sha: string }>(
      `select path,blob_sha from jina_ontology.commit_manifest($1,$2,$3)`, [tenantId, repository, sha]
    )).rows.map((row) => [row.path, row.blob_sha]);
    assert.deepEqual(await manifest(rootSha), [
      ["README.md", readmeBlob], ["src/app.ts", oldAppBlob], ["src/old.ts", sourceBlob]
    ]);
    assert.deepEqual(await manifest(childSha), [
      ["README.md", readmeBlob], ["src/app.ts", newAppBlob], ["src/new.ts", sourceBlob]
    ]);
    assert.deepEqual(await manifest(headSha), [["README.md", readmeBlob], ["src/app.ts", newAppBlob]]);
  } finally {
    await pool.end();
    await store.close();
  }
});

test("Postgres preserves review and provenance when a new model contract confirms a fact", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresOntologyGraphStore({ connectionString });
  const suffix = Date.now().toString(36);
  const tenantId = `generation-${suffix}`;
  const repository = "omlabs/db-generation-fixture";
  const common = {
    tenantId,
    repository,
    ref: "main",
    commitSha: "e".repeat(40),
    registryVersion: ONTOLOGY_REGISTRY_VERSION,
    evidenceFingerprint: "same-input",
    evidenceObservationIds: [],
    model: "fixture",
    summary: "README documents the repository",
    rawOutput: { summary: "fixture", nodes: [], edges: [] },
    assertions: [{
      subject: { kind: "Repository" as const, naturalKey: `github:repo:${repository}`, label: repository },
      predicate: "DOCUMENTED_BY",
      object: { kind: "Document" as const, naturalKey: `repo:${repository}:path:README.md`, label: "README" },
      confidence: 0.95,
      evidence: ["README.md:1"]
    }]
  };
  try {
    await store.saveAssertionBatch({ ...common, taskId: `v1-${suffix}`, generatedAt: "2026-07-20T00:00:00Z", generatorVersion: "model-v1" });
    const [proposal] = await store.listAssertions(tenantId, repository);
    assert.ok(proposal);
    await store.executeCommand(tenantId, "svc:reviewer", {
      type: "review_assertion", assertionId: proposal.id, decision: "accept"
    }, "2026-07-20T00:00:30Z");
    await store.saveAssertionBatch({
      ...common, taskId: `v2-${suffix}`, generatedAt: "2026-07-20T00:01:00Z",
      generatorVersion: "model-v2", evidenceFingerprint: "updated-input"
    });
    const assertions = await store.listAssertions(tenantId, repository);
    assert.equal(assertions.length, 1);
    assert.equal(assertions[0]?.generator, "model:model-v1");
    assert.equal(assertions[0]?.status, "active");

    const concurrentRepository = `${repository}-concurrent`;
    const concurrent = {
      ...common,
      repository: concurrentRepository,
      assertions: [{
        ...common.assertions[0]!,
        subject: { ...common.assertions[0]!.subject, naturalKey: `github:repo:${concurrentRepository}` },
        object: { ...common.assertions[0]!.object, naturalKey: `repo:${concurrentRepository}:path:README.md` }
      }]
    };
    await Promise.all([
      store.saveAssertionBatch({
        ...concurrent, taskId: `concurrent-a-${suffix}`, generatedAt: "2026-07-20T00:02:00Z",
        generatorVersion: "model-v1", evidenceFingerprint: "concurrent-a"
      }),
      store.saveAssertionBatch({
        ...concurrent, taskId: `concurrent-b-${suffix}`, generatedAt: "2026-07-20T00:02:01Z",
        generatorVersion: "model-v1", evidenceFingerprint: "concurrent-b"
      })
    ]);
    assert.equal((await store.listAssertions(tenantId, concurrentRepository)).length, 1,
      "the natural-key lock prevents duplicate live proposals from concurrent generators");
    assert.ok(await store.hasAssertionGeneration(
      tenantId, concurrentRepository, concurrent.commitSha, "model-v1", concurrent.registryVersion, "concurrent-a"
    ));
    assert.ok(await store.hasAssertionGeneration(
      tenantId, concurrentRepository, concurrent.commitSha, "model-v1", concurrent.registryVersion, "concurrent-b"
    ), "distinct evidence generations under one model contract remain independently cacheable");

    const ownershipRepository = `${repository}-ownership`;
    const ownershipBatch = {
      ...common,
      repository: ownershipRepository,
      taskId: `ownership-model-${suffix}`,
      generatedAt: "2026-07-20T00:03:00Z",
      generatorVersion: "ownership-model-v1",
      evidenceFingerprint: "ownership-race",
      assertions: [{
        subject: { kind: "Repository" as const, naturalKey: `github:repo:${ownershipRepository}`, label: ownershipRepository },
        predicate: "OWNED_BY",
        object: { kind: "Team" as const, naturalKey: "github:team:omlabs/platform", label: "@omlabs/platform" },
        confidence: 0.9,
        evidence: ["CODEOWNERS:1"],
        qualifiers: { pattern: "src/**" }
      }]
    };
    await Promise.all([
      store.saveAssertionBatch(ownershipBatch),
      store.applyGitHubObservations([{
        tenantId, repository: ownershipRepository, kind: "codeowners" as const,
        commitSha: ownershipBatch.commitSha, path: "CODEOWNERS",
        entries: [{ pattern: "src/**", owners: ["@omlabs/platform"] }],
        recordedAt: "2026-07-20T00:03:01Z"
      }])
    ]);
    const liveOwnership = (await store.listAssertions(tenantId, ownershipRepository, { predicate: "OWNED_BY" }))
      .filter((assertion) => assertion.status === "active" || assertion.status === "proposed");
    assert.equal(liveOwnership.length, 1, "source and model writers share the same natural-key serialization");

    const commandRepository = `${repository}-command`;
    const commandBatch = {
      ...common,
      repository: commandRepository,
      taskId: `command-model-${suffix}`,
      generatedAt: "2026-07-20T00:04:00Z",
      generatorVersion: "docs-model-v1",
      evidenceFingerprint: "command-race",
      assertions: [{
        ...common.assertions[0]!,
        subject: { kind: "Repository" as const, naturalKey: `github:repo:${commandRepository}`, label: commandRepository },
        object: { kind: "Document" as const, naturalKey: `repo:${commandRepository}:path:README.md`, label: "README" }
      }]
    };
    await Promise.all([
      store.saveAssertionBatch(commandBatch),
      store.executeCommand(tenantId, "svc:curator", {
        type: "assign_relationship", repository: commandRepository,
        subject: { kind: "Repository", key: `github:repo:${commandRepository}`, displayName: commandRepository },
        predicate: "DOCUMENTED_BY",
        object: { kind: "Document", key: `repo:${commandRepository}:path:README.md`, displayName: "README" }
      }, "2026-07-20T00:04:01Z")
    ]);
    const liveDocumentation = (await store.listAssertions(tenantId, commandRepository, { predicate: "DOCUMENTED_BY" }))
      .filter((assertion) => assertion.status === "active" || assertion.status === "proposed");
    assert.equal(liveDocumentation.length, 1, "command and model writers share the same natural-key serialization");
    assert.equal(liveDocumentation[0]?.status, "active");

    const cardinalityRepository = `${repository}-cardinality`;
    const assignOwner = (team: string, now: string) => store.executeCommand(tenantId, "svc:curator", {
      type: "assign_relationship" as const,
      repository: cardinalityRepository,
      subject: {
        kind: "Repository" as const,
        key: `github:repo:${cardinalityRepository}`,
        displayName: cardinalityRepository
      },
      predicate: "OWNED_BY",
      object: { kind: "Team" as const, key: `github:team:omlabs/${team}`, displayName: `@omlabs/${team}` },
      qualifiers: { pattern: "src/**" }
    }, now);
    await Promise.all([
      assignOwner("platform", "2026-07-20T00:05:00Z"),
      assignOwner("security", "2026-07-20T00:05:01Z")
    ]);
    const activeOwners = (await store.listAssertions(tenantId, cardinalityRepository, { predicate: "OWNED_BY" }))
      .filter((assertion) => assertion.status === "active");
    assert.equal(activeOwners.length, 1,
      "the cardinality-context lock serializes concurrent writes with different objects");

    const constraintPool = new Pool({ connectionString });
    try {
      const active = await constraintPool.query<{ id: string; object_id: string }>(
        `select id,object_id from jina_ontology.assertions
         where tenant_id=$1 and repository=$2 and predicate='OWNED_BY' and status='active'`,
        [tenantId, cardinalityRepository]
      );
      await assert.rejects(
        constraintPool.query(
          `insert into jina_ontology.assertions
            (id,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,
             predicate,object_id,object_kind,object_natural_key,object_label,status,confidence,evidence,
             asserted_by,generator_version,registry_version,recorded_at,qualifiers,qualifiers_hash,last_confirmed_at)
           select $1,tenant_id,repository,commit_sha,subject_id,subject_kind,subject_natural_key,subject_label,
                  predicate,object_id,object_kind,object_natural_key,object_label,status,confidence,evidence,
                  asserted_by,generator_version,registry_version,recorded_at,qualifiers,qualifiers_hash,last_confirmed_at
           from jina_ontology.assertions where tenant_id=$2 and id=$3`,
          [stableId("assertion", `${tenantId}:duplicate-active`), tenantId, active.rows[0]?.id]
        ),
        /ontology_assertions_one_(?:active|live_candidate)/
      );
      const foreignTenant = `${tenantId}-foreign`;
      const foreignEntityId = stableId("entity", `${foreignTenant}:Team:foreign`);
      await constraintPool.query(
        `insert into jina_ontology.entities (id,tenant_id,kind,natural_key,display_name)
         values ($1,$2,'Team','team:foreign','Foreign')`, [foreignEntityId, foreignTenant]
      );
      await assert.rejects(
        constraintPool.query(
          `insert into jina_ontology.identities
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
});

test("Postgres projects an accepted virtual issue by entity identity", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresOntologyGraphStore({ connectionString });
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
    const source = await store.applyGitHubObservations([42, 43].map((number) => ({
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
    })));
    assert.equal((await store.loadAssertionEvidence(tenantId, repository, source.observationIds)).length, 2);
    const issueKey = derivedIssueNaturalKey(repository, 42);
    await store.saveAssertionBatch({
      tenantId,
      repository,
      ref: "main",
      commitSha,
      taskId: `assert-${suffix}`,
      generatedAt: "2026-07-20T00:01:00.000Z",
      generatorVersion: ONTOLOGY_GENERATOR_VERSION,
      registryVersion: ONTOLOGY_REGISTRY_VERSION,
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
            id: "virtual:pr:42",
            kind: "Issue",
            label: "Administrators encounter an authorization error",
            description: "Administrator deletion is incorrectly denied.",
            evidence: ["src/auth.ts:1"]
          },
          {
            id: "virtual:pr:43",
            kind: "Issue",
            label: "Administrators encounter an authorization error",
            description: "Administrator audit export is incorrectly denied.",
            evidence: ["src/auth.ts:1"]
          }
        ],
        edges: [42, 43].map((number) => ({
          source: String(number), target: `virtual:pr:${number}`, predicate: "RESOLVES", plane: "knowledge" as const,
          confidence: 0.95, evidence: ["src/auth.ts:1"]
        }))
      },
      assertions: [{
        subject: { kind: "PullRequest", naturalKey: `github:pr:${repository}#42`, label: "PR #42" },
        predicate: "RESOLVES",
        object: { kind: "Issue", naturalKey: issueKey, label: "Administrators encounter an authorization error" },
        confidence: 0.95,
        evidence: ["src/auth.ts:1"]
      }, {
        subject: { kind: "PullRequest", naturalKey: `github:pr:${repository}#43`, label: "PR #43" },
        predicate: "RESOLVES",
        object: {
          kind: "Issue", naturalKey: derivedIssueNaturalKey(repository, 43),
          label: "Administrators encounter an authorization error"
        },
        confidence: 0.95,
        evidence: ["src/auth.ts:1"]
      }]
    });
    const proposals = await store.listAssertions(tenantId, repository, { status: "proposed", predicate: "RESOLVES" });
    assert.equal(proposals.length, 2);
    for (const [index, proposal] of proposals.entries()) {
      await store.executeCommand(tenantId, "svc:test", {
        type: "review_assertion", assertionId: proposal.id, decision: "accept"
      }, `2026-07-20T00:02:0${index}.000Z`);
    }
    await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:03:00.000Z");
    assert.equal((await store.retrieve({
      tenantId,
      allowedRepositories: [repository],
      repository,
      ref: "main",
      template: "issue_trace",
      issueText: "deletion is incorrectly denied"
    })).items.length, 0, "issue traces do not materialize outside ontology_project");
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
    assert.equal((await store.retrieve({
      tenantId,
      allowedRepositories: [repository],
      repository,
      ref: "main",
      template: "issue_trace",
      issueEntityId: payload.issue.entityId
    })).items.length, 1);
    await store.executeCommand(tenantId, "svc:test", {
      type: "assign_relationship",
      repository,
      subject: {
        kind: "Issue", key: derivedIssueNaturalKey(repository, 44), displayName: "Unresolved derived issue"
      },
      predicate: "LIKELY_AFFECTS",
      object: { kind: "File", key: `repo:${repository}:path:src/auth.ts`, displayName: "src/auth.ts" },
      reason: "exercise non-trace Issue projection completeness"
    }, "2026-07-20T00:04:00.000Z");
    await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:05:00.000Z");
    const confirmed = await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:06:00.000Z");
    assert.equal(confirmed.rebuilt, false, "active non-trace Issue assertions do not force perpetual rebuilds");
  } finally {
    await store.close();
  }
});

test("Postgres projects and retrieves a reviewed Feature", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresOntologyGraphStore({ connectionString });
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
      generatorVersion: ONTOLOGY_GENERATOR_VERSION,
      registryVersion: ONTOLOGY_REGISTRY_VERSION,
      evidenceFingerprint: `feature-evidence-${suffix}`,
      evidenceObservationIds: [],
      model: "fixture",
      summary: "Administrator deletion is a named product capability",
      rawOutput: {
        summary: "Administrator deletion is a named product capability",
        nodes: [
          { id: "repo", kind: "Repository", label: repository, description: "repo", evidence: ["README.md:1"] },
          {
            id: "feature:administrator-deletion", kind: "Feature", label: "Administrator deletion",
            description: "Administrators can delete resources.", evidence: ["README.md:2"]
          },
          {
            id: "auth-file", kind: "File", label: "src/auth.ts", description: "authorization",
            path: "src/auth.ts", evidence: ["src/auth.ts:1"]
          }
        ],
        edges: [{
          source: "auth-file", target: "feature:administrator-deletion", predicate: "IMPLEMENTS",
          plane: "knowledge", confidence: 0.96, evidence: ["src/auth.ts:1"]
        }]
      },
      assertions: [{
        subject: { kind: "File", naturalKey: `repo:${repository}:path:src/auth.ts`, label: "src/auth.ts" },
        predicate: "IMPLEMENTS",
        object: { kind: "Feature", naturalKey: featureKey, label: "Administrator deletion" },
        confidence: 0.96,
        evidence: ["src/auth.ts:1"]
      }]
    });
    const proposal = (await store.listAssertions(tenantId, repository, { status: "proposed", predicate: "IMPLEMENTS" }))[0];
    assert.ok(proposal);
    await store.executeCommand(tenantId, "svc:test", {
      type: "review_assertion", assertionId: proposal.id, decision: "accept"
    }, "2026-07-20T00:02:00.000Z");
    await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:02:30.000Z");
    const graph = await store.project({
      tenantId,
      repository,
      ref: "main",
      commitSha,
      taskId: `feature-project-${suffix}`,
      generatedAt: "2026-07-20T00:03:00.000Z"
    });
    assert.equal(graph.nodes.some((node) => node.kind === "Feature" && node.label === "Administrator deletion"), true);
    assert.equal(graph.edges.some((edge) => edge.predicate === "IMPLEMENTS"), true);

    const result = await store.retrieve({
      tenantId,
      allowedRepositories: [repository],
      repository,
      ref: "main",
      template: "feature_trace",
      featureText: "administrator deletion"
    });
    assert.equal(result.items[0]?.title, "src/auth.ts implements Administrator deletion");
    assert.equal(result.items[0]?.citations.some((citation) => citation.kind === "code" && citation.path === "src/auth.ts"), true);
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
      tenantId, repository, ref: "old", commitSha: oldCommitSha, treeSha: "8".repeat(40), parents: [],
      updateRef: true, recordedAt: "2026-07-20T00:04:00.000Z", taskId: `feature-old-ingest-${suffix}`,
      files: [{ path: "src/auth.ts", blobSha: "9".repeat(40), size: 40 }]
    });
    await store.rebuildDerivedProjections(tenantId, repository, "old", "2026-07-20T00:04:10.000Z");
    await store.project({
      tenantId, repository, ref: "old", commitSha: oldCommitSha, taskId: `feature-old-project-${suffix}`,
      generatedAt: "2026-07-20T00:04:20.000Z"
    });
    const oldResult = await store.retrieve({
      tenantId, allowedRepositories: [repository], repository, ref: "old", template: "feature_trace",
      featureText: "administrator deletion"
    });
    assert.equal(oldResult.items.length, 0, "feature retrieval does not leak assertions whose evidence is stale on the requested ref");
  } finally {
    await store.close();
  }
});

test("Postgres repository context runs intake, knowledge, outbox projections, ACLs, and cited retrieval end to end", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const store = new PostgresOntologyGraphStore({ connectionString });
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
  const projectCurrentGraph = (generatedAt: string) => store.project({
    tenantId,
    repository,
    ref: "main",
    commitSha: headSha,
    taskId: `project-${suffix}-${generatedAt}`,
    generatedAt
  });
  const parent = {
    tenantId, repository, ref: "main", commitSha: parentSha, treeSha: "3".repeat(40), parents: [],
    authorExternalId: "alice@example.com", authorGitHubLogin: "alice", authorName: "Alice",
    committedAt: "2026-07-18T00:00:00.000Z", message: "initial implementation", isDefaultRef: true,
    updateRef: false, recordedAt: "2026-07-20T00:00:00.000Z", taskId: `ingest-${suffix}`,
    files: [
      { path: "README.md", blobSha: readmeBlob, size: 20 },
      { path: "src/old.ts", blobSha: movedBlob, size: 20 },
      { path: "src/app.ts", blobSha: oldAppBlob, size: 30 },
      { path: "src/deleted.ts", blobSha: deletedBlob, size: 10 }
    ]
  } as const;
  const head = {
    ...parent, commitSha: headSha, treeSha: "4".repeat(40), parents: [parentSha],
    committedAt: "2026-07-19T00:00:00.000Z", message: "fixes #7 and updates app", updateRef: true,
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
      { blobSha: readmeBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "markdown", symbols: [], imports: [], edges: [] },
      { blobSha: movedBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "typescript", symbols: [], imports: [], edges: [] },
      { blobSha: oldAppBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "typescript", symbols: [], imports: [], edges: [] },
      { blobSha: deletedBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "typescript", symbols: [], imports: [], edges: [] }
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
        blobSha: newAppBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "typescript",
        symbols: [
          { moniker: "typescript:main#1", name: "main", kind: "function", signatureHash: "1".repeat(64), startLine: 1, endLine: 3 },
          { moniker: "typescript:helper#2", name: "helper", kind: "function", signatureHash: "2".repeat(64), startLine: 5, endLine: 5 }
        ],
        imports: [],
        edges: [{ fromMoniker: "main", kind: "calls", toMoniker: "helper", startLine: 2, endLine: 2 }]
      },
      { blobSha: addedBlob, parserVersion: ONTOLOGY_PARSER_VERSION, language: "typescript", symbols: [], imports: [], edges: [] }
    ]);

    const source = await store.applyGitHubObservations([
      {
        tenantId, repository, kind: "pull_request", number: 3, title: "Update app", body: "Fixes #7",
        state: "closed", url: `https://github.com/${repository}/pull/3`, authorLogin: "alice",
        occurredAt: "2026-07-19T00:00:00.000Z", recordedAt: "2026-07-20T00:02:00.000Z",
        mergedAt: "2026-07-19T00:00:00.000Z", mergeCommitSha: headSha,
        commitShas: [headSha], resolvesIssueNumbers: [7], referencesIssueNumbers: []
      },
      {
        tenantId, repository, kind: "issue", number: 7, title: "App is outdated",
        body: "The outdated access policy bypasses the application guard.", state: "closed",
        url: `https://github.com/${repository}/issues/7`, authorLogin: "alice",
        occurredAt: "2026-07-19T00:00:00.000Z", recordedAt: "2026-07-20T00:02:00.000Z"
      },
      {
        tenantId, repository, kind: "codeowners", commitSha: headSha, path: ".github/CODEOWNERS",
        entries: [{ pattern: "/src/**", owners: ["@omlabs/owners"] }],
        recordedAt: "2026-07-20T00:02:00.000Z"
      }
    ]);
    assert.equal(source.observationCount, 3);
    assert.equal(source.assertionCount >= 4, true);

    const batch = {
      tenantId, repository, ref: "main", commitSha: headSha, taskId: `assert-${suffix}`,
      generatedAt: "2026-07-20T00:03:00.000Z", generatorVersion: ONTOLOGY_GENERATOR_VERSION,
      registryVersion: ONTOLOGY_REGISTRY_VERSION, evidenceFingerprint: "evidence-causal-fixture",
      evidenceObservationIds: [],
      model: "fixture", summary: "README documents the repository and records a root cause",
      rawOutput: {
        summary: "README documents the repository and records a root cause",
        nodes: [
          { id: "repo", kind: "Repository" as const, label: repository, description: "repo", evidence: ["README.md:1"] },
          { id: "readme", kind: "Document" as const, label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] },
          { id: "7", kind: "Issue" as const, label: "Issue #7", description: "app regression", evidence: ["src/app.ts:1"] },
          { id: headSha, kind: "Commit" as const, label: headSha.slice(0, 12), description: "introduced the regression", evidence: ["src/app.ts:1"] }
        ],
        edges: [
          { source: "repo", target: "readme", predicate: "DOCUMENTED_BY", plane: "knowledge" as const, confidence: 0.99, evidence: ["README.md:1"] },
          { source: "7", target: headSha, predicate: "INTRODUCED_BY", plane: "knowledge" as const, confidence: 0.99, why: "The commit bypassed the app guard.", evidence: ["src/app.ts:1"] }
        ]
      },
      assertions: [
        {
          subject: { kind: "Repository" as const, naturalKey: `github:repo:${repository}`, label: repository }, predicate: "DOCUMENTED_BY",
          object: { kind: "Document" as const, naturalKey: `repo:${repository}:path:README.md`, label: "README" }, confidence: 0.99, evidence: ["README.md:1"]
        },
        {
          subject: { kind: "Issue" as const, naturalKey: `github:issue:${repository}#7`, label: "Issue #7" }, predicate: "INTRODUCED_BY",
          object: { kind: "Commit" as const, naturalKey: `repo:${repository}:sha:${headSha}`, label: headSha.slice(0, 12) },
          confidence: 0.99, evidence: ["src/app.ts:1"], qualifiers: { reason: "The commit bypassed the app guard." }
        }
      ]
    };
    const proposed = await store.saveAssertionBatch(batch);
    assert.equal(proposed.proposedCount, 2);
    const assertionId = stableId("assertion", `${tenantId}:${repository}:${headSha}:${ONTOLOGY_REGISTRY_VERSION}:evidence-causal-fixture:Repository:github:repo:${repository}:DOCUMENTED_BY:Document:repo:${repository}:path:README.md:{}`);
    const causalAssertionId = stableId("assertion", `${tenantId}:${repository}:${headSha}:${ONTOLOGY_REGISTRY_VERSION}:evidence-causal-fixture:Issue:github:issue:${repository}#7:INTRODUCED_BY:Commit:repo:${repository}:sha:${headSha}:{"reason":"The commit bypassed the app guard."}`);
    await store.executeCommand(tenantId, "svc:api", {
      type: "grant_repository_access", repository, principalId: "user:curator", role: "writer"
    }, "2026-07-20T00:03:30.000Z");
    await store.executeCommand(tenantId, "user:curator", {
      type: "review_assertion", assertionId, decision: "accept", reason: "verified against README"
    }, "2026-07-20T00:04:00.000Z");
    await store.executeCommand(tenantId, "user:curator", {
      type: "review_assertion", assertionId: causalAssertionId, decision: "accept", reason: "verified against root-cause evidence"
    }, "2026-07-20T00:04:10.000Z");
    await store.executeCommand(tenantId, "user:curator", {
      type: "assign_relationship", repository,
      subject: { kind: "File", key: `repo:${repository}:path:src/app.ts`, displayName: "src/app.ts" },
      predicate: "OWNED_BY", object: { kind: "Team", key: "team:platform", displayName: "Platform" },
      qualifiers: { pattern: "src/**" }, reason: "curated ownership"
    }, "2026-07-20T00:05:00.000Z");
    await store.executeCommand(tenantId, "svc:api", {
      type: "grant_repository_access", repository, principalId: "user:reader", role: "reader"
    }, "2026-07-20T00:05:30.000Z");
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
      `select id from jina_ontology.outbox
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
      `select count(*) from jina_ontology.outbox where id=any($1::text[]) and processed_at is not null`,
      [repositoryWideEvents.rows.map((row) => row.id)]
    );
    assert.equal(Number(prematurelyAcknowledged.rows[0]?.count ?? 0), 0,
      "a single-ref rebuild never acknowledges repository-wide events");
    const initialFanout = await store.drainDerivedProjectionEvents(tenantId, "2026-07-20T00:06:00.500Z");
    assert.equal(initialFanout.rebuiltRepositories.includes(repository), true);
    const projectedRefs = await fanoutPool.query<{ ref_name: string }>(
      `select distinct ref_name from jina_ontology.ref_manifest
       where tenant_id=$1 and repository=$2 order by ref_name`, [tenantId, repository]
    );
    assert.deepEqual(projectedRefs.rows.map((row) => row.ref_name), ["main", "release"]);
    await fanoutPool.end();
    await projectCurrentGraph("2026-07-20T00:06:01.000Z");
    const allowedRepositories = [repository];
    const structure = await store.retrieve({ tenantId, allowedRepositories, repository, ref: "main", template: "structure", symbol: "main" });
    assert.equal(structure.items.some((item) => item.kind === "calls" && item.citations[0]?.path === "src/app.ts"), true);
    const change = await store.retrieve({ tenantId, allowedRepositories, repository, template: "change", pullRequestNumber: 3 });
    assert.equal(change.items.some((item) => item.title === "modify src/app.ts"), true);
    const intent = await store.retrieve({ tenantId, allowedRepositories, repository, template: "intent", path: "src/app.ts", query: "fixes app" });
    assert.equal(intent.items.some((item) => item.citations[0]?.kind === "commit_change"), true);
    assert.equal(intent.items.some((item) => item.kind === "work_intent" && item.title.includes("Issue #7")), true);
    const issueTrace = await store.retrieve({ tenantId, allowedRepositories, repository, ref: "main", template: "issue_trace", issueNumber: 7 });
    assert.equal(issueTrace.items.length, 1);
    const trace = issueTrace.items[0]?.data as {
      resolutions?: readonly { pullRequestNumber: number; commits: readonly { sha: string; role: string; changes: readonly { path: string }[] }[] }[];
    };
    assert.equal(trace.resolutions?.[0]?.pullRequestNumber, 3);
    assert.equal(trace.resolutions?.[0]?.commits[0]?.sha, headSha);
    assert.equal(trace.resolutions?.[0]?.commits[0]?.role, "merge");
    assert.equal(trace.resolutions?.[0]?.commits[0]?.changes.some((change) => change.path === "src/app.ts"), true);
    const causal = issueTrace.items[0]?.data as {
      introducedBy?: readonly { sha: string; why?: string; evidence?: readonly string[]; evidenceCommitSha?: string; pullRequests?: readonly { number: number }[] }[];
    };
    assert.equal(causal.introducedBy?.[0]?.sha, headSha);
    assert.match(causal.introducedBy?.[0]?.why ?? "", /bypassed the app guard/);
    assert.deepEqual(causal.introducedBy?.[0]?.evidence, ["src/app.ts:1"]);
    assert.equal(causal.introducedBy?.[0]?.evidenceCommitSha, headSha);
    assert.equal(causal.introducedBy?.[0]?.pullRequests?.some((pullRequest) => pullRequest.number === 3), true);
    const titleTrace = await store.retrieve({
      tenantId, allowedRepositories, repository, ref: "main", template: "issue_trace",
      issueText: "App is outdated", query: 'What caused "App is outdated"?'
    });
    assert.equal((titleTrace.items[0]?.data as { issue?: { number: number } }).issue?.number, 7);
    const bodyTrace = await store.retrieve({
      tenantId, allowedRepositories, repository, ref: "main", template: "issue_trace",
      issueText: "bypasses the application guard", query: 'What caused "bypasses the application guard"?'
    });
    assert.equal((bodyTrace.items[0]?.data as { issue?: { number: number } }).issue?.number, 7);
    const reverseCommitTrace = await store.retrieve({
      tenantId, allowedRepositories, repository, ref: "main", template: "issue_trace",
      commitSha: headSha, query: `Which issue did commit ${headSha} cause, and why?`
    });
    assert.equal((reverseCommitTrace.items[0]?.data as { issue?: { number: number } }).issue?.number, 7);
    const reversePullRequestTrace = await store.retrieve({
      tenantId, allowedRepositories, repository, ref: "main", template: "issue_trace",
      pullRequestNumber: 3, query: "Which issue did PR #3 cause, and why?"
    });
    assert.equal((reversePullRequestTrace.items[0]?.data as { issue?: { number: number } }).issue?.number, 7);
    const releaseTrace = await store.retrieve({
      tenantId, allowedRepositories, repository, ref: "release", template: "issue_trace", issueNumber: 7
    });
    assert.equal((releaseTrace.items[0]?.data as { introducedBy?: readonly unknown[] }).introducedBy?.length, 1,
      "refs at the same commit reuse the same immutable graph generation");
    const ownership = await store.retrieve({ tenantId, allowedRepositories, repository, template: "ownership", path: "src/app.ts" });
    assert.equal(ownership.items.some((item) => item.title.includes("Platform")), true);
    assert.equal(ownership.items.some((item) => item.title.includes("@omlabs/owners") && item.data.authority === "codeowners"), true);
    await assert.rejects(
      store.retrieve({ tenantId, allowedRepositories: [], repository, template: "structure" }),
      /access denied/
    );
    const metrics = await store.operationalMetrics(tenantId, "2026-07-20T00:07:00.000Z");
    assert.equal(metrics.unparsedBlobCount, 0);
    assert.equal(metrics.acceptanceRates.some((item) => item.predicate === "DOCUMENTED_BY" && item.accepted === 1), true);

    const legacyLabelPool = new Pool({ connectionString });
    try {
      await legacyLabelPool.query(
        `update jina_ontology.entities set display_name='Model paraphrase'
         where tenant_id=$1 and kind='Issue' and natural_key=$2`,
        [tenantId, `github:issue:${repository}#7`]
      );
    } finally {
      await legacyLabelPool.end();
    }
    const graph = await store.project({
      tenantId, repository, ref: "main", commitSha: headSha, taskId: `project-${suffix}`, generatedAt: "2026-07-20T00:08:00.000Z"
    });
    assert.equal(graph.nodes.some((node) => node.kind === "Issue" && node.label === "#7 App is outdated"), true,
      "projection restores the latest source title after upgrading a model-overwritten entity");
    assert.equal(graph.edges.some((edge) => edge.predicate === "CALLS"), true);
    assert.equal(graph.edges.some((edge) => edge.predicate === "DOCUMENTED_BY"), true);
    assert.equal(graph.edges.some((edge) => edge.predicate === "INTRODUCED_BY" && edge.evidence.includes("src/app.ts:1") && edge.why === "The commit bypassed the app guard."), true);
    assert.equal((await store.get(graph.id, tenantId))?.edges.some((edge) =>
      edge.predicate === "INTRODUCED_BY" && edge.why === "The commit bypassed the app guard."
    ), true, "the persisted graph retains the causal reason");
    const sourceOwnership = graph.edges.find((edge) => edge.predicate === "OWNED_BY");
    assert.equal(sourceOwnership?.evidence[0]?.startsWith("observation:"), true);
    assert.equal([...graph.nodes, ...graph.edges].every((item) => item.evidence.length > 0), true);

    const otherRepository = `${repository}-other`;
    await store.planIngestion({
      tenantId, repository: otherRepository, ref: "main", commitSha: "9".repeat(40), treeSha: "8".repeat(40),
      parents: [], committedAt: "2026-07-20T00:08:30.000Z", isDefaultRef: true, updateRef: true,
      recordedAt: "2026-07-20T00:08:30.000Z", taskId: `other-${suffix}`,
      files: [{ path: "README.md", blobSha: readmeBlob, size: 20 }]
    });
    await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:08:40.000Z");
    const beforeDrain = await store.operationalMetrics(tenantId, "2026-07-20T00:08:45.000Z");
    assert.equal(Object.values(beforeDrain.outboxDepth).reduce((sum, count) => sum + count, 0) > 0, true);
    const drained = await store.drainDerivedProjectionEvents(tenantId, "2026-07-20T00:08:50.000Z");
    assert.equal(drained.processedEventCount > 0, true);
    assert.equal(drained.rebuiltRepositories.includes(otherRepository), true);
    await store.applyGitHubObservations([{
      tenantId, repository, kind: "codeowners", commitSha: headSha, path: ".github/CODEOWNERS",
      entries: [{ pattern: "/src/**", owners: ["@omlabs/owners"] }],
      recordedAt: "2026-07-20T00:02:00.000Z"
    }]);
    const afterSourceReplay = await store.operationalMetrics(tenantId, "2026-07-20T00:08:52.000Z");
    assert.equal(Object.values(afterSourceReplay.outboxDepth).reduce((sum, count) => sum + count, 0), 0);
    const noOpProjection = await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:08:55.000Z");
    assert.equal(noOpProjection.rebuilt, false);
    assert.equal(noOpProjection.processedEventCount, 0);
    const otherStructure = await store.retrieve({
      tenantId, allowedRepositories: [otherRepository], repository: otherRepository, ref: "main", template: "structure"
    });
    assert.equal(otherStructure.repository, otherRepository);

    const updatedPullRequest = (occurredAt: string, resolvesIssueNumbers: readonly number[]) => ({
      tenantId, repository, kind: "pull_request" as const, number: 3, title: "Update app",
      body: resolvesIssueNumbers.length ? "Fixes #7" : "No longer closes the issue",
      state: "closed", url: `https://github.com/${repository}/pull/3`, authorLogin: "alice",
      occurredAt, recordedAt: occurredAt, mergedAt: "2026-07-19T00:00:00.000Z", mergeCommitSha: headSha,
      commitShas: [headSha], resolvesIssueNumbers, referencesIssueNumbers: []
    });
    await store.applyGitHubObservations([updatedPullRequest("2026-07-20T00:09:00.000Z", [])]);
    await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:05.000Z");
    await projectCurrentGraph("2026-07-20T00:09:06.000Z");
    const removedTrace = await store.retrieve({
      tenantId, allowedRepositories, repository, ref: "main", template: "issue_trace", issueNumber: 7
    });
    assert.equal((removedTrace.items[0]?.data as { resolutions?: readonly unknown[] }).resolutions?.length, 0,
      "a newer GitHub snapshot retracts source relationships it no longer contains");
    const removedReleaseTrace = await store.retrieve({
      tenantId, allowedRepositories, repository, ref: "release", template: "issue_trace", issueNumber: 7
    });
    assert.equal((removedReleaseTrace.items[0]?.data as { resolutions?: readonly unknown[] }).resolutions?.length, 0,
      "secondary refs at the same commit use the updated graph generation");

    const restoredAt = "2026-07-20T00:09:10.000Z";
    await store.applyGitHubObservations([updatedPullRequest(restoredAt, [7])]);
    await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:15.000Z");
    await projectCurrentGraph("2026-07-20T00:09:16.000Z");
    const restoredTrace = await store.retrieve({
      tenantId, allowedRepositories, repository, ref: "main", template: "issue_trace", issueNumber: 7
    });
    assert.equal((restoredTrace.items[0]?.data as { resolutions?: readonly unknown[] }).resolutions?.length, 1);

    await store.applyGitHubObservations([{
      ...updatedPullRequest("2026-07-20T00:09:05.000Z", []),
      recordedAt: "2026-07-20T00:09:16.000Z"
    }]);
    await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:17.000Z");
    await projectCurrentGraph("2026-07-20T00:09:18.000Z");
    const afterDelayedSnapshot = await store.retrieve({
      tenantId, allowedRepositories, repository, ref: "main", template: "issue_trace", issueNumber: 7
    });
    assert.equal((afterDelayedSnapshot.items[0]?.data as { resolutions?: readonly unknown[] }).resolutions?.length, 1,
      "a delayed older GitHub snapshot cannot retract or replace newer source facts");

    const githubObservationId = stableId("observation", `${tenantId}:github:${repository}:pull_request:3:${restoredAt}`);
    const redaction = await store.executeCommand(tenantId, "user:privacy", {
      type: "redact_observation", observationId: githubObservationId, reason: "fixture redaction", commitShas: [headSha]
    }, "2026-07-20T00:09:20.000Z", true);
    assert.equal(redaction.affectedIds.includes(githubObservationId), true);
    await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:25.000Z");
    await projectCurrentGraph("2026-07-20T00:09:26.000Z");
    const redactedTrace = await store.retrieve({
      tenantId, allowedRepositories, repository, ref: "main", template: "issue_trace", issueNumber: 7
    });
    const redactedTraceData = redactedTrace.items[0]?.data as { resolutions?: readonly unknown[] };
    assert.equal(redactedTraceData.resolutions?.length, 0, "redacted source assertions leave no stale resolution projection");

    await store.applyGitHubObservations([updatedPullRequest("2026-07-20T00:09:30.000Z", [7])]);
    await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:35.000Z");
    await projectCurrentGraph("2026-07-20T00:09:36.000Z");
    const engineerId = stableId("entity", `${tenantId}:Engineer:github:user:alice`);
    const erased = await store.executeCommand(tenantId, "user:privacy", {
      type: "erase_person", entityId: engineerId, reason: "fixture erasure"
    }, "2026-07-20T00:09:40.000Z", true);
    assert.equal(erased.affectedIds.includes(engineerId), true);
    await store.rebuildDerivedProjections(tenantId, repository, "main", "2026-07-20T00:09:45.000Z");
    await projectCurrentGraph("2026-07-20T00:09:46.000Z");
    const erasedTrace = await store.retrieve({
      tenantId, allowedRepositories, repository, ref: "main", template: "issue_trace", issueNumber: 7
    });
    assert.equal((erasedTrace.items[0]?.data as { resolutions?: readonly unknown[] }).resolutions?.length, 0,
      "person erasure retracts assertions sourced from every destroyed personal observation");
  } finally {
    await store.close();
  }
});
