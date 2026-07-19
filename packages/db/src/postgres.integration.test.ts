import assert from "node:assert/strict";
import { test } from "node:test";
import { createOntologyGraph } from "@jina/ontology";
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
