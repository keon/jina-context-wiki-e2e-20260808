import assert from "node:assert/strict";
import test from "node:test";
import {
  citationLocation,
  contextScopes,
  generationForScope,
  matchesStructure,
  projectorRows,
  publishedGenerations,
  queryCitationAnchors,
  reviewableDocument,
  safeSourceUrl,
  structureEntries
} from "./context.ts";
import type { ContextGeneration, ContextQueryResponse, KnowledgeDocumentSummary } from "./types.ts";

const generations: readonly ContextGeneration[] = [
  {
    id: "old",
    repository: "acme/payments",
    ref: "main",
    commitSha: "111",
    status: "published",
    derivedKnowledge: "partial",
    projectors: { lexical: "ready" },
    createdAt: "2026-01-01T00:00:00Z",
    publishedAt: "2026-01-01T00:00:01Z"
  },
  {
    id: "new",
    repository: "acme/payments",
    ref: "main",
    commitSha: "222",
    status: "published",
    derivedKnowledge: "available",
    projectors: [{ name: "lexical", status: "ready" }],
    createdAt: "2026-01-02T00:00:00Z",
    publishedAt: "2026-01-02T00:00:01Z"
  },
  {
    id: "building",
    repository: "acme/payments",
    ref: "next",
    commitSha: "333",
    status: "building",
    derivedKnowledge: "unavailable",
    projectors: {},
    createdAt: "2026-01-03T00:00:00Z"
  }
];

test("context scope helpers choose the latest published generation", () => {
  assert.deepEqual(
    publishedGenerations(generations).map((generation) => generation.id),
    ["new", "old"]
  );
  assert.deepEqual(contextScopes(generations), [{ repository: "acme/payments", ref: "main" }]);
  assert.equal(generationForScope(generations, "acme/payments", "main")?.id, "new");
  assert.deepEqual(projectorRows(generations[0]), [{ name: "lexical", status: "ready" }]);
});

test("citation helpers preserve exact ranges and reject unsafe links", () => {
  const citation = {
    id: "c1",
    sourceType: "blob",
    sourceId: "blob-1",
    repository: "acme/payments",
    pathOrUrl: "src/payments/service.ts",
    startLine: 12,
    endLine: 19,
    url: "https://github.com/acme/payments/blob/222/src/payments/service.ts#L12-L19"
  };
  assert.equal(citationLocation(citation), "src/payments/service.ts:12-19");
  assert.match(safeSourceUrl(citation) ?? "", /^https:\/\/github\.com\//);
  assert.equal(safeSourceUrl({ ...citation, url: "javascript:alert(1)" }), undefined);
});

test("structure entries are a deterministic tree plus source-anchored relations", () => {
  const entries = structureEntries(
    [{ kind: "imports", from: "src/app.ts", to: "src/lib.ts", anchors: [] }],
    [
      {
        id: "c1",
        sourceType: "blob",
        sourceId: "blob-1",
        repository: "acme/payments",
        pathOrUrl: "src/payments/service.ts"
      }
    ]
  );
  assert.deepEqual(
    entries.map(({ kind, path }) => [kind, path]),
    [
      ["directory", "src"],
      ["file", "src/app.ts"],
      ["file", "src/lib.ts"],
      ["directory", "src/payments"],
      ["file", "src/payments/service.ts"],
      ["relation", "src/app.ts"]
    ]
  );
  assert.equal(matchesStructure(entries[4]!, "service"), true);
  assert.equal(matchesStructure(entries[4]!, "README"), false);
});

test("dashboard consumes deployed query responses with nested anchors and traceId", () => {
  const response = {
    answer: "The context engine indexes evidence.",
    generation: {
      id: "ig_1",
      ref: "main",
      commitSha: "a".repeat(40),
      derivedKnowledge: "available"
    },
    citations: [
      {
        id: "citation_1",
        title: "README.md",
        excerpt: "indexes evidence",
        anchors: [
          {
            tenantId: "tenant-a",
            repository: "acme/context",
            sourceType: "blob",
            sourceId: "b".repeat(40),
            contentDigest: "c".repeat(64),
            commitSha: "a".repeat(40),
            pathOrUrl: "README.md"
          }
        ],
        authorityClass: "source_code",
        sourceKind: "code",
        sourceId: "b".repeat(40)
      }
    ],
    conflicts: [],
    ambiguities: [],
    coverage: { status: "complete", missing: [], retrieversUsed: ["lexical"] },
    traceId: "trace_1"
  } satisfies ContextQueryResponse;
  assert.equal(response.traceId, "trace_1");
  assert.deepEqual(queryCitationAnchors(response.citations), [
    {
      ...response.citations[0]!.anchors[0]!,
      id: "citation_1:0",
      excerpt: "indexes evidence",
      sourceKind: "code"
    }
  ]);
});

test("terminal knowledge states are not reviewable", () => {
  const document = {
    id: "revision-1",
    logicalId: "component:acme/payments:billing",
    repository: "acme/payments",
    kind: "component",
    title: "Billing",
    summary: "Billing context",
    confidence: 0.9,
    reviewStatus: "generated",
    commitSha: "222",
    createdAt: "2026-01-02T00:00:00Z"
  } satisfies KnowledgeDocumentSummary;
  assert.equal(reviewableDocument(document), true);
  assert.equal(reviewableDocument({ ...document, reviewStatus: "reviewed" }), false);
  assert.equal(reviewableDocument({ ...document, reviewStatus: "invalidated" }), false);
});
