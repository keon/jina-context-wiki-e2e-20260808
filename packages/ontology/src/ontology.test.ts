import assert from "node:assert/strict";
import { test } from "node:test";
import { createOntologyGraph, parseGeneratedOntology, validateOntologyEvidence } from "./model.js";
import { MemoryOntologyGraphStore } from "./store.js";
import {
  ONTOLOGY_GENERATOR_VERSION,
  ONTOLOGY_PARSER_VERSION,
  ONTOLOGY_REGISTRY_VERSION,
  assertionsFromGeneratedOntology
} from "./pipeline.js";
import { analyzeSourceBlob } from "./parser.js";

test("pure structural parsing produces versioned symbols and imports", () => {
  const analysis = analyzeSourceBlob("a".repeat(40), "typescript", 'import { helper } from "./helper";\nexport function main() {}\n');
  assert.equal(analysis.parserVersion, ONTOLOGY_PARSER_VERSION);
  assert.deepEqual(analysis.imports, [{ specifier: "./helper", line: 1 }]);
  assert.equal(analysis.symbols[0]?.name, "main");
});

test("normalizes model output into distinct semantic entity identities", () => {
  const assertions = assertionsFromGeneratedOntology({
    summary: "symbols implement separate documents",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "symbol:src/app.ts:first", kind: "Symbol", label: "first", description: "first symbol", path: "src/app.ts", evidence: ["src/app.ts:1"] },
      { id: "symbol:src/app.ts:second", kind: "Symbol", label: "second", description: "second symbol", path: "src/app.ts", evidence: ["src/app.ts:2"] },
      { id: "doc:first", kind: "Document", label: "first docs", description: "docs", path: "README.md", evidence: ["README.md:2"] }
    ],
    edges: [
      { source: "symbol:src/app.ts:first", target: "doc:first", predicate: "IMPLEMENTS", plane: "knowledge", confidence: 0.91, evidence: ["src/app.ts:1"] },
      { source: "symbol:src/app.ts:second", target: "doc:first", predicate: "IMPLEMENTS", plane: "knowledge", confidence: 0.92, evidence: ["src/app.ts:2"] }
    ]
  }, "omxyz/demo");
  assert.deepEqual(assertions.map((assertion) => assertion.subject.naturalKey), [
    "symbol:src/app.ts:first",
    "symbol:src/app.ts:second"
  ]);
});

test("creates a stable graph and removes dangling edges", () => {
  const generated = parseGeneratedOntology({
    summary: "A small service",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "file:src/app.ts", kind: "File", label: "app.ts", description: "entry", path: "src/app.ts", evidence: ["src/app.ts:1"] }
    ],
    edges: [
      { source: "repo", target: "file:src/app.ts", predicate: "contains", plane: "code", evidence: ["src/app.ts:1"] },
      { source: "missing", target: "repo", predicate: "references", plane: "knowledge", evidence: ["README.md:1"] }
    ]
  });
  const graph = createOntologyGraph({
    request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId: "task" },
    commitSha: "abc",
    generatedAt: "2026-01-01T00:00:00.000Z",
    executor: "fixture",
    model: "fixture",
    generated
  });
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]?.predicate, "CONTAINS");
  assert.match(graph.id, /^graph_/);
});

test("keeps graph generations immutable per task", () => {
  const generated = parseGeneratedOntology({
    summary: "repo",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "readme", kind: "File", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] }
    ],
    edges: [{ source: "repo", target: "readme", predicate: "contains", plane: "code", evidence: ["README.md:1"] }]
  });
  const build = (taskId: string) => createOntologyGraph({
    request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId },
    commitSha: "abc",
    generatedAt: "2026-01-01T00:00:00.000Z",
    executor: "fixture" as const,
    model: "fixture",
    generated
  });
  assert.notEqual(build("task-1").id, build("task-2").id);
});

test("does not overwrite an existing graph generation", async () => {
  const generated = parseGeneratedOntology({
    summary: "first",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "readme", kind: "File", label: "README", description: "docs", evidence: ["README.md:1"] }
    ],
    edges: [{ source: "repo", target: "readme", predicate: "contains", plane: "code", evidence: ["README.md:1"] }]
  });
  const graph = createOntologyGraph({
    request: { tenantId: "tenant", repository: "omxyz/demo", ref: "main", taskId: "task" },
    commitSha: "abc",
    generatedAt: "2026-01-01T00:00:00.000Z",
    executor: "fixture",
    model: "fixture",
    generated
  });
  const store = new MemoryOntologyGraphStore();
  await store.save(graph);
  await store.save({ ...graph, summary: "replacement" });
  assert.equal((await store.get(graph.id, "tenant"))?.summary, "first");
});

test("validates citations against repository files", async () => {
  const generated = parseGeneratedOntology({
    summary: "repo",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:2"] },
      { id: "readme", kind: "File", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1-2"] }
    ],
    edges: [{ source: "repo", target: "readme", predicate: "contains", plane: "code", evidence: ["README.md:1"] }]
  });
  await validateOntologyEvidence(generated, async () => "line one\nline two");
  await assert.rejects(
    validateOntologyEvidence(generated, async () => "one line"),
    /outside README\.md/
  );
  assert.throws(
    () => parseGeneratedOntology({
      summary: "bad",
      nodes: [{ id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: [] }],
      edges: []
    }),
    /must include evidence/
  );
});

test("reuses parsed blobs and projects canonical code facts plus active assertions", async () => {
  const store = new MemoryOntologyGraphStore();
  const snapshot = {
    tenantId: "tenant",
    repository: "omxyz/demo",
    ref: "main",
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    parents: [],
    recordedAt: "2026-07-19T00:00:00.000Z",
    taskId: "ingest-task",
    files: [
      { path: "README.md", blobSha: "c".repeat(40), size: 10 },
      { path: "src/index.ts", blobSha: "d".repeat(40), size: 20 }
    ]
  };
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
  const replay = await store.planIngestion({ ...snapshot, taskId: "retry-task" });
  assert.equal(replay.missingBlobs.length, 0);
  assert.equal(replay.reusedBlobCount, 2);

  const assertions = await store.saveAssertionBatch({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: snapshot.commitSha,
    taskId: "assert-task",
    generatedAt: "2026-07-19T00:01:00.000Z",
    generatorVersion: ONTOLOGY_GENERATOR_VERSION,
    registryVersion: ONTOLOGY_REGISTRY_VERSION,
    model: "fixture",
    summary: "README documents the repository",
    rawOutput: {
      summary: "README documents the repository",
      nodes: [
        { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
        { id: "readme", kind: "Document", label: "README", description: "docs", path: "README.md", evidence: ["README.md:1"] }
      ],
      edges: [{ source: "repo", target: "readme", predicate: "DOCUMENTED_BY", plane: "knowledge", confidence: 0.95, evidence: ["README.md:1"] }]
    },
    assertions: [{
      subject: { kind: "Repository", naturalKey: snapshot.repository, label: "demo" },
      predicate: "DOCUMENTED_BY",
      object: { kind: "Document", naturalKey: "README.md", label: "README" },
      confidence: 0.95,
      evidence: ["README.md:1"]
    }]
  });
  assert.equal(assertions.activeCount, 1);
  assert.equal((await store.hasAssertionGeneration(snapshot.tenantId, snapshot.repository, snapshot.commitSha, ONTOLOGY_GENERATOR_VERSION))?.cached, true);

  const graph = await store.project({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: snapshot.commitSha,
    taskId: "project-task",
    generatedAt: "2026-07-19T00:02:00.000Z"
  });
  assert.equal(graph.generator.executor, "projection");
  assert.equal(graph.nodes.some((node) => node.kind === "Symbol" && node.label === "main"), true);
  assert.equal(graph.edges.some((edge) => edge.plane === "knowledge" && edge.predicate === "DOCUMENTED_BY"), true);
  assert.equal(graph.edges.find((edge) => edge.predicate === "DOCUMENTED_BY")?.confidence, 0.95);

  const nextSnapshot = {
    ...snapshot,
    commitSha: "e".repeat(40),
    treeSha: "f".repeat(40),
    parents: [snapshot.commitSha],
    taskId: "next-ingest",
    files: [
      snapshot.files[0]!,
      { path: "src/index.ts", blobSha: "1".repeat(40), size: 21 }
    ]
  };
  const nextPlan = await store.planIngestion(nextSnapshot);
  assert.deepEqual(nextPlan.missingBlobs.map((blob) => blob.path), ["src/index.ts"]);
  assert.deepEqual(nextPlan.changedPaths, ["src/index.ts"]);
  await store.applyBlobAnalyses(nextSnapshot, [{
    blobSha: "1".repeat(40),
    parserVersion: ONTOLOGY_PARSER_VERSION,
    language: "typescript",
    symbols: [{ moniker: "main", name: "main", kind: "function", startLine: 1, endLine: 1 }],
    imports: []
  }]);
  const carried = await store.project({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: nextSnapshot.commitSha,
    taskId: "next-project",
    generatedAt: "2026-07-19T00:03:00.000Z"
  });
  assert.equal(carried.edges.some((edge) => edge.predicate === "DOCUMENTED_BY"), true, "unchanged cited blobs carry assertions forward");

  const changedReadme = {
    ...nextSnapshot,
    commitSha: "2".repeat(40),
    treeSha: "3".repeat(40),
    parents: [nextSnapshot.commitSha],
    taskId: "readme-ingest",
    files: [
      { path: "README.md", blobSha: "4".repeat(40), size: 11 },
      nextSnapshot.files[1]!
    ]
  };
  await store.planIngestion(changedReadme);
  const withoutStaleAssertion = await store.project({
    tenantId: snapshot.tenantId,
    repository: snapshot.repository,
    ref: snapshot.ref,
    commitSha: changedReadme.commitSha,
    taskId: "readme-project",
    generatedAt: "2026-07-19T00:04:00.000Z"
  });
  assert.equal(withoutStaleAssertion.edges.some((edge) => edge.predicate === "DOCUMENTED_BY"), false, "changed cited blobs invalidate old assertions");
});
