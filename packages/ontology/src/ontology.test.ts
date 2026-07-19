import assert from "node:assert/strict";
import { test } from "node:test";
import { createOntologyGraph, parseGeneratedOntology, validateOntologyEvidence } from "./model.js";
import { MemoryOntologyGraphStore } from "./store.js";

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
