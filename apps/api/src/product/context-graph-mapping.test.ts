import assert from "node:assert/strict";
import { test } from "node:test";

import {
  codePlaneFromRelations,
  contextGraphDetail,
  contextQueryResult,
  formatAnchor,
  knowledgePlaneFromDocuments,
  type ContextKnowledgeCitation,
  type ContextStructuralRelation
} from "./context-graph-mapping.js";

const relations: ContextStructuralRelation[] = [
  {
    id: "sr_defines",
    kind: "defines",
    from: "src/server.ts",
    to: "src/server.ts#createApiServer",
    anchors: [{ sourceType: "blob", sourceId: "b1", pathOrUrl: "src/server.ts", commitSha: "a".repeat(40), startLine: 10, endLine: 20 }],
    metadata: { symbol: { name: "createApiServer", kind: "function" } }
  },
  {
    id: "sr_imports",
    kind: "imports",
    from: "src/server.ts",
    to: "node:crypto",
    anchors: [{ sourceType: "blob", sourceId: "b2", pathOrUrl: "src/server.ts" }],
    metadata: { importedNames: ["createHash", "randomUUID"] }
  }
];

test("the code plane synthesizes file, symbol, and module nodes from an edge list", () => {
  const { nodes, edges } = codePlaneFromRelations(relations);

  assert.deepEqual(
    nodes.map((node) => [node.id, node.kind, node.label, node.path]),
    [
      ["src/server.ts", "File", "server.ts", "src/server.ts"],
      ["src/server.ts#createApiServer", "Symbol:function", "createApiServer", "src/server.ts"],
      ["node:crypto", "Module", "node:crypto", undefined]
    ]
  );
  // Every structural relation becomes a code-plane edge carrying its own kind.
  assert.deepEqual(
    edges.map((edge) => [edge.id, edge.source, edge.target, edge.predicate, edge.plane]),
    [
      ["sr_defines", "src/server.ts", "src/server.ts#createApiServer", "defines", "code"],
      ["sr_imports", "src/server.ts", "node:crypto", "imports", "code"]
    ]
  );
  assert.equal(edges[1]?.qualifiers?.importedNames, "createHash, randomUUID");
  // The file appears once even though two relations reference it, and it keeps
  // evidence from both.
  assert.equal(nodes[0]?.evidence.length, 2);
});

test("the knowledge plane links documents only to files the code plane contains", () => {
  const citations = new Map<string, ContextKnowledgeCitation[]>([
    [
      "kr_1",
      [
        { revisionId: "kr_1", ordinal: 1, claim: "The server is created here", anchor: { sourceType: "blob", sourceId: "b1", pathOrUrl: "src/server.ts" } },
        { revisionId: "kr_1", ordinal: 2, claim: "Unrelated file", anchor: { sourceType: "blob", sourceId: "b9", pathOrUrl: "src/absent.ts" } }
      ]
    ]
  ]);

  const { nodes, edges } = knowledgePlaneFromDocuments(
    [
      {
        id: "kr_1",
        logicalId: "repository:acme/app:architecture",
        kind: "architecture",
        title: "Architecture",
        summary: "How the API is assembled",
        confidence: 0.82,
        reviewStatus: "reviewed",
        commitSha: "a".repeat(40)
      }
    ],
    citations,
    new Set(["src/server.ts"])
  );

  assert.deepEqual(
    nodes.map((node) => [node.id, node.kind, node.label]),
    [["kr_1", "architecture", "Architecture"]]
  );
  // src/absent.ts is cited but absent from the code plane, so it is not linked.
  assert.equal(edges.length, 1);
  assert.deepEqual(
    [edges[0]?.source, edges[0]?.target, edges[0]?.predicate, edges[0]?.plane, edges[0]?.confidence, edges[0]?.why],
    ["kr_1", "src/server.ts", "cites", "knowledge", 0.82, "The server is created here"]
  );
});

test("a generation assembles both planes into one detail with counted nodes and edges", () => {
  const detail = contextGraphDetail({
    generation: {
      id: "ig_1",
      repository: "acme/app",
      ref: "main",
      commitSha: "b".repeat(40),
      status: "published",
      derivedKnowledge: "available",
      createdAt: "2026-01-01T00:00:00.000Z",
      publishedAt: "2026-01-02T00:00:00.000Z"
    },
    relations,
    documents: [
      {
        id: "kr_1",
        logicalId: "repository:acme/app:architecture",
        kind: "architecture",
        title: "Architecture",
        summary: "How the API is assembled",
        confidence: 0.5,
        reviewStatus: "generated",
        commitSha: "b".repeat(40)
      }
    ],
    citationsByRevision: new Map([
      ["kr_1", [{ revisionId: "kr_1", ordinal: 1, claim: "c", anchor: { sourceType: "blob", sourceId: "b1", pathOrUrl: "src/server.ts" } }]]
    ])
  });

  assert.equal(detail.id, "ig_1");
  assert.equal(detail.versionLabel, "main@bbbbbbb");
  assert.equal(detail.sourceCommit, "b".repeat(40));
  // publishedAt wins over createdAt when the generation is published.
  assert.equal(detail.generatedAt, "2026-01-02T00:00:00.000Z");
  assert.equal(detail.nodeCount, 4);
  assert.equal(detail.edgeCount, 3);
  assert.deepEqual(
    [...new Set(detail.edges.map((edge) => edge.plane))],
    ["code", "knowledge"]
  );
});

test("a context query maps onto claims, highlights, and coverage notes", () => {
  const result = contextQueryResult("acme/app", {
    answer: "The API server is created in src/server.ts.",
    generation: { id: "ig_9", ref: "main", commitSha: "c".repeat(40), derivedKnowledge: "partial" },
    citations: [
      {
        id: "cite_1",
        title: "server entrypoint",
        excerpt: "createApiServer assembles the routes",
        sourceKind: "code",
        anchors: [{ sourceType: "blob", sourceId: "b1", pathOrUrl: "src/server.ts", commitSha: "c".repeat(40), startLine: 5, endLine: 9 }]
      }
    ],
    conflicts: [{ subject: "ownership", description: "two owners claimed" }],
    ambiguities: ["ambiguous ref"],
    coverage: { status: "partial", missing: ["dense retrieval"] }
  });

  assert.equal(result.graphId, "ig_9");
  assert.equal(result.incomplete, true);
  assert.deepEqual(result.claims, [
    {
      text: "createApiServer assembles the routes",
      citations: [
        { kind: "code", id: "cite_1", repository: "acme/app", commitSha: "c".repeat(40), path: "src/server.ts", startLine: 5, endLine: 9 }
      ]
    }
  ]);
  assert.deepEqual(result.highlightedNodeIds, ["src/server.ts"]);
  assert.deepEqual(result.notes, [
    "ambiguous ref",
    "Coverage gap: dense retrieval",
    "Conflict on ownership: two owners claimed"
  ]);
});

test("a complete query is not reported as incomplete", () => {
  const result = contextQueryResult("acme/app", {
    answer: "answer",
    generation: { id: "ig_1", ref: "main", commitSha: "d".repeat(40), derivedKnowledge: "available" },
    coverage: { status: "complete" }
  });
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.notes, []);
});

test("anchors render with lines and a short commit, or fall back to the source", () => {
  assert.equal(
    formatAnchor({ sourceType: "blob", sourceId: "b1", pathOrUrl: "src/a.ts", commitSha: "e".repeat(40), startLine: 1, endLine: 2 }),
    "src/a.ts:1-2@eeeeeee"
  );
  assert.equal(formatAnchor({ sourceType: "pull_request", sourceId: "42" }), "pull_request:42");
});
