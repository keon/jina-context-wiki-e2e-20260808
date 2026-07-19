import assert from "node:assert/strict";
import { test } from "node:test";
import { createOntologyGraph, parseGeneratedOntology } from "./model.js";

test("creates a stable graph and removes dangling edges", () => {
  const generated = parseGeneratedOntology({
    summary: "A small service",
    nodes: [
      { id: "repo", kind: "Repository", label: "demo", description: "repo", evidence: ["README.md:1"] },
      { id: "file:src/app.ts", kind: "File", label: "app.ts", description: "entry", path: "src/app.ts", evidence: ["src/app.ts:1"] }
    ],
    edges: [
      { source: "repo", target: "file:src/app.ts", predicate: "contains", plane: "code", evidence: ["src/app.ts:1"] },
      { source: "missing", target: "repo", predicate: "references", plane: "knowledge", evidence: [] }
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
