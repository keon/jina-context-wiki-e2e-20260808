import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ONTOLOGY_GENERATOR_VERSION,
  ONTOLOGY_PARSER_VERSION,
  ONTOLOGY_REGISTRY_VERSION,
  createOntologyGraph
} from "@jina/ontology";
import { PostgresJsonStateStore } from "./postgres-json-state-store.js";
import { PostgresOntologyGraphStore } from "./postgres-ontology-graph-store.js";

const connectionString = process.env.TEST_DATABASE_URL;

test("Postgres atomically stores board completion and an immutable graph", {
  skip: connectionString ? false : "TEST_DATABASE_URL is not configured"
}, async () => {
  assert.ok(connectionString);
  const stateStore = new PostgresJsonStateStore<{ readonly boardStatus: string }>({ connectionString });
  const graphStore = new PostgresOntologyGraphStore({ connectionString });
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
    await stateStore.close();
    await graphStore.close();
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
      { blobSha: "c".repeat(40), parserVersion: ONTOLOGY_PARSER_VERSION, language: "markdown", symbols: [], imports: [] },
      {
        blobSha: "d".repeat(40),
        parserVersion: ONTOLOGY_PARSER_VERSION,
        language: "typescript",
        symbols: [{ moniker: "main", name: "main", kind: "function", startLine: 1, endLine: 1 }],
        imports: []
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
        subject: { kind: "Repository", naturalKey: snapshot.repository, label: "fixture" },
        predicate: "DOCUMENTED_BY",
        object: { kind: "Document", naturalKey: "README.md", label: "README" },
        confidence: 0.95,
        evidence: ["README.md:1"]
      }]
    });
    assert.equal(asserted.activeCount, 1);
    assert.equal((await store.hasAssertionGeneration(snapshot.tenantId, snapshot.repository, snapshot.commitSha, ONTOLOGY_GENERATOR_VERSION))?.cached, true);
    const graph = await store.project({
      tenantId: snapshot.tenantId,
      repository: snapshot.repository,
      ref: snapshot.ref,
      commitSha: snapshot.commitSha,
      taskId: `project-${suffix}`,
      generatedAt: "2026-07-19T12:02:00.000Z"
    });
    assert.equal(graph.generator.executor, "projection");
    assert.equal(graph.edges.some((edge) => edge.predicate === "DOCUMENTED_BY"), true);
    assert.equal(graph.edges.find((edge) => edge.predicate === "DOCUMENTED_BY")?.confidence, 0.95);
    assert.equal(graph.nodes.some((node) => node.kind === "Symbol"), true);
  } finally {
    await store.close();
  }
});
