import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJson,
  fingerprint,
  normalizeProviderObservation,
  type IngestEvidenceInput
} from "@jina/context-engine";
import { boardPageAuditInventory, boardPublicPageDigest } from "./board-page-audit.js";

const snapshot: IngestEvidenceInput = {
  tenantId: "tenant-1",
  repository: "acme/sample",
  ref: "main",
  refSequence: 1,
  commitSha: "a".repeat(40),
  files: [
    {
      path: "src/server.ts",
      blobSha: "b".repeat(40),
      body: ["export function start() {", "  return createServer();", "}"].join("\n"),
      executable: false
    }
  ],
  observations: [
    {
      sourceType: "issue",
      sourceId: "github:issue:acme/sample#7",
      title: "Track startup",
      payload: { number: 7, title: "Track startup" },
      pathOrUrl: "https://github.com/acme/sample/issues/7",
      observedAt: "2026-07-29T00:00:00.000Z",
      metadata: { provider: "github", number: 7 }
    }
  ],
  git: {
    commit: {
      treeSha: "c".repeat(40),
      parentShas: [],
      message: "Initialize"
    },
    changes: [],
    history: [
      {
        sha: "e".repeat(40),
        treeSha: "f".repeat(40),
        parentShas: ["a".repeat(40)],
        message: "Explain the startup decision"
      }
    ]
  },
  aclFingerprint: "d".repeat(64),
  observationFrontier: "{}",
  createdAt: "2026-07-29T00:00:00.000Z",
  sourceComplete: true
};

test("board page audit deterministically binds core claims to exact immutable evidence", () => {
  const body = [
    "# Runtime",
    "",
    "The runtime [creates its server in `start`](src/server.ts#L1-L3).",
    "",
    "[Issue 7 tracks startup](https://github.com/acme/sample/issues/7).",
    "",
    "[A later commit explains the startup decision](https://github.com/acme/sample/commit/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee)."
  ].join("\n");
  const inventory = boardPageAuditInventory({
    documentPath: "runtime.md",
    bodyMarkdown: body,
    snapshot
  });
  assert.deepEqual(inventory.structuralProblems, []);
  assert.equal(inventory.references.length, 3);
  assert.equal(inventory.references[0]?.sourceId, "b".repeat(40));
  assert.equal(inventory.references[0]?.excerpt, snapshot.files[0]?.body);
  assert.equal(inventory.references[1]?.sourceId, "github:issue:acme/sample#7");
  assert.equal(
    inventory.references[1]?.contentDigest,
    normalizeProviderObservation(snapshot.observations![0]!).contentDigest
  );
  assert.equal(inventory.references[2]?.sourceType, "commit");
  assert.equal(inventory.references[2]?.sourceId, "e".repeat(40));
  assert.equal(inventory.references[2]?.contentDigest, fingerprint(canonicalJson(snapshot.git!.history![0]!)));
  assert.match(inventory.references[2]?.excerpt ?? "", /startup decision/);
  assert.match(boardPublicPageDigest("runtime.md", body), /^[0-9a-f]{64}$/);
});

test("board page audit requires a grounded lead without asking the model to invent a source binding", () => {
  const inventory = boardPageAuditInventory({
    documentPath: "runtime.md",
    bodyMarkdown: "# Runtime\n\nThe runtime retries every failure forever.",
    snapshot
  });
  assert.ok(inventory.structuralProblems.some((problem) => problem.includes("ungrounded lead summary")));
  assert.ok(inventory.structuralProblems.some((problem) => problem.includes("no source-bound")));
  assert.deepEqual(inventory.references, []);
});

test("board page audit accepts uncited connective prose but requires every substantive section to be grounded", () => {
  const navigation = boardPageAuditInventory({
    documentPath: "runtime.md",
    bodyMarkdown: [
      "# Runtime",
      "",
      "[The runtime creates its server in `start`](src/server.ts#L1-L3).",
      "",
      "Read this alongside [the API boundary](api/boundary.md), [the worker runtime](workers/runtime.md), and [the architecture](architecture.md)."
    ].join("\n"),
    snapshot
  });
  assert.deepEqual(navigation.structuralProblems, []);

  const section = boardPageAuditInventory({
    documentPath: "runtime.md",
    bodyMarkdown: [
      "# Runtime",
      "",
      "[The runtime creates its server in `start`](src/server.ts#L1-L3).",
      "",
      "This paragraph connects the overview to the operational detail without adding a new source binding.",
      "",
      "## Retry behavior",
      "",
      "The worker retries every failure forever.",
      "",
      "## Navigation",
      "",
      "See [Architecture](architecture.md)."
    ].join("\n"),
    snapshot
  });
  assert.ok(
    section.structuralProblems.some((problem) =>
      problem.includes("ungrounded substantive section in runtime.md: Retry behavior")
    )
  );
  assert.ok(section.structuralProblems.every((problem) => !problem.includes("Navigation")));
});

test("board page audit excludes source links that occur only inside explicit maintenance questions", () => {
  const inventory = boardPageAuditInventory({
    documentPath: "runtime.md",
    bodyMarkdown: [
      "# Runtime",
      "",
      "[The runtime creates its server in `start`](src/server.ts#L1-L3).",
      "",
      "How should a change to [server startup](src/server.ts#L1-L3) preserve [creation behavior](src/server.ts#L1-L3)?"
    ].join("\n"),
    snapshot
  });

  assert.deepEqual(inventory.structuralProblems, []);
  assert.equal(inventory.references.length, 1);
  assert.equal(inventory.references[0]?.claimSpan, "The runtime creates its server in start.");
});

test("board page audit groups complementary links from one compound claim", () => {
  const inventory = boardPageAuditInventory({
    documentPath: "runtime.md",
    bodyMarkdown: [
      "# Runtime",
      "",
      "[The runtime creates its server](src/server.ts#L1-L2) and [returns it to the caller](src/server.ts#L2-L3)."
    ].join("\n"),
    snapshot
  });

  assert.deepEqual(inventory.structuralProblems, []);
  assert.equal(inventory.references.length, 2);
  assert.match(inventory.references[0]?.claimId ?? "", /^claim_[a-f0-9]{20}$/);
  assert.equal(inventory.references[0]?.claimId, inventory.references[1]?.claimId);
});

test("board page audit does not require decorative citations in tables once the section has a core anchor", () => {
  const inventory = boardPageAuditInventory({
    documentPath: "runtime.md",
    bodyMarkdown: [
      "# Runtime",
      "",
      "[The runtime creates its server in `start`](src/server.ts#L1-L3).",
      "",
      "## Runtime matrix",
      "",
      "[The server is created by `start`](src/server.ts#L1-L3).",
      "",
      "| Operational guarantee | Read next |",
      "| --- | --- |",
      "| Every tenant shares one token | [Architecture](architecture.md) |"
    ].join("\n"),
    snapshot
  });

  assert.deepEqual(inventory.structuralProblems, []);
  assert.equal(inventory.references.length, 2);
});
