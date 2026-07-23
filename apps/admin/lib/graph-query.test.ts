import assert from "node:assert/strict";
import { test } from "node:test";
import { graphCitationLabel, graphQueryMatches, parseGraphQuestion } from "./graph-query.ts";

test("parseGraphQuestion trims and bounds input", () => {
  assert.equal(parseGraphQuestion("  Where is auth implemented?  "), "Where is auth implemented?");
  assert.throws(() => parseGraphQuestion("   "), /required/);
  assert.throws(() => parseGraphQuestion("x".repeat(4_001)), /at most 4000/);
});

test("graphQueryMatches maps cited paths and relationships back to the graph", () => {
  const graph = {
    nodes: [
      { id: "repo", kind: "Repository", label: "repo", evidence: [] },
      { id: "file", kind: "File", label: "auth.ts", path: "src/auth.ts", evidence: ["src/auth.ts:1-30"] }
    ],
    edges: [
      {
        id: "contains",
        source: "repo",
        target: "file",
        predicate: "CONTAINS",
        evidence: ["src/auth.ts:1-30"]
      }
    ]
  };
  const matches = graphQueryMatches(
    {
      answer: "Authentication lives in auth.ts.",
      citedClaims: [{ text: "Auth file", citations: [{ path: "src/auth.ts", startLine: 4 }] }]
    },
    graph
  );
  assert.deepEqual(matches, [
    { kind: "node", id: "repo" },
    { kind: "node", id: "file" },
    { kind: "edge", id: "contains" }
  ]);
});

test("graphCitationLabel prefers precise source locations", () => {
  assert.equal(graphCitationLabel({ path: "src/auth.ts", startLine: 4, endLine: 8 }), "src/auth.ts:4-8");
  assert.equal(graphCitationLabel({ id: "entity:auth" }), "entity:auth");
});
