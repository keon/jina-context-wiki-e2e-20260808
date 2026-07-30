import assert from "node:assert/strict";
import test from "node:test";
import {
  contextCitationHref,
  contextCitationLabel,
  contextDocumentPath,
  contextRelevantSourceFiles,
  resolveContextMarkdownLink
} from "./context-citations.ts";
import type { ContextCatalogDocument, ContextSourceCitation } from "./types.ts";

function citation(
  anchor: ContextSourceCitation["anchor"],
  claim = "The webhook creates a review task."
): ContextSourceCitation {
  return { claim, anchor };
}

test("blob citations link to the immutable GitHub commit and exact line range", () => {
  const source = citation({
    sourceType: "blob",
    sourceId: "b".repeat(40),
    repository: "omlabs/example",
    commitSha: "d".repeat(40),
    pathOrUrl: "src/webhook handler.ts",
    startLine: 12,
    endLine: 15
  });

  assert.equal(
    contextCitationHref(source),
    `https://github.com/omlabs/example/blob/${"d".repeat(40)}/src/webhook%20handler.ts#L12-L15`
  );
  assert.equal(contextCitationLabel(source), "src/webhook handler.ts:12-15");
});

test("provider citations keep their recorded URL", () => {
  const source = citation({
    sourceType: "issue",
    sourceId: "github:issue:omlabs/example#91",
    repository: "omlabs/example",
    pathOrUrl: "https://github.com/omlabs/example/issues/91",
    jsonPointer: "/body"
  });

  assert.equal(contextCitationHref(source), "https://github.com/omlabs/example/issues/91");
  assert.equal(contextCitationLabel(source), "https://github.com/omlabs/example/issues/91");
});

test("a non-URL provider identifier is displayed without inventing a link", () => {
  const source = citation({
    sourceType: "observation",
    sourceId: "provider:observation:7",
    repository: "omlabs/example"
  });

  assert.equal(contextCitationHref(source), undefined);
  assert.equal(contextCitationLabel(source), "observation:provider:observation:7");
});

test("mutable GitHub blob URLs are repinned to the citation commit", () => {
  const source = citation({
    sourceType: "blob",
    sourceId: "source",
    repository: "omlabs/example",
    commitSha: "e".repeat(40),
    pathOrUrl: "https://github.com/omlabs/example/blob/main/src/index.ts",
    startLine: 7
  });

  assert.equal(contextCitationHref(source), `https://github.com/omlabs/example/blob/${"e".repeat(40)}/src/index.ts#L7`);
});

test("relevant source files are unique, sorted, commit-pinned, and exclude provider records", () => {
  const commitSha = "a".repeat(40);
  const citations = [
    citation({
      sourceType: "blob",
      sourceId: "one",
      repository: "omlabs/example",
      commitSha,
      pathOrUrl: "src/zeta.ts",
      startLine: 4
    }),
    citation({
      sourceType: "blob",
      sourceId: "two",
      repository: "omlabs/example",
      commitSha,
      pathOrUrl: "src/zeta.ts",
      startLine: 12
    }),
    citation({
      sourceType: "blob",
      sourceId: "three",
      repository: "omlabs/example",
      commitSha,
      pathOrUrl: "src/alpha.ts",
      startLine: 2
    }),
    citation({
      sourceType: "issue",
      sourceId: "issue",
      repository: "omlabs/example",
      pathOrUrl: "https://github.com/omlabs/example/issues/1"
    })
  ];

  assert.deepEqual(contextRelevantSourceFiles(citations), [
    {
      path: "src/alpha.ts",
      href: `https://github.com/omlabs/example/blob/${commitSha}/src/alpha.ts#L2`,
      citationCount: 1
    },
    {
      path: "src/zeta.ts",
      href: `https://github.com/omlabs/example/blob/${commitSha}/src/zeta.ts#L4`,
      citationCount: 2
    }
  ]);
});

function document(id: string, logicalId: string, kind: string): ContextCatalogDocument {
  return {
    id,
    logicalId,
    revisionId: `${id}-revision`,
    kind,
    title: id,
    summary: `${id} summary`,
    citations: []
  };
}

test("catalog logical IDs recover the Markdown paths used for cross-document links", () => {
  assert.equal(
    contextDocumentPath(
      document("architecture", "repository:omlabs/example:architecture", "architecture"),
      "omlabs/example"
    ),
    "architecture"
  );
  assert.equal(
    contextDocumentPath(document("worker", "component:omlabs/example:worker/runtime", "component"), "omlabs/example"),
    "components/worker/runtime"
  );
  assert.equal(
    contextDocumentPath(document("retrieval", "topic:omlabs/example:retrieval", "topic"), "omlabs/example"),
    "retrieval"
  );
});

test("Markdown evidence and context links resolve to exact sources and dashboard documents", () => {
  const current = document("retrieval-id", "topic:omlabs/example:retrieval", "topic");
  const evidence = document("evidence-id", "topic:omlabs/example:evidence-model", "topic");
  const release = { repository: "omlabs/example", commitSha: "f".repeat(40) };
  const input = { release, document: current, documents: [current, evidence] };

  assert.deepEqual(resolveContextMarkdownLink("evidence-model.md", input), {
    kind: "document",
    documentId: "evidence-id"
  });
  assert.deepEqual(resolveContextMarkdownLink("docs/ARCHITECTURE.md#L173-L183", input), {
    kind: "source",
    href: `https://github.com/omlabs/example/blob/${"f".repeat(40)}/docs/ARCHITECTURE.md#L173-L183`
  });
  assert.deepEqual(resolveContextMarkdownLink("packages/api/src/server.ts#L10", input), {
    kind: "source",
    href: `https://github.com/omlabs/example/blob/${"f".repeat(40)}/packages/api/src/server.ts#L10`
  });
  assert.deepEqual(resolveContextMarkdownLink("https://github.com/omlabs/example/issues/3", input), {
    kind: "external",
    href: "https://github.com/omlabs/example/issues/3"
  });
});

test("Markdown link resolution rejects unknown documents, traversal, and unsafe protocols", () => {
  const current = document("retrieval-id", "topic:omlabs/example:retrieval", "topic");
  const input = {
    release: { repository: "omlabs/example", commitSha: "f".repeat(40) },
    document: current,
    documents: [current]
  };

  assert.deepEqual(resolveContextMarkdownLink("missing.md", input), { kind: "unsafe" });
  assert.deepEqual(resolveContextMarkdownLink("../secrets.txt#L1", input), { kind: "unsafe" });
  assert.deepEqual(resolveContextMarkdownLink("javascript:alert(1)", input), { kind: "unsafe" });
  assert.deepEqual(resolveContextMarkdownLink("//tracker.example/pixel", input), { kind: "unsafe" });
});
